// Seat authority: a deposit carries a permit, the judge seats and moves under it, and the player can end it. No network, no proofs.
// A "landing" here is what the chain does: it runs a transcript built earlier against the state of the moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createConstructorContext, createCircuitContext, sampleContractAddress, QueryContext, CostModel } from 'cage-l8/runtime';
import { planTable, HOLD_MARGIN_SECS } from '../scripts/judge-plan.mjs';
import { batchWidth } from './batch-width.mjs';
const { Contract, ledger, pureCircuits } = await import(new URL(`${process.env.MANAGED ?? '../contracts/managed/sealed-cage'}/contract/index.js`, import.meta.url).href);
const WIDTH = batchWidth(new URL(`${process.env.MANAGED ?? '../contracts/managed/sealed-cage'}/contract/index.js`, import.meta.url));
// v4b: a move is seatByJudge with a from-table, a revoke is a deposit of 0 with the empty permit, and a single settle is a batch of one.
const NO_FROM = { is_some: false, value: 0n }, fromT = (t) => ({ is_some: true, value: BigInt(t) });
const REVOKE = [{ bytes: new Uint8Array(32) }, 0n, new Uint8Array(32), 0n, 0n];
const one = (e) => [{ is_some: true, value: e }, ...Array(WIDTH - 1).fill({ is_some: false, value: e })];

const witnesses = { secretKey: ({ privateState }) => [privateState, privateState.sk] };
const b32 = () => new Uint8Array(randomBytes(32));
const COIN = '00'.repeat(32);
const T0 = 1_900_000_000n, NIGHT = 1_000_000n, CAP = 1000n * NIGHT, ESCAPE = 1800n, SLACK = 300n, SEATS = 6n, DELAY = 2700n, HOURS12 = 43_200n, MAXGRANT = 2_592_000n;
const player = () => ({ sk: b32(), addr: { bytes: b32() } });
const id = (p) => pureCircuits.playerId(p.sk);
const hex = (u) => Buffer.from(u).toString('hex');
const NONE_LINE = { is_some: false, value: { id: new Uint8Array(32), debit: 0n, credit: 0n } };
const line = (p, debit = 0n, credit = 0n) => ({ is_some: true, value: { id: id(p), debit, credit } });
const entry = (t, roundNo, lines) => ({ table: BigInt(t), roundNo: BigInt(roundNo), houseCut: 0n, lines: [...lines, ...Array(6 - lines.length).fill(NONE_LINE)] });
const NO_JUDGE = new Uint8Array(32);

function world({ seats = SEATS, maxGrant = MAXGRANT } = {}) {
  const contract = new Contract(witnesses);
  const judge = { sk: b32() }, addr = sampleContractAddress();
  const init = contract.initialState(createConstructorContext({ sk: b32() }, COIN), id(judge), id(judge), 0n, CAP, ESCAPE, seats, SLACK, DELAY, maxGrant);
  let ctx = createCircuitContext(addr, COIN, init.currentContractState.data, judge, undefined, undefined, Number(T0));
  let now = T0;
  const w = {
    judge,
    at(t) { now = BigInt(t); return w; }, get now() { return now; },
    build(who, name, ...args) { const cc = { ...ctx, currentPrivateState: who }; cc.currentQueryContext.block = { ...cc.currentQueryContext.block, secondsSinceEpoch: now }; return contract.impureCircuits[name](cc, ...args); },
    call(who, name, ...args) { const r = w.build(who, name, ...args); ctx = r.context; return r; },
    /** Lands something built earlier: true if it applied. */
    land(r) {
      const qc = new QueryContext(ctx.currentQueryContext.state, addr);
      qc.block = { ...ctx.currentQueryContext.block, secondsSinceEpoch: now };
      const gas = { readTime: 10n ** 12n, computeTime: 10n ** 12n, bytesWritten: 10n ** 9n, bytesDeleted: 10n ** 9n };
      let after;
      try { after = qc.runTranscript({ gas, effects: r.context.currentQueryContext.effects, program: r.proofData.publicTranscript }, CostModel.initialCostModel()); } catch { return false; }
      ctx = { ...ctx, currentQueryContext: after };
      return true;
    },
    state: () => ledger(ctx.currentQueryContext.state),
    bal: (p) => { const L = w.state(); return L.balance.member(id(p)) ? L.balance.lookup(id(p)) : 0n; },
    seat: (p) => { const L = w.state(); return L.seat.member(id(p)) ? { ...L.seat.lookup(id(p)), atRisk: L.risks.lookup(id(p)) } : null; },
    permit: (p) => { const L = w.state(); return L.permits.member(id(p)) ? L.permits.lookup(id(p)) : null; },
    count: (t) => { const L = w.state(); const k = BigInt(t); return L.seats.member(k) ? L.seats.lookup(k).read() : 0n; },
    epoch: (t) => { const L = w.state(); const k = BigInt(t); return L.epochs.member(k) ? L.epochs.lookup(k) : 0n; },
  };
  return w;
}
const fund = (w, p, n = 100n * NIGHT) => w.call(p, 'deposit', p.addr, n, NO_JUDGE, 0n, 0n);
const grant = (w, p, { n = 100n * NIGHT, cap = 50n * NIGHT, until = T0 + HOURS12, judge = id(w.judge) } = {}) => w.call(p, 'deposit', p.addr, n, judge, cap, until);
const seatBy = (w, p, t, r = 10n * NIGHT, by = w.judge) => w.call(by, 'seatByJudge', id(p), NO_FROM, BigInt(t), r, w.now);
const moveBy = (w, p, f, t, r = 10n * NIGHT, by = w.judge) => w.call(by, 'seatByJudge', id(p), fromT(BigInt(f)), BigInt(t), r, w.now);
const sit = (w, p, t, r = 10n * NIGHT) => w.call(p, 'sit', BigInt(t), r, w.now);
const player2 = (w) => { const q = player(); fund(w, q); return q; };
const stand = (w, p, t) => w.call(p, 'stand', BigInt(t), w.now);
const settle = (w, t, n, lines) => w.call(w.judge, 'settleBatch', one(entry(t, n, lines)), w.now);
/** A table kept alive by others while the test does something else. */
function two(w, t = 9) { const a = player(), b = player(); fund(w, a); fund(w, b); sit(w, a, t); sit(w, b, t); return [a, b]; }

// ---------- the permit on a deposit ----------
test('deposit: a cap records the permit; an empty permit records nothing and leaves one that is there; a later cap replaces it', () => {
  const w = world(); const p = player();
  fund(w, p); assert.equal(w.permit(p), null, 'cap 0 is the empty permit');
  assert.equal(w.bal(p), 100n * NIGHT);
  grant(w, p, { n: NIGHT, cap: 5n * NIGHT, until: T0 + 100n });
  assert.deepEqual({ ...w.permit(p), judge: hex(w.permit(p).judge) }, { judge: hex(id(w.judge)), cap: 5n * NIGHT, until: T0 + 100n, floor: 96n * NIGHT });
  fund(w, p, NIGHT);
  assert.equal(w.permit(p).cap, 5n * NIGHT, 'an empty permit on a later deposit changes nothing');
  grant(w, p, { n: NIGHT, cap: 7n * NIGHT, until: T0 + 200n });
  assert.equal(w.permit(p).cap, 7n * NIGHT); assert.equal(w.permit(p).until, T0 + 200n);
  grant(w, p, { n: NIGHT, cap: NIGHT, until: T0 + 50n });
  assert.equal(w.permit(p).cap, NIGHT, 'a later cap can lower it too');
  assert.equal(w.bal(p), 104n * NIGHT, 'the money goes in every time');
  assert.throws(() => w.call(p, 'deposit', p.addr, 0n, id(w.judge), NIGHT, T0), /amount must be positive/);
});

// ---------- the floor ----------
test('floor: the balance at the grant less the cap, counting the deposit that carries it, and 0 when the cap is the balance or more', () => {
  const w = world(); const p = player(), q = player(), r = player();
  grant(w, p, { n: 100n * NIGHT, cap: 30n * NIGHT }); assert.equal(w.permit(p).floor, 70n * NIGHT);
  grant(w, q, { n: 30n * NIGHT, cap: 30n * NIGHT }); assert.equal(w.permit(q).floor, 0n, 'the cap is the balance');
  grant(w, r, { n: 10n * NIGHT, cap: 30n * NIGHT }); assert.equal(w.permit(r).floor, 0n, 'the cap is over the balance');
  grant(w, p, { n: 50n * NIGHT, cap: 20n * NIGHT }); assert.equal(w.permit(p).floor, 130n * NIGHT, 'a new grant starts from the new balance');
});

test('floor: a top-up with an empty permit raises it by as much, so it adds nothing the judge can place. With no permit it writes none', () => {
  const w = world(); const p = player(); grant(w, p, { n: 100n * NIGHT, cap: 30n * NIGHT });
  fund(w, p, 50n * NIGHT);
  assert.equal(w.permit(p).floor, 120n * NIGHT); assert.equal(w.permit(p).cap, 30n * NIGHT);
  assert.throws(() => seatBy(w, p, 1, 30n * NIGHT + 1n), /over the permit's cap/);
  seatBy(w, p, 1, 30n * NIGHT);
  const q = player(); fund(w, q); fund(w, q); assert.equal(w.permit(q), null);
});

test('a top-up changes only the floor: it can\'t point a permit at a new judge, or hand an old permit to one after a rotation', () => {
  const w = world(); const p = player(); const other = b32(); const next = { sk: b32() };
  grant(w, p, { judge: other });
  fund(w, p, NIGHT);
  assert.equal(hex(w.permit(p).judge), hex(other), 'still the key it named');
  assert.throws(() => seatBy(w, p, 1), /names another judge/);
  const q = player(); grant(w, q);
  w.call(w.judge, 'proposeJudge', id(next), w.now); w.at(T0 + DELAY); w.call(next, 'acceptJudge');
  fund(w, q, NIGHT);
  assert.equal(hex(w.permit(q).judge), hex(id(w.judge)), 'it still names the old key');
  assert.throws(() => w.call(next, 'seatByJudge', id(q), NO_FROM, 1n, NIGHT, w.now), /names another judge/);
});

test('floor: the judge can place down to it and not one STAR below, at a seat and at a move', () => {
  const w = world(); const [k] = two(w, 1); const p = player(); grant(w, p, { n: 100n * NIGHT, cap: 30n * NIGHT });
  assert.throws(() => seatBy(w, p, 1, 30n * NIGHT + 1n), /over the permit's cap/, 'the cap still limits a seat');
  seatBy(w, p, 1, 30n * NIGHT);
  settle(w, 1, 1, [line(p, 10n * NIGHT), line(k, 0n, 10n * NIGHT)]); assert.equal(w.bal(p), 90n * NIGHT);
  assert.throws(() => moveBy(w, p, 1, 2, 20n * NIGHT + 1n), /below the permit's floor/);
  moveBy(w, p, 1, 2, 20n * NIGHT); assert.equal(w.seat(p).atRisk, 20n * NIGHT);
  w.call(w.judge, 'release', 2n, id(p));
  assert.throws(() => seatBy(w, p, 3, 20n * NIGHT + 1n), /below the permit's floor/, 'a release gives nothing back');
  seatBy(w, p, 3, 20n * NIGHT);
});

test('floor: the drain is closed. A stolen key with mules takes the cap and no more, by moves or by release and seat', () => {
  for (const hop of ['move', 'release']) {
    const w = world(); const victim = player(), mule = player(), mule2 = player();
    grant(w, victim, { n: 1000n * NIGHT, cap: 100n * NIGHT }); fund(w, mule, NIGHT); fund(w, mule2, NIGHT);
    sit(w, mule, 1, NIGHT); sit(w, mule2, 2, NIGHT);
    seatBy(w, victim, 1, 100n * NIGHT);
    settle(w, 1, 1, [line(victim, 100n * NIGHT), line(mule, 0n, 100n * NIGHT)]);
    assert.equal(w.bal(victim), 900n * NIGHT);
    if (hop === 'release') w.call(w.judge, 'release', 1n, id(victim));
    for (const r of [1n, 2n, 50n * NIGHT, 100n * NIGHT]) assert.throws(() => (hop === 'move' ? moveBy(w, victim, 1, 2, r) : seatBy(w, victim, 2, r)), /below the permit's floor/);
    assert.equal(w.bal(victim), 900n * NIGHT, 'the rest is out of reach');
  }
});

test('floor: hops with no loss are free, a partial loss lowers what can be placed, and a win can be placed too, since it is above the floor', () => {
  const w = world(); const [k1] = two(w, 1); const [k2] = two(w, 2); const p = player(); grant(w, p, { n: 100n * NIGHT, cap: 30n * NIGHT });
  seatBy(w, p, 1, 30n * NIGHT);
  for (const [f, t] of [[1, 2], [2, 1], [1, 2], [2, 1]]) moveBy(w, p, f, t, 30n * NIGHT);
  assert.equal(w.bal(p), 100n * NIGHT, 'no loss, no cost');
  settle(w, 1, 1, [line(p, 12n * NIGHT), line(k1, 0n, 12n * NIGHT)]);
  moveBy(w, p, 1, 2, 18n * NIGHT);
  settle(w, 2, 1, [line(p, 0n, 7n * NIGHT), line(k2, 7n * NIGHT)]);
  assert.equal(w.bal(p), 95n * NIGHT);
  moveBy(w, p, 2, 1, 25n * NIGHT);
  assert.throws(() => moveBy(w, p, 1, 2, 25n * NIGHT + 1n), /below the permit's floor/);
});

test('floor: a new approval with a new cap opens it again, and only the player can do that', () => {
  const w = world(); const [k] = two(w, 1); const p = player(); grant(w, p, { n: 100n * NIGHT, cap: 30n * NIGHT });
  seatBy(w, p, 1, 30n * NIGHT); settle(w, 1, 1, [line(p, 30n * NIGHT), line(k, 0n, 30n * NIGHT)]);
  w.call(w.judge, 'release', 1n, id(p));
  assert.throws(() => seatBy(w, p, 1, 1n), /below the permit's floor/);
  grant(w, p, { n: NIGHT, cap: 10n * NIGHT });
  assert.equal(w.permit(p).floor, 61n * NIGHT);
  seatBy(w, p, 1, 10n * NIGHT);
});

test('floor: a withdraw leaves it where it is, so the judge can place less until a new grant. It never lets the judge reach further', () => {
  const w = world(); const p = player(); grant(w, p, { n: 100n * NIGHT, cap: 30n * NIGHT });
  w.call(p, 'withdraw', 20n * NIGHT);
  assert.equal(w.permit(p).floor, 70n * NIGHT);
  assert.throws(() => seatBy(w, p, 1, 10n * NIGHT + 1n), /below the permit's floor/);
  seatBy(w, p, 1, 10n * NIGHT);
  const q = player(); grant(w, q, { n: 100n * NIGHT, cap: 30n * NIGHT }); w.call(q, 'withdraw', 50n * NIGHT);
  assert.throws(() => seatBy(w, q, 1, 1n), /below the permit's floor/, 'under the floor: nothing at all');
});

test('floor: it binds the judge, not the player. Their own sit can go below it, and a move of that seat is held to the floor again', () => {
  const w = world(); const p = player(); grant(w, p, { n: 100n * NIGHT, cap: 30n * NIGHT });
  sit(w, p, 1, 90n * NIGHT); assert.equal(w.seat(p).atRisk, 90n * NIGHT);
  assert.throws(() => moveBy(w, p, 1, 2, 30n * NIGHT + 1n), /over the permit's cap/);
  moveBy(w, p, 1, 2, 30n * NIGHT); assert.equal(w.seat(p).atRisk, 30n * NIGHT);
});

test('floor: a settle can\'t be made to break it: nothing a judge seat can lose gets past it', () => {
  const w = world(); const [k] = two(w, 1); const p = player(); grant(w, p, { n: 100n * NIGHT, cap: 30n * NIGHT });
  seatBy(w, p, 1, 30n * NIGHT);
  assert.throws(() => settle(w, 1, 1, [line(p, 30n * NIGHT + 1n), line(k, 0n, 30n * NIGHT + 1n)]), /remaining atRisk/);
  settle(w, 1, 1, [line(p, 30n * NIGHT), line(k, 0n, 30n * NIGHT)]);
  assert.equal(w.bal(p), w.permit(p).floor);
  assert.throws(() => settle(w, 1, 2, [line(p, 1n), line(k, 0n, 1n)]), /remaining atRisk/);
});

// ---------- a stand ends the permit ----------
test('stand ends the permit, on a bound seat and on a void one. With no permit it works as it always has', () => {
  const w = world(); const p = player(), q = player(), r = player(); grant(w, p); grant(w, q); fund(w, r); seatBy(w, p, 1); seatBy(w, q, 2); sit(w, r, 3);
  stand(w, p, 1); assert.equal(w.permit(p), null); assert.equal(w.seat(p).standing, true);
  stand(w, r, 3); assert.equal(w.seat(r).standing, true);
  w.at(T0 + ESCAPE); stand(w, q, 2); assert.equal(w.permit(q), null, 'its table is dead, and it still ends the permit');
});

test('stand ends the permit: the judge can\'t seat them again after a release or a settle freed the seat', () => {
  const setup = () => { const w = world(); const [k1] = two(w); const p = player(); grant(w, p); seatBy(w, p, 9); stand(w, p, 9); return { w, k1, p }; };
  { const { w, p } = setup();
    w.call(w.judge, 'release', 9n, id(p));
    assert.throws(() => seatBy(w, p, 1), /no permit/);
    w.call(p, 'withdraw', 100n * NIGHT); assert.equal(w.bal(p), 0n); }
  { const { w, k1, p } = setup();
    settle(w, 9, 1, [line(p), line(k1)]); assert.equal(w.seat(p), null);
    assert.throws(() => seatBy(w, p, 1), /no permit/);
    w.call(p, 'withdraw', 100n * NIGHT); assert.equal(w.bal(p), 0n); }
  { const { w, p } = setup();
    assert.throws(() => moveBy(w, p, 9, 1), /no permit/); }
});

test('stand ends the permit: a seat or move built before the stand doesn\'t land after it, and the stand still lands across a settle naming others', () => {
  const w = world(); const [k1, k2] = two(w); const p = player(), q = player(); grant(w, p); grant(w, q); seatBy(w, p, 9);
  const move = w.build(w.judge, 'seatByJudge', id(p), fromT(9n), 1n, NIGHT, w.now);
  const reseat = w.build(w.judge, 'seatByJudge', id(q), NO_FROM, 2n, NIGHT, w.now);
  stand(w, p, 9); assert.equal(w.land(move), false);
  seatBy(w, q, 9); stand(w, q, 9); assert.equal(w.land(reseat), false);
  const p2 = player(); grant(w, p2); seatBy(w, p2, 9);
  const built = w.build(p2, 'stand', 9n, w.now);
  settle(w, 9, 1, [line(k1), line(k2)]);
  assert.ok(w.land(built), 'it reads the permit, and a settle doesn\'t write that');
  assert.equal(w.permit(p2), null);
});

test('stand ends the permit: a revoke in flight then fails, and that means done. A deposit in flight fails too, by the seat rule', () => {
  const w = world(); const p = player(); grant(w, p); seatBy(w, p, 1);
  const rev = w.build(p, 'deposit', ...REVOKE);
  stand(w, p, 1);
  assert.equal(w.land(rev), false);
  assert.throws(() => w.call(p, 'deposit', ...REVOKE), /no permit/);
});

test('after a stand has run out a player can grant again. The judge still can\'t seat over or move the old seat until it is released, and then can', () => {
  const w = world(); const [k1, k2] = two(w); const p = player(); grant(w, p); seatBy(w, p, 9); stand(w, p, 9);
  w.at(T0 + 1000n); settle(w, 9, 1, [line(k1), line(k2)]);
  w.at(T0 + ESCAPE);
  grant(w, p, { n: NIGHT });
  assert.equal(w.seat(p).standing, true);
  const count = w.count(9);
  assert.throws(() => seatBy(w, p, 1), /standing: this seat is leaving/, 'overwriting it would leave a ghost on the count');
  assert.throws(() => moveBy(w, p, 9, 1), /standing: this seat is leaving/);
  assert.equal(w.count(9), count);
  w.call(w.judge, 'release', 9n, id(p)); assert.equal(w.count(9), count - 1n);
  seatBy(w, p, 1); assert.equal(w.seat(p).standing, false);
});

test('deposit: the rules from before still hold with a permit on it: the payout address is fixed, and a bound seat can\'t deposit', () => {
  const w = world(); const p = player(); grant(w, p);
  assert.throws(() => w.call(p, 'deposit', { bytes: b32() }, NIGHT, id(w.judge), NIGHT, T0), /payout address is fixed/);
  seatBy(w, p, 1);
  assert.throws(() => grant(w, p, { n: NIGHT }), /seated: deposit after you stand/);
});

// ---------- seatByJudge ----------
test('seatByJudge: writes the seat a sit would, for the same table and atRisk', () => {
  const w = world(); const a = player(), b = player(); grant(w, a); fund(w, b);
  seatBy(w, a, 1, 10n * NIGHT); sit(w, b, 1, 10n * NIGHT);
  assert.deepEqual(w.seat(a), w.seat(b));
  assert.deepEqual(w.seat(a), { table: 1n, epoch: 1n, standing: false, standAt: 0n, atRisk: 10n * NIGHT });
  assert.equal(w.count(1), 2n);
});

test('seatByJudge: judge only, with a permit that names this judge', () => {
  const w = world(); const p = player(), other = player(); grant(w, p); fund(w, other);
  assert.throws(() => seatBy(w, p, 1, NIGHT, other), /judge only/);
  assert.throws(() => seatBy(w, p, 1, NIGHT, p), /judge only/, 'not even the player: they have sit');
  assert.throws(() => seatBy(w, other, 1), /no permit/);
  const q = player(); grant(w, q, { judge: b32() });
  assert.throws(() => seatBy(w, q, 1), /names another judge/);
  const e = player(); grant(w, e, { judge: NO_JUDGE });
  assert.throws(() => seatBy(w, e, 1), /names another judge/);
});

test('seatByJudge: atRisk is above 0, at most the cap and at most the balance', () => {
  const w = world(); const p = player(); grant(w, p, { n: 30n * NIGHT, cap: 20n * NIGHT });
  assert.throws(() => seatBy(w, p, 1, 0n), /atRisk must be positive/);
  assert.throws(() => seatBy(w, p, 1, 20n * NIGHT + 1n), /over the permit's cap/);
  seatBy(w, p, 1, 20n * NIGHT); assert.equal(w.seat(p).atRisk, 20n * NIGHT);
  const q = player(); grant(w, q, { n: 5n * NIGHT, cap: 20n * NIGHT });
  assert.throws(() => seatBy(w, q, 1, 5n * NIGHT + 1n), /exceeds balance/);
  seatBy(w, q, 1, 5n * NIGHT);
});

test('seatByJudge: the permit ends at `until` by the block\'s clock, and declaring an older time doesn\'t help', () => {
  const edge = T0 + 1000n;
  const w = world(); const p = player(), q = player(); grant(w, p, { until: edge }); grant(w, q, { until: edge });
  w.at(edge); seatBy(w, p, 1); assert.ok(w.seat(p), 'at `until` it still works');
  w.at(edge + 1n);
  assert.throws(() => seatBy(w, q, 1), /permit has run out/);
  assert.throws(() => w.call(w.judge, 'seatByJudge', id(q), NO_FROM, 1n, NIGHT, edge), /permit has run out/, 'a declared time inside the slack is the back-dating this is for');
  assert.throws(() => w.call(w.judge, 'seatByJudge', id(q), NO_FROM, 1n, NIGHT, w.now + 1n), /in the future/);
  assert.throws(() => w.call(w.judge, 'seatByJudge', id(q), NO_FROM, 1n, NIGHT, w.now - SLACK), /stale/);
});

test('seatByJudge: one seat per player, and a full table is full', () => {
  const w = world({ seats: 2n }); const a = player(), b = player(), c = player(); for (const p of [a, b, c]) grant(w, p);
  seatBy(w, a, 1); assert.throws(() => seatBy(w, a, 1), /already seated/); assert.throws(() => seatBy(w, a, 2), /already seated/);
  seatBy(w, b, 1); assert.throws(() => seatBy(w, c, 1), /table is full/);
  assert.equal(w.count(1), 2n);
  const s = player(); grant(w, s); sit(w, s, 3); assert.throws(() => seatBy(w, s, 4), /already seated/, 'a seat the player took for themselves binds the same');
});

test('seatByJudge: a void seat is replaced, on a stale epoch the count is left alone, and a dead table starts a new epoch', () => {
  const w = world(); const a = player(); grant(w, a); seatBy(w, a, 1);
  w.at(T0 + ESCAPE);
  const n = player(); fund(w, n); sit(w, n, 1); assert.equal(w.epoch(1), 2n); assert.equal(w.count(1), 1n);
  seatBy(w, a, 1); assert.equal(w.count(1), 2n, 'a stale epoch takes nothing off the new one');
  assert.equal(w.seat(a).epoch, 2n);
  const w2 = world(); const x = player(); grant(w2, x); seatBy(w2, x, 1);
  w2.at(T0 + ESCAPE);
  seatBy(w2, x, 2, NIGHT); assert.equal(w2.seat(x).table, 2n); assert.equal(w2.seat(x).atRisk, NIGHT);
});

test('seatByJudge: a void seat on no count is overwritten, and the count of its old table is left alone', () => {
  const w = world(); const p = player(), q = player(), n = player(); grant(w, p); grant(w, q); fund(w, n);
  seatBy(w, p, 1); seatBy(w, q, 1); w.at(T0 + ESCAPE); // table 1 is dead
  sit(w, n, 1); assert.equal(w.count(1), 1n);
  seatBy(w, p, 1); assert.equal(w.count(1), 2n, 'a stale epoch was on no count');
  w.at(T0 + 2n * ESCAPE); // and again, to a different table from a dead one, same epoch
  seatBy(w, q, 2); assert.equal(w.seat(q).table, 2n); assert.equal(w.count(1), 2n, 'a dead table\'s count means nothing and isn\'t touched');
  sit(w, player2(w), 1); assert.equal(w.count(1), 1n, 'a new epoch starts its own count');
});

// ---------- seatByJudge with a from-table: a move ----------
test('seatByJudge, a move: one transaction off the old table and onto the new one, with the new atRisk', () => {
  const w = world(); const [k1] = two(w, 1); const p = player(); grant(w, p); seatBy(w, p, 1, 10n * NIGHT);
  const c = player(); fund(w, c); sit(w, c, 2);
  assert.equal(w.count(1), 3n); assert.equal(w.count(2), 1n);
  moveBy(w, p, 1, 2, 7n * NIGHT);
  assert.deepEqual(w.seat(p), { table: 2n, epoch: 1n, standing: false, standAt: 0n, atRisk: 7n * NIGHT });
  assert.equal(w.count(1), 2n); assert.equal(w.count(2), 2n);
  settle(w, 2, 1, [line(p, NIGHT), line(c, 0n, NIGHT)]); assert.equal(w.bal(p), 99n * NIGHT);
  assert.throws(() => settle(w, 1, 1, [line(p), line(k1)]), /not sitting at this table/, 'the old table can\'t name them now');
  assert.throws(() => w.call(p, 'withdraw', NIGHT), /seated/, 'and the money stays held the whole way');
});

test('seatByJudge, a move: there and back again, dice to cards to dice, and the seat is never held twice', () => {
  const w = world(); const p = player(); grant(w, p);
  const [d1, d2] = two(w, 1), [c1, c2] = two(w, 2); void d2; void c2;
  seatBy(w, p, 1);
  const round = { 1: 0, 2: 0 };
  for (const [f, t, other] of [[1, 2, c1], [2, 1, d1], [1, 2, c1]]) {
    moveBy(w, p, f, t);
    round[t] += 1; settle(w, t, round[t], [line(p, NIGHT), line(other, 0n, NIGHT)]);
    assert.equal(w.seat(p).table, BigInt(t));
    assert.equal(w.count(1) + w.count(2), 5n, 'two and two and one');
  }
  assert.equal(w.bal(p), 97n * NIGHT);
});

test('seatByJudge, a move: the same limits as a seat, plus it must be this seat, on another table, and not standing', () => {
  const edge = T0 + 1000n;
  const w = world({ seats: 2n }); const p = player(), o = player(); grant(w, p, { n: 30n * NIGHT, cap: 20n * NIGHT, until: edge }); fund(w, o);
  seatBy(w, p, 1);
  assert.throws(() => moveBy(w, p, 1, 2, NIGHT, o), /judge only/);
  assert.throws(() => moveBy(w, o, 1, 2), /no permit/);
  assert.throws(() => moveBy(w, p, 1, 2, 0n), /atRisk must be positive/);
  assert.throws(() => moveBy(w, p, 1, 2, 20n * NIGHT + 1n), /over the permit's cap/);
  assert.throws(() => moveBy(w, p, 3, 2), /not at this table/);
  assert.throws(() => moveBy(w, p, 1, 1), /another table/);
  const q = player(); grant(w, q); assert.throws(() => moveBy(w, q, 1, 2), /no seat/);
  const r = player(), s = player(); fund(w, r); fund(w, s); sit(w, r, 5); sit(w, s, 5);
  assert.throws(() => moveBy(w, p, 1, 5), /table is full/);
  assert.equal(w.seat(p).table, 1n, 'nothing moved'); assert.equal(w.count(1), 1n);
  w.at(edge + 1n); assert.throws(() => moveBy(w, p, 1, 2), /permit has run out/);
  const z = player(); grant(w, z, { n: 5n * NIGHT, cap: 20n * NIGHT, until: edge + 10n }); seatBy(w, z, 6, NIGHT);
  assert.throws(() => moveBy(w, z, 6, 7, 6n * NIGHT), /exceeds balance/);
});

test('seatByJudge, a move: the last seat leaves an empty table behind; to a dead table is a new epoch; from a stale epoch takes nothing off the new one', () => {
  const w = world(); const p = player(); grant(w, p); seatBy(w, p, 1);
  moveBy(w, p, 1, 2); assert.equal(w.count(1), 0n);
  const a = player(); fund(w, a); sit(w, a, 1); assert.equal(w.epoch(1), 2n, 'an empty table starts over');
  w.at(T0 + ESCAPE);
  moveBy(w, p, 2, 3); assert.equal(w.seat(p).table, 3n); assert.equal(w.seat(p).epoch, 1n);
  const w2 = world(); const q = player(); grant(w2, q); seatBy(w2, q, 1);
  w2.at(T0 + ESCAPE);
  const n = player(); fund(w2, n); sit(w2, n, 1); assert.equal(w2.count(1), 1n);
  moveBy(w2, q, 1, 2); assert.equal(w2.count(1), 1n, 'q was from the old epoch');
  assert.equal(w2.seat(q).table, 2n);
});

test('seatByJudge, a move: a declared time in the future or gone stale is refused, and the time it declares is what starts a new table\'s clock', () => {
  const w = world(); const p = player(); grant(w, p); seatBy(w, p, 1);
  assert.throws(() => w.call(w.judge, 'seatByJudge', id(p), fromT(1n), 2n, NIGHT, w.now + 1n), /in the future/);
  assert.throws(() => w.call(w.judge, 'seatByJudge', id(p), fromT(1n), 2n, NIGHT, w.now - SLACK), /stale/);
  w.call(w.judge, 'seatByJudge', id(p), fromT(1n), 2n, NIGHT, w.now - SLACK + 1n);
  assert.equal(w.state().tables.lookup(2n).heartbeat, T0 - SLACK + 1n);
});

// ---------- a revoke: a deposit of 0 with the empty permit ----------
test('a revoke (a deposit of 0, the empty permit): only the player\'s own permit, after it nothing can be seated, a seat already held stays, and a new deposit can grant again', () => {
  const w = world(); const p = player(), o = player(); grant(w, p); fund(w, o);
  assert.throws(() => w.call(o, 'deposit', ...REVOKE), /no permit/, 'it reads the caller\'s own, so a stranger has nothing to end');
  seatBy(w, p, 1);
  w.call(p, 'deposit', ...REVOKE); assert.equal(w.permit(p), null);
  assert.ok(w.seat(p), 'the seat stays');
  assert.throws(() => moveBy(w, p, 1, 2), /no permit/);
  assert.throws(() => w.call(p, 'deposit', ...REVOKE), /no permit/);
  stand(w, p, 1); settle(w, 1, 1, [line(p)]);
  assert.throws(() => seatBy(w, p, 1), /no permit/);
  grant(w, p, { n: NIGHT }); seatBy(w, p, 1); assert.equal(w.seat(p).table, 1n);
});

test('a revoke moves no money, doesn\'t read the payout address it is given, and works on a seat that binds, where a deposit with money is refused', () => {
  const w = world(); const [k1] = two(w); const p = player(); grant(w, p); seatBy(w, p, 9);
  assert.throws(() => w.call(p, 'deposit', p.addr, NIGHT, NO_JUDGE, 0n, 0n), /seated: deposit after you stand/);
  const received = (r) => [...(r.context.currentQueryContext.effects.unshieldedInputs?.entries?.() ?? [])].reduce((n, [, v]) => n + v, 0n); // the simulator's effects add up across calls
  const before = received(w.build(w.judge, 'proposeJudge', b32(), w.now));
  const r = w.call(p, 'deposit', { bytes: b32() }, 0n, b32(), 0n, T0 + 99n);
  assert.equal(w.permit(p), null);
  assert.equal(w.bal(p), 100n * NIGHT);
  assert.equal(received(r), before, 'nothing received');
  assert.equal(hex(w.state().payTo.lookup(id(p)).bytes), hex(p.addr.bytes), 'a different payout address in a revoke changes nothing');
  assert.equal(w.seat(p).table, 9n, 'the seat stays until it is settled, released or stood from');
  settle(w, 9, 1, [line(p, NIGHT), line(k1, 0n, NIGHT)]); assert.equal(w.bal(p), 99n * NIGHT, 'and it still pays its losses');
  assert.throws(() => moveBy(w, p, 9, 1), /no permit/);
});

test('no judge action can block a revoke: built first, it lands after settles, moves, a release, a new seat and a rotation proposal, all of that same player', () => {
  const w = world(); const [k1] = two(w, 1); const [k2] = two(w, 2); const p = player(); grant(w, p); seatBy(w, p, 1);
  const out = w.build(p, 'deposit', ...REVOKE);
  const L0 = w.state(), seat0 = w.seat(p);
  settle(w, 1, 1, [line(p, NIGHT), line(k1, 0n, NIGHT)]);
  moveBy(w, p, 1, 2);
  settle(w, 2, 1, [line(p, 0n, 2n * NIGHT), line(k2, 2n * NIGHT)]);
  w.call(w.judge, 'release', 2n, id(p));
  seatBy(w, p, 3, 7n * NIGHT);
  w.call(w.judge, 'proposeJudge', b32(), w.now);
  w.at(T0 + 100n); settle(w, 3, 1, [line(p)]);
  // so that a revoke reading anything of theirs but the permit would fail: the balance, the seat, its table, the counts and the rotation all changed
  const L1 = w.state();
  assert.notEqual(w.bal(p), L0.balance.lookup(id(p))); assert.notDeepEqual(w.seat(p), seat0);
  assert.notDeepEqual(L1.tables.lookup(1n), L0.tables.lookup(1n)); assert.notEqual(L1.hasPending, L0.hasPending);
  assert.ok(w.land(out), 'the revoke lands');
  assert.equal(w.permit(p), null);
  assert.throws(() => moveBy(w, p, 3, 1), /no permit/);
  assert.equal(w.bal(p), 101n * NIGHT);
});

test('seatByJudge, the from-table picks the move: with none it can\'t touch a seat that binds; with one, the seat must be at that table, and not standing', () => {
  const w = world(); const p = player(); grant(w, p); seatBy(w, p, 1);
  assert.throws(() => seatBy(w, p, 2), /already seated/, 'a seat with no from-table can\'t be used to move a bound seat');
  assert.throws(() => moveBy(w, p, 3, 2), /not at this table/);
  assert.throws(() => moveBy(w, p, 1, 1), /another table/);
  const q = player(); grant(w, q);
  assert.throws(() => moveBy(w, q, 1, 2), /no seat/, 'a move needs a seat');
  moveBy(w, p, 1, 2); assert.equal(w.seat(p).table, 2n); assert.equal(w.count(1), 0n); assert.equal(w.count(2), 1n);
  stand(w, p, 2);
  assert.throws(() => moveBy(w, p, 2, 1), /no permit/, 'the stand ended the permit');
  assert.throws(() => grant(w, p, { n: NIGHT }), /seated: deposit after you stand/, 'and a standing seat binds until it is freed or runs out, so no new grant yet');
  // a standing seat refused by a move or a seat, after a new grant, is in "after a stand has run out a player can grant again"
});

// ---------- what stays as it was ----------
test('a seat the judge made is an ordinary seat: settled by atRisk, freed by a stand, voided by the escape, released by the judge', () => {
  const w = world(); const p = player(), o = player(); grant(w, p); fund(w, o); seatBy(w, p, 1, 10n * NIGHT); sit(w, o, 1);
  assert.throws(() => settle(w, 1, 1, [line(p, 11n * NIGHT), line(o, 0n, 11n * NIGHT)]), /remaining atRisk/);
  settle(w, 1, 1, [line(p, 4n * NIGHT), line(o, 0n, 4n * NIGHT)]); assert.equal(w.seat(p).atRisk, 6n * NIGHT);
  assert.throws(() => w.call(p, 'withdraw', NIGHT), /seated/);
  assert.throws(() => w.call(o, 'rescue', id(p)), /a permit is live/, 'F5: and seated too');
  stand(w, p, 1); settle(w, 1, 2, [line(p)]); assert.equal(w.seat(p), null);
  w.call(p, 'withdraw', 96n * NIGHT); assert.equal(w.bal(p), 0n);
  const w2 = world(); const a = player(); grant(w2, a); seatBy(w2, a, 1);
  w2.at(T0 + ESCAPE); w2.call(a, 'withdraw', 100n * NIGHT); assert.equal(w2.seat(a), null);
  const w3 = world(); const b = player(); grant(w3, b); seatBy(w3, b, 1);
  w3.call(w3.judge, 'release', 1n, id(b)); assert.equal(w3.seat(b), null); assert.equal(w3.count(1), 0n);
  w3.call(b, 'withdraw', NIGHT);
});

test('a player can still sit and stand for themselves with a permit on file, and the judge can\'t change a seat they took while it binds', () => {
  const w = world(); const p = player(); grant(w, p);
  sit(w, p, 1, 80n * NIGHT); assert.equal(w.seat(p).atRisk, 80n * NIGHT, 'their own sit isn\'t held to the cap');
  assert.throws(() => seatBy(w, p, 2), /already seated/);
  moveBy(w, p, 1, 2, 10n * NIGHT);
  assert.equal(w.seat(p).atRisk, 10n * NIGHT, 'a move is allowed on any seat of theirs: the permit is theirs');
});

test('a permit never moves money: the judge has no withdraw, and rescue still pays only the bound address, once the permit has run out', () => {
  const w = world(); const p = player(); grant(w, p);
  assert.throws(() => w.call(w.judge, 'withdraw', NIGHT), /no payout address/);
  assert.throws(() => w.call(w.judge, 'rescue', id(p)), /a permit is live/);
  w.at(T0 + HOURS12 + 1n);
  const r = w.call(w.judge, 'rescue', id(p));
  assert.equal(w.bal(p), 0n);
  const claimed = [...(r.context.currentQueryContext.effects.claimedUnshieldedSpends?.entries?.() ?? [])];
  assert.ok(claimed.some(([k, v]) => JSON.stringify(k, (_, x) => (typeof x === 'bigint' ? String(x) : x instanceof Uint8Array ? hex(x) : x)).includes(hex(p.addr.bytes)) && v === 100n * NIGHT));
});

test('rotation: a permit names a key, so the new judge can\'t use it until the player grants again, and a permit can name the coming judge', () => {
  const w = world(); const p = player(), early = player(); const next = { sk: b32() };
  grant(w, p); grant(w, early, { judge: id(next) });
  w.call(w.judge, 'proposeJudge', id(next), w.now);
  w.at(T0 + DELAY); w.call(next, 'acceptJudge');
  assert.throws(() => w.call(next, 'seatByJudge', id(p), NO_FROM, 1n, NIGHT, w.now), /names another judge/);
  assert.throws(() => w.call(w.judge, 'seatByJudge', id(p), NO_FROM, 1n, NIGHT, w.now), /judge only/, 'and the old key has lost its powers');
  w.call(next, 'seatByJudge', id(early), NO_FROM, 1n, NIGHT, w.now); assert.equal(w.seat(early).table, 1n);
  grant(w, p, { n: NIGHT, judge: id(next) }); w.call(next, 'seatByJudge', id(p), NO_FROM, 2n, NIGHT, w.now); assert.equal(w.seat(p).table, 2n);
});

// ---------- attacks ----------
test('attack: a stolen judge key can keep a stand off the chain by moving the seat. Revoke can\'t be stopped, and it ends that', () => {
  const w = world(); const p = player(); grant(w, p); seatBy(w, p, 1);
  let table = 1n;
  const hop = () => { const to = table + 1n; w.call(w.judge, 'seatByJudge', id(p), fromT(table), to, NIGHT, w.now); table = to; };
  for (let i = 0; i < 20; i++) { const built = w.build(p, 'stand', table, w.now); hop(); assert.equal(w.land(built), false, 'the move changed the seat this stand read'); }
  // the way out: revoke first. Moves made in the meantime can't touch it, because the judge has no way to write this player's permit.
  const out = w.build(p, 'deposit', ...REVOKE); hop(); hop(); assert.ok(w.land(out), 'the revoke lands across moves');
  const late = (() => { try { return w.build(w.judge, 'seatByJudge', id(p), fromT(table), table + 1n, NIGHT, w.now); } catch { return null; } })();
  assert.equal(late, null, 'and no move can be built after it');
  const standing = w.build(p, 'stand', table, w.now); assert.ok(w.land(standing));
  assert.equal(w.permit(p), null);
  w.at(T0 + ESCAPE); w.call(p, 'withdraw', 100n * NIGHT); assert.equal(w.bal(p), 0n, 'out, at most one escape window after the revoke');
});

test('attack: a seat or move built before a revoke, landing after it, does not land', () => {
  const w = world(); const p = player(), q = player(); grant(w, p); grant(w, q); seatBy(w, q, 1);
  const seat = w.build(w.judge, 'seatByJudge', id(p), NO_FROM, 1n, NIGHT, w.now);
  const move = w.build(w.judge, 'seatByJudge', id(q), fromT(1n), 2n, NIGHT, w.now);
  w.call(p, 'deposit', ...REVOKE); w.call(q, 'deposit', ...REVOKE);
  assert.equal(w.land(seat), false); assert.equal(w.land(move), false);
  assert.equal(w.seat(p), null); assert.equal(w.seat(q).table, 1n);
});

test('attack: with a permit live, a seat by the judge can knock out a withdraw built just before it. The stand that follows ends the permit, so that is the last time', () => {
  const w = world(); const p = player(); grant(w, p);
  const out = w.build(p, 'withdraw', 100n * NIGHT);
  seatBy(w, p, 1); assert.equal(w.land(out), false);
  stand(w, p, 1);
  w.at(T0 + ESCAPE); w.call(p, 'withdraw', 100n * NIGHT); assert.equal(w.bal(p), 0n);
});

test('attack: the judge\'s seat fails safely if the player\'s money moved first, so a deposit or withdraw beats it. A rescue can\'t come between, since F5', () => {
  { const w = world(); const p = player(); grant(w, p); assert.throws(() => w.call(player2(w), 'rescue', id(p)), /a permit is live/); }
  for (const move of [(w, p) => w.call(p, 'withdraw', NIGHT), (w, p) => grant(w, p, { n: NIGHT })]) {
    const w = world(); const p = player(); grant(w, p);
    const built = w.build(w.judge, 'seatByJudge', id(p), NO_FROM, 1n, NIGHT, w.now);
    move(w, p);
    assert.equal(w.land(built), false);
    assert.equal(w.seat(p), null);
  }
});

test('attack A still closed: a deposit built before the judge seats you can\'t land after, and can\'t fail the settle', () => {
  const w = world(); const loser = player(), winner = player(); grant(w, loser); grant(w, winner);
  const prepared = w.build(loser, 'deposit', loser.addr, 1n, NO_JUDGE, 0n, 0n);
  seatBy(w, loser, 1); seatBy(w, winner, 1);
  const s = w.build(w.judge, 'settleBatch', one(entry(1, 1, [line(loser, NIGHT), line(winner, 0n, NIGHT)])), w.now);
  assert.equal(w.land(prepared), false);
  assert.ok(w.land(s)); assert.equal(w.bal(loser), 99n * NIGHT);
});

test('a move can\'t break a settle that names others at either table: the Counter still keeps them apart', () => {
  const w = world(); const [a, b] = two(w, 1), [c, d] = two(w, 2); const p = player(), q = player(); grant(w, p); grant(w, q); seatBy(w, p, 1); seatBy(w, q, 3);
  const at1 = w.build(w.judge, 'settleBatch', one(entry(1, 1, [line(a, NIGHT), line(b, 0n, NIGHT)])), w.now);
  moveBy(w, p, 1, 2);
  assert.ok(w.land(at1), 'the table it left');
  const at2 = w.build(w.judge, 'settleBatch', one(entry(2, 1, [line(c, NIGHT), line(d, 0n, NIGHT)])), w.now);
  moveBy(w, q, 3, 2);
  assert.ok(w.land(at2), 'the table it came to');
});

test('a settle naming the seat beats a move built before it, and the other way round: rounds at a table and moves off it have to go in order', () => {
  const w = world(); const [a] = two(w, 1); const p = player(); grant(w, p); seatBy(w, p, 1);
  const move = w.build(w.judge, 'seatByJudge', id(p), fromT(1n), 2n, NIGHT, w.now);
  settle(w, 1, 1, [line(p, NIGHT), line(a, 0n, NIGHT)]);
  assert.equal(w.land(move), false, 'the balance it read has changed, so nothing is moved on a stale view');
  const s = w.build(w.judge, 'settleBatch', one(entry(1, 2, [line(p, NIGHT), line(a, 0n, NIGHT)])), w.now);
  moveBy(w, p, 1, 2);
  assert.equal(w.land(s), false, 'the judge\'s own settle is lost if it moves the seat first: it must not');
});

test('the permit still ends at a revoke, and at `until`, with budget left', () => {
  const run = (stop) => {
    const w = world(); const victim = player(), mule = player();
    grant(w, victim, { n: 1000n * NIGHT, cap: 100n * NIGHT, until: T0 + 300n }); fund(w, mule, NIGHT); sit(w, mule, 1, NIGHT); seatBy(w, victim, 1, 100n * NIGHT);
    settle(w, 1, 1, [line(victim, 50n * NIGHT), line(mule, 0n, 50n * NIGHT)]);
    stop(w, victim);
    return () => moveBy(w, victim, 1, 2, 10n * NIGHT);
  };
  assert.throws(run((w, v) => w.call(v, 'deposit', ...REVOKE)), /no permit/);
  assert.throws(run((w) => w.at(T0 + 301n)), /permit has run out/);
});

// ---------- F5, fixed in v4b: no rescue of a balance while a permit is live ----------
test('F5: a stranger can\'t send a granted player home, between the deposit and the seat or between two seats, while the permit is live', () => {
  const w = world(); const p = player(), stranger = player(); fund(w, stranger, NIGHT);
  grant(w, p);
  assert.throws(() => w.call(stranger, 'rescue', id(p)), /a permit is live/, 'after the deposit, before any seat');
  assert.throws(() => w.call(p, 'rescue', id(p)), /a permit is live/, 'and not the player either: they have withdraw');
  seatBy(w, p, 1); w.call(w.judge, 'release', 1n, id(p));
  assert.throws(() => w.call(stranger, 'rescue', id(p)), /a permit is live/, 'between two seats, when the judge releases instead of moving');
  assert.equal(w.bal(p), 100n * NIGHT); assert.ok(w.permit(p));
  seatBy(w, p, 2); assert.equal(w.seat(p).table, 2n, 'the judge seats them again, with the floor where it was');
  w.call(w.judge, 'release', 2n, id(p));
  w.call(p, 'withdraw', 100n * NIGHT); assert.equal(w.bal(p), 0n, 'the player\'s own way out is untouched');
});

test('F5: live is what a seat by the judge checks: refused up to and at `until` by the block\'s clock, and the lost-key path opens after it', () => {
  const edge = T0 + 1000n;
  const w = world(); const p = player(), stranger = player(); fund(w, stranger, NIGHT);
  grant(w, p, { until: edge });
  w.at(edge); assert.throws(() => w.call(stranger, 'rescue', id(p)), /a permit is live/, 'at `until` the judge can still seat them, so it is still live');
  seatBy(w, p, 1); w.call(w.judge, 'release', 1n, id(p));
  w.at(edge + 1n); assert.throws(() => seatBy(w, p, 1), /permit has run out/);
  const r = w.call(stranger, 'rescue', id(p));
  assert.equal(w.bal(p), 0n, 'one second later the permit is dead and the lost-key path works, to the bound address');
  const claimed = [...(r.context.currentQueryContext.effects.claimedUnshieldedSpends?.entries?.() ?? [])];
  assert.ok(claimed.some(([k, v]) => JSON.stringify(k, (_, x) => (typeof x === 'bigint' ? String(x) : x instanceof Uint8Array ? hex(x) : x)).includes(hex(p.addr.bytes)) && v === 100n * NIGHT));
});

test('F5: a permit that ended opens rescue again: after a revoke, after a stand, and with no permit at all', () => {
  const w = world(); const [k1] = two(w); const stranger = player(); fund(w, stranger, NIGHT);
  const a = player(); grant(w, a); w.call(a, 'deposit', ...REVOKE);
  w.call(stranger, 'rescue', id(a)); assert.equal(w.bal(a), 0n, 'after a revoke');
  const b = player(); grant(w, b); seatBy(w, b, 9); stand(w, b, 9);
  assert.throws(() => w.call(stranger, 'rescue', id(b)), /seated/, 'the stand ended the permit, and the seat still binds');
  settle(w, 9, 1, [line(b), line(k1)]); w.call(stranger, 'rescue', id(b)); assert.equal(w.bal(b), 0n, 'after the settle that freed the stand');
  const c = player(); fund(w, c); w.call(stranger, 'rescue', id(c)); assert.equal(w.bal(c), 0n, 'with the empty permit there is no permit, as before');
});

test('F5: a permit that names another judge, or one proposed, still stops a rescue until it runs out', () => {
  const w = world(); const p = player(), stranger = player(); fund(w, stranger, NIGHT); const other = b32();
  grant(w, p, { judge: other, until: T0 + 500n });
  assert.throws(() => w.call(stranger, 'rescue', id(p)), /a permit is live/);
  w.at(T0 + 501n); w.call(stranger, 'rescue', id(p)); assert.equal(w.bal(p), 0n);
});

test('F5: nothing the judge writes can hold a rescue in. It reads the permit, which only the player writes, and the seat rule, as before', () => {
  const w = world(); const [k1, k2] = two(w); const p = player(), stranger = player(), q = player(); fund(w, stranger, NIGHT); grant(w, q);
  grant(w, p, { until: T0 + 100n }); w.at(T0 + 101n);
  const built = w.build(stranger, 'rescue', id(p));
  settle(w, 9, 1, [line(k1, NIGHT), line(k2, 0n, NIGHT)]); seatBy(w, q, 9); w.call(w.judge, 'release', 9n, id(q));
  assert.ok(w.land(built), 'settles, seats and releases of others: the rescue still lands');
  assert.equal(w.bal(p), 0n);
  const r = player(); grant(w, r, { until: T0 + 200n }); w.at(T0 + 201n);
  const late = w.build(stranger, 'rescue', id(r));
  grant(w, r, { n: NIGHT, until: T0 + 5000n });
  assert.equal(w.land(late), false, 'a new grant by the player beats a rescue in flight: their own permit changed');
  assert.equal(w.bal(r), 101n * NIGHT);
});

test('KNOWN, F5 is not closed for a house float: its deposit carries the empty permit, so it can be sent home between the deposit and its sit', () => {
  const w = world(); const house = player(), stranger = player(); fund(w, stranger, NIGHT);
  fund(w, house, 60n * NIGHT);
  w.call(stranger, 'rescue', id(house));
  assert.equal(w.bal(house), 0n, 'the judge can close this by depositing floats with a short permit naming itself');
  const h2 = player(); grant(w, h2, { n: 60n * NIGHT, cap: NIGHT, until: T0 + 600n });
  assert.throws(() => w.call(stranger, 'rescue', id(h2)), /a permit is live/, 'which is what this shows');
});

// ---------- L1: a permit runs at most maxGrant past the block's clock, so F5's hold on a lost-key player ends at most that long after the grant ----------
const ZERO = new Uint8Array(32), MAX64 = 2n ** 64n - 1n;
test('L1: the bound is the cage\'s own maxGrant, read from the ledger: on a cage with an hour, an hour is granted and an hour and a second is not', () => {
  const w = world({ maxGrant: 3600n }); const p = player(), q = player();
  assert.equal(w.state().maxGrant, 3600n);
  grant(w, p, { until: T0 + 3600n }); assert.equal(w.permit(p).until, T0 + 3600n);
  assert.throws(() => grant(w, q, { until: T0 + 3601n }), /a permit runs at most maxGrant/);
  assert.throws(() => grant(w, q, { until: T0 + HOURS12 }), /a permit runs at most maxGrant/, 'the Hall\'s 12 hours, on a cage deployed with the wrong unit');
  grant(w, q, { until: 3600n }); assert.equal(w.permit(q).until, 3600n, 'the first test uses this cage\'s maxGrant too');
});

test('L1: a grant asks the clock once and reads maxGrant; cap 0 reads neither, so a top-up, a plain deposit and a revoke are as they were', () => {
  const MAXGRANT_PATH = JSON.stringify([0, 4]); // maxGrant's place in the ledger: the first group, after roundCap
  const reads = (r) => {
    const t = r.proofData.publicTranscript;
    const clock = t.filter((op) => op === 'lt').length;
    const paths = t.filter((op) => op?.idx).map((op) => JSON.stringify(op.idx.path.map((k) => (k.tag === 'value' ? Number(k.value.value[0]?.[0] ?? 0) : k.tag))));
    return { clock, maxGrant: paths.filter((p) => p === MAXGRANT_PATH).length };
  };
  const w = world(); const p = player(), q = player(), s = player();
  assert.deepEqual(reads(grant(w, p)), { clock: 1, maxGrant: 2 }, 'a grant: the bound reads maxGrant for each of its two tests, and asks the clock once');
  assert.deepEqual(reads(grant(w, s, { until: 1000n })), { clock: 0, maxGrant: 1 }, 'under maxGrant itself: the first test settles it, and the clock isn\'t asked');
  assert.deepEqual(reads(w.call(p, 'deposit', p.addr, NIGHT, NO_JUDGE, 0n, MAX64)), { clock: 0, maxGrant: 0 }, 'a top-up under a permit');
  assert.deepEqual(reads(w.call(q, 'deposit', q.addr, NIGHT, NO_JUDGE, 0n, MAX64)), { clock: 0, maxGrant: 0 }, 'a plain deposit');
  assert.deepEqual(reads(w.call(p, 'deposit', { bytes: ZERO }, 0n, ZERO, 0n, MAX64)), { clock: 0, maxGrant: 0 }, 'a revoke');
});
test('L1: a grant may run to now + maxGrant by the block\'s clock, and not one second more. The bound moves with the clock', () => {
  const w = world(); const p = player(), q = player();
  assert.equal(w.state().maxGrant, MAXGRANT, 'the constructor\'s maxGrant is on the ledger');
  grant(w, p, { until: T0 + MAXGRANT });
  assert.equal(w.permit(p).until, T0 + MAXGRANT, 'now + maxGrant, on the bound: granted');
  assert.throws(() => grant(w, q, { until: T0 + MAXGRANT + 1n }), /a permit runs at most maxGrant/, 'one second over');
  assert.equal(w.bal(q), 0n, 'nothing went in'); assert.equal(w.permit(q), null);
  grant(w, p, { n: NIGHT, until: T0 + 10n });
  assert.throws(() => grant(w, p, { n: NIGHT, until: T0 + MAXGRANT + 1n }), /a permit runs at most maxGrant/, 'a grant replacing a permit is held to it too');
  assert.equal(w.permit(p).until, T0 + 10n, 'the refused grant left the permit as it was'); assert.equal(w.bal(p), 101n * NIGHT);
  w.at(T0 + 1n); grant(w, q, { until: T0 + MAXGRANT + 1n });
  assert.equal(w.permit(q).until, T0 + 1n + MAXGRANT, 'a second later the same until is on the bound');
});

test('L1: an until in milliseconds is refused, and so is anything that would hold a lost-key player for longer', () => {
  const w = world(); const p = player();
  assert.throws(() => grant(w, p, { until: (T0 + HOURS12) * 1000n }), /a permit runs at most maxGrant/, '12 hours written in milliseconds: about 60,000 years');
  assert.throws(() => grant(w, p, { until: MAX64 }), /a permit runs at most maxGrant/, 'the review\'s 2^64 - 1');
  assert.throws(() => grant(w, p, { until: T0 + 365n * 86_400n }), /a permit runs at most maxGrant/, 'a year');
  assert.equal(w.bal(p), 0n); assert.equal(w.permit(p), null);
});

test('L1: cap 0 is no permit, and any until goes with it: a plain deposit, a top-up under a permit, and a revoke', () => {
  const w = world(); const p = player(), q = player();
  w.call(p, 'deposit', p.addr, NIGHT, NO_JUDGE, 0n, MAX64);
  assert.equal(w.permit(p), null, 'the empty permit records nothing, whatever until says'); assert.equal(w.bal(p), NIGHT);
  grant(w, q, { until: T0 + HOURS12 });
  w.call(q, 'deposit', q.addr, NIGHT, NO_JUDGE, 0n, MAX64);
  assert.equal(w.permit(q).until, T0 + HOURS12, 'a top-up keeps the permit\'s own until'); assert.equal(w.permit(q).floor, 51n * NIGHT);
  w.call(q, 'deposit', { bytes: ZERO }, 0n, ZERO, 0n, MAX64);
  assert.equal(w.permit(q), null, 'a revoke carries any until and still ends the permit');
});

test('L1: after a revoke a player can grant again, up to the bound and not over it, and the judge seats under the new grant', () => {
  const w = world(); const p = player();
  grant(w, p); w.call(p, 'deposit', ...REVOKE); assert.equal(w.permit(p), null);
  w.at(T0 + 5000n);
  grant(w, p, { n: NIGHT, until: w.now + MAXGRANT });
  assert.equal(w.permit(p).until, T0 + 5000n + MAXGRANT);
  seatBy(w, p, 1); assert.equal(w.seat(p).table, 1n, 'a grant on the bound is a working permit');
  w.call(w.judge, 'release', 1n, id(p)); w.call(p, 'deposit', ...REVOKE);
  assert.throws(() => grant(w, p, { n: NIGHT, until: w.now + MAXGRANT + 1n }), /a permit runs at most maxGrant/);
  assert.equal(w.permit(p), null, 'still revoked'); assert.equal(w.bal(p), 101n * NIGHT);
});

test('L1: an until at or under maxGrant itself passes on the first test, so nothing goes below 0. It is long past, so it seats nobody and holds nothing in', () => {
  const w = world(); const p = player(), q = player(), stranger = player(); fund(w, stranger, NIGHT);
  grant(w, p, { until: 1000n }); assert.equal(w.permit(p).until, 1000n);
  grant(w, q, { until: MAXGRANT }); assert.equal(w.permit(q).until, MAXGRANT);
  assert.throws(() => seatBy(w, p, 1), /permit has run out/);
  w.call(stranger, 'rescue', id(p)); assert.equal(w.bal(p), 0n, 'not live, so F5 doesn\'t hold it');
  grant(w, p, { until: MAXGRANT + 1n }); assert.equal(w.permit(p).until, MAXGRANT + 1n, 'one over takes the clock test, which passes');
});

test('L1: built at T and landed at T+1, on both sides of the bound: on it lands, one over is refused when built. Only a builder\'s clock ahead of the chain knocks one out', () => {
  const T = T0 + 7n, J = (w) => id(w.judge);
  const w = world(); const [p, q, r, s] = [player(), player(), player(), player()];
  w.at(T); const onBound = w.build(p, 'deposit', p.addr, 10n * NIGHT, J(w), 5n * NIGHT, T + MAXGRANT);
  w.at(T + 1n); assert.equal(w.land(onBound), true, 'on the bound, built at T, landed at T+1: the clock only moves away from the bound');
  assert.equal(w.permit(p).until, T + MAXGRANT);
  const sameSecond = w.build(q, 'deposit', q.addr, 10n * NIGHT, J(w), 5n * NIGHT, T + 1n + MAXGRANT);
  assert.equal(w.land(sameSecond), true, 'on the bound, built and landed in the same second');
  w.at(T); assert.throws(() => w.build(r, 'deposit', r.addr, 10n * NIGHT, J(w), 5n * NIGHT, T + MAXGRANT + 1n), /a permit runs at most maxGrant/, 'one over, built at T: refused before anything is sent');
  w.at(T + 1n); const later = w.build(r, 'deposit', r.addr, 10n * NIGHT, J(w), 5n * NIGHT, T + MAXGRANT + 1n);
  w.at(T + 2n); assert.equal(w.land(later), true, 'the same until built at T+1 is on the bound, and lands at T+2');
  w.at(T + 1n); const ahead = w.build(s, 'deposit', s.addr, 10n * NIGHT, J(w), 5n * NIGHT, T + 1n + MAXGRANT);
  w.at(T); assert.equal(w.land(ahead), false, 'on the bound by a clock one second ahead of the chain: knocked out');
  assert.equal(w.permit(s), null);
  // ten minutes inside the bound: a builder 600 s ahead of the chain lands, and one 601 s ahead is knocked out
  w.at(T + 600n); const inside = w.build(s, 'deposit', s.addr, 10n * NIGHT, J(w), 5n * NIGHT, T + 600n + MAXGRANT - 600n);
  const t = player(); w.at(T + 601n); const tooFar = w.build(t, 'deposit', t.addr, 10n * NIGHT, J(w), 5n * NIGHT, T + 601n + MAXGRANT - 600n);
  w.at(T); assert.equal(w.land(tooFar), false, 'ten minutes inside, by a clock 601 s ahead: knocked out');
  assert.equal(w.land(inside), true, 'ten minutes inside, by a clock 600 s ahead: lands');
});

test('L1 with F5: a lost-key player with no seat waits at most maxGrant from the grant. A rescue opens one second after a grant on the bound runs out', () => {
  const w = world(); const p = player(), stranger = player(); fund(w, stranger, NIGHT);
  grant(w, p, { until: T0 + MAXGRANT });
  w.at(T0 + MAXGRANT); assert.throws(() => w.call(stranger, 'rescue', id(p)), /a permit is live/, 'at until it is still live');
  w.at(T0 + MAXGRANT + 1n); w.call(stranger, 'rescue', id(p));
  assert.equal(w.bal(p), 0n, 'thirty days and a second after the grant, the lost-key path is open');
});

test('KNOWN, L1 bounds F5, not a seat: a judge that seats a lost-key player before until, and keeps the table alive, holds them past maxGrant', () => {
  // As before L1: rescue waits while a seat binds, and a lost-key player's seat binds until the judge releases it or the table goes quiet (a
  // settle frees only a standing seat, and they can't stand). judge-plan keeps a seat alive with settles of nothing only while a round is live
  // or for a stand's hold, and releases a player the Worker has dropped. This pins what a judge key could do.
  const w = world(); const p = player(), stranger = player(); fund(w, stranger, NIGHT);
  grant(w, p, { until: T0 + MAXGRANT });
  w.at(T0 + MAXGRANT); seatBy(w, p, 1, NIGHT); // the last second of the permit: a new table, with p alone at it
  let round = 1;
  for (let at = T0 + MAXGRANT + ESCAPE - 10n; at <= T0 + MAXGRANT + 4n * ESCAPE; at += ESCAPE - 10n) { w.at(at); settle(w, 1, round++, []); } // settles of nothing
  assert.ok(w.now > T0 + MAXGRANT + 3n * ESCAPE);
  assert.throws(() => w.call(stranger, 'rescue', id(p)), /seated: the judge must release this seat first/, 'past grant + maxGrant, held by the seat');
  w.call(w.judge, 'release', 1n, id(p)); w.call(stranger, 'rescue', id(p));
  assert.equal(w.bal(p), 0n, 'released: the lost-key path opens at once, the permit having run out');
});

test('L1: the constructor takes maxGrant in seconds, from 1 second to 365 days: 30 days in milliseconds is refused here (the deploy command holds the value itself)', () => {
  const contract = new Contract(witnesses); const j = { sk: b32() };
  const make = (g) => contract.initialState(createConstructorContext({ sk: b32() }, COIN), id(j), id(j), 0n, CAP, ESCAPE, SEATS, SLACK, DELAY, g);
  assert.throws(() => make(0n), /maxGrant must be from 1 second to 365 days/);
  assert.throws(() => make(MAXGRANT * 1000n), /maxGrant must be from 1 second to 365 days/, '30 days in milliseconds');
  assert.throws(() => make(31_536_001n), /maxGrant must be from 1 second to 365 days/);
  assert.equal(ledger(make(31_536_000n).currentContractState.data).maxGrant, 31_536_000n);
  assert.equal(ledger(make(1n).currentContractState.data).maxGrant, 1n);
});

// ---------- F4, against the real contract ----------
test('F4: the plan the judge makes lands on the contract, and leaves the expired seat\'s balance and atRisk untouched', () => {
  const w = world(); const out = player(), w1 = player(), w2 = player();
  for (const p of [out, w1, w2]) { fund(w, p); sit(w, p, 1, 50n * NIGHT); }
  stand(w, out, 1);
  w.at(T0 + 1000n); settle(w, 1, 1, [line(w1), line(w2)]);
  w.at(T0 + ESCAPE);
  const L = w.state();
  const chain = {
    table: { lastRound: L.tables.lookup(1n).lastRound, heartbeat: L.tables.lookup(1n).heartbeat, epoch: L.epochs.lookup(1n), seated: L.seats.lookup(1n).read() },
    seats: new Map([...L.seat].map(([k, s]) => [hex(k), { ...s, atRisk: L.risks.lookup(k) }])),
    balance: (x) => { const k = Buffer.from(x, 'hex'); const B = w.state().balance; return B.member(k) ? B.lookup(k) : 0n; },
    payTo: () => null, nowSecs: w.now, escapeSecs: ESCAPE,
  };
  const row = { id: 'T', cageTable: 1, status: 'open', wantHouse: false, claims: [], releases: [], lastChainRound: 1, holders: [out, w1, w2].map((p) => ({ cageId: hex(id(p)), kind: 'player', left: p === out, epoch: 1, released: false })),
    entries: [{ seq: 5, rounds: [5], lines: [{ id: hex(id(out)), delta: -4 }, { id: hex(id(w1)), delta: -2 }, { id: hex(id(w2)), delta: 6 }] }] };
  const plan = planTable(row, chain, { knownRound: 1n });
  assert.equal(plan.blocked, null); assert.equal(plan.entries.length, 1);
  const naive = entry(1, 2, row.entries[0].lines.map((l) => ({ is_some: true, value: { id: Buffer.from(l.id, 'hex'), debit: l.delta < 0 ? BigInt(-l.delta) * NIGHT : 0n, credit: l.delta > 0 ? BigInt(l.delta) * NIGHT : 0n } })));
  assert.throws(() => w.call(w.judge, 'settleBatch', one(naive), w.now), /stand has run out/, 'without the rule the whole entry fails');
  const e = plan.entries[0];
  w.call(w.judge, 'settleBatch', one(entry(1, e.roundNo, e.lines.map((l) => ({ is_some: true, value: { id: Buffer.from(l.id, 'hex'), debit: l.debit, credit: l.credit } })))), w.now);
  assert.equal(w.bal(out), 100n * NIGHT); assert.equal(w.seat(out).atRisk, 50n * NIGHT, 'atRisk untouched');
  assert.equal(w.bal(w1), 98n * NIGHT); assert.equal(w.bal(w2), 102n * NIGHT, 'the winner got what the others lost');
  assert.equal(w.state().tables.lookup(1n).lastRound, 2n);
  w.call(out, 'withdraw', 100n * NIGHT); assert.equal(w.bal(out), 0n);
});

test('a standing loser can\'t stall away a finished round: the plan keeps the table alive through the hold, then the loss lands before the stand runs out', () => {
  const w = world(); const loser = player(), winner = player();
  for (const p of [loser, winner]) { fund(w, p); sit(w, p, 1, 50n * NIGHT); }
  const chainNow = () => {
    const L = w.state();
    return { table: { lastRound: L.tables.lookup(1n).lastRound, heartbeat: L.tables.lookup(1n).heartbeat, epoch: L.epochs.lookup(1n), seated: L.seats.lookup(1n).read() },
      seats: new Map([...L.seat].map(([k, s]) => [hex(k), { ...s, atRisk: L.risks.lookup(k) }])),
      balance: (x) => { const k = Buffer.from(x, 'hex'); return L.balance.member(k) ? L.balance.lookup(k) : 0n; }, payTo: () => null, nowSecs: w.now, escapeSecs: ESCAPE };
  };
  const row = (lastChainRound) => ({ id: 'T', cageTable: 1, status: 'open', live: true, wantHouse: false, claims: [], releases: [], lastChainRound, holders: [loser, winner].map((p) => ({ cageId: hex(id(p)), kind: 'player', left: false, epoch: 1, released: false })),
    entries: [{ seq: 1, rounds: [1], lines: [{ id: hex(id(loser)), delta: -5 }, { id: hex(id(winner)), delta: 5 }] }] });
  const land = (e) => w.call(w.judge, 'settleBatch', one(entry(1, e.roundNo, e.lines.map((l) => ({ is_some: true, value: { id: Buffer.from(l.id, 'hex'), debit: l.debit, credit: l.credit } })))), w.now);
  w.at(T0 + 100n); stand(w, loser, 1);
  const standAt = w.seat(loser).standAt; let round = 0n, carried = 0;
  for (let at = T0 + 200n; at < standAt + ESCAPE - HOLD_MARGIN_SECS; at += 100n) { // the loser never finishes: the Worker never says they have left
    w.at(at);
    const plan = planTable(row(Number(round)), chainNow(), { knownRound: round });
    assert.equal(plan.dead, null); assert.equal(plan.hold, true); assert.equal(plan.entries.length, 0);
    if (plan.keepAlive) { land(plan.keepAlive); round = plan.keepAlive.roundNo; carried += 1; assert.equal(w.seat(loser).standing, true, 'the zero line did not free them'); }
  }
  w.at(standAt + ESCAPE - HOLD_MARGIN_SECS);
  const plan = planTable(row(Number(round)), chainNow(), { knownRound: round });
  assert.equal(plan.hold, false); assert.deepEqual(plan.dropped, []);
  land(plan.entries[0]);
  assert.equal(w.bal(loser), 95n * NIGHT, 'the loss landed'); assert.equal(w.bal(winner), 105n * NIGHT); assert.equal(w.seat(loser), null);
  assert.ok(carried > 0, 'the table needed carrying, so this shows what it means to show');
});

// ---------- the rehearsal, step by step: what docs/CAGE-V4-REHEARSAL.md tells the owner to expect ----------
test('the preprod rehearsal, in the simulator, with its real parameters and numbers', () => {
  const contract = new Contract(witnesses);
  const a = player(), b = player();
  const init = contract.initialState(createConstructorContext({ sk: b32() }, COIN), id(a), id(a), 0n, CAP, ESCAPE, SEATS, SLACK, DELAY, MAXGRANT);
  let ctx = createCircuitContext(sampleContractAddress(), COIN, init.currentContractState.data, a, undefined, undefined, Number(T0));
  let now = T0; const behind = 60n; // cage.mjs declares a minute behind the clock
  const call = (who, name, ...args) => { const cc = { ...ctx, currentPrivateState: who }; cc.currentQueryContext.block = { ...cc.currentQueryContext.block, secondsSinceEpoch: now }; const r = contract.impureCircuits[name](cc, ...args); ctx = r.context; return r; };
  const L = () => ledger(ctx.currentQueryContext.state);
  const until = T0 + 86_400n;
  // 2, 3, 4. a is the judge. It proposes b. The new key can't accept early, and can once judgeDelay has passed from the declared time.
  assert.equal(hex(L().judge), hex(id(a)));
  call(a, 'proposeJudge', id(b), now - behind);
  const asked = now - behind;
  now = asked + DELAY - 1n; assert.throws(() => call(b, 'acceptJudge'), /timelock/);
  now = asked + DELAY; call(b, 'acceptJudge');
  assert.equal(hex(L().judge), hex(id(b))); assert.equal(L().hasPending, false);
  assert.throws(() => call(a, 'proposeJudge', id(a), now - behind), /judge only/);
  // 5, 6. b, the judge, deposits with a permit for itself (cap 2, so floor 3), and sits at cards to be the other side of the settle
  call(b, 'deposit', b.addr, 5n * NIGHT, id(b), 2n * NIGHT, until);
  assert.deepEqual({ cap: L().permits.lookup(id(b)).cap, floor: L().permits.lookup(id(b)).floor }, { cap: 2n * NIGHT, floor: 3n * NIGHT });
  // 5b. L1: a permit one second over maxGrant is refused when it is built, so nothing is sent and nothing changes
  assert.equal(L().maxGrant, MAXGRANT);
  assert.throws(() => call(a, 'deposit', a.addr, 10n * NIGHT, id(b), 5n * NIGHT, now + MAXGRANT + 1n), /a permit runs at most maxGrant/);
  assert.equal(L().balance.member(id(a)), false); assert.equal(L().payTo.member(id(a)), false);
  call(b, 'sit', 2n, 5n * NIGHT, now - behind);
  assert.equal(L().seats.lookup(2n).read(), 1n); assert.equal(L().risks.lookup(id(b)), 5n * NIGHT, 'its own sit is not held to its permit');
  // 7. a deposits 10 with a cap of 5, for exactly maxGrant: 720 hours, on the bound
  call(a, 'deposit', a.addr, 10n * NIGHT, id(b), 5n * NIGHT, now + MAXGRANT);
  assert.equal(L().permits.lookup(id(a)).floor, 5n * NIGHT); assert.equal(L().balance.lookup(id(a)), 10n * NIGHT); assert.equal(L().permits.lookup(id(a)).until, now + MAXGRANT);
  // 8. refused: over the cap
  assert.throws(() => call(b, 'seatByJudge', id(a), NO_FROM, 1n, 6n * NIGHT, now - behind), /over the permit's cap/);
  // 9. F5: refused, a's permit is live
  assert.throws(() => call(b, 'rescue', id(a)), /a permit is live: rescue after it runs out/);
  // 10. b seats a at dice, table 1, with no signature from a
  call(b, 'seatByJudge', id(a), NO_FROM, 1n, 4n * NIGHT, now - behind);
  assert.deepEqual({ t: L().seat.lookup(id(a)).table, e: L().seat.lookup(id(a)).epoch, r: L().risks.lookup(id(a)), n: L().seats.lookup(1n).read() }, { t: 1n, e: 1n, r: 4n * NIGHT, n: 1n });
  // 11. dice to cards, in one transaction: seatByJudge with a from-table
  call(b, 'seatByJudge', id(a), fromT(1n), 2n, 5n * NIGHT, now - behind);
  assert.deepEqual({ t: L().seat.lookup(id(a)).table, r: L().risks.lookup(id(a)), d: L().seats.lookup(1n).read(), c: L().seats.lookup(2n).read() }, { t: 2n, r: 5n * NIGHT, d: 0n, c: 2n });
  // 12. a settle at cards: a loses 2
  now += 120n; call(b, 'settleBatch', one(entry(2, 1, [line(a, 2n * NIGHT), line(b, 0n, 2n * NIGHT)])), now - behind);
  assert.equal(L().balance.lookup(id(a)), 8n * NIGHT); assert.equal(L().balance.lookup(id(b)), 7n * NIGHT); assert.equal(L().risks.lookup(id(a)), 3n * NIGHT);
  assert.equal(L().tables.lookup(2n).lastRound, 1n);
  // 13. a withdraw is refused while seated
  assert.throws(() => call(a, 'withdraw', NIGHT), /seated/);
  // 14. a revokes while seated: a deposit of 0 with the empty permit. The seat stays, no money moves
  call(a, 'deposit', ...REVOKE);
  assert.equal(L().permits.member(id(a)), false); assert.equal(L().balance.lookup(id(a)), 8n * NIGHT);
  assert.deepEqual({ t: L().seat.lookup(id(a)).table, s: L().seat.lookup(id(a)).standing, r: L().risks.lookup(id(a)) }, { t: 2n, s: false, r: 3n * NIGHT });
  // 15. refused: no permit now
  assert.throws(() => call(b, 'seatByJudge', id(a), fromT(2n), 1n, NIGHT, now - behind), /no permit/);
  // 16. a stands
  call(a, 'stand', 2n, now - behind);
  assert.equal(L().seat.lookup(id(a)).standing, true);
  // 17. a settle of nothing naming a frees the seat
  now += 120n; call(b, 'settleBatch', one(entry(2, 2, [line(a)])), now - behind);
  assert.equal(L().seat.member(id(a)), false); assert.equal(L().seats.lookup(2n).read(), 1n); assert.equal(L().tables.lookup(2n).lastRound, 2n);
  // 18. a withdraws everything
  call(a, 'withdraw', 8n * NIGHT);
  assert.equal(L().balance.lookup(id(a)), 0n);
  // 19. b stands, and the stand ends b's permit
  call(b, 'stand', 2n, now - behind);
  assert.equal(L().seat.lookup(id(b)).standing, true); assert.equal(L().permits.member(id(b)), false);
  // 20, 21. a settle naming b frees it, and b takes its money home
  now += 120n; call(b, 'settleBatch', one(entry(2, 3, [line(b)])), now - behind);
  assert.equal(L().seat.member(id(b)), false); assert.equal(L().tables.lookup(2n).lastRound, 3n);
  call(b, 'withdraw', 7n * NIGHT);
  assert.equal(L().balance.lookup(id(b)), 0n); assert.equal(L().seats.lookup(2n).read(), 0n);
});
