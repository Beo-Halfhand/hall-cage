// The two holes in cage #3 and the ways round the first attempt at closing them. No network, no proofs.
//
// Each test here must pass on v4 and fail on cage #3. test/attacks-cage3.test.mjs runs this file against cage #3's code and checks
// exactly that. A "landing" below is what the chain does: it runs a transcript built earlier against the state of the moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { batchWidth } from './batch-width.mjs';
import { createConstructorContext, createCircuitContext, sampleContractAddress, QueryContext, CostModel } from 'cage-l8/runtime';
const build = process.env.MANAGED ? resolve(process.env.MANAGED) : new URL('../contracts/managed/sealed-cage', import.meta.url).pathname;
const { Contract, ledger, pureCircuits } = await import(pathToFileURL(`${build}/contract/index.js`).href);
const WIDTH = batchWidth(`${build}/contract/index.js`); // 8 on cage #3, which test/attacks-cage3.test.mjs runs this file against
// v4b: a move is seatByJudge with a from-table, a revoke is a deposit of 0 with the empty permit, and a single settle is a batch of one.
const NO_FROM = { is_some: false, value: 0n }, fromT = (t) => ({ is_some: true, value: BigInt(t) });
const REVOKE = [{ bytes: new Uint8Array(32) }, 0n, new Uint8Array(32), 0n, 0n];
const one = (e) => [{ is_some: true, value: e }, ...Array(WIDTH - 1).fill({ is_some: false, value: e })];

const witnesses = { secretKey: ({ privateState }) => [privateState, privateState.sk] };
const b32 = () => new Uint8Array(randomBytes(32));
const COIN = '00'.repeat(32);
const T0 = 1_900_000_000n, NIGHT = 1_000_000n, CAP = 1000n * NIGHT, ESCAPE = 1800n, SLACK = 300n, SEATS = 6n, DELAY = 2100n, MAXGRANT = 2_592_000n;
const player = () => ({ sk: b32(), addr: { bytes: b32() } });
const id = (p) => pureCircuits.playerId(p.sk);
const NONE_LINE = { is_some: false, value: { id: new Uint8Array(32), debit: 0n, credit: 0n } };
const line = (p, debit = 0n, credit = 0n) => ({ is_some: true, value: { id: id(p), debit, credit } });
const entry = (t, roundNo, lines) => ({ table: BigInt(t), roundNo: BigInt(roundNo), houseCut: 0n, lines: [...lines, ...Array(6 - lines.length).fill(NONE_LINE)] });
const NONE_ENTRY = { is_some: false, value: entry(0, 0, []) };
const batch = (...es) => [...es.map((e) => ({ is_some: true, value: e })), ...Array(WIDTH - es.length).fill(NONE_ENTRY)];

function world() {
  const contract = new Contract(witnesses);
  const judge = { sk: b32() }, addr = sampleContractAddress();
  const init = contract.initialState(createConstructorContext({ sk: b32() }, COIN), id(judge), id(judge), 0n, CAP, ESCAPE, SEATS, SLACK, DELAY, MAXGRANT);
  let ctx = createCircuitContext(addr, COIN, init.currentContractState.data, judge, undefined, undefined, Number(T0));
  let now = T0;
  const w = {
    judge,
    at(t) { now = BigInt(t); return w; }, get now() { return now; },
    /** Builds on the state of the moment, without landing. */
    build(who, name, ...args) { const cc = { ...ctx, currentPrivateState: who }; cc.currentQueryContext.block = { ...cc.currentQueryContext.block, secondsSinceEpoch: now }; return contract.impureCircuits[name](cc, ...args); },
    /** Builds and lands at once. */
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
    seat: (p) => { const L = w.state(); return L.seat.member(id(p)) ? L.seat.lookup(id(p)) : null; },
    round: (t) => w.state().tables.lookup(BigInt(t)).lastRound,
  };
  return w;
}
/** deposit takes a permit since v4, and an empty one changes nothing. On cage #3 it takes two arguments, and these tests have to reach the attack there too. */
const depositOf = (w, p, n) => { try { return w.build(p, 'deposit', p.addr, n, new Uint8Array(32), 0n, 0n); } catch (e) { if (/expected \d+ arguments?/.test(String(e?.message))) return w.build(p, 'deposit', p.addr, n); throw e; } };
const deposit = (w, p, n) => { try { return w.call(p, 'deposit', p.addr, n, new Uint8Array(32), 0n, 0n); } catch (e) { if (/expected \d+ arguments?/.test(String(e?.message))) return w.call(p, 'deposit', p.addr, n); throw e; } };
const sit = (w, p, t, r) => w.call(p, 'sit', BigInt(t), r, w.now);
const refused = (f) => { try { f(); return false; } catch { return true; } };
/** stand takes the declared time since v4. On cage #3 it takes one argument, and these tests have to reach the attack, not an argument error. */
const standOf = (w, p, t) => { try { return w.build(p, 'stand', BigInt(t), w.now); } catch (e) { if (/expected \d+ arguments?/.test(String(e?.message))) return w.build(p, 'stand', BigInt(t)); throw e; } };
const stand = (w, p, t) => { assert.ok(w.land(standOf(w, p, t)), 'the stand landed'); };
function fresh() {
  const w = world();
  const loser = player(), winner = player(), other = player();
  for (const p of [loser, winner, other]) { deposit(w, p, 100n * NIGHT); sit(w, p, 1, 50n * NIGHT); }
  return { w, loser, winner, other };
}
const settleOf = (w, t, n, lines) => w.build(w.judge, 'settleBatch', one(entry(t, n, lines)), w.now);

test('attack A: a seated loser who deposits 1 STAR first cannot make the settle fail', () => {
  const { w, loser, winner } = fresh();
  const settle = settleOf(w, 1, 1, [line(loser, NIGHT), line(winner, 0n, NIGHT)]);
  if (!refused(() => deposit(w, loser, 1n))) assert.fail('the seated loser deposited');
  assert.ok(w.land(settle), 'the settle still lands');
  assert.equal(w.bal(loser), 99n * NIGHT, 'and the loss is taken');
});

test('attack A: a deposit built before sitting, sent after the loss, cannot land and cannot make the settle fail', () => {
  const w = world(); const loser = player(), winner = player();
  for (const p of [loser, winner]) deposit(w, p, 100n * NIGHT);
  const prepared = depositOf(w, loser, 1n);
  for (const p of [loser, winner]) sit(w, p, 1, 50n * NIGHT);
  const settle = settleOf(w, 1, 1, [line(loser, NIGHT), line(winner, 0n, NIGHT)]);
  assert.equal(w.land(prepared), false, 'the prepared deposit must not land: it read "no seat"');
  assert.ok(w.land(settle));
});

test('attack A: a loser at one table cannot fail a whole batch by depositing', () => {
  const { w, loser, winner } = fresh();
  const c = player(), d = player();
  for (const p of [c, d]) { deposit(w, p, 100n * NIGHT); sit(w, p, 2, 50n * NIGHT); }
  const settle = w.build(w.judge, 'settleBatch', batch(entry(1, 1, [line(loser, NIGHT), line(winner, 0n, NIGHT)]), entry(2, 1, [line(c, NIGHT), line(d, 0n, NIGHT)])), w.now);
  if (!refused(() => deposit(w, c, 1n))) assert.fail('the seated loser deposited');
  assert.ok(w.land(settle));
  assert.equal(w.round(1), 1n);
  assert.equal(w.round(2), 1n);
});

test('attack A: the griefing runs out. Of everything a loser and their friends can do, only one stand by the loser breaks a settle', () => {
  const { w, loser, winner } = fresh();
  const friends = Array.from({ length: 10 }, player);
  for (const f of friends) deposit(w, f, NIGHT);
  let stood = false, nextFriend = 0, broken = 0, landed = false;
  for (let attempt = 0; attempt < 40 && !landed; attempt++) {
    w.at(w.now + 1n);
    const settle = settleOf(w, 1, 1, [line(loser, NIGHT), line(winner, 0n, NIGHT)]);
    // the attacker's turn, before the settle lands: the first move that's still allowed
    if (!refused(() => deposit(w, loser, 1n))) { /* moved */ }
    else if (!stood) { stood = true; stand(w, loser, 1); }
    else if (nextFriend < friends.length && !refused(() => sit(w, friends[nextFriend], 1, NIGHT))) nextFriend += 1;
    if (w.land(settle)) landed = true; else broken += 1;
  }
  assert.ok(landed, `the settle never landed in 40 tries (${broken} broken)`);
  assert.ok(broken <= 1, `only the loser's own stand may break a settle, but ${broken} did`);
  assert.equal(w.bal(loser), 99n * NIGHT);
});

test('attack B: a standing seat goes free after escapeSecs, however long the judge keeps the table alive', () => {
  const { w, loser: a, winner: b, other: c } = fresh();
  stand(w, a, 1);
  let round = 1, t = T0;
  for (let i = 0; i < 20; i++) { t += ESCAPE - 60n; w.at(t); w.call(w.judge, 'settleBatch', one(entry(1, round++, [line(b), line(c)])), t); }
  assert.ok(t - T0 > 9n * 3600n, 'nine hours on');
  if (refused(() => w.call(a, 'withdraw', 100n * NIGHT))) assert.fail('nine hours of settles naming others, and the withdraw is still refused');
  assert.equal(w.bal(a), 0n, 'the whole balance came out, not just the part outside atRisk');
});

test('attack B: a stolen judge key cannot push a stand off the chain by landing settles that name others', () => {
  const { w, loser: a, winner: b, other: c } = fresh();
  const built = standOf(w, a, 1);
  w.at(T0 + 30n); w.call(w.judge, 'settleBatch', one(entry(1, 1, [line(b), line(c)])), w.now);
  assert.ok(w.land(built), 'the stand was built before that settle, and it still lands');
  assert.equal(w.seat(a).standing, true);
});

test('attack B: a stolen judge key cannot push the way out off the chain either, once the stand has run out', () => {
  const { w, loser: a, winner: b, other: c } = fresh();
  stand(w, a, 1);
  let round = 1;
  for (const t of [900n, 1500n]) { w.at(T0 + t); w.call(w.judge, 'settleBatch', one(entry(1, round++, [line(b), line(c)])), w.now); }
  w.at(T0 + ESCAPE);
  const out = w.build(a, 'withdraw', 100n * NIGHT);
  w.at(T0 + ESCAPE + 30n); w.call(w.judge, 'settleBatch', one(entry(1, round++, [line(b), line(c)])), w.now);
  assert.ok(w.land(out), 'the withdraw was built before that settle, and it still lands');
  assert.equal(w.bal(a), 0n);
});

test('attack B: the rescue path is just as out of reach', () => {
  const { w, loser: a, winner: b, other: c } = fresh();
  stand(w, a, 1);
  let round = 1;
  for (const t of [900n, 1500n]) { w.at(T0 + t); w.call(w.judge, 'settleBatch', one(entry(1, round++, [line(b), line(c)])), w.now); }
  w.at(T0 + ESCAPE);
  const rescue = w.build(b, 'rescue', id(a));
  w.at(T0 + ESCAPE + 30n); w.call(w.judge, 'settleBatch', one(entry(1, round++, [line(b), line(c)])), w.now);
  assert.ok(w.land(rescue));
  assert.equal(w.bal(a), 0n);
});

test('attack A: a friend who sits at the table cannot make the settle fail', () => {
  const { w, loser, winner } = fresh();
  const friend = player(); deposit(w, friend, NIGHT);
  const settle = settleOf(w, 1, 1, [line(loser, NIGHT), line(winner, 0n, NIGHT)]);
  sit(w, friend, 1, NIGHT);
  assert.ok(w.land(settle), 'the settle lands across a sit at its table');
});

test('attack A: a friend whose stand ran out, leaving for another table, cannot make the settle fail', () => {
  const { w, loser, winner, other } = fresh();
  stand(w, other, 1);
  w.at(T0 + 1000n); w.call(w.judge, 'settleBatch', one(entry(1, 1, [line(loser), line(winner)])), w.now);
  w.at(T0 + ESCAPE);
  const settle = settleOf(w, 1, 2, [line(loser, NIGHT), line(winner, 0n, NIGHT)]);
  sit(w, other, 2, NIGHT);
  assert.ok(w.land(settle), 'the settle lands across the exit from its table');
  assert.equal(w.bal(loser), 99n * NIGHT);
});

test('attack B: a stolen judge key cannot keep a stand off the chain by debiting the seat 1 STAR at a time', () => {
  const { w, loser: a, winner: mule } = fresh();
  const built = standOf(w, a, 1);
  w.at(T0 + 30n); w.call(w.judge, 'settleBatch', one(entry(1, 1, [line(a, 1n), line(mule, 0n, 1n)])), w.now);
  assert.ok(w.land(built), 'the stand lands across a settle that debits this very seat');
  assert.equal(w.seat(a).standing, true);
});

test('attack B: a void seat can leave across settles at the new epoch of its table, with or without its key', () => {
  const w = world(); const a = player(), n1 = player(), n2 = player();
  deposit(w, a, 100n * NIGHT); sit(w, a, 1, 50n * NIGHT);
  for (const p of [n1, n2]) deposit(w, p, 100n * NIGHT);
  w.at(T0 + ESCAPE); // a's table is dead, and a new epoch starts there
  for (const p of [n1, n2]) sit(w, p, 1, NIGHT);
  const out = w.build(a, 'withdraw', NIGHT);
  w.at(T0 + ESCAPE + 30n); w.call(w.judge, 'settleBatch', one(entry(1, 1, [line(n1), line(n2)])), w.now);
  assert.ok(w.land(out), 'the withdraw lands across a settle at the new epoch');
  w.at(T0 + ESCAPE + 60n); w.call(w.judge, 'settleBatch', one(entry(1, 2, [line(n1), line(n2)])), w.now);
  const again = w.build(n1, 'rescue', id(a));
  w.at(T0 + ESCAPE + 90n); w.call(w.judge, 'settleBatch', one(entry(1, 3, [line(n1), line(n2)])), w.now);
  assert.ok(w.land(again), 'a rescue with no key at all does too');
  assert.equal(w.bal(a), 0n);
});
