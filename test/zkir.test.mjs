// The check a proof server runs before proving, on the path each circuit takes. It catches a branch the simulator accepts and the
// prover would not, which the simulator tests can't see. It is not a full proof, so it doesn't replace an end-to-end run.
// The idea comes from Lunardraw's settlement-zk.test.ts (MIT, Copyright (c) 2026 Jack Baker).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createConstructorContext, createCircuitContext, sampleContractAddress, proofDataIntoSerializedPreimage } from 'cage-l8/runtime';
import * as zkir from '@midnight-ntwrk/zkir-v2';
import { batchWidth } from './batch-width.mjs';
import { ENTRIES_PER_BATCH } from '../scripts/judge-plan.mjs';
const dir = new URL(`${process.env.MANAGED ?? '../contracts/managed/sealed-cage'}/`, import.meta.url).pathname;
const { Contract, pureCircuits } = await import(`${dir}contract/index.js`);
const WIDTH = batchWidth(`${dir}contract/index.js`);
// v4b: a move is seatByJudge with a from-table, a revoke is a deposit of 0 with the empty permit, and a single settle is a batch of one.
const NO_FROM = { is_some: false, value: 0n }, fromT = (t) => ({ is_some: true, value: BigInt(t) });
const REVOKE = [{ bytes: new Uint8Array(32) }, 0n, new Uint8Array(32), 0n, 0n];
const one = (e) => [{ is_some: true, value: e }, ...Array(WIDTH - 1).fill({ is_some: false, value: e })];

const witnesses = { secretKey: ({ privateState }) => [privateState, privateState.sk] };
const b32 = () => new Uint8Array(randomBytes(32));
const COIN = '00'.repeat(32), T0 = 1_900_000_000n, NIGHT = 1_000_000n, E = 1800n, DELAY = 2100n, MAXGRANT = 2_592_000n;
const player = () => ({ sk: b32(), addr: { bytes: b32() } });
const id = (p) => pureCircuits.playerId(p.sk);
const NONE = { is_some: false, value: { id: new Uint8Array(32), debit: 0n, credit: 0n } };
const line = (p, debit = 0n, credit = 0n) => ({ is_some: true, value: { id: id(p), debit, credit } });
const entry = (t, n, ls, cut = 0n) => ({ table: BigInt(t), roundNo: BigInt(n), houseCut: cut, lines: [...ls, ...Array(6 - ls.length).fill(NONE)] });
const blank = { is_some: false, value: entry(0, 0, []) };
const batch = (...es) => [...es.map((e) => ({ is_some: true, value: e })), ...Array(WIDTH - es.length).fill(blank)];

const runs = [];
function world(rake = 0n) {
  const contract = new Contract(witnesses);
  const judge = { sk: b32() }, house = { sk: b32(), addr: { bytes: b32() } };
  const init = contract.initialState(createConstructorContext({ sk: b32() }, COIN), id(judge), id(house), rake, 1000n * NIGHT, E, 6n, 300n, DELAY, MAXGRANT);
  let ctx = createCircuitContext(sampleContractAddress(), COIN, init.currentContractState.data, judge, undefined, undefined, Number(T0));
  let now = T0, label = null;
  const w = {
    judge, house,
    as(s) { label = s; return w; }, at(t) { now = t; return w; }, get now() { return now; },
    call(who, name, ...args) { const cc = { ...ctx, currentPrivateState: who }; cc.currentQueryContext.block = { ...cc.currentQueryContext.block, secondsSinceEpoch: now }; const r = contract.impureCircuits[name](cc, ...args); ctx = r.context; if (label) runs.push({ label, circuit: name, p: r.proofData }); label = null; return r; },
  };
  return w;
}
const NO_JUDGE = new Uint8Array(32);
const dep = (w, p, n = 100n * NIGHT) => w.call(p, 'deposit', p.addr, n, NO_JUDGE, 0n, 0n);
const grant = (w, p, cap = 50n * NIGHT, n = 100n * NIGHT, until = T0 + 43200n) => w.call(p, 'deposit', p.addr, n, id(w.judge), cap, until);
const sit = (w, p, t, r = 50n * NIGHT) => w.call(p, 'sit', BigInt(t), r, w.now);
const stand = (w, p, t = 1) => w.call(p, 'stand', BigInt(t), w.now);

{ // the plain paths
  const w = world(); const [a, b, c, d] = Array.from({ length: 4 }, player);
  w.as('deposit: first'); dep(w, a); w.as('deposit: again, no seat'); dep(w, a, NIGHT); dep(w, b); dep(w, c); dep(w, d);
  w.as('sit: new table'); sit(w, a, 1); w.as('sit: live table'); sit(w, b, 1);
  w.as('settleBatch, one entry: debit and credit'); w.call(w.judge, 'settleBatch', one(entry(1, 1, [line(a, NIGHT), line(b, 0n, NIGHT)])), w.now);
  w.as('settleBatch, one entry: lines of zero'); w.call(w.judge, 'settleBatch', one(entry(1, 2, [line(a), line(b)])), w.now);
  w.as('settleBatch: one entry'); w.call(w.judge, 'settleBatch', batch(entry(1, 3, [line(a, NIGHT), line(b, 0n, NIGHT)])), w.now);
  sit(w, c, 2); sit(w, d, 2);
  w.as('settleBatch: two tables'); w.call(w.judge, 'settleBatch', batch(entry(1, 4, [line(a, NIGHT), line(b, 0n, NIGHT)]), entry(2, 1, [line(c), line(d)])), w.now);
  w.as('stand: bound seat'); stand(w, a);
  w.as('settleBatch: standing seat freed'); w.call(w.judge, 'settleBatch', batch(entry(1, 5, [line(a), line(b)])), w.now);
  w.as('withdraw: no seat'); w.call(a, 'withdraw', NIGHT);
  w.as('rescue: no seat'); w.call(c, 'rescue', id(a));
  w.as('release: current epoch'); w.call(w.judge, 'release', 2n, id(c));
  w.at(T0 + E + 1n);
  w.as('stand: void seat, dead table'); stand(w, d, 2);
  w.as('withdraw: void seat, dead table, not standing'); w.call(b, 'withdraw', NIGHT);
  w.as('rescue: void seat, dead table, standing'); w.call(c, 'rescue', id(d));
  w.as('deposit: void seat, dead table'); dep(w, d, NIGHT);
  w.as('sit: own void seat, dead table, new epoch'); sit(w, d, 2, NIGHT);
  dep(w, b, NIGHT); w.as('sit: no seat, dead table, new epoch'); sit(w, b, 1, NIGHT);
  const e = player(), f = player(); dep(w, e, NIGHT); sit(w, e, 3, NIGHT);
  w.at(T0 + 2n * E + 2n); dep(w, f, NIGHT); sit(w, f, 3, NIGHT);
  w.as('release: stale epoch'); w.call(w.judge, 'release', 3n, id(e));
  const n = player();
  w.as('proposeJudge'); w.call(w.judge, 'proposeJudge', id(n), w.now);
  w.as('cancelJudge'); w.call(w.judge, 'cancelJudge');
  w.call(w.judge, 'proposeJudge', id(n), w.now); w.at(w.now + DELAY);
  w.as('acceptJudge'); w.call(n, 'acceptJudge');
}
{ // the new paths: an expired stand at a table the judge keeps alive
  const w = world(); const [a, b, c, g, h] = Array.from({ length: 5 }, player);
  for (const p of [a, b, c, g, h]) { dep(w, p); sit(w, p, 1); }
  for (const p of [a, g, h]) stand(w, p);
  w.at(T0 + 1000n); w.call(w.judge, 'settleBatch', one(entry(1, 1, [line(b), line(c)])), w.now);
  w.at(T0 + 1700n); w.as('settleBatch, one entry: a standing seat named, in time'); w.call(w.judge, 'settleBatch', one(entry(1, 2, [line(h, NIGHT), line(b, 0n, NIGHT)])), w.now);
  w.at(T0 + E);
  w.as('withdraw: expired stand'); w.call(a, 'withdraw', NIGHT);
  w.as('rescue: expired stand'); w.call(b, 'rescue', id(g));
  w.as('deposit: expired stand'); dep(w, a, NIGHT);
  w.as('sit: own expired stand, same live table'); sit(w, a, 1, NIGHT);
  stand(w, a);
  w.as('settleBatch: others, with an expired stand on the table'); w.call(w.judge, 'settleBatch', batch(entry(1, 3, [line(b), line(c)])), w.now);
  w.at(T0 + 3000n); w.call(w.judge, 'settleBatch', one(entry(1, 4, [line(c)])), w.now);
  w.at(T0 + 2n * E);
  w.as('sit: own expired stand, another table'); sit(w, a, 2, NIGHT);
  w.as('release: expired stand'); w.call(w.judge, 'release', 1n, id(g));
}
{ // the rake paths: maxRake is 0 on every cage so far, so these have never run on chain
  const w = world(NIGHT); const a = player(), b = player(); dep(w, a); dep(w, b); sit(w, a, 1); sit(w, b, 1);
  w.as('settleBatch, one entry: rake'); w.call(w.judge, 'settleBatch', one(entry(1, 1, [line(a, 2n * NIGHT), line(b, 0n, NIGHT)], NIGHT)), w.now);
  w.as('settleBatch: rake'); w.call(w.judge, 'settleBatch', batch(entry(1, 2, [line(a, 2n * NIGHT), line(b, 0n, NIGHT)], NIGHT)), w.now);
  w.call(w.house, 'deposit', w.house.addr, NIGHT, NO_JUDGE, 0n, 0n); w.as('withdraw: the house takes its rake'); w.call(w.house, 'withdraw', 3n * NIGHT);
}
{ // the widest settles
  const w = world(); const ps = Array.from({ length: 6 }, player); for (const p of ps) { dep(w, p); sit(w, p, 1); }
  w.as('settleBatch: 6 lines'); w.call(w.judge, 'settleBatch', batch(entry(1, 1, ps.map((p, i) => (i === 0 ? line(p, 5n * NIGHT) : line(p, 0n, NIGHT))))), w.now);
  const es = []; for (let i = 2; i <= 1 + WIDTH; i++) es.push(entry(1, i, ps.map((p, j) => (j === 1 ? line(p, 5n * NIGHT) : j === 0 ? line(p, 0n, 5n * NIGHT) : line(p)))));
  w.as('settleBatch: every slot full, 6 lines each'); w.call(w.judge, 'settleBatch', es.map((e) => ({ is_some: true, value: e })), w.now);
}

{ // the edges of the count: a settle taking a table to 0, a release at 1, and an untaken decrement with the count at 0
  const w = world(); const a = player(), b = player(), c = player(); for (const p of [a, b, c]) dep(w, p);
  sit(w, a, 1); sit(w, b, 1); stand(w, a); stand(w, b);
  w.as('settleBatch, one entry: frees the last two seats'); w.call(w.judge, 'settleBatch', one(entry(1, 1, [line(a), line(b)])), w.now);
  w.as('sit: table at 0, new epoch'); sit(w, c, 1);
  w.as('release: the last seat'); w.call(w.judge, 'release', 1n, id(c));
  w.as('sit: own freed seat gone, table at 0'); sit(w, c, 1);
  w.as('release: the last seat again'); w.call(w.judge, 'release', 1n, id(c));
  dep(w, a, NIGHT); w.at(T0 + 10n); sit(w, a, 2, NIGHT); w.at(T0 + E + 20n);
  w.as('release: dead table, same epoch'); w.call(w.judge, 'release', 2n, id(a));
}
{ // a stolen judge's own moves, and a table full to the last seat
  const w = world(); const ps = Array.from({ length: 6 }, player); for (const p of ps) { dep(w, p); }
  for (const p of ps.slice(0, 5)) sit(w, p, 1);
  w.as('sit: the last seat at a live table'); sit(w, ps[5], 1);
  w.as('settleBatch, one entry: debit 1 STAR'); w.call(w.judge, 'settleBatch', one(entry(1, 1, [line(ps[0], 1n), line(ps[1], 0n, 1n)])), w.now);
  w.as('settleBatch: seat debited to 0'); w.call(w.judge, 'settleBatch', batch(entry(1, 2, [line(ps[0], 50n * NIGHT - 1n), line(ps[1], 0n, 50n * NIGHT - 1n)])), w.now);
  w.at(T0 + E); w.as('rescue: void seat, not standing, dead table'); w.call(ps[2], 'rescue', id(ps[3]));
}

{ // seat authority: the permit on a deposit, the floor, a stand ending it, the judge's two moves on each branch, and revoke
  const w = world(); const [a, b, c, d, e, f, h] = Array.from({ length: 7 }, player);
  w.as('deposit: first, with a permit, floor above 0'); grant(w, a);
  w.as('deposit: again, replacing the permit'); grant(w, a, 40n * NIGHT, NIGHT);
  w.as('deposit: again, an empty permit raises the floor'); dep(w, a, NIGHT);
  w.as('deposit: cap over the balance, floor 0'); grant(w, h, 200n * NIGHT, NIGHT);
  w.as('deposit: cap the same as the balance, floor 0'); grant(w, h, NIGHT + NIGHT, NIGHT);
  grant(w, b); grant(w, c); grant(w, d); grant(w, e); grant(w, f);
  w.as('seatByJudge: new table'); w.call(w.judge, 'seatByJudge', id(a), NO_FROM, 1n, 10n * NIGHT, w.now);
  w.as('seatByJudge: live table, right down to the floor'); w.call(w.judge, 'seatByJudge', id(b), NO_FROM, 1n, 50n * NIGHT, w.now);
  w.as('seatByJudge, a move: live table to a new table'); w.call(w.judge, 'seatByJudge', id(a), fromT(1n), 2n, 40n * NIGHT, w.now);
  w.call(w.judge, 'seatByJudge', id(c), NO_FROM, 2n, NIGHT, w.now);
  w.as('seatByJudge, a move: live table to a live table'); w.call(w.judge, 'seatByJudge', id(a), fromT(2n), 1n, NIGHT, w.now);
  w.as('seatByJudge, a move: the last seat leaves'); w.call(w.judge, 'seatByJudge', id(c), fromT(2n), 1n, NIGHT, w.now);
  w.as('settleBatch, one entry: a seat the judge moved'); w.call(w.judge, 'settleBatch', one(entry(1, 1, [line(a, NIGHT), line(b, 0n, NIGHT)])), w.now);
  w.as('stand: a seat the judge made, the permit ends'); stand(w, c);
  w.as('settleBatch: frees a stand on a judge seat'); w.call(w.judge, 'settleBatch', batch(entry(1, 2, [line(c)])), w.now);
  w.as('deposit: a new grant after a stand'); grant(w, c, 10n * NIGHT, NIGHT);
  w.as('seatByJudge: after a settle freed the seat'); w.call(w.judge, 'seatByJudge', id(c), NO_FROM, 3n, NIGHT, w.now);
  w.as('deposit, a revoke: seated'); w.call(c, 'deposit', ...REVOKE);
  w.call(w.judge, 'seatByJudge', id(e), NO_FROM, 8n, NIGHT, w.now); w.call(w.judge, 'seatByJudge', id(f), NO_FROM, 8n, NIGHT, w.now);
  w.at(T0 + E); // table 8 is dead
  w.as('stand: void seat, no permit left after'); stand(w, c, 3);
  w.as('seatByJudge: own void seat, dead table, new epoch'); w.call(w.judge, 'seatByJudge', id(e), NO_FROM, 8n, NIGHT, w.now);
  w.as('seatByJudge, a move: from a stale epoch, to a new table'); w.call(w.judge, 'seatByJudge', id(f), fromT(8n), 9n, NIGHT, w.now);
  w.as('seatByJudge, a move: the last seat of a new epoch leaves'); w.call(w.judge, 'seatByJudge', id(e), fromT(8n), 10n, NIGHT, w.now);
  w.at(T0 + E + 2000n); // tables 9 and 10 are dead
  w.as('seatByJudge, a move: from a dead table, same epoch'); w.call(w.judge, 'seatByJudge', id(e), fromT(10n), 11n, NIGHT, w.now);
  w.as('seatByJudge: own void seat, live table'); w.call(w.judge, 'seatByJudge', id(f), NO_FROM, 11n, NIGHT, w.now);
  w.as('deposit, a revoke: no seat'); w.call(d, 'deposit', ...REVOKE);
  w.as('deposit: an empty permit, no permit here'); dep(w, d, NIGHT);
}

{ // L1: each way through the bound on a grant, and the deposits it must leave alone
  const w = world(); const [a, b, c, d] = Array.from({ length: 4 }, player); const MAX64 = 2n ** 64n - 1n;
  w.as('deposit: a permit on the bound, now + maxGrant'); grant(w, a, 50n * NIGHT, 100n * NIGHT, w.now + MAXGRANT);
  w.as('deposit: a permit with until under maxGrant (no clock read)'); grant(w, b, 50n * NIGHT, 100n * NIGHT, 1000n);
  w.as('deposit: the empty permit, any until'); w.call(c, 'deposit', c.addr, NIGHT, NO_JUDGE, 0n, MAX64);
  grant(w, d); w.as('deposit, a revoke: any until'); w.call(d, 'deposit', { bytes: new Uint8Array(32) }, 0n, new Uint8Array(32), 0n, MAX64);
}

{ // a full batch: as many tables as it holds, in one call
  const w = world(); const ps = Array.from({ length: 2 * WIDTH }, player);
  for (const [i, p] of ps.entries()) { dep(w, p); sit(w, p, 1 + (i >> 1)); }
  w.as('settleBatch: a full batch, a table in every slot'); w.call(w.judge, 'settleBatch', Array.from({ length: WIDTH }, (_, k) => ({ is_some: true, value: entry(k + 1, 1, [line(ps[2 * k], NIGHT), line(ps[2 * k + 1], 0n, NIGHT)]) })), w.now);
}

const cache = new Map();
const provider = {
  async lookupKey(c) { if (!cache.has(c)) cache.set(c, zkir.jsonIrToBinary(readFileSync(`${dir}zkir/${c}.zkir`, 'utf8'))); return { ir: cache.get(c), proverKey: new Uint8Array(), verifierKey: new Uint8Array() }; },
  async getParams() { throw new Error('checking needs no parameters'); },
};

// Time to dismiss, measured on preprod on 2026-11-05 (rehearsal step 12): an 8-entry settleBatch, 14,687 declared public inputs, took 25.187 ms, and preprod
// allows max(15 ms, 2 µs a byte). Proof verification costs 4.555 µs a declared input over a parallelism of 4, so the rest is 25.187 - 14.687 x 1.13875 = 8.462 ms.
// What a call carries doesn't change its count: every slot is declared, used or not. The smallest settle measured was 12,291 bytes, so allowed 24.58 ms.
const DISMISS_FIXED_MS = 8.462, DISMISS_PER_INPUT_MS = 4.555 / 4 / 1000;
const declared = (c) => JSON.parse(readFileSync(`${dir}zkir/${c}.zkir`, 'utf8')).instructions.filter((i) => i.op === 'declare_pub_input').length;
test('time to dismiss: settleBatch stays under 20 ms, so a settle of one lands on preprod, and every other circuit under the 15 ms floor', () => {
  for (const c of readdirSync(`${dir}zkir`).filter((f) => f.endsWith('.zkir')).map((f) => f.replace('.zkir', ''))) {
    const ms = DISMISS_FIXED_MS + DISMISS_PER_INPUT_MS * declared(c);
    assert.ok(ms <= (c === 'settleBatch' ? 20 : 15), `${c}: ${declared(c)} declared public inputs, about ${ms.toFixed(1)} ms to dismiss`);
  }
});
test('the batch is as wide as the judge fills it', () => {
  assert.equal(WIDTH, ENTRIES_PER_BATCH);
});

test('the circuit count stays at 11', () => {
  assert.equal(readdirSync(`${dir}zkir`).filter((f) => f.endsWith('.zkir')).length, 11);
});
for (const r of runs) {
  test(`zkir check, ${r.label}`, { timeout: 60_000 }, async () => {
    const pre = proofDataIntoSerializedPreimage(r.p.input, r.p.output, r.p.publicTranscript, r.p.privateTranscriptOutputs, r.circuit);
    await zkir.check(pre, provider);
  });
}
// L1 is split between the proof and the chain. The proof says the clock answered "not before until - maxGrant", and the chain checks that answer
// against the block's own clock when it lands (the simulator's land, in permit.test.mjs). Here: a proof can't claim the other answer and pass.
test('L1 is in the proof: with the clock query\'s answer flipped, the check refuses the grant', { timeout: 60_000 }, async () => {
  const r = runs.find((x) => x.label === 'deposit: a permit on the bound, now + maxGrant');
  const t = structuredClone(r.p.publicTranscript);
  const at = t.findIndex((op) => op === 'lt');
  assert.ok(at > 0 && t[at + 1]?.popeq, 'the grant asks the block clock once');
  assert.equal(t[at + 1].popeq.result.value[0].length, 0, 'and the answer it carries is false: block time is not before until - maxGrant');
  t[at + 1].popeq.result.value = [new Uint8Array([1])];
  const pre = proofDataIntoSerializedPreimage(r.p.input, r.p.output, t, r.p.privateTranscriptOutputs, r.circuit);
  await assert.rejects(() => zkir.check(pre, provider));
});
// What only the proof can hold: the chain answers whatever query the transcript asks, so the proof must tie the question to the grant.
test('L1 is in the proof: the clock is asked about until - maxGrant, not a time of the prover\'s choosing, and the question can\'t be left out', { timeout: 60_000 }, async () => {
  const r = runs.find((x) => x.label === 'deposit: a permit on the bound, now + maxGrant');
  const at = r.p.publicTranscript.findIndex((op) => op === 'lt');
  assert.ok(r.p.publicTranscript[at - 1]?.push && r.p.publicTranscript[at - 3]?.dup, 'the query: the block time, then the operand, then lt');
  const check = (t) => zkir.check(proofDataIntoSerializedPreimage(r.p.input, r.p.output, t, r.p.privateTranscriptOutputs, r.circuit), provider);
  const zero = structuredClone(r.p.publicTranscript);
  zero[at - 1].push.value.content.value = [new Uint8Array(0)]; // "is block time before 0?": false at any time, so the chain would pass it
  await assert.rejects(() => check(zero), 'the operand set to 0');
  const dropped = structuredClone(r.p.publicTranscript);
  dropped.splice(at - 3, 5); // the whole query: dup, idx, push, lt, popeq
  await assert.rejects(() => check(dropped), 'the query left out');
  await check(r.p.publicTranscript); // and the honest one passes
});
test('every circuit was checked', () => {
  const names = readdirSync(`${dir}zkir`).filter((f) => f.endsWith('.zkir')).map((f) => f.replace('.zkir', ''));
  for (const n of names) assert.ok(runs.some((r) => r.circuit === n), `no run of ${n}`);
});
