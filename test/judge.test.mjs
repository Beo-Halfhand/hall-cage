// The judge's decisions and journal: no network, real ledger signatures, and the contract's simulator for batching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DEAD_MARGIN_SECS, HOLD_MARGIN_SECS, Journal, checkClaim, checkDoor, dropExpiredLines, planTable, signedForms, standRunOut, tableAlive, CLAIM_PATIENCE_MS } from '../scripts/judge-plan.mjs';
import { addressFromKey, sampleSigningKey, signData, signatureVerifyingKey, verifySignature } from './sig-v9.mjs';

const NOW = 2_000_000_000n;
const A = 'a'.repeat(64), B = 'b'.repeat(64), H = 'c'.repeat(64);
const M = 1_000_000n;
const tableRow = (over = {}) => ({ id: 'T1', cageTable: 1, status: 'open', live: false, wantHouse: false, claims: [], holders: [], entries: [], releases: [], lastChainRound: 0, ...over });
const holder = (cageId, over = {}) => ({ cageId, kind: 'player', left: false, epoch: 1, released: false, ...over });
const seat = (over = {}) => ({ table: 1n, epoch: 1n, atRisk: 5n * M, standing: false, standAt: over.standing ? NOW - 10n : 0n, ...over });
const chainOf = ({ seats = {}, table = {}, balances = {}, payTo = {} } = {}) => ({
  table: table === null ? null : { epoch: 1n, lastRound: 0n, heartbeat: NOW - 10n, seated: 2n, ...table },
  seats: new Map(Object.entries(seats)),
  balance: (id) => balances[id] ?? 5n * M,
  payTo: (id) => payTo[id] ?? null,
  nowSecs: NOW,
  escapeSecs: 1800n,
});
const entry = (seq, rounds, lines) => ({ seq, rounds, lines });

test('a finished round becomes one chain entry with the next round number, in STAR', () => {
  const row = tableRow({ holders: [holder(A), holder(B)], entries: [entry(1, [1], [{ id: A, delta: -2 }, { id: B, delta: 2 }]), entry(2, [2], [{ id: A, delta: 1 }, { id: B, delta: -1 }])] });
  const p = planTable(row, chainOf({ seats: { [A]: seat(), [B]: seat() }, table: { lastRound: 3n } }), { knownRound: 3n });
  assert.equal(p.blocked, null);
  assert.deepEqual(p.entries.map((e) => [e.roundNo, e.seqs, e.rounds]), [[4n, [1], [1]], [5n, [2], [2]]]);
  assert.deepEqual(p.entries[0].lines, [{ id: A, debit: 2n * M, credit: 0n }, { id: B, debit: 0n, credit: 2n * M }]);
});

test('a round already taken by the journal is never planned again', () => {
  const row = tableRow({ holders: [holder(A), holder(B)], entries: [entry(1, [1], [{ id: A, delta: -1 }, { id: B, delta: 1 }])] });
  const c = chainOf({ seats: { [A]: seat(), [B]: seat() } });
  assert.equal(planTable(row, c, { done: new Set(['T1:1']) }).entries.length, 0);
  assert.equal(planTable(row, c).entries.length, 1);
});

test('chain ahead of everything we know (a lost journal) blocks the table instead of settling again', () => {
  const row = tableRow({ holders: [holder(A), holder(B)], lastChainRound: 2, entries: [entry(3, [3], [{ id: A, delta: -1 }, { id: B, delta: 1 }])] });
  const seats = { [A]: seat(), [B]: seat() };
  const blocked = planTable(row, chainOf({ seats, table: { lastRound: 3n } }), { knownRound: 0n });
  assert.match(blocked.blocked, /refusing to settle/);
  assert.equal(blocked.entries.length, 0);
  assert.equal(planTable(row, chainOf({ seats, table: { lastRound: 3n } }), { knownRound: 3n }).blocked, null, 'the journal knows round 3: the receipt just has not reached the Worker');
  assert.equal(planTable(row, chainOf({ seats, table: { lastRound: 2n } })).blocked, null);
});

test('a seat standing on chain holds the table until the Worker has it out, then its rounds merge into one entry', () => {
  const seats = { [A]: seat({ standing: true }), [B]: seat() };
  const entries = [entry(1, [1], [{ id: A, delta: -1 }, { id: B, delta: 1 }]), entry(2, [2], [{ id: A, delta: -2 }, { id: B, delta: 2 }]), entry(3, [3], [{ id: B, delta: 1 }, { id: H, delta: -1 }])];
  const still = planTable(tableRow({ holders: [holder(A), holder(B)], entries }), chainOf({ seats: { ...seats, [H]: seat() } }));
  assert.deepEqual(still.standing, [A]);
  assert.equal(still.hold, true);
  assert.equal(still.entries.length, 0, 'their round may still be running');

  const out = planTable(tableRow({ holders: [holder(A, { left: true }), holder(B), holder(H)], entries }), chainOf({ seats: { ...seats, [H]: seat() } }));
  assert.equal(out.hold, false);
  assert.deepEqual(out.entries.map((e) => [e.roundNo, e.seqs, e.rounds]), [[1n, [1, 2], [1, 2]], [2n, [3], [3]]]);
  assert.deepEqual(out.entries[0].lines, [{ id: A, debit: 3n * M, credit: 0n }, { id: B, debit: 0n, credit: 3n * M }]);
});

test('a line for a player with no seat, or over the limits, blocks: it never reaches a failing transaction', () => {
  const row = tableRow({ holders: [holder(A), holder(B)], entries: [entry(1, [1], [{ id: A, delta: -1 }, { id: B, delta: 1 }])] });
  assert.match(planTable(row, chainOf({ seats: { [A]: seat() } })).blocked, /no seat/);
  assert.match(planTable(row, chainOf({ seats: { [A]: seat({ atRisk: M / 2n }), [B]: seat() } })).blocked, /over atRisk/);
  assert.match(planTable(row, chainOf({ seats: { [A]: seat(), [B]: seat() }, balances: { [A]: 0n } })).blocked, /over atRisk .* or balance/);
  assert.match(planTable(row, chainOf({ seats: { [A]: seat({ table: 2n }), [B]: seat() } })).blocked, /no seat/, 'seated at another table');
  assert.match(planTable(row, chainOf({ seats: { [A]: seat({ epoch: 9n }), [B]: seat() } })).blocked, /no seat/, 'a seat from an old epoch');
});

test('balances carry through the entries of a plan', () => {
  const row = tableRow({ holders: [holder(A), holder(B)], entries: [entry(1, [1], [{ id: A, delta: -3 }, { id: B, delta: 3 }]), entry(2, [2], [{ id: A, delta: -3 }, { id: B, delta: 3 }])] });
  const c = chainOf({ seats: { [A]: seat({ atRisk: 9n * M }), [B]: seat() }, balances: { [A]: 5n * M } });
  assert.match(planTable(row, c).blocked, /over atRisk .* or balance/, '5 can pay 3 once, not twice');
});

test('atRisk carries through the entries of a plan too', () => {
  const row = tableRow({ holders: [holder(A), holder(B)], entries: [entry(1, [1], [{ id: A, delta: -3 }, { id: B, delta: 3 }]), entry(2, [2], [{ id: A, delta: -3 }, { id: B, delta: 3 }])] });
  const c = chainOf({ seats: { [A]: seat({ atRisk: 5n * M }), [B]: seat() }, balances: { [A]: 9n * M } });
  assert.match(planTable(row, c).blocked, /over atRisk 2000000/);
});

test('a quiet table is called dead, with the same arithmetic as the contract, and an old epoch too', () => {
  const row = tableRow({ holders: [holder(A)] });
  assert.equal(planTable(row, chainOf({ seats: { [A]: seat() }, table: { heartbeat: NOW - 1000n } })).dead, null);
  assert.match(planTable(row, chainOf({ seats: { [A]: seat() }, table: { heartbeat: NOW - 1800n } })).dead, /escape fired/);
  assert.match(planTable(row, chainOf({ seats: { [A]: seat() }, table: { epoch: 2n } })).dead, /voided/);
  assert.match(planTable(row, chainOf({ seats: { [A]: seat() }, table: null })).dead, /escape fired/);
  assert.equal(planTable(tableRow(), chainOf({ table: null })).dead, null, 'a lobby with no seats yet has nothing to die');
  assert.equal(tableAlive({ seated: 0n, heartbeat: NOW }, NOW, 1800n), false);
});

test('releases: only what the next settle does not already cover', () => {
  const row = tableRow({ holders: [holder(A, { left: true }), holder(B)], entries: [entry(1, [1], [{ id: B, delta: 1 }, { id: H, delta: -1 }])], releases: [{ cageId: A, kind: 'player' }, { cageId: B, kind: 'player' }] });
  const p = planTable(row, chainOf({ seats: { [A]: seat(), [B]: seat(), [H]: seat() } }));
  assert.deepEqual(p.releases.map((r) => r.cageId), [A]);
});

function signedClaim(key, message) {
  return { cageId: A, at: Date.now() - CLAIM_PATIENCE_MS - 1, message, verifyingKey: signatureVerifyingKey(key), signature: signData(key, new TextEncoder().encode(message)) };
}
const ADDRESS = 'e'.repeat(64);
const MSG = `sealed-hand:seat:v1|${ADDRESS}|T1|${A}`;
const opts = { address: ADDRESS, addressFromKey, verify: (vk, m, sig) => verifySignature(vk, new TextEncoder().encode(m), sig) };

test('a seat claim must be signed by the key the cage pays out to', () => {
  const owner = sampleSigningKey();
  const thief = sampleSigningKey();
  const payTo = { [A]: addressFromKey(signatureVerifyingKey(owner)) };
  const c = chainOf({ seats: { [A]: seat({ atRisk: 7n * M }) }, balances: { [A]: 9n * M }, payTo });

  const ok = checkClaim(signedClaim(owner, MSG), 1, c, opts);
  assert.deepEqual(ok, { ok: true, atRiskStar: String(7n * M), balanceStar: String(9n * M), epoch: 1, lastRound: '0' });

  assert.match(checkClaim(signedClaim(thief, MSG), 1, c, opts).reason, /not the payout address/, 'public id, other wallet: this is the attack');
  const forged = { ...signedClaim(thief, MSG), verifyingKey: signatureVerifyingKey(owner) };
  assert.match(checkClaim(forged, 1, c, opts).reason, /signature does not match/, 'claiming the right public key with a wrong signature');
  const replay = { ...signedClaim(owner, MSG), message: `sealed-hand:seat:v1|${ADDRESS}|T2|${A}` };
  assert.match(checkClaim(replay, 1, c, opts).reason, /signature does not match/, 'a signature for another table');
  const otherCage = signedClaim(owner, `sealed-hand:seat:v1|${'f'.repeat(64)}|T1|${A}`);
  assert.match(checkClaim(otherCage, 1, c, opts).reason, /different cage/);
  assert.match(checkClaim({ ...signedClaim(owner, MSG), verifyingKey: 'junk' }, 1, c, opts).reason, /valid key/);
});

test('a claim waits a while for its seat to appear on chain, then is refused; a bad seat is refused at once', () => {
  const owner = sampleSigningKey();
  const payTo = { [A]: addressFromKey(signatureVerifyingKey(owner)) };
  const fresh = { ...signedClaim(owner, MSG), at: Date.now() };
  assert.deepEqual(checkClaim(fresh, 1, chainOf({ payTo }), opts), { wait: true });
  assert.match(checkClaim(signedClaim(owner, MSG), 1, chainOf({ payTo }), opts).reason, /No seat/);
  assert.deepEqual(checkClaim(fresh, 1, chainOf({ seats: { [A]: seat({ table: 2n }) }, payTo }), opts), { wait: true });
  assert.match(checkClaim(signedClaim(owner, MSG), 1, chainOf({ seats: { [A]: seat({ standing: true }) }, payTo }), opts).reason, /standing/);
  assert.match(checkClaim(signedClaim(owner, MSG), 1, chainOf({ seats: { [A]: seat() }, table: { heartbeat: NOW - 1800n }, payTo }), opts).reason, /quiet/);
  assert.match(checkClaim(signedClaim(owner, MSG), 1, chainOf({ seats: { [A]: seat() } }), opts).reason, /no payout address/);
});

const intent = (batch, table, roundNo, seqs) => ({ type: 'intent', batch, entries: [{ table, cageTable: 1, roundNo: String(roundNo), seqs, rounds: seqs, lines: [] }] });

test('journal: replayed from its lines it knows what is taken, unresolved and unwritten', () => {
  const lines = [
    intent('b1', 'T1', 1, [1]), { type: 'sent', batch: 'b1', id: 'x1', at: '2026-11-03T00:00:00Z' }, { type: 'landed', batch: 'b1', id: 'x1', hash: 'h1', block: 5, status: 'SucceedEntirely' }, { type: 'written', batch: 'b1', table: 'T1' },
    intent('b2', 'T1', 2, [2]), { type: 'sent', batch: 'b2', id: 'x2', at: '2026-11-03T00:00:01Z' }, { type: 'landed', batch: 'b2', id: 'x2', hash: 'h2', block: 6, status: 'SucceedEntirely' },
    intent('b3', 'T1', 3, [3]), { type: 'sent', batch: 'b3', id: 'x3', at: '2026-11-03T00:00:02Z' },
    intent('b4', 'T1', 4, [4]),
    intent('b5', 'T2', 1, [1]), { type: 'failed', batch: 'b5', reason: 'refused' },
  ];
  const j = new Journal(lines);
  assert.deepEqual([...j.taken()].sort(), ['T1:1', 'T1:2', 'T1:3', 'T1:4']);
  assert.deepEqual(j.unresolved().map((b) => [b.batch, b.state]), [['b3', 'sent'], ['b4', 'intent']]);
  assert.deepEqual(j.unwritten().map((u) => [u.batch, u.tx.hash, u.tx.chainRound]), [['b2', 'h2', '2']]);
  assert.equal(j.knownRound('T1'), 4n);
  assert.deepEqual([...j.tablesInFlight()], ['T1'], 'rounds stay in order: nothing more settles at T1 until b3 is resolved');
  assert.equal(j.knownRound('T2'), 0n, 'a failed batch moved nothing');
  const round = planTable(tableRow({ holders: [holder(A), holder(B)], entries: [entry(2, [2], [{ id: A, delta: -1 }, { id: B, delta: 1 }]), entry(5, [5], [{ id: A, delta: -1 }, { id: B, delta: 1 }])] }), chainOf({ seats: { [A]: seat(), [B]: seat() }, table: { lastRound: 4n } }), { done: j.taken(), knownRound: j.knownRound('T1') });
  assert.deepEqual(round.entries.map((e) => [e.seqs, e.roundNo]), [[[5], 5n]], 'restart: only the new round goes, numbered after the chain');
});

test('a signature made the way Lace makes it verifies, in both accepted forms, and a different message does not', () => {
  const key = sampleSigningKey();
  const vk = signatureVerifyingKey(key);
  const ok = (message, signature) => signedForms(message).some((data) => verifySignature(vk, data, signature));
  const lace = signData(key, new TextEncoder().encode(`midnight_signed_message:${MSG.length}:${MSG}`));
  assert.ok(ok(MSG, lace));
  assert.ok(ok(MSG, signData(key, new TextEncoder().encode(MSG))));
  assert.ok(!ok(`${MSG}x`, lace));
});

test('merging keeps a line that nets to zero: it frees the standing seat, and an empty entry would be refused', () => {
  const seats = { [A]: seat({ standing: true }), [B]: seat() };
  const entries = [entry(7, [7], [{ id: A, delta: 1 }, { id: B, delta: -1 }]), entry(8, [8], [{ id: A, delta: -1 }, { id: B, delta: 1 }])];
  const p = planTable(tableRow({ holders: [holder(A, { left: true }), holder(B)], entries }), chainOf({ seats, table: { lastRound: 6n } }), { knownRound: 6n });
  assert.equal(p.blocked, null);
  assert.deepEqual(p.entries.map((e) => [e.roundNo, e.seqs, e.lines]), [[7n, [7, 8], [{ id: A, debit: 0n, credit: 0n }, { id: B, debit: 0n, credit: 0n }]]]);
});

test('a seat standing on chain that this table never took: the judge frees it, and only that one', () => {
  const stray = 'd'.repeat(64);
  const pending = 'e'.repeat(64);
  const elsewhere = 'f'.repeat(64);
  const seats = { [A]: seat(), [stray]: seat({ standing: true }), [pending]: seat({ standing: true }), [elsewhere]: seat({ standing: true, table: 9n }), [B]: seat({ epoch: 7n, standing: true }) };
  const row = tableRow({ holders: [holder(A)], claims: [{ cageId: pending, at: 0, message: '', verifyingKey: '', signature: '' }] });
  assert.deepEqual(planTable(row, chainOf({ seats })).strays, [stray], 'not a claim still waiting, not another table, not an old epoch');
  const notStanding = { [A]: seat(), [stray]: seat() };
  assert.deepEqual(planTable(row, chainOf({ seats: notStanding })).strays, [], 'one who has not asked stays put');
});


const DOOR_ADDRESS = 'e'.repeat(64);
function doorOf(key, over = {}) {
  const payout = addressFromKey(signatureVerifyingKey(key));
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const message = `sealed-hand:door:v1|${DOOR_ADDRESS}|${A}|${payout}|${expires}`;
  // what Lace signs: its own envelope round the message
  const signature = signData(key, new TextEncoder().encode(`midnight_signed_message:${message.length}:${message}`));
  return { cageId: A, payout, expires, message, verifyingKey: signatureVerifyingKey(key), signature, ...over };
}
const doorOpts = { address: DOOR_ADDRESS, addressFromKey, verify: (vk, m, sig) => signedForms(m).some((data) => verifySignature(vk, data, sig)) };

test('the door: a session is good only from the key the cage pays out to, for this message, until it runs out', () => {
  const owner = sampleSigningKey();
  const thief = sampleSigningKey();
  const c = chainOf({ payTo: { [A]: addressFromKey(signatureVerifyingKey(owner)) } });
  assert.deepEqual(checkDoor(doorOf(owner), c, doorOpts), { ok: true });
  assert.match(checkDoor(doorOf(thief), c, doorOpts).reason, /not the payout address/, 'another wallet, naming itself');
  assert.match(checkDoor(doorOf(thief, { payout: doorOf(owner).payout, message: doorOf(owner).message }), c, doorOpts).reason, /key is not the payout/, 'another wallet, naming the owner');
  assert.match(checkDoor(doorOf(owner, { verifyingKey: 'junk' }), c, doorOpts).reason, /valid key/);
  assert.match(checkDoor(doorOf(owner, { signature: doorOf(thief).signature }), c, doorOpts).reason, /signature does not match/);
  const tampered = doorOf(owner);
  tampered.expires += 86400;
  assert.match(checkDoor(tampered, c, doorOpts).reason, /not the one for this session/, 'stretching the expiry breaks it');
  assert.match(checkDoor(doorOf(owner), chainOf(), doorOpts).reason, /deposit first/);
  assert.match(checkDoor(doorOf(owner, { expires: 100 }), c, doorOpts).reason, /run out/);
});

test('a seat claimed with a door session still has to be on chain at this table, and it skips only the signature', () => {
  const claim = { cageId: A, at: Date.now() - CLAIM_PATIENCE_MS - 1, door: true };
  const payTo = { [A]: 'f'.repeat(64) };
  assert.deepEqual(checkClaim(claim, 1, chainOf({ seats: { [A]: seat({ atRisk: 7n * M }) }, balances: { [A]: 9n * M }, payTo }), opts), { ok: true, atRiskStar: String(7n * M), balanceStar: String(9n * M), epoch: 1, lastRound: '0' });
  assert.match(checkClaim(claim, 1, chainOf({ payTo }), opts).reason, /No seat/);
  assert.match(checkClaim(claim, 1, chainOf({ seats: { [A]: seat({ table: 2n }) }, payTo }), opts).reason, /No seat/, 'seated at another table');
  assert.match(checkClaim(claim, 1, chainOf({ seats: { [A]: seat({ standing: true }) }, payTo }), opts).reason, /standing/);
});

test('a warm table with only the house on it gets a settle of nothing before it would go quiet, and not once anyone sits', () => {
  const warm = (over = {}) => tableRow({ warm: true, phase: 'lobby', house: H, holders: [holder(H, { kind: 'house' })], ...over });
  const near = chainOf({ seats: { [H]: seat() }, table: { heartbeat: NOW - 1300n, lastRound: 4n, seated: 1n } });
  const p = planTable(warm(), near, { knownRound: 4n });
  assert.deepEqual(p.keepAlive, { roundNo: 5n, seqs: [], rounds: [], lines: [{ id: H, debit: 0n, credit: 0n }] });
  assert.equal(planTable(warm(), chainOf({ seats: { [H]: seat() }, table: { heartbeat: NOW - 300n, seated: 1n } })).keepAlive, null, 'plenty of time left');
  assert.equal(planTable(warm({ holders: [holder(H, { kind: 'house' }), holder(A)] }), chainOf({ seats: { [H]: seat(), [A]: seat() }, table: { heartbeat: NOW - 1300n } })).keepAlive, null, 'a player is seated: their escape is theirs');
  assert.equal(planTable(tableRow({ phase: 'lobby', house: H, holders: [holder(H, { kind: 'house' })] }), near).keepAlive, null, 'only a warm table');
  assert.equal(planTable(warm({ phase: 'pass' }), near).keepAlive, null, 'not once it has dealt');
});

test('a stand has a deadline: the Worker is told it, and a round that outlasts it loses that line before it can fail a transaction', () => {
  const standAt = NOW - 60n;
  const seats = { [A]: seat({ standing: true, standAt }), [B]: seat() };
  const entries = [entry(1, [1], [{ id: A, delta: -1 }, { id: B, delta: 1 }])];
  const live = planTable(tableRow({ holders: [holder(A), holder(B)], entries }), chainOf({ seats }));
  assert.deepEqual(live.standUntil, { [A]: standAt + 1800n });
  assert.equal(live.hold, true);
  assert.deepEqual(live.expired, []);

  const late = { [A]: seat({ standing: true, standAt: NOW - 1800n + DEAD_MARGIN_SECS }), [B]: seat() };
  const run = planTable(tableRow({ holders: [holder(A), holder(B)], entries }), chainOf({ seats: late }));
  assert.deepEqual(run.expired, [A]);
  assert.equal(run.hold, false, 'an expired stand holds nobody up');
  assert.deepEqual(run.standing, []);
  assert.equal(run.blocked, null, 'the rest of the table carries on');
  assert.deepEqual(run.dropped, [{ seqs: [1], id: A, delta: -1 }]);
  assert.deepEqual(run.entries[0].lines, [{ id: B, debit: 0n, credit: 0n }], 'the winner had only that loser to be paid by');

  const justInTime = { [A]: seat({ standing: true, standAt: NOW - 1800n + DEAD_MARGIN_SECS + 1n }), [B]: seat() };
  const fine = planTable(tableRow({ holders: [holder(A, { left: true }), holder(B)], entries }), chainOf({ seats: justInTime }));
  assert.equal(fine.blocked, null);
  assert.equal(fine.entries.length, 1);
  assert.equal(standRunOut(seat({ standing: false, standAt: 0n }), NOW, 1800n), false, 'a seat that is not standing has no deadline');
});

test('strays are freed only with no round waiting: each release is a free seat a griefer could sit in to fail the settle', () => {
  const X = 'd'.repeat(64);
  const seats = { [A]: seat(), [B]: seat(), [X]: seat({ standing: true, standAt: NOW - 5n }) };
  const entries = [entry(1, [1], [{ id: A, delta: -1 }, { id: B, delta: 1 }])];
  const holders = [holder(A), holder(B)];
  assert.deepEqual(planTable(tableRow({ holders, entries }), chainOf({ seats })).strays, []);
  assert.deepEqual(planTable(tableRow({ holders, entries: [] }), chainOf({ seats })).strays, [X]);
  assert.deepEqual(planTable(tableRow({ holders, entries }), chainOf({ seats }), { done: new Set(['T1:1']) }).strays, [X], 'a round already sent is not waiting');
  const ghost = { [A]: seat({ standing: true, standAt: NOW - 1800n }), [B]: seat() };
  assert.deepEqual(planTable(tableRow({ holders, entries: [] }), chainOf({ seats: ghost })).strays, [A], 'a known holder whose stand ran out still takes up a seat');
});

// ---------- F4: a line naming a stand that has run out ----------
const C = 'd'.repeat(64), D = 'f'.repeat(64);
const lapsed = () => seat({ standing: true, standAt: NOW - 1800n });
const sumOf = (ls) => ls.reduce((n, l) => n + l.credit - l.debit, 0n);

test('F4: an expired loser is dropped, their atRisk and balance are not planned against, and the winner gets what is left', () => {
  const row = tableRow({ holders: [holder(A), holder(B), holder(C)], entries: [entry(1, [1], [{ id: A, delta: -4 }, { id: C, delta: -2 }, { id: B, delta: 6 }])] });
  const p = planTable(row, chainOf({ seats: { [A]: lapsed(), [B]: seat(), [C]: seat() } }));
  assert.equal(p.blocked, null);
  assert.deepEqual(p.dropped, [{ seqs: [1], id: A, delta: -4 }]);
  assert.deepEqual(p.entries[0].lines, [{ id: C, debit: 2n * M, credit: 0n }, { id: B, debit: 0n, credit: 2n * M }]);
  assert.deepEqual(p.entries[0].dropped, [{ id: A, delta: -4 }]);
  assert.ok(!p.entries[0].lines.some((l) => l.id === A), 'no line for them at all: the cage would refuse it');
});

test('F4: an expired winner is dropped too, and the losers pay less: what is on the table adds up either way', () => {
  const row = tableRow({ holders: [holder(A), holder(B), holder(C)], entries: [entry(1, [1], [{ id: A, delta: 6 }, { id: B, delta: -4 }, { id: C, delta: -2 }])] });
  const p = planTable(row, chainOf({ seats: { [A]: lapsed(), [B]: seat(), [C]: seat() } }));
  assert.deepEqual(p.entries[0].lines, [{ id: B, debit: 0n, credit: 0n }, { id: C, debit: 0n, credit: 0n }], 'nobody left to pay');
  const q = planTable(tableRow({ holders: [holder(A), holder(B), holder(C), holder(D)], entries: [entry(1, [1], [{ id: A, delta: 3 }, { id: D, delta: 3 }, { id: B, delta: -4 }, { id: C, delta: -2 }])] }), chainOf({ seats: { [A]: lapsed(), [B]: seat(), [C]: seat(), [D]: seat() } }));
  assert.deepEqual(q.entries[0].lines, [{ id: D, debit: 0n, credit: 3n * M }, { id: B, debit: 2n * M, credit: 0n }, { id: C, debit: 1n * M, credit: 0n }]);
  assert.equal(sumOf(q.entries[0].lines), 0n);
});

test('F4: the sharing is by size, whole chips, largest remainder then line order, and it always adds up', () => {
  const none = dropExpiredLines([{ id: A, delta: -1 }, { id: B, delta: 1 }], () => false);
  assert.deepEqual(none.dropped, []); assert.deepEqual(none.lines, [{ id: A, delta: -1 }, { id: B, delta: 1 }]);
  const shared = dropExpiredLines([{ id: A, delta: -10 }, { id: B, delta: 7 }, { id: C, delta: 2 }, { id: D, delta: 1 }], (id) => id === A);
  assert.deepEqual(shared.lines.map((l) => l.delta), [0, 0, 0], 'all of it came from the dropped line: nothing moves, and the lines stay');
  const part = dropExpiredLines([{ id: A, delta: -5 }, { id: H, delta: -5 }, { id: B, delta: 7 }, { id: C, delta: 2 }, { id: D, delta: 1 }], (id) => id === A);
  assert.deepEqual(part.lines, [{ id: H, delta: -5 }, { id: B, delta: 3 }, { id: C, delta: 1 }, { id: D, delta: 1 }], '7/10, 2/10, 1/10 of 5 is 3.5, 1, 0.5: the first of the two equal remainders gets the chip');
  for (const lines of [[{ id: A, delta: -7 }, { id: H, delta: -1 }, { id: B, delta: 3 }, { id: C, delta: 3 }, { id: D, delta: 2 }], [{ id: A, delta: 5 }, { id: H, delta: 1 }, { id: B, delta: -3 }, { id: C, delta: -2 }, { id: D, delta: -1 }]]) {
    const r = dropExpiredLines(lines, (id) => id === A);
    assert.equal(r.balanced, true); assert.equal(r.lines.reduce((n, l) => n + l.delta, 0), 0);
    for (const l of r.lines) assert.ok(Math.sign(l.delta) === Math.sign(lines.find((x) => x.id === l.id).delta) || l.delta === 0, 'shaving never flips a line');
  }
  assert.equal(dropExpiredLines([{ id: A, delta: 5 }, { id: B, delta: 1 }], (id) => id === A).balanced, false, 'an entry that never added up stays a problem for a person');
  assert.match(planTable(tableRow({ holders: [holder(A), holder(B)], entries: [entry(1, [1], [{ id: A, delta: 5 }, { id: B, delta: 1 }])] }), chainOf({ seats: { [A]: lapsed(), [B]: seat() } })).blocked, /don't add up/);
  assert.deepEqual(dropExpiredLines([{ id: A, delta: -2 }, { id: B, delta: 2 }, { id: C, delta: 0 }], (id) => id === A).lines, [{ id: B, delta: 0 }, { id: C, delta: 0 }], 'a zero line stays: it may be what frees a standing seat');
  const before = [{ id: A, delta: -2 }, { id: B, delta: 2 }]; dropExpiredLines(before, (id) => id === A);
  assert.deepEqual(before, [{ id: A, delta: -2 }, { id: B, delta: 2 }], 'the Worker\'s lines are not changed in place');
});

test('F4: an entry naming only expired seats is carried by a zero line for someone seated, or blocks if there is nobody', () => {
  const entries = [entry(1, [1], [{ id: A, delta: 0 }])];
  const p = planTable(tableRow({ holders: [holder(A), holder(B)], entries }), chainOf({ seats: { [A]: lapsed(), [B]: seat() } }));
  assert.deepEqual(p.entries[0].lines, [{ id: B, debit: 0n, credit: 0n }]);
  assert.match(planTable(tableRow({ holders: [holder(A)], entries }), chainOf({ seats: { [A]: lapsed() } })).blocked, /only stands that have run out/);
  const notAStander = planTable(tableRow({ holders: [holder(A), holder(B, { left: true })], entries }), chainOf({ seats: { [A]: lapsed(), [B]: seat({ standing: true }) } }));
  assert.match(notAStander.blocked, /only stands that have run out/, 'a zero line would free a live stand ahead of its own round');
});

test('F4: later entries still number in order, and limits are checked on what is left', () => {
  const row = tableRow({ holders: [holder(A), holder(B), holder(C)], entries: [entry(1, [1], [{ id: A, delta: -1 }, { id: B, delta: 1 }]), entry(2, [2], [{ id: B, delta: -2 }, { id: C, delta: 2 }])] });
  const c = chainOf({ seats: { [A]: lapsed(), [B]: seat(), [C]: seat() } });
  const p = planTable(row, c);
  assert.deepEqual(p.entries.map((e) => e.roundNo), [1n, 2n]);
  assert.deepEqual(p.dropped.map((d) => d.seqs), [[1]]);
  assert.match(planTable(row, chainOf({ seats: { [A]: lapsed(), [B]: seat({ atRisk: M }), [C]: seat() } })).blocked, /over atRisk/);
});

test('F4 reaches someone who has left and whose seat has gone. Someone who has not left still blocks: that is a fault, not a stand', () => {
  const entries = [entry(1, [1], [{ id: A, delta: -1 }, { id: B, delta: 1 }])];
  const away = planTable(tableRow({ holders: [holder(A, { left: true }), holder(B)], entries }), chainOf({ seats: { [A]: seat({ table: 2n }), [B]: seat() } }));
  assert.equal(away.blocked, null, 'back at another table after their stand ran out');
  assert.deepEqual(away.dropped, [{ seqs: [1], id: A, delta: -1 }]);
  assert.deepEqual(away.entries[0].lines, [{ id: B, debit: 0n, credit: 0n }]);
  const freed = planTable(tableRow({ holders: [holder(A, { left: true }), holder(B)], entries }), chainOf({ seats: { [B]: seat() } }));
  assert.equal(freed.blocked, null, 'freed by the settle that ended a hold');
  assert.match(planTable(tableRow({ holders: [holder(A), holder(B)], entries }), chainOf({ seats: { [B]: seat() } })).blocked, /no seat/, 'has not left');
  assert.match(planTable(tableRow({ holders: [holder(B)], entries }), chainOf({ seats: { [B]: seat() } })).blocked, /no seat/, 'not a holder here at all');
});

// ---------- a round can't be run out of time ----------
const standingAt = (at) => seat({ standing: true, standAt: at });

test('a hold ends before the stand runs out, so a finished loss still lands: a standing loser can\'t stall it away', () => {
  const entries = [entry(1, [1], [{ id: A, delta: -5 }, { id: B, delta: 5 }])];
  const holders = [holder(A), holder(B)];
  const standAt = NOW - 1000n;
  const fresh = { heartbeat: NOW - 10n };
  const holding = planTable(tableRow({ holders, entries }), chainOf({ seats: { [A]: standingAt(standAt), [B]: seat() }, table: fresh }));
  assert.equal(holding.hold, true); assert.equal(holding.entries.length, 0);
  const edge = NOW - 1800n + HOLD_MARGIN_SECS + 1n;
  assert.equal(planTable(tableRow({ holders, entries }), chainOf({ seats: { [A]: standingAt(edge), [B]: seat() }, table: fresh })).hold, true, 'one second before the margin');
  const out = planTable(tableRow({ holders, entries }), chainOf({ seats: { [A]: standingAt(edge - 1n), [B]: seat() }, table: fresh }));
  assert.equal(out.hold, false);
  assert.deepEqual(out.dropped, [], 'nothing forgiven: the stand has not run out');
  assert.deepEqual(out.entries[0].lines, [{ id: A, debit: 5n * M, credit: 0n }, { id: B, debit: 0n, credit: 5n * M }]);
  assert.deepEqual(out.standing, [A], 'and the Worker is still told');
});

test('a table on hold is carried by a settle of nothing, naming someone not standing, before it would go quiet', () => {
  const entries = [entry(1, [1], [{ id: A, delta: -5 }, { id: B, delta: 5 }])];
  const holders = [holder(A), holder(B)];
  const seats = { [A]: standingAt(NOW - 60n), [B]: seat() };
  const near = planTable(tableRow({ holders, entries }), chainOf({ seats, table: { heartbeat: NOW - 1200n, lastRound: 3n } }), { knownRound: 3n });
  assert.equal(near.hold, true); assert.equal(near.dead, null);
  assert.deepEqual(near.keepAlive, { roundNo: 4n, seqs: [], rounds: [], lines: [{ id: B, debit: 0n, credit: 0n }] });
  assert.equal(planTable(tableRow({ holders, entries }), chainOf({ seats, table: { heartbeat: NOW - 1199n } })).keepAlive, null, 'not before it is needed');
});

test('a settle of nothing names only someone with a seat here, and a table whose settles of nothing keep failing stops holding, so what is finished can still land', () => {
  const entries = [entry(1, [1], [{ id: A, delta: -5 }, { id: B, delta: 5 }])];
  const seats = { [A]: standingAt(NOW - 60n), [B]: seat({ table: 2n }), [C]: seat() };
  const near = planTable(tableRow({ holders: [holder(A), holder(B), holder(C)], entries: [] }), chainOf({ seats, table: { heartbeat: NOW - 1200n, lastRound: 3n } }), { knownRound: 3n });
  assert.deepEqual(near.keepAlive.lines, [{ id: C, debit: 0n, credit: 0n }], 'not B, whose seat is at another table');
  const failing = planTable(tableRow({ holders: [holder(A), holder(B)], entries }), chainOf({ seats: { [A]: standingAt(NOW - 60n), [B]: seat() }, table: { heartbeat: NOW - 1620n } }));
  assert.equal(failing.hold, false);
  assert.deepEqual(failing.entries[0].lines, [{ id: A, debit: 5n * M, credit: 0n }, { id: B, debit: 0n, credit: 5n * M }]);
});

test('with nobody to carry it, a hold ends before the table goes quiet, and the standing seats settle', () => {
  const entries = [entry(1, [1], [{ id: A, delta: -5 }, { id: B, delta: 5 }])];
  const holders = [holder(A), holder(B)];
  const seats = { [A]: standingAt(NOW - 60n), [B]: standingAt(NOW - 60n) };
  const row = () => tableRow({ holders, entries });
  const ok = planTable(row(), chainOf({ seats, table: { heartbeat: NOW - 1000n } }));
  assert.equal(ok.hold, true); assert.equal(ok.keepAlive, null, 'a zero line would free a standing seat ahead of its round');
  const late = planTable(row(), chainOf({ seats, table: { heartbeat: NOW - 1620n } }));
  assert.equal(late.hold, false);
  assert.equal(late.entries.length, 1);
  assert.deepEqual(late.dropped, []);
});

test('a seat that still owes a line is never released, even if the Worker lists it: on a hold, or with the line planned', () => {
  const entries = [entry(1, [1], [{ id: A, delta: -5 }, { id: B, delta: 5 }])];
  const releases = [{ cageId: A, kind: 'player' }, { cageId: H, kind: 'player' }];
  const seats = { [A]: seat(), [B]: seat(), [C]: standingAt(NOW - 60n), [H]: seat() };
  const held = planTable(tableRow({ holders: [holder(A, { left: true }), holder(B), holder(C), holder(H, { left: true })], entries, releases }), chainOf({ seats }));
  assert.equal(held.hold, true); assert.equal(held.entries.length, 0);
  assert.deepEqual(held.releases.map((r) => r.cageId), [H], 'A owes a held line, and H owes nothing');
  const open = planTable(tableRow({ holders: [holder(A, { left: true }), holder(B), holder(H, { left: true })], entries, releases }), chainOf({ seats: { [A]: seat(), [B]: seat(), [H]: seat() } }));
  assert.equal(open.entries.length, 1); assert.deepEqual(open.releases.map((r) => r.cageId), [H]);
  const taken = planTable(tableRow({ holders: [holder(A, { left: true }), holder(B), holder(H, { left: true })], entries, releases }), chainOf({ seats: { [A]: seat(), [B]: seat(), [H]: seat() } }), { done: new Set(['T1:1']) });
  assert.deepEqual(taken.releases.map((r) => r.cageId), [A, H], 'a line already sent is the journal\'s to follow, and judge.mjs holds releases while it is out');
});

test('a round in play is kept alive whoever is seated, and a seated player with no round going still is not', () => {
  const holders = [holder(A), holder(B)];
  const seats = { [A]: seat(), [B]: seat() };
  const old = { heartbeat: NOW - 1200n, lastRound: 2n };
  const live = planTable(tableRow({ holders, live: true, phase: 'pass' }), chainOf({ seats, table: old }), { knownRound: 2n });
  assert.deepEqual(live.keepAlive, { roundNo: 3n, seqs: [], rounds: [], lines: [{ id: A, debit: 0n, credit: 0n }] });
  assert.equal(planTable(tableRow({ holders, live: false, phase: 'lobby' }), chainOf({ seats, table: old }), { knownRound: 2n }).keepAlive, null, 'their escape is theirs');
  assert.equal(planTable(tableRow({ holders, live: true }), chainOf({ seats, table: { heartbeat: NOW - 100n } })).keepAlive, null, 'plenty of time');
  const busy = planTable(tableRow({ holders, live: true, entries: [entry(1, [1], [{ id: A, delta: -1 }, { id: B, delta: 1 }])] }), chainOf({ seats, table: old }), { knownRound: 2n });
  assert.equal(busy.keepAlive, null, 'a real entry refreshes the clock anyway'); assert.equal(busy.entries.length, 1);
  const lapsed2 = planTable(tableRow({ holders: [holder(A, { left: true })], live: true }), chainOf({ seats: { [A]: lapsed() }, table: old }), { knownRound: 2n });
  assert.equal(lapsed2.keepAlive, null, 'nobody to name');
});
