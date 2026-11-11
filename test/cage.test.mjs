// sealed-cage simulator tests. No network, no proofs. Run: node --test cage.test.mjs  (MANAGED=managed/cageN to pick a build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createConstructorContext, createCircuitContext, sampleContractAddress } from 'cage-l8/runtime';
import { batchWidth } from './batch-width.mjs';
const M = process.env.MANAGED ?? '../contracts/managed/sealed-cage';
const { Contract, ledger, pureCircuits } = await import(`./${M}/contract/index.js`);
const WIDTH = batchWidth(new URL(`./${M}/contract/index.js`, import.meta.url));
// v4b: a move is seatByJudge with a from-table, a revoke is a deposit of 0 with the empty permit, and a single settle is a batch of one.
const NO_FROM = { is_some: false, value: 0n }, fromT = (t) => ({ is_some: true, value: BigInt(t) });
const REVOKE = [{ bytes: new Uint8Array(32) }, 0n, new Uint8Array(32), 0n, 0n];
const one = (e) => [{ is_some: true, value: e }, ...Array(WIDTH - 1).fill({ is_some: false, value: e })];

const witnesses = { secretKey: ({ privateState }) => [privateState, privateState.sk] };
const b32 = () => new Uint8Array(randomBytes(32));
const COIN = '00'.repeat(32);
const hex = (u) => Buffer.from(u).toString('hex');
const rep = (k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v);
const T0 = 1_900_000_000n, MAXGRANT = 2_592_000n;
const NIGHT = 1_000_000n;                     // 1 tNIGHT in STAR
const CAP = 756n * NIGHT;                      // roundCap: 756 chips at 1 chip = 1 tNIGHT (see report)
const ESCAPE = 1800n;                          // 30 min
const SLACK = 300n;
const SEATS = 6n;
const RAKE = 0n;
const DELAY = 3600n;                          // judge timelock: 2 x escape

function world({ rake = RAKE, seats = SEATS, delay = DELAY, slack = SLACK } = {}) {
  const contract = new Contract(witnesses);
  const judge = { sk: b32() }, house = { sk: b32(), addr: { bytes: b32() } }, nobody = { sk: b32() };
  const init = contract.initialState(createConstructorContext(nobody, COIN), pureCircuits.playerId(judge.sk), pureCircuits.playerId(house.sk), rake, CAP, ESCAPE, seats, slack, delay, MAXGRANT);
  let ctx = createCircuitContext(sampleContractAddress(), COIN, init.currentContractState.data, nobody, undefined, undefined, Number(T0));
  let now = T0;
  const w = {
    judge, house, nobody,
    get ctx() { return ctx; },
    as(who) { ctx = { ...ctx, currentPrivateState: who }; return w; },
    at(t) { now = BigInt(t); return w; },
    get now() { return now; },
    // run a circuit on an explicit context without adopting the result (for same-block comparisons)
    on(c, who, name, ...args) { const cc = { ...c, currentPrivateState: who }; cc.currentQueryContext.block = { ...cc.currentQueryContext.block, secondsSinceEpoch: now }; return contract.impureCircuits[name](cc, ...args); },
    call(name, ...args) { const r = w.on(ctx, ctx.currentPrivateState, name, ...args); ctx = r.context; return r; },
    state: () => ledger(ctx.currentQueryContext.state),
    bal: (p) => { const L = w.state(); const id = pureCircuits.playerId(p.sk); return L.balance.member(id) ? L.balance.lookup(id) : 0n; },
    seat: (p) => { const L = w.state(); const id = pureCircuits.playerId(p.sk); return L.seat.member(id) ? { ...L.seat.lookup(id), atRisk: L.risks.lookup(id) } : null; },
    table: (t) => { const L = w.state(); const k = BigInt(t); return L.tables.member(k) ? { ...L.tables.lookup(k), epoch: L.epochs.lookup(k), seated: L.seats.lookup(k).read() } : null; },
  };
  return w;
}
const player = () => ({ sk: b32(), addr: { bytes: b32() } });
const id = (p) => pureCircuits.playerId(p.sk);
const NO_JUDGE = new Uint8Array(32);
const deposit = (w, p, n) => w.as(p).call('deposit', p.addr, n, NO_JUDGE, 0n, 0n);
const sit = (w, p, t, atRisk) => w.as(p).call('sit', BigInt(t), atRisk, w.now);
const line = (p, { debit = 0n, credit = 0n } = {}) => ({ is_some: true, value: { id: id(p), debit, credit } });
const NONE_LINE = { is_some: false, value: { id: new Uint8Array(32), debit: 0n, credit: 0n } };
const entry = (t, roundNo, lines, houseCut = 0n) => ({ table: BigInt(t), roundNo: BigInt(roundNo), houseCut, lines: [...lines, ...Array(6 - lines.length).fill(NONE_LINE)] });
const settle = (w, e) => w.as(w.judge).call('settleBatch', one(e), w.now);
const transcript = (r) => JSON.stringify(r.proofData?.publicTranscript ?? null, rep);
const claimed = (r) => [...(r.context.currentQueryContext.effects.claimedUnshieldedSpends?.entries?.() ?? [])];
const inputs = (r) => [...(r.context.currentQueryContext.effects.unshieldedInputs?.entries?.() ?? [])];

function seatedTable(w, n = 3, atRisk = 50n * NIGHT, dep = 100n * NIGHT) {
  const ps = Array.from({ length: n }, player);
  for (const p of ps) { deposit(w, p, dep); sit(w, p, 1, atRisk); }
  return ps;
}

test('deposit: balance grows, NIGHT comes in, payout address is fixed at the first deposit', () => {
  const w = world(); const p = player();
  const r = deposit(w, p, 10n * NIGHT);
  assert.equal(w.bal(p), 10n * NIGHT);
  assert.deepEqual(inputs(r).map(([, v]) => v), [10n * NIGHT]);
  deposit(w, p, 5n * NIGHT); assert.equal(w.bal(p), 15n * NIGHT);
  assert.throws(() => w.as(p).call('deposit', { bytes: b32() }, NIGHT, NO_JUDGE, 0n, 0n), /payout address is fixed/);
  assert.throws(() => deposit(w, p, 0n), /no permit/, 'nothing in, with the empty permit, is a revoke: there is no permit here to end');
  assert.throws(() => w.as(p).call('deposit', p.addr, 0n, NO_JUDGE, NIGHT, T0), /amount must be positive/, 'a grant still has to bring money');
  assert.equal(w.bal(p), 15n * NIGHT);
});

test('sit: needs balance ≥ atRisk, one seat per player, six seats per table, a fresh table starts its clock', () => {
  const w = world(); const p = player(); deposit(w, p, 10n * NIGHT);
  assert.throws(() => sit(w, p, 1, 11n * NIGHT), /atRisk exceeds balance/);
  assert.throws(() => sit(w, p, 1, 0n), /atRisk must be positive/);
  sit(w, p, 1, 10n * NIGHT);
  assert.deepEqual(w.table(1), { epoch: 1n, lastRound: 0n, heartbeat: T0, seated: 1n });
  assert.throws(() => sit(w, p, 1, NIGHT), /already seated/);
  assert.throws(() => sit(w, p, 2, NIGHT), /already seated/);
  for (let i = 0; i < 5; i++) { const q = player(); deposit(w, q, NIGHT); sit(w, q, 1, NIGHT); }
  const extra = player(); deposit(w, extra, NIGHT);
  assert.throws(() => sit(w, extra, 1, NIGHT), /table is full/);
  assert.equal(w.table(1).seated, 6n);
});

test('declared time: not in the future, not older than clockSlack', () => {
  const w = world(); const p = player(); deposit(w, p, NIGHT);
  assert.throws(() => w.as(p).call('sit', 1n, NIGHT, T0 + 1n), /in the future/);
  assert.throws(() => w.as(p).call('sit', 1n, NIGHT, T0 - SLACK), /stale/);
  w.as(p).call('sit', 1n, NIGHT, T0 - SLACK + 1n);
});

test('a settle declares its time as a sit does: not in the future and not stale, so no judge can push a table\'s clock ahead of the block', () => {
  const w = world(); const [a, b] = seatedTable(w, 2);
  w.at(T0 + 600n);
  const e = entry(1, 1, [line(a, { debit: NIGHT }), line(b, { credit: NIGHT })]);
  assert.throws(() => w.as(w.judge).call('settleBatch', one(e), w.now + 1n), /in the future/);
  assert.throws(() => w.as(w.judge).call('settleBatch', one(e), w.now - SLACK), /stale/);
  assert.equal(w.table(1).lastRound, 0n, 'nothing applied');
  w.as(w.judge).call('settleBatch', one(e), w.now - SLACK + 1n);
  assert.equal(w.table(1).heartbeat, w.now - SLACK + 1n, 'the heartbeat is the declared time, never later than the block');
});

test('a line naming a seat left from an earlier epoch of the same table is refused: a void seat can\'t be debited', () => {
  const w = world(); const [a] = seatedTable(w, 2);
  w.at(T0 + ESCAPE); // table 1 goes quiet, so a's seat is void
  const c = player(), d = player(); deposit(w, c, 10n * NIGHT); sit(w, c, 1, 5n * NIGHT); deposit(w, d, 10n * NIGHT); sit(w, d, 1, 5n * NIGHT);
  assert.equal(w.table(1).epoch, 2n); assert.equal(w.seat(a).table, 1n); assert.equal(w.seat(a).epoch, 1n, 'the old seat is still there, at the same table');
  assert.throws(() => settle(w, entry(1, 1, [line(a, { debit: NIGHT }), line(c, { credit: NIGHT })])), /not sitting at this table/);
  assert.equal(w.bal(a), 100n * NIGHT, 'untouched');
  settle(w, entry(1, 1, [line(d, { debit: NIGHT }), line(c, { credit: NIGHT })]));
  assert.equal(w.bal(c), 11n * NIGHT);
});

test('withdraw: refused while seated, allowed after release, never more than the balance', () => {
  const w = world(); const [a, b] = seatedTable(w, 2);
  assert.throws(() => w.as(a).call('withdraw', NIGHT), /seated/);
  w.as(a).call('stand', 1n, w.now);
  assert.throws(() => w.as(a).call('withdraw', NIGHT), /seated/);          // intent is not release
  w.at(T0 + 60n); settle(w, entry(1, 1, [line(a, { debit: NIGHT }), line(b, { credit: NIGHT })]));
  assert.throws(() => w.as(a).call('withdraw', 100n * NIGHT), /insufficient balance/);
  assert.throws(() => w.as(a).call('withdraw', 0n), /amount must be positive/);
  w.as(a).call('withdraw', 99n * NIGHT); assert.equal(w.bal(a), 0n);
});

test('settle: sum rule, rake ceiling, one round at a time, only sitting players, debit limits', () => {
  const w = world(); const [a, b, c] = seatedTable(w);
  w.at(T0 + 60n);
  assert.throws(() => w.as(a).call('settleBatch', one(entry(1, 1, [line(a, { debit: NIGHT }), line(b, { credit: NIGHT })])), w.now), /judge only/);
  assert.throws(() => settle(w, entry(1, 2, [line(a, { debit: NIGHT }), line(b, { credit: NIGHT })])), /round number out of order/);
  assert.throws(() => settle(w, entry(1, 1, [line(a, { debit: 2n * NIGHT }), line(b, { credit: NIGHT })])), /debits must equal credits/);
  assert.throws(() => settle(w, entry(1, 1, [line(a, { debit: 2n * NIGHT }), line(b, { credit: NIGHT })], NIGHT)), /rake too large/);
  const stranger = player(); deposit(w, stranger, NIGHT);
  assert.throws(() => settle(w, entry(1, 1, [line(stranger, { debit: NIGHT }), line(b, { credit: NIGHT })])), /no seat/);
  const other = player(); deposit(w, other, NIGHT); sit(w, other, 2, NIGHT);
  assert.throws(() => settle(w, entry(1, 1, [line(other, { debit: NIGHT }), line(b, { credit: NIGHT })])), /not sitting at this table/);
  assert.throws(() => settle(w, entry(1, 1, [line(a, { debit: NIGHT, credit: NIGHT })])), /debit or a credit, not both/);
  assert.throws(() => settle(w, entry(1, 1, [line(a, { debit: CAP + 1n }), line(b, { credit: CAP + 1n })])), /over roundCap/);
  assert.throws(() => settle(w, entry(1, 1, [line(a, { debit: 51n * NIGHT }), line(b, { credit: 51n * NIGHT })])), /remaining atRisk/);
  // balance guard: lower atRisk cannot be below balance by construction, so test it through the mutation sweep (see report)
  settle(w, entry(1, 1, [line(a, { debit: 30n * NIGHT }), line(b, { credit: 20n * NIGHT }), line(c, { credit: 10n * NIGHT })]));
  assert.equal(w.bal(a), 70n * NIGHT); assert.equal(w.bal(b), 120n * NIGHT); assert.equal(w.bal(c), 110n * NIGHT);
  assert.equal(w.seat(a).atRisk, 20n * NIGHT, 'atRisk falls by the net loss');
  assert.equal(w.seat(b).atRisk, 50n * NIGHT, 'a win does not raise atRisk');
  assert.deepEqual(w.table(1), { epoch: 1n, lastRound: 1n, heartbeat: T0 + 60n, seated: 3n });
  assert.throws(() => settle(w, entry(1, 1, [])), /out of order/);
  settle(w, entry(1, 2, []));                                                  // an empty round is legal (carry = no-op)
  assert.equal(w.table(1).lastRound, 2n);
});

test('rake: houseCut ≤ maxRake is credited to the house balance, which withdraws like a player', () => {
  const w = world({ rake: NIGHT }); const [a, b] = seatedTable(w, 2);
  w.at(T0 + 60n);
  settle(w, entry(1, 1, [line(a, { debit: 10n * NIGHT }), line(b, { credit: 9n * NIGHT })], NIGHT));
  assert.equal(w.bal(w.house), NIGHT);
  assert.throws(() => w.as(w.house).call('withdraw', NIGHT), /no payout address/);   // the house binds its address by depositing once
  deposit(w, w.house, 1n); w.as(w.house).call('withdraw', NIGHT + 1n); assert.equal(w.bal(w.house), 0n);
  assert.throws(() => settle(w, entry(1, 2, [line(a, { debit: 2n * NIGHT })], 2n * NIGHT)), /rake too large/);
});

test('stand: debited in the round it stood from, released at that settle, then free to withdraw', () => {
  const w = world(); const [a, b] = seatedTable(w, 2);
  assert.throws(() => w.as(a).call('stand', 2n, w.now), /seated at another table/);
  w.as(a).call('stand', 1n, w.now);
  assert.equal(w.seat(a).standing, true);
  w.at(T0 + 60n);
  settle(w, entry(1, 1, [line(a, { debit: 5n * NIGHT }), line(b, { credit: 5n * NIGHT })]));
  assert.equal(w.seat(a), null, 'released'); assert.equal(w.table(1).seated, 1n);
  assert.equal(w.bal(a), 95n * NIGHT, 'the loss still landed');
  const r = w.as(a).call('withdraw', 95n * NIGHT);
  assert.equal(w.bal(a), 0n);
  assert.ok(claimed(r).some(([k, v]) => JSON.stringify(k, rep).includes(hex(a.addr.bytes)) && v === 95n * NIGHT), 'paid to the bound address');
  assert.throws(() => settle(w, entry(1, 2, [line(a, { debit: NIGHT }), line(b, { credit: NIGHT })])), /no seat/);
  assert.throws(() => w.as(a).call('stand', 1n, w.now), /not seated/);
});

test('release: judge frees a seat with no settle; a stranger cannot; wrong table or no seat is refused', () => {
  const w = world(); const [a] = seatedTable(w, 1);
  assert.throws(() => w.as(a).call('release', 1n, id(a)), /judge only/);
  assert.throws(() => w.as(w.judge).call('release', 2n, id(a)), /not at this table/);
  assert.throws(() => w.as(w.judge).call('release', 1n, id(player())), /no seat/);
  assert.equal(w.table(1).seated, 1n);
  w.as(w.judge).call('release', 1n, id(a));
  assert.equal(w.seat(a), null); assert.equal(w.table(1).seated, 0n);
  w.as(a).call('withdraw', 100n * NIGHT); assert.equal(w.bal(a), 0n);
});

test('escape: no settle for 30 min → the table is dead, players withdraw, the judge can no longer settle it', () => {
  const w = world(); const [a, b] = seatedTable(w, 2);
  w.at(T0 + ESCAPE - 1n);
  assert.throws(() => w.as(a).call('withdraw', NIGHT), /seated/);
  w.at(T0 + ESCAPE);
  w.as(a).call('withdraw', 100n * NIGHT); assert.equal(w.bal(a), 0n); assert.equal(w.seat(a), null);
  assert.throws(() => settle(w, entry(1, 1, [line(b, { debit: NIGHT })])), /dead or empty/);
  // the table comes back as a new epoch; b's old seat is void and clears on withdraw
  const c = player(); deposit(w, c, NIGHT); sit(w, c, 1, NIGHT);
  assert.deepEqual(w.table(1), { epoch: 2n, lastRound: 0n, heartbeat: T0 + ESCAPE, seated: 1n });
  w.as(b).call('withdraw', 100n * NIGHT); assert.equal(w.seat(b), null);
  // a settle keeps the clock alive: heartbeat moves to the declared time
  w.at(T0 + ESCAPE + 100n); settle(w, entry(1, 1, []));
  assert.equal(w.table(1).heartbeat, T0 + ESCAPE + 100n);
});

test('grind attack: a judge settling roundCap losses every round is bounded by atRisk, not by balance', () => {
  const w = world(); const victim = player(), shill = player();
  deposit(w, victim, 10_000n * NIGHT); sit(w, victim, 1, 100n * NIGHT);
  deposit(w, shill, NIGHT); sit(w, shill, 1, NIGHT);
  let round = 0n, took = 0n;
  for (let i = 0; i < 20; i++) {
    const left = w.seat(victim)?.atRisk ?? 0n;
    const d = left < CAP ? left : CAP;
    if (d === 0n) break;
    w.at(T0 + 60n * BigInt(i + 1));
    settle(w, entry(1, ++round, [line(victim, { debit: d }), line(shill, { credit: d })]));
    took += d;
  }
  assert.equal(took, 100n * NIGHT, 'total loss equals the declared atRisk');
  assert.equal(w.bal(victim), 9_900n * NIGHT);
  assert.throws(() => settle(w, entry(1, round + 1n, [line(victim, { debit: 1n }), line(shill, { credit: 1n })])), /remaining atRisk/);
});

test('same block: two deposits by different players are independent; a second deposit by the same player is a stale read', () => {
  const w = world(); const a = player(), b = player();
  const s0 = w.ctx;
  const bOld = w.on(s0, b, 'deposit', b.addr, NIGHT, NO_JUDGE, 0n, 0n);
  deposit(w, a, NIGHT);
  const bNew = w.on(w.ctx, b, 'deposit', b.addr, NIGHT, NO_JUDGE, 0n, 0n);
  assert.equal(transcript(bOld), transcript(bNew), 'b built before a landed still matches');
  const aOld = w.on(s0, a, 'deposit', a.addr, NIGHT, NO_JUDGE, 0n, 0n);
  const aAgain = w.on(w.ctx, a, 'deposit', a.addr, NIGHT, NO_JUDGE, 0n, 0n);
  assert.notEqual(transcript(aOld), transcript(aAgain), 'the same player twice: the second read of balance differs, so one of the two fails');
});

test('same block: two sits for the last seat; the second is refused on the new state', () => {
  const w = world({ seats: 2n }); const [a] = seatedTable(w, 1);
  const x = player(), y = player(); deposit(w, x, NIGHT); deposit(w, y, NIGHT);
  const s = w.ctx;
  w.on(s, x, 'sit', 1n, NIGHT, w.now); w.on(s, y, 'sit', 1n, NIGHT, w.now);   // both legal on the same snapshot
  sit(w, x, 1, NIGHT);
  assert.throws(() => w.on(w.ctx, y, 'sit', 1n, NIGHT, w.now), /table is full/);
  // two sits at a table with room: the transcripts differ (seated count), so the ledger serialises them; neither can be built blind
  const w2 = world(); const p = player(), q = player(); deposit(w2, p, NIGHT); deposit(w2, q, NIGHT);
  const qOld = w2.on(w2.ctx, q, 'sit', 1n, NIGHT, w2.now);
  sit(w2, p, 1, NIGHT);
  const qNew = w2.on(w2.ctx, q, 'sit', 1n, NIGHT, w2.now);
  assert.notEqual(transcript(qOld), transcript(qNew));
});

test('withdraw vs settle race: a withdraw cannot be built while seated, and one built after release is unaffected by other settles', () => {
  const w = world(); const [a, b, c] = seatedTable(w, 3);
  w.as(a).call('stand', 1n, w.now); w.at(T0 + 60n);
  settle(w, entry(1, 1, [line(a, { debit: 10n * NIGHT }), line(b, { credit: 10n * NIGHT })]));
  const built = w.on(w.ctx, a, 'withdraw', 90n * NIGHT);                     // a is released; builds the withdraw now
  w.at(T0 + 120n); settle(w, entry(1, 2, [line(b, { debit: NIGHT }), line(c, { credit: NIGHT })]));   // lands first
  const rebuilt = w.on(w.ctx, a, 'withdraw', 90n * NIGHT);
  assert.equal(transcript(built), transcript(rebuilt), 'the earlier-built withdraw still matches the state');
  // and a settle that names a after release fails, so nothing can debit a between build and landing
  assert.throws(() => settle(w, entry(1, 3, [line(a, { debit: NIGHT }), line(b, { credit: NIGHT })])), /no seat/);
});

test('batch: a full batch settles a table in every slot, in one call', () => {
  const w = world();
  const tables = Array.from({ length: WIDTH }, (_, i) => { const t = i + 1, p = player(), q = player(); deposit(w, p, 10n * NIGHT); sit(w, p, t, 10n * NIGHT); deposit(w, q, 10n * NIGHT); sit(w, q, t, 10n * NIGHT); return { t, p, q }; });
  w.at(T0 + 60n);
  w.as(w.judge).call('settleBatch', tables.map(({ t, p, q }) => ({ is_some: true, value: entry(t, 1, [line(p, { debit: BigInt(t) * NIGHT }), line(q, { credit: BigInt(t) * NIGHT })]) })), w.now);
  for (const { t, p, q } of tables) { assert.equal(w.table(t).lastRound, 1n); assert.equal(w.bal(p), (10n - BigInt(t)) * NIGHT); assert.equal(w.bal(q), (10n + BigInt(t)) * NIGHT); }
});

test('batch: two tables in one call; a bad entry fails the whole call; empty slots are skipped', () => {
  const w = world();
  const [a, b] = seatedTable(w, 2); const c = player(), d = player();
  deposit(w, c, 10n * NIGHT); sit(w, c, 2, 10n * NIGHT); deposit(w, d, 10n * NIGHT); sit(w, d, 2, 10n * NIGHT);
  w.at(T0 + 60n);
  const e1 = entry(1, 1, [line(a, { debit: NIGHT }), line(b, { credit: NIGHT })]);
  const e2 = entry(2, 1, [line(c, { debit: 2n * NIGHT }), line(d, { credit: 2n * NIGHT })]);
  const NONE = { is_some: false, value: e1 };
  const B = WIDTH;
  const pad = (xs) => [...xs, ...Array(B - xs.length).fill(NONE)];
  assert.throws(() => w.as(a).call('settleBatch', pad([{ is_some: true, value: e1 }]), w.now), /judge only/);
  assert.throws(() => w.as(w.judge).call('settleBatch', pad([{ is_some: true, value: e1 }, { is_some: true, value: { ...e2, roundNo: 2n } }].slice(0, B)), w.now), /out of order/);
  assert.equal(w.table(1).lastRound, 0n, 'nothing applied');
  w.as(w.judge).call('settleBatch', pad([{ is_some: true, value: e1 }, { is_some: true, value: e2 }].slice(0, B)), w.now);
  assert.equal(w.table(1).lastRound, 1n); assert.equal(w.bal(b), 101n * NIGHT);
  if (B >= 2) { assert.equal(w.table(2).lastRound, 1n); assert.equal(w.bal(d), 12n * NIGHT); }
});

test('invariant: balance ≥ remaining atRisk for every seated player, through wins and losses', () => {
  const w = world(); const ps = seatedTable(w, 4, 20n * NIGHT, 20n * NIGHT);
  let round = 0n;
  const rng = (n) => BigInt(Math.floor(Math.random() * Number(n)));
  for (let i = 0; i < 30; i++) {
    w.at(T0 + 60n * BigInt(i + 1));
    const loser = ps[Number(rng(4n))], winner = ps[(ps.indexOf(loser) + 1) % 4];
    const left = w.seat(loser).atRisk; const d = left === 0n ? 0n : 1n + rng(left);
    settle(w, entry(1, ++round, d ? [line(loser, { debit: d }), line(winner, { credit: d })] : []));
    for (const p of ps) assert.ok(w.bal(p) >= w.seat(p).atRisk, 'balance covers atRisk');
  }
  assert.equal(ps.reduce((s, p) => s + w.bal(p), 0n), 80n * NIGHT, 'the cage conserves NIGHT');
});

test('rescue: anyone sends the whole balance to the bound address; refused while seated, with no address, or when empty', () => {
  const w = world(); const [a, b] = seatedTable(w, 2); const stranger = player();
  assert.throws(() => w.as(stranger).call('rescue', id(a)), /seated/);
  assert.throws(() => w.as(stranger).call('rescue', id(stranger)), /no payout address/);
  w.as(w.judge).call('release', 1n, id(a));
  const r = w.as(stranger).call('rescue', id(a));
  assert.equal(w.bal(a), 0n);
  assert.ok(claimed(r).some(([k, v]) => JSON.stringify(k, rep).includes(hex(a.addr.bytes)) && v === 100n * NIGHT), 'all 100 tNIGHT to a\'s own address');
  assert.throws(() => w.as(stranger).call('rescue', id(a)), /nothing to rescue/);
  // a void seat (dead table) is cleared by rescue too
  w.at(T0 + ESCAPE); w.as(stranger).call('rescue', id(b)); assert.equal(w.seat(b), null); assert.equal(w.bal(b), 0n);
});

test('constructor: the judge timelock must cover the escape window and the clock slack, and the slack must sit under the escape window', () => {
  assert.throws(() => world({ delay: ESCAPE + SLACK - 1n }), /judgeDelay must cover/);
  world({ delay: ESCAPE + SLACK });
  assert.throws(() => world({ slack: ESCAPE, delay: 2n * ESCAPE }), /clockSlack must be above 0/);
  assert.throws(() => world({ slack: 0n }), /clockSlack must be above 0/);
  world({ slack: ESCAPE - 1n, delay: 2n * ESCAPE });
});

test('judge rotation: propose (judge only, not self), cancel by the old key, accept by the new key only after the timelock', () => {
  const w = world(); const next = { sk: b32() }, other = { sk: b32() };
  assert.throws(() => w.as(other).call('proposeJudge', id(next), w.now), /judge only/);
  assert.throws(() => w.as(w.judge).call('proposeJudge', id(w.judge), w.now), /already the judge/);
  assert.throws(() => w.as(w.judge).call('cancelJudge'), /no pending judge/);
  assert.throws(() => w.as(next).call('acceptJudge'), /no pending judge/);
  w.as(w.judge).call('proposeJudge', id(next), w.now);
  assert.equal(w.state().hasPending, true);
  assert.throws(() => w.as(other).call('cancelJudge'), /judge only/);
  assert.throws(() => w.as(next).call('acceptJudge'), /timelock/);
  assert.throws(() => w.as(other).call('acceptJudge'), /only the proposed judge/);
  w.at(T0 + DELAY - 1n); assert.throws(() => w.as(next).call('acceptJudge'), /timelock/);
  w.as(w.judge).call('cancelJudge'); assert.equal(w.state().hasPending, false);
  w.at(T0 + DELAY); assert.throws(() => w.as(next).call('acceptJudge'), /no pending judge/);
  // propose again, let it pass, accept: the old key loses its powers, the new one settles
  w.as(w.judge).call('proposeJudge', id(next), w.now);
  w.at(T0 + 2n * DELAY); w.as(next).call('acceptJudge');
  assert.equal(hex(w.state().judge), hex(id(next)));
  const [a, b] = seatedTable(w, 2);
  assert.throws(() => w.as(w.judge).call('settleBatch', one(entry(1, 1, [])), w.now), /judge only/);
  w.as(next).call('settleBatch', one(entry(1, 1, [line(a, { debit: NIGHT }), line(b, { credit: NIGHT })])), w.now);
  assert.equal(w.bal(b), 101n * NIGHT);
  assert.throws(() => w.as(next).call('acceptJudge'), /no pending judge/);
});

test('batch: two rounds of one table in one settleBatch apply in order', () => {
  const w = world();
  const a = player(w), b = player(w);
  deposit(w, a, 10n * NIGHT);
  deposit(w, b, 10n * NIGHT);
  w.as(a).call('sit', 1n, 5n * NIGHT, w.now);
  w.as(b).call('sit', 1n, 5n * NIGHT, w.now);
  const id = (p) => pureCircuits.playerId(p.sk);
  const none = { is_some: false, value: { id: new Uint8Array(32), debit: 0n, credit: 0n } };
  const line = (p, debit, credit) => ({ is_some: true, value: { id: id(p), debit, credit } });
  const entry = (roundNo, lines) => ({ is_some: true, value: { table: 1n, roundNo, houseCut: 0n, lines: [...lines, ...Array(6 - lines.length).fill(none)] } });
  const blank = { is_some: false, value: { table: 0n, roundNo: 0n, houseCut: 0n, lines: Array(6).fill(none) } };
  w.as(w.judge).call('settleBatch', [entry(1n, [line(a, 2n * NIGHT, 0n), line(b, 0n, 2n * NIGHT)]), entry(2n, [line(a, 1n * NIGHT, 0n), line(b, 0n, 1n * NIGHT)]), ...Array(WIDTH - 2).fill(blank)], w.now);
  assert.equal(w.bal(a), 7n * NIGHT);
  assert.equal(w.bal(b), 13n * NIGHT);
  assert.equal(w.seat(a).atRisk, 2n * NIGHT);
  assert.equal(w.state().tables.lookup(1n).lastRound, 2n);
  // The same rounds again are refused: round 1 is no longer next.
  assert.throws(() => w.as(w.judge).call('settleBatch', [entry(1n, [line(a, 1n, 0n), line(b, 0n, 1n)]), ...Array(WIDTH - 1).fill(blank)], w.now), /round number out of order/);
});

// ---------- v4: seated players can't deposit, and a stand runs out ----------
const stood = (w, p, t = 1) => w.as(p).call('stand', BigInt(t), w.now);

test('deposit: refused while the seat binds, allowed before sitting, after release, and once the seat is void or expired', () => {
  const w = world(); const [a, b] = seatedTable(w, 2);
  assert.throws(() => deposit(w, a, 1n), /seated: deposit after you stand/);
  stood(w, a);
  assert.throws(() => deposit(w, a, 1n), /seated: deposit after you stand/, 'standing is not free yet');
  w.as(w.judge).call('release', 1n, id(b));
  deposit(w, b, 1n); assert.equal(w.bal(b), 100n * NIGHT + 1n);
  w.at(T0 + ESCAPE - 1n); assert.throws(() => deposit(w, a, 1n), /seated/);
  w.at(T0 + ESCAPE); deposit(w, a, 1n); assert.equal(w.bal(a), 100n * NIGHT + 1n);
});

test('stand: only once, the deadline is the declared time, and a back-dated stand shortens it by at most the slack', () => {
  const w = world(); const [a, b] = seatedTable(w, 2);
  assert.throws(() => w.as(a).call('stand', 1n, T0 + 1n), /in the future/);
  assert.throws(() => w.as(a).call('stand', 1n, T0 - SLACK), /stale/);
  w.at(T0 + 100n); stood(w, a);
  assert.equal(w.seat(a).standAt, T0 + 100n);
  assert.throws(() => stood(w, a), /already standing/);
  const back = T0 + 100n - SLACK + 1n;
  w.as(b).call('stand', 1n, back);
  assert.equal(w.seat(b).standAt, back);
  w.at(back + ESCAPE - 1n); assert.throws(() => w.as(b).call('withdraw', NIGHT), /seated/);
  w.at(back + ESCAPE); w.as(b).call('withdraw', NIGHT);
});

test('the stand edge: at standAt + E - 1 the judge can settle and the player cannot leave; at standAt + E it is the other way round', () => {
  const edge = () => { const w = world(); const [a, b, c] = seatedTable(w, 3); w.at(T0 + 100n); stood(w, a); w.at(T0 + 1000n); settle(w, entry(1, 1, [line(b), line(c)])); return { w, a, b, c, D: T0 + 100n + ESCAPE }; };
  { const { w, a, b, D } = edge(); w.at(D - 1n);
    assert.throws(() => w.as(a).call('withdraw', NIGHT), /seated/);
    assert.throws(() => w.as(b).call('rescue', id(a)), /seated/);
    settle(w, entry(1, 2, [line(a, { debit: NIGHT }), line(b, { credit: NIGHT })]));
    assert.equal(w.seat(a), null, 'settled in time: freed'); assert.equal(w.bal(a), 99n * NIGHT); assert.equal(w.table(1).seated, 2n); }
  { const { w, a, b, D } = edge(); w.at(D);
    assert.throws(() => settle(w, entry(1, 2, [line(a, { debit: NIGHT }), line(b, { credit: NIGHT })])), /stand has run out/);
    assert.throws(() => w.as(w.judge).call('settleBatch', [{ is_some: true, value: entry(1, 2, [line(a)]) }, ...Array(WIDTH - 1).fill({ is_some: false, value: entry(0, 0, []) })], w.now), /stand has run out/);
    w.as(a).call('withdraw', 100n * NIGHT); assert.equal(w.bal(a), 0n); }
  { const { w, a, b, c, D } = edge(); w.at(D); // the others carry on
    w.as(a).call('withdraw', NIGHT);
    settle(w, entry(1, 2, [line(b, { debit: NIGHT }), line(c, { credit: NIGHT })]));
    assert.equal(w.table(1).lastRound, 2n); }
});

test('an expired stand stays on the count until its owner sits again or the judge releases it, and it never counts twice', () => {
  const setup = () => { const w = world(); const [a, b] = seatedTable(w, 2); stood(w, a); w.at(T0 + 1000n); settle(w, entry(1, 1, [line(b)])); w.at(T0 + ESCAPE); return { w, a, b }; };
  { const { w, a } = setup(); // leaving writes nothing to the table
    w.as(a).call('withdraw', 40n * NIGHT);
    assert.equal(w.table(1).seated, 2n); assert.equal(w.seat(a).standing, true); assert.equal(w.bal(a), 60n * NIGHT);
    w.as(a).call('withdraw', 60n * NIGHT); assert.equal(w.bal(a), 0n, 'and leaving twice is fine'); }
  { const { w, a } = setup(); // back at the same table
    sit(w, a, 1, NIGHT);
    assert.equal(w.table(1).seated, 2n, 'the old seat came off as the new one went on');
    assert.equal(w.seat(a).standing, false); assert.equal(w.seat(a).atRisk, NIGHT); }
  { const { w, a } = setup(); // at another table
    sit(w, a, 2, NIGHT);
    assert.equal(w.table(1).seated, 1n); assert.equal(w.table(2).seated, 1n); assert.equal(w.seat(a).table, 2n); }
  { const { w, a, b } = setup(); // the judge reaps it
    w.as(w.judge).call('release', 1n, id(a));
    assert.equal(w.table(1).seated, 1n); assert.equal(w.seat(a), null);
    settle(w, entry(1, 2, [line(b)])); }
  { const { w, a, b } = setup(); // a stranger rescues: the money goes home and the seat stays until reaped
    const stranger = player();
    const r = w.as(stranger).call('rescue', id(a));
    assert.equal(w.bal(a), 0n); assert.ok(claimed(r).some(([k, v]) => JSON.stringify(k, rep).includes(hex(a.addr.bytes)) && v === 100n * NIGHT));
    assert.equal(w.table(1).seated, 2n);
    assert.equal(w.seat(a).standing, true, 'the seat is still there for the judge to reap: gone, nothing could ever take it off the count');
    settle(w, entry(1, 2, [line(b)]));
    w.as(w.judge).call('release', 1n, id(a)); assert.equal(w.table(1).seated, 1n); }
  { const w = world({ seats: 2n }); const [a, b] = seatedTable(w, 2); stood(w, a); w.at(T0 + 1000n); settle(w, entry(1, 1, [line(b)])); w.at(T0 + ESCAPE);
    const c = player(); deposit(w, c, NIGHT);
    assert.throws(() => sit(w, c, 1, NIGHT), /table is full/, 'the expired seat still holds its place');
    sit(w, a, 2, NIGHT); sit(w, c, 1, NIGHT); assert.equal(w.table(1).seated, 2n); }
});

test('the last seat out: an expired stand re-seating on a table it alone held starts a new epoch', () => {
  const w = world(); const [a] = seatedTable(w, 1); stood(w, a); w.at(T0 + ESCAPE);
  sit(w, a, 1, NIGHT); // the table has gone quiet at the same moment, so this is the dead-table branch either way
  assert.deepEqual(w.table(1), { epoch: 2n, lastRound: 0n, heartbeat: T0 + ESCAPE, seated: 1n });
  const b = player(), c = player(); deposit(w, b, NIGHT); sit(w, b, 3, NIGHT); deposit(w, c, NIGHT); sit(w, c, 3, NIGHT);
  stood(w, b, 3); w.at(T0 + ESCAPE + 60n); settle(w, entry(3, 1, [line(c)])); w.at(T0 + 2n * ESCAPE);
  w.as(w.judge).call('release', 3n, id(c));
  assert.equal(w.table(3).seated, 1n);
  sit(w, b, 3, NIGHT); // the only seat at a live table was b's own expired one: down to zero, so a new epoch and a new clock
  assert.deepEqual(w.table(3), { epoch: 2n, lastRound: 1n, heartbeat: T0 + 2n * ESCAPE, seated: 1n });
});

test('a stand on a void seat changes nothing that matters: withdraw and sit still work, and no count moves', () => {
  const w = world(); const [a, b] = seatedTable(w, 2);
  w.at(T0 + ESCAPE); // the table is dead
  stood(w, a); assert.equal(w.seat(a).standing, true);
  w.as(a).call('withdraw', NIGHT);
  const c = player(); deposit(w, c, NIGHT); sit(w, c, 1, NIGHT); // a new epoch
  assert.equal(w.table(1).seated, 1n);
  sit(w, a, 1, NIGHT); assert.equal(w.table(1).seated, 2n, 'a stale epoch takes nothing off the new one');
  stood(w, b); w.as(b).call('withdraw', NIGHT); sit(w, b, 1, NIGHT); assert.equal(w.table(1).seated, 3n);
});

test('judge rotation still works with the new seats: a stand made under the old judge is settled by the new one, or runs out all the same', () => {
  const w = world({ delay: ESCAPE + SLACK }); const [a, b, c] = seatedTable(w, 3); const next = { sk: b32() };
  w.as(w.judge).call('proposeJudge', id(next), w.now);
  stood(w, a);
  w.at(T0 + 1700n); settle(w, entry(1, 1, [line(b), line(c)]));
  stood(w, b);
  w.at(T0 + ESCAPE + SLACK); w.as(next).call('acceptJudge');
  assert.equal(hex(w.state().judge), hex(id(next)));
  assert.throws(() => w.as(a).call('settleBatch', one(entry(1, 2, [line(b)])), w.now), /judge only/);
  w.as(a).call('withdraw', 100n * NIGHT); assert.equal(w.bal(a), 0n, "a's stand ran out long before the new key could act");
  w.as(next).call('settleBatch', one(entry(1, 2, [line(b, { debit: NIGHT }), line(c, { credit: NIGHT })])), w.now);
  assert.equal(w.seat(b), null); assert.equal(w.bal(c), 101n * NIGHT);
});

test('the count: two sits with room both go on it, and the last seat goes to one of two racing for it', () => {
  const w = world({ seats: 3n }); seatedTable(w, 1);
  const x = player(), y = player(), z = player(); for (const p of [x, y, z]) deposit(w, p, NIGHT);
  sit(w, x, 1, NIGHT); sit(w, y, 1, NIGHT);
  assert.equal(w.table(1).seated, 3n);
  assert.throws(() => sit(w, z, 1, NIGHT), /table is full/);
});

test('a debit touches what the seat can still lose and not the seat: a win or a zero line writes neither', () => {
  const w = world(); const [a, b] = seatedTable(w, 2);
  const before = JSON.stringify(w.state().seat.lookup(id(a)), rep);
  settle(w, entry(1, 1, [line(a, { debit: NIGHT }), line(b, { credit: NIGHT })]));
  assert.equal(JSON.stringify(w.state().seat.lookup(id(a)), rep), before);
  assert.equal(w.seat(a).atRisk, 49n * NIGHT); assert.equal(w.seat(b).atRisk, 50n * NIGHT);
  stood(w, a); w.as(w.judge).call('release', 1n, id(a));
  sit(w, a, 1, 3n * NIGHT); assert.equal(w.seat(a).atRisk, 3n * NIGHT, 'a new sit starts from what it declares, not from what was left');
});

test('release of a seat from an old epoch takes nothing off the new epoch', () => {
  const w = world(); const [a] = seatedTable(w, 1);
  w.at(T0 + ESCAPE);
  const b = player(); deposit(w, b, NIGHT); sit(w, b, 1, NIGHT);
  assert.equal(w.table(1).seated, 1n);
  w.as(w.judge).call('release', 1n, id(a));
  assert.equal(w.seat(a), null); assert.equal(w.table(1).seated, 1n);
  w.at(w.now + 60n); settle(w, entry(1, 1, [line(b)]));
});
