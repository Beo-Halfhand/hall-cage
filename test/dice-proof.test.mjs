// dice-proof, simulator and circuit checker. No network and no proofs here: real proofs are in scripts/dice-rounds.mjs, on preprod.
// Two levels of "refused":
//   - refused(): the contract's own code refuses, which is what an honest client sees before it spends anything.
//   - the checker tests at the end run a cheat's code, with the refusals taken out or the source changed, and hand what it produces to
//     the same check the proof server runs before proving. That's the level that matters: it doesn't care what the client's code did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createCircuitContext, createConstructorContext, proofDataIntoSerializedPreimage, QueryContext, CostModel, sampleContractAddress } from 'cage-l8/runtime';
import * as zkir from '@midnight-ntwrk/zkir-v2';
import * as J from '../scripts/dice-fair.mjs';

const root = new URL('../', import.meta.url).pathname;
const dir = `${root}contracts/managed/dice-proof/`;
const { Contract, ledger, pureCircuits: P, Phase, Verdict, Why, SeatKind } = await import('../contracts/managed/dice-proof/contract/index.js');

const COIN = '00'.repeat(32), T0 = 1_900_000_000n, ZERO = new Uint8Array(32);
const SEAL = 300n, OPEN = 180n, CALL = 900n, HOUSE = 180n, ANSWER = 300n, SLACK = 60n;
const SEAL_ALL = SEAL + SLACK; // from a round's declared time to the end of its seal window
const b32 = () => new Uint8Array(randomBytes(32));
const hex = (u) => Buffer.from(u).toString('hex');
const witnesses = {
  seatKey: ({ privateState }) => [privateState, privateState.sk ?? ZERO],
  cupSeed: ({ privateState }) => [privateState, privateState.seed ?? ZERO],
};
const runs = [];
const addr = sampleContractAddress();
const selfOf = (a) => new Uint8Array(Buffer.from(a, 'hex'));
const SELF = selfOf(addr);

function world(contract = new Contract(witnesses), address = addr) {
  const house = { sk: b32() };
  const init = contract.initialState(createConstructorContext({}, COIN), P.keyId(house.sk), SEAL, OPEN, CALL, HOUSE, ANSWER, SLACK);
  let ctx = createCircuitContext(address, COIN, init.currentContractState.data, {}, undefined, undefined, Number(T0));
  let now = T0, label = null;
  const w = {
    house, contract, self: selfOf(address),
    get now() { return now; },
    get ctx() { return ctx; },
    at(t) { now = BigInt(t); return w; },
    wait(s) { now += BigInt(s); return w; },
    as(s) { label = s; return w; },
    build(who, name, ...args) {
      const cc = { ...ctx, currentPrivateState: who };
      cc.currentQueryContext.block = { ...cc.currentQueryContext.block, secondsSinceEpoch: now };
      return contract.impureCircuits[name](cc, ...args);
    },
    call(who, name, ...args) { const r = w.build(who, name, ...args); ctx = r.context; if (label) runs.push({ label, circuit: name, p: r.proofData }); label = null; return r; },
    /** Lands something built earlier, as the chain would: true if the transcript still applies to the state of the moment. */
    land(r) {
      const qc = new QueryContext(ctx.currentQueryContext.state, address);
      qc.block = { ...ctx.currentQueryContext.block, secondsSinceEpoch: now };
      const gas = { readTime: 10n ** 12n, computeTime: 10n ** 12n, bytesWritten: 10n ** 9n, bytesDeleted: 10n ** 9n };
      let after;
      try { after = qc.runTranscript({ gas, effects: r.context.currentQueryContext.effects, program: r.proofData.publicTranscript }, CostModel.initialCostModel()); } catch { return false; }
      ctx = { ...ctx, currentQueryContext: after };
      return true;
    },
    state: () => ledger(ctx.currentQueryContext.state),
  };
  return w;
}

/**
 * Seats a round and optionally rigs one cup's dice by trying seeds, which is the only way to get dice you want: try until the hash
 * obliges. `rig` is { seat, wanted(dice) }. The search needs every other seed fixed first, because each sealed cup moves the salt.
 */
function round(w, { table = 1n, round = 1n, seats = ['house', 'player', 'player'], rig = null } = {}) {
  const id = { table, round };
  const houseSeed = b32();
  const cups = seats.map((kind, s) => (kind === 'empty' ? null : { kind, seat: BigInt(s), seed: b32(), sk: b32(), cup: { table, round, seat: BigInt(s) } }));
  const SELF_W = w.self;
  const seal = (c) => (c ? P.commitOf(c.seed, c.cup, SELF_W) : ZERO);
  const vec = () => Array.from({ length: 6 }, (_, s) => seal(cups[s] ?? null));
  const saltNow = () => J.saltOf(houseSeed, id, vec(), SELF_W);
  if (rig) {
    const c = cups[rig.seat];
    for (let i = 0; ; i++) {
      assert.ok(i < 2_000_000, 'no seed found');
      c.seed = b32();
      const cs = cups.map((x) => (x === null ? ZERO : J.commitOf(x.seed, x.cup, SELF_W)));
      while (cs.length < 6) cs.push(ZERO);
      if (rig.wanted(J.diceOf(J.rollOf(J.saltOf(houseSeed, id, cs, SELF_W), c.seed, Number(c.seat))))) break;
    }
  }
  const init = Array.from({ length: 6 }, (_, s) => {
    const c = cups[s];
    if (!c) return { kind: SeatKind.empty, holder: ZERO, seal: ZERO };
    if (c.kind === 'house') return { kind: SeatKind.house, holder: ZERO, seal: seal(c) };
    return { kind: SeatKind.player, holder: P.keyId(c.sk), seal: P.preSealOf(seal(c), c.cup) };
  });
  const rd = {
    id, houseSeed, cups, init, saltNow,
    live: () => cups.filter(Boolean),
    players: () => cups.filter((c) => c?.kind === 'player'),
    bots: () => cups.filter((c) => c?.kind === 'house'),
    open: () => w.call(w.house, 'openRound', id, P.houseCommitOf(houseSeed, id), init, w.now),
    seal: (c) => w.call(c, 'commitCup', c.cup, seal(c)),
    reveal: () => w.call({}, 'openHouse', id, houseSeed),
    salt: () => w.state().rounds.lookup(id).salt,
    dice: (c) => P.diceOf(P.rollOf(rd.salt(), c.seed, c.seat)),
    count: (c, face) => P.countOf(rd.dice(c), BigInt(face)),
    total: (face) => rd.live().reduce((n, c) => n + rd.count(c, face), 0n),
    call: (bidder, caller, count, face) => w.call(w.house, 'callLiar', id, BigInt(bidder), BigInt(caller), BigInt(count), BigInt(face), w.now),
    prove: (c, face) => w.call(c, 'proveCount', c.cup, rd.count(c, face)),
    show: (c) => w.call(c, 'showCup', c.cup, rd.dice(c)),
    finish: () => w.call({}, 'finish', id),
    result: () => w.state().results.lookup(id),
    phase: () => w.state().rounds.lookup(id).phase,
  };
  return rd;
}
/** Opened, sealed and revealed: bidding can start. */
function dealt(w, opts) { const rd = round(w, opts); rd.open(); for (const c of rd.players()) rd.seal(c); rd.reveal(); return rd; }
const refused = (fn, re) => assert.throws(fn, (e) => { assert.match(String(e?.message ?? e), re); return true; });

// ---------- honest rounds ----------

test('honest round: the bid holds, and the chain says so from the proofs alone', () => {
  const w = world();
  const rd = dealt(w, { rig: { seat: 1, wanted: (d) => J.countOf(d, 4) >= 2 } });
  assert.equal(rd.phase(), Phase.dealt);
  const total = rd.total(4);
  rd.call(1, 2, total, 4);
  w.as('proveCount: house seat'); rd.prove(rd.cups[0], 4);
  w.as('proveCount: player'); rd.prove(rd.cups[1], 4);
  rd.prove(rd.cups[2], 4);
  w.as('finish: holds'); rd.finish();
  assert.deepEqual({ ...rd.result() }, { verdict: Verdict.holds, why: Why.counted, total, answered: 3n });
  assert.equal(rd.phase(), Phase.finished);
});

test('honest round: the bid falls, by exactly one die', () => {
  const w = world();
  const rd = dealt(w);
  const total = rd.total(5);
  rd.call(0, 1, total + 1n, 5);
  for (const c of rd.live()) rd.prove(c, 5);
  w.as('finish: falls'); rd.finish();
  assert.equal(rd.result().verdict, Verdict.falls);
  assert.equal(rd.result().why, Why.counted);
  assert.equal(rd.result().total, total);
});

test('honest rounds at every table size, and with no house seats', () => {
  for (const seats of [['house', 'player'], ['player', 'player'], ['house', 'house', 'player', 'player'], ['house', 'house', 'house', 'house', 'house', 'player'], ['player', 'player', 'player', 'player', 'player', 'player'], ['empty', 'player', 'empty', 'house', 'empty', 'player']]) {
    const w = world();
    const rd = dealt(w, { seats });
    const live = rd.live();
    const total = rd.total(3);
    rd.call(live[0].seat, live[1].seat, total || 1, 3);
    for (const c of rd.bots()) rd.prove(c, 3);
    for (const c of rd.players()) rd.prove(c, 3);
    rd.finish();
    assert.equal(rd.result().total, total, seats.join());
    assert.equal(rd.result().verdict, total >= 1n ? Verdict.holds : Verdict.falls);
  }
});

test('a seat can choose to show: its dice go on chain, and only its own', () => {
  const w = world();
  const rd = dealt(w, { rig: { seat: 0, wanted: (d) => J.countOf(d, 6) >= 1 } });
  const [bot, a, b] = rd.cups;
  rd.call(1, 2, rd.total(6), 6);
  w.as('showCup: house seat'); rd.show(bot);
  w.as('showCup: player'); rd.show(a);
  rd.prove(b, 6);
  const L = w.state();
  assert.deepEqual(L.answers.lookup(a.cup).dice, rd.dice(a));
  assert.equal(L.answers.lookup(a.cup).shown, true);
  assert.equal(L.answers.lookup(a.cup).count, rd.count(a, 6));
  assert.equal(L.answers.lookup(b.cup).shown, false);
  assert.deepEqual(L.answers.lookup(b.cup).dice, [0n, 0n, 0n, 0n, 0n], 'a shut cup holds no dice');
  rd.finish();
  assert.equal(rd.result().verdict, Verdict.holds);
});

test('nobody has to wait once what is proven settles it, either way', () => {
  const w = world();
  const rd = dealt(w, { rig: { seat: 0, wanted: (d) => J.countOf(d, 2) === 5 } });
  rd.call(1, 2, 3, 2);
  rd.prove(rd.cups[0], 2);
  w.as('finish: holds early'); rd.finish();
  assert.equal(rd.result().verdict, Verdict.holds);
  assert.equal(rd.result().answered, 1n, 'the two players never had to prove anything');

  const x = world();
  const low = dealt(x, { rig: { seat: 0, wanted: (d) => J.countOf(d, 2) === 0 } });
  low.call(1, 2, 11, 2);
  low.prove(low.cups[0], 2);
  x.as('finish: falls early'); low.finish();
  assert.equal(low.result().verdict, Verdict.falls, 'two silent cups can make at most 10');
  assert.equal(low.result().why, Why.counted);
});

// ---------- a house that tries to swap dice after the deal ----------

test('swap: a house seat cannot answer from any seed but the sealed one', () => {
  const w = world();
  const rd = dealt(w);
  const bot = rd.cups[0];
  rd.call(1, 2, 1, 4);
  const other = { seed: b32() };
  const claim = P.countOf(P.diceOf(P.rollOf(rd.salt(), other.seed, bot.seat)), 4n);
  refused(() => w.call(other, 'proveCount', bot.cup, claim), /not the seed sealed/);
  refused(() => w.call(other, 'showCup', bot.cup, P.diceOf(P.rollOf(rd.salt(), other.seed, bot.seat))), /not the seed sealed/);
  rd.prove(bot, 4);
});

test('swap: a sealed cup cannot be sealed again, by anyone', () => {
  const w = world();
  const rd = round(w);
  rd.open();
  const a = rd.cups[1];
  rd.seal(a);
  refused(() => w.call(a, 'commitCup', a.cup, b32()), /already sealed/);
  refused(() => w.call(a, 'commitCup', rd.cups[0].cup, b32()), /no player seat/); // a house seat was sealed at the open
});

test('swap: the house cannot seal a player\'s cup for them', () => {
  const w = world();
  const rd = round(w);
  rd.open();
  refused(() => w.call(w.house, 'commitCup', rd.cups[1].cup, b32()), /belongs to someone else/);
  refused(() => w.call(rd.cups[2], 'commitCup', rd.cups[1].cup, b32()), /belongs to someone else/);
});

test('swap: a round cannot be opened twice, so its seals cannot be replaced', () => {
  const w = world();
  const rd = dealt(w);
  refused(() => w.call(w.house, 'openRound', rd.id, b32(), rd.init, w.now), /already been opened/);
  refused(() => w.call({ sk: b32() }, 'openRound', { table: 9n, round: 9n }, b32(), rd.init, w.now), /house only/);
});

test('swap: the house can only open the seed it sealed, and only once, and only after the players have sealed', () => {
  const w = world();
  const rd = round(w);
  rd.open();
  rd.seal(rd.cups[1]);
  refused(() => rd.reveal(), /can still seal/);
  rd.seal(rd.cups[2]);
  refused(() => w.call({}, 'openHouse', rd.id, b32()), /not the seed the house sealed/);
  w.as('openHouse: everyone sealed'); rd.reveal();
  assert.deepEqual(w.state().rounds.lookup(rd.id).houseSeed, rd.houseSeed);
  refused(() => w.call({}, 'openHouse', rd.id, b32()), /not waiting to open/);
  refused(() => rd.reveal(), /not waiting to open/);
});

test('swap: nothing can be sealed once the seed is open, so nobody can seal after seeing it', () => {
  const w = world();
  const rd = round(w, { seats: ['player', 'player', 'player'] });
  rd.open();
  rd.seal(rd.cups[0]);
  rd.seal(rd.cups[1]);
  w.wait(SEAL_ALL);
  rd.reveal(); // the third player missed the window
  refused(() => rd.seal(rd.cups[2]), /deal has closed/);
});

test('swap: a sealed seed is tied to its round and seat, so an old proof or seat cannot be replayed', () => {
  const w = world();
  const one = dealt(w, { round: 1n });
  one.call(1, 2, 1, 4);
  one.prove(one.cups[0], 4);
  one.prove(one.cups[1], 4);
  refused(() => one.prove(one.cups[1], 4), /already answered/);
  // The same seed in another seat of the same round doesn't open that seat's seal.
  refused(() => w.call({ seed: one.cups[1].seed }, 'proveCount', one.cups[2].cup, 0n), /not the seed sealed/);
  // Next round: the old seed doesn't open the new seal.
  const two = dealt(w, { round: 2n });
  two.call(1, 2, 1, 4);
  two.prove(two.cups[0], 4);
  refused(() => w.call({ seed: one.cups[1].seed }, 'proveCount', two.cups[1].cup, 0n), /not the seed sealed/);
});

test('the house commits before it can know any die: every sealed cup moves every other cup\'s dice', () => {
  const w = world();
  const a = round(w, { seats: ['house', 'player'] });
  const before = J.diceOf(J.rollOf(a.saltNow(), a.cups[0].seed, 0));
  a.cups[1].seed = b32(); // the player picks another seed, which the house can't see or predict
  const after = J.diceOf(J.rollOf(a.saltNow(), a.cups[0].seed, 0));
  assert.notDeepEqual(before, after, 'the house seat\'s own dice depend on what the player sealed');
  // And the chain's order is fixed: no cup can be sealed before the house has sealed its seed and its own seats.
  const w2 = world();
  const rd = round(w2, { seats: ['house', 'player'] });
  refused(() => rd.seal(rd.cups[1]), /no such round/);
});

test('the salt on chain takes in every seat, the last as well as the first', () => {
  const w = world();
  const rd = dealt(w, { seats: ['house', 'player', 'player', 'player', 'player', 'player'] });
  const cups = Array.from({ length: 6 }, (_, s) => P.commitOf(rd.cups[s].seed, rd.cups[s].cup, SELF));
  assert.equal(hex(rd.salt()), hex(J.saltOf(rd.houseSeed, rd.id, cups, SELF)));
  for (let s = 0; s < 6; s += 1) assert.deepEqual(w.state().commits.lookup(rd.cups[s].cup), cups[s]);
  // An empty seat counts as zero, in its own place.
  const x = world();
  const gap = dealt(x, { seats: ['empty', 'player', 'empty', 'house', 'empty', 'player'] });
  assert.equal(hex(gap.salt()), hex(J.saltOf(gap.houseSeed, gap.id, Array.from({ length: 6 }, (_, s) => (gap.cups[s] ? P.commitOf(gap.cups[s].seed, gap.cups[s].cup, SELF) : ZERO)), SELF)));
});

test('there is no answering or finishing without a call, or after the round has finished', () => {
  const w = world();
  const rd = round(w);
  rd.open();
  const a = rd.cups[1];
  refused(() => w.call(a, 'proveCount', a.cup, 0n), /no call to answer/);
  refused(() => rd.finish(), /no call to finish/);
  for (const c of rd.players()) rd.seal(c);
  rd.reveal();
  refused(() => w.call(a, 'proveCount', a.cup, 0n), /no call to answer/);
  refused(() => w.call(a, 'showCup', a.cup, rd.dice(a)), /no call to answer/);
  refused(() => rd.finish(), /no call to finish/);
  rd.call(1, 2, 1, 4);
  refused(() => w.call({ seed: b32() }, 'proveCount', { ...rd.id, seat: 5n }, 0n), /no cup at this seat/);
  for (const c of rd.live()) rd.prove(c, 4);
  rd.finish();
  refused(() => rd.finish(), /no call to finish/);
  refused(() => rd.call(1, 2, 1, 4), /no open bidding/);
  refused(() => w.call({}, 'finish', { table: 7n, round: 7n }), /no such round/);
  refused(() => w.call({}, 'openHouse', { table: 7n, round: 7n }, b32()), /no such round/);
});

test('no seat can try seeds: a player\'s seal is named when the round opens, before anyone\'s can be read', () => {
  // What the review did: a "player" seat whose key the house holds waits for the honest player to seal, then tries seeds until the bot's
  // dice are all 1s, with everything but its own seal already public. It finds one, and it can't post it.
  const w = world();
  const rd = round(w, { seats: ['house', 'player', 'player'] });
  rd.open();
  const [bot, honest, sock] = rd.cups;
  rd.seal(honest);
  let grind = null;
  for (let i = 0; i < 2_000_000 && !grind; i += 1) {
    const seed = b32();
    const cups = [P.commitOf(bot.seed, bot.cup, SELF), P.commitOf(honest.seed, honest.cup, SELF), J.commitOf(seed, sock.cup, SELF), ZERO, ZERO, ZERO];
    if (J.diceOf(J.rollOf(J.saltOf(rd.houseSeed, rd.id, cups, SELF), bot.seed, 0)).every((d) => d === 1)) grind = seed;
  }
  assert.ok(grind, 'the search itself still works');
  refused(() => w.call(sock, 'commitCup', sock.cup, P.commitOf(grind, sock.cup, SELF)), /not the seal named/);
  // All it can still do is keep its seal back, and then the round goes on without it. That's a choice of two, not a choice of any.
  w.wait(SEAL_ALL);
  rd.reveal();
  assert.equal(w.state().rounds.lookup(rd.id).dealt, 2n);
});

test('a seat\'s named seal can\'t be lifted to another seat or round', () => {
  const w = world();
  const rd = round(w, { seats: ['player', 'player'] });
  rd.open();
  const [a, b] = rd.cups;
  // b tries a's seal, which it can see once a posts it. It was never what b named.
  rd.seal(a);
  refused(() => w.call(b, 'commitCup', b.cup, P.commitOf(a.seed, a.cup, SELF)), /not the seal named/);
  assert.notEqual(hex(P.preSealOf(ZERO, a.cup)), hex(P.preSealOf(ZERO, b.cup)));
  assert.notEqual(hex(P.preSealOf(ZERO, a.cup)), hex(P.preSealOf(ZERO, { ...a.cup, round: 2n })));
});

test('a player seat has to name its seal\'s hash when the round opens', () => {
  const w = world();
  const rd = round(w);
  const seats = rd.init.map((x) => ({ ...x }));
  seats[1].seal = ZERO;
  refused(() => w.call(w.house, 'openRound', rd.id, P.houseCommitOf(rd.houseSeed, rd.id), seats, w.now), /holder and the hash of its seal/);
  const noKey = rd.init.map((x) => ({ ...x }));
  noKey[2].holder = ZERO;
  refused(() => w.call(w.house, 'openRound', rd.id, P.houseCommitOf(rd.houseSeed, rd.id), noKey, w.now), /holder and the hash of its seal/);
  const noSeal = rd.init.map((x) => ({ ...x }));
  noSeal[0].seal = ZERO;
  refused(() => w.call(w.house, 'openRound', rd.id, P.houseCommitOf(rd.houseSeed, rd.id), noSeal, w.now), /sealed when the round opens/);
  refused(() => w.call(w.house, 'openRound', rd.id, ZERO, rd.init, w.now), /must seal a seed/);
});

test('another deployment gives other seals and other dice, even from the same ids and seeds', () => {
  const seed = b32(), houseSeed = b32(), id = { table: 1n, round: 1n }, cup = { ...id, seat: 1n }, cups = Array.from({ length: 6 }, () => b32());
  const [s1, s2] = [b32(), b32()];
  assert.notEqual(hex(P.saltOf(houseSeed, id, cups, s1)), hex(P.saltOf(houseSeed, id, cups, s2)));
  assert.notEqual(hex(P.commitOf(seed, cup, s1)), hex(P.commitOf(seed, cup, s2)));
  assert.notEqual(hex(P.preSealOf(P.commitOf(seed, cup, s1), cup)), hex(P.preSealOf(P.commitOf(seed, cup, s2), cup)));
  const other = sampleContractAddress();
  assert.notEqual(other, addr);
  const w = world(new Contract(witnesses), other);
  const rd = dealt(w, { seats: ['house', 'player'] });
  const cupSeals = [P.commitOf(rd.cups[0].seed, rd.cups[0].cup, selfOf(other)), P.commitOf(rd.cups[1].seed, rd.cups[1].cup, selfOf(other)), ZERO, ZERO, ZERO, ZERO];
  assert.equal(hex(rd.salt()), hex(J.saltOf(rd.houseSeed, rd.id, cupSeals, selfOf(other))));
  // The whole round works on the other deployment, with its own address in every seal.
  rd.call(1, 0, 1, 4);
  rd.prove(rd.cups[0], 4);
  rd.prove(rd.cups[1], 4);
  rd.finish();
  assert.ok(w.state().results.member(rd.id));
});

test('a seal for a decoy deployment can\'t be reused here: the review\'s way of bringing the grind back', () => {
  const w = world();
  const rd = round(w, { seats: ['house', 'player'] });
  const a = rd.cups[1];
  const decoy = b32();
  const leaked = P.commitOf(a.seed, a.cup, decoy); // what a page would post if a house pointed it at a decoy first
  assert.notEqual(hex(leaked), hex(P.commitOf(a.seed, a.cup, w.self)));
  assert.notEqual(hex(P.preSealOf(leaked, a.cup)), hex(rd.init[1].seal));
  rd.open();
  refused(() => w.call(a, 'commitCup', a.cup, leaked), /not the seal named/);
});

test('a zero seal is refused: it would count as sealed, move nothing, and could never answer', () => {
  const w = world();
  const rd = round(w, { seats: ['house', 'player', 'player'] });
  const seats = rd.init.map((x) => ({ ...x }));
  seats[2].seal = P.preSealOf(ZERO, rd.cups[2].cup);
  w.call(w.house, 'openRound', rd.id, P.houseCommitOf(rd.houseSeed, rd.id), seats, w.now);
  refused(() => w.call(rd.cups[2], 'commitCup', rd.cups[2].cup, ZERO), /must be sealed with a commitment/);
});

test('the time for a call is fixed when the round opens, and whoever opens the seed can\'t move it', () => {
  const w = world();
  const rd = round(w);
  rd.open();
  const R0 = w.state().rounds.lookup(rd.id);
  assert.equal(R0.callBy, R0.openBy + CALL);
  for (const c of rd.players()) rd.seal(c);
  rd.reveal();
  assert.equal(w.state().rounds.lookup(rd.id).callBy, R0.callBy, 'opening the seed doesn\'t touch it');
});

// ---------- a wrong count claim ----------

test('wrong count: one more or one fewer is refused, for a player and for the house', () => {
  const w = world();
  const rd = dealt(w);
  rd.call(1, 2, 1, 3);
  for (const c of [rd.cups[0], rd.cups[1], rd.cups[2]]) {
    const n = rd.count(c, 3);
    refused(() => w.call(c, 'proveCount', c.cup, n + 1n), /not this cup's count/);
    if (n > 0n) refused(() => w.call(c, 'proveCount', c.cup, n - 1n), /not this cup's count/);
    refused(() => w.call(c, 'proveCount', c.cup, 200n), /not this cup's count/);
    rd.prove(c, 3);
  }
});

test('wrong count: a count for another face is refused unless it happens to be the same', () => {
  const w = world();
  const rd = dealt(w, { rig: { seat: 1, wanted: (d) => J.countOf(d, 4) !== J.countOf(d, 5) } });
  rd.call(1, 2, 1, 4);
  const a = rd.cups[1];
  rd.prove(rd.cups[0], 4);
  refused(() => w.call(a, 'proveCount', a.cup, rd.count(a, 5)), /not this cup's count/);
});

test('wrong dice: showing any other dice is refused, even with the same count', () => {
  const w = world();
  const rd = dealt(w, { rig: { seat: 1, wanted: (d) => new Set(d).size > 1 } });
  rd.call(1, 2, 1, 4);
  rd.prove(rd.cups[0], 4);
  const a = rd.cups[1];
  const d = rd.dice(a);
  const reordered = [...d.slice(1), d[0]];
  assert.notDeepEqual(reordered, d);
  refused(() => w.call(a, 'showCup', a.cup, reordered), /not this cup's dice/);
});

test('the bid and the result are not claims: the count is added from what was proven, and finish takes no argument', () => {
  const w = world();
  const rd = dealt(w);
  rd.call(1, 2, 1, 4);
  refused(() => w.call({}, 'finish', rd.id, Verdict.holds), /argument/); // it takes the round and nothing else
  refused(() => w.call(w.house, 'callLiar', rd.id, 1n, 2n, 1n, 4n, w.now), /no open bidding/);
});

test('the call itself: the face, the count and the seats have to make sense', () => {
  const w = world();
  const rd = dealt(w);
  refused(() => rd.call(1, 2, 1, 1), /face from 2 to 6/);
  refused(() => rd.call(1, 2, 1, 7), /face from 2 to 6/);
  refused(() => rd.call(1, 2, 0, 4), /between 1 die/);
  refused(() => rd.call(1, 2, 16, 4), /between 1 die/);
  refused(() => rd.call(1, 1, 1, 4), /own bid/);
  refused(() => rd.call(1, 5, 1, 4), /caller has no cup/);
  refused(() => rd.call(5, 1, 1, 4), /bidder has no cup/);
  refused(() => w.call({ sk: b32() }, 'callLiar', rd.id, 1n, 2n, 1n, 4n, w.now), /house only/);
  w.as('callLiar'); rd.call(1, 2, 15, 4);
});

// ---------- a player who never reveals their seed: the timeout rules ----------

function silent(w, { silentSeats, face = 4 }) {
  // Seat 0 is the house's. Seats 1 and 2 are the bidder and the caller, and 3 a third party. The bid is one more than the answering
  // cups can show, so only the silent cups could make it: nothing is settled until the window closes.
  const rd = dealt(w, { seats: ['house', 'player', 'player', 'player'] });
  const answering = rd.live().filter((c) => !silentSeats.includes(Number(c.seat)));
  const known = answering.reduce((n, c) => n + rd.count(c, face), 0n);
  rd.call(1, 2, known + 1n, face);
  for (const c of answering) rd.prove(c, face);
  refused(() => rd.finish(), /can still answer/);
  return rd;
}

test('timeout: a third seat never answers. Nobody can finish until the window closes, then the round is void, and it shows', () => {
  const w = world();
  const rd = dealt(w, { seats: ['house', 'player', 'player', 'player'] });
  const face = 4, total = rd.total(face);
  const missing = rd.count(rd.cups[3], face);
  const known = total - missing;
  rd.call(1, 2, known + 1n, face);
  for (const s of [0, 1, 2]) rd.prove(rd.cups[s], face);
  refused(() => rd.finish(), /can still answer/);
  w.wait(HOUSE + ANSWER - 1n);
  refused(() => rd.finish(), /can still answer/);
  w.wait(1n);
  refused(() => rd.prove(rd.cups[3], face), /window has closed/);
  w.as('finish: a third seat silent'); rd.finish();
  assert.equal(rd.result().verdict, Verdict.voided);
  assert.equal(rd.result().why, Why.thirdSilent);
  assert.equal(rd.phase(), Phase.voided);
  assert.equal(w.state().answers.member(rd.cups[3].cup), false, 'the silent cup is plain to see');
});

test('timeout: a bidder who never answers loses the call', () => {
  const w = world();
  const rd = silent(w, { silentSeats: [1] });
  w.wait(HOUSE + ANSWER);
  w.as('finish: the bidder silent'); rd.finish();
  assert.equal(rd.result().verdict, Verdict.falls);
  assert.equal(rd.result().why, Why.bidderSilent);
});

test('timeout: a caller who never answers loses the call', () => {
  const w = world();
  const rd = silent(w, { silentSeats: [2] });
  w.wait(HOUSE + ANSWER);
  w.as('finish: the caller silent'); rd.finish();
  assert.equal(rd.result().verdict, Verdict.holds);
  assert.equal(rd.result().why, Why.callerSilent);
});

test('timeout: bidder and caller both silent: void', () => {
  const w = world();
  const rd = silent(w, { silentSeats: [1, 2] });
  w.wait(HOUSE + ANSWER);
  w.as('finish: both silent'); rd.finish();
  assert.equal(rd.result().verdict, Verdict.voided);
  assert.equal(rd.result().why, Why.bothSilent);
});

test('timeout: a silent bot can\'t save the house from a call it would lose', () => {
  // The bot bids and a player calls. The other bot goes quiet: with its cup missing, the count can't settle. That loses it for the house.
  const w = world();
  const rd = dealt(w, { seats: ['house', 'house', 'player'] });
  const [bidder, quiet, caller] = rd.cups;
  const known = rd.count(bidder, 4) + rd.count(caller, 4);
  rd.call(0, 2, known + 1n, 4);
  rd.prove(bidder, 4);
  w.wait(HOUSE);
  refused(() => rd.prove(quiet, 4), /house's answer window has closed/);
  rd.prove(caller, 4);
  refused(() => rd.finish(), /can still answer/);
  w.wait(ANSWER);
  w.as('finish: a bot silent, the house bid'); rd.finish();
  assert.equal(rd.result().verdict, Verdict.falls);
  assert.equal(rd.result().why, Why.houseSeatSilent);

  // A player bids and a bot calls: the same silence makes the bid hold.
  const x = world();
  const r2 = dealt(x, { seats: ['house', 'house', 'player'] });
  const k2 = r2.count(r2.cups[0], 4) + r2.count(r2.cups[2], 4);
  r2.call(2, 0, k2 + 1n, 4);
  r2.prove(r2.cups[0], 4);
  x.wait(HOUSE);
  r2.prove(r2.cups[2], 4);
  x.wait(ANSWER);
  x.as('finish: a bot silent, the house called'); r2.finish();
  assert.equal(r2.result().verdict, Verdict.holds);
  assert.equal(r2.result().why, Why.houseSeatSilent);
});

test('timeout: when the silent seat isn\'t the house\'s, or the house is on both sides or neither, the round is void', () => {
  // Players on both sides, a bot silent: it isn't the house's call to lose.
  const a = world();
  const r1 = dealt(a, { seats: ['house', 'player', 'player'] });
  r1.call(1, 2, r1.count(r1.cups[1], 4) + r1.count(r1.cups[2], 4) + 1n, 4);
  a.wait(HOUSE);
  r1.prove(r1.cups[1], 4);
  r1.prove(r1.cups[2], 4);
  a.wait(ANSWER);
  r1.finish();
  assert.equal(r1.result().why, Why.thirdSilent);
  // The house on both sides, a bot silent, a player's cup counted: void, and the player's stake goes back.
  const b = world();
  const r2 = dealt(b, { seats: ['house', 'house', 'house', 'player'] });
  const k = r2.count(r2.cups[0], 4) + r2.count(r2.cups[1], 4) + r2.count(r2.cups[3], 4);
  r2.call(0, 1, k + 1n, 4);
  r2.prove(r2.cups[0], 4);
  r2.prove(r2.cups[1], 4);
  b.wait(HOUSE);
  r2.prove(r2.cups[3], 4);
  b.wait(ANSWER);
  r2.finish();
  assert.equal(r2.result().why, Why.thirdSilent);
  // A player's third seat silent, the house on one side: void. This is the lever a second wallet still has: see docs/DICE-PROOF.md.
  const c = world();
  const r3 = dealt(c, { seats: ['house', 'player', 'player'] });
  r3.call(0, 1, r3.count(r3.cups[0], 4) + r3.count(r3.cups[1], 4) + 1n, 4);
  r3.prove(r3.cups[0], 4);
  r3.prove(r3.cups[1], 4);
  c.wait(HOUSE + ANSWER);
  r3.finish();
  assert.equal(r3.result().why, Why.thirdSilent);
});

test('timeout: a call can\'t be held back until a player has gone', () => {
  // The review's delayed call: a player calls at the table, closes the page, and the house posts the call days later and wins on silence.
  const w = world();
  const rd = dealt(w);
  const R = w.state().rounds.lookup(rd.id);
  assert.equal(R.callBy, R.openBy + CALL);
  refused(() => w.call({}, 'voidRound', rd.id), /still has time for a call/);
  w.at(R.callBy - 1n);
  refused(() => w.call({}, 'voidRound', rd.id), /still has time for a call/);
  w.at(R.callBy);
  refused(() => rd.call(1, 2, 1, 4), /time for a call has passed/);
  w.as('voidRound: no call'); w.call({}, 'voidRound', rd.id);
  assert.equal(rd.result().why, Why.noCall);
  assert.equal(rd.phase(), Phase.voided);
  assert.equal(w.state().houseFaults, 0n, 'an uncontested round looks the same from outside, so it isn\'t counted against anyone');
  refused(() => rd.call(1, 2, 1, 4), /no open bidding/);
  refused(() => w.call({}, 'voidRound', rd.id), /can't be voided/);
});

test('a round in play can\'t be voided', () => {
  const w = world();
  const rd = dealt(w);
  rd.call(1, 2, 1, 4);
  w.wait(CALL * 4n);
  refused(() => w.call({}, 'voidRound', rd.id), /can't be voided/);
});

test('the seal window can\'t be shortened by back-dating: a player gets all of it, even from the stalest time allowed', () => {
  const w = world();
  const rd = round(w);
  const back = SLACK - 1n;
  w.at(T0 + back); // the block is ahead of what the house declares, by as much as the contract lets it be
  w.call(w.house, 'openRound', rd.id, P.houseCommitOf(rd.houseSeed, rd.id), rd.init, T0);
  const opened = w.now;
  w.wait(SEAL - 1n);
  assert.ok(w.now - opened < SEAL);
  w.as('commitCup: at the end of the window'); rd.seal(rd.cups[1]);
  rd.seal(rd.cups[2]);
  assert.equal(w.state().rounds.lookup(rd.id).sealBy, T0 + SLACK + SEAL);
});

test('timeout: silence can\'t rescue a bid that what\'s proven has already settled', () => {
  const w = world();
  const rd = dealt(w, { rig: { seat: 0, wanted: (d) => J.countOf(d, 4) === 0 } });
  rd.call(1, 2, 11, 4);
  rd.prove(rd.cups[0], 4);
  // The bidder goes quiet to avoid a loss. It doesn't need waiting for: two silent cups can't make 11.
  rd.finish();
  assert.equal(rd.result().verdict, Verdict.falls);
  assert.equal(rd.result().why, Why.counted);
});

test('timeout: a player who never seals is simply not dealt in', () => {
  const w = world();
  const rd = round(w, { seats: ['house', 'player', 'player'] });
  rd.open();
  rd.seal(rd.cups[1]);
  refused(() => rd.reveal(), /can still seal/);
  w.wait(SEAL_ALL);
  refused(() => rd.seal(rd.cups[2]), /too late to seal/);
  w.as('openHouse: a player missed the seal'); rd.reveal();
  const R = w.state().rounds.lookup(rd.id);
  assert.equal(R.dealt, 2n);
  refused(() => rd.call(1, 2, 1, 4), /caller has no cup/);
  refused(() => rd.call(1, 0, 11, 4), /between 1 die/);
  w.as('callLiar: two cups dealt of three'); rd.call(1, 0, 10, 4);
});

test('timeout: if no player seals, there is no round', () => {
  const w = world();
  const rd = round(w);
  rd.open();
  w.wait(SEAL_ALL);
  w.as('openHouse: no player sealed'); rd.reveal();
  assert.equal(rd.result().verdict, Verdict.voided);
  assert.equal(rd.result().why, Why.tooFewCups);
  assert.equal(w.state().houseFaults, 0n, 'the house did nothing wrong');
});

test('timeout: a house that never opens its seed: anyone can void the round, and it counts against the house', () => {
  const w = world();
  const rd = round(w);
  rd.open();
  for (const c of rd.players()) rd.seal(c);
  refused(() => w.call({}, 'voidRound', rd.id), /still has time/);
  w.wait(SEAL_ALL + OPEN - 1n);
  refused(() => w.call({}, 'voidRound', rd.id), /still has time/);
  w.wait(1n);
  refused(() => rd.reveal(), /missed its window/);
  w.as('voidRound'); w.call({}, 'voidRound', rd.id);
  assert.equal(rd.result().why, Why.houseSilent);
  assert.equal(w.state().houseFaults, 1n);
  refused(() => w.call({}, 'voidRound', rd.id), /can't be voided/);
});

test('the house answers first, so it can\'t go quiet after seeing a player\'s count', () => {
  const w = world();
  const rd = dealt(w);
  const [bot, a] = rd.cups;
  rd.call(1, 2, 1, 4);
  refused(() => rd.prove(a, 4), /house's seats answer first/);
  w.as('proveCount: player, after the house seat'); rd.prove(bot, 4);
  rd.prove(a, 4);
});

test('a house seat that misses its window can\'t answer late, and the players aren\'t held up', () => {
  const w = world();
  const rd = dealt(w);
  const [bot, a, b] = rd.cups;
  rd.call(1, 2, rd.count(a, 4) + rd.count(b, 4) + 1n, 4);
  w.wait(HOUSE);
  refused(() => rd.prove(bot, 4), /house's answer window has closed/);
  w.as('proveCount: player, the house seat silent'); rd.prove(a, 4);
  rd.prove(b, 4);
  w.wait(ANSWER);
  w.as('finish: a house seat silent'); rd.finish();
  assert.equal(rd.result().why, Why.thirdSilent);
  assert.equal(rd.result().verdict, Verdict.voided);
});

test('the windows can\'t be shortened: the house can\'t declare a time in the future, or a stale one', () => {
  const w = world();
  const rd = round(w);
  refused(() => w.call(w.house, 'openRound', rd.id, P.houseCommitOf(rd.houseSeed, rd.id), rd.init, w.now + 1n), /in the future/);
  refused(() => w.call(w.house, 'openRound', rd.id, P.houseCommitOf(rd.houseSeed, rd.id), rd.init, w.now - SLACK), /stale/);
  rd.open();
  for (const c of rd.players()) rd.seal(c);
  rd.reveal();
  refused(() => w.call(w.house, 'callLiar', rd.id, 1n, 2n, 1n, 4n, w.now + 1n), /in the future/);
  refused(() => w.call(w.house, 'callLiar', rd.id, 1n, 2n, 1n, 4n, w.now - SLACK), /stale/);
  w.call(w.house, 'callLiar', rd.id, 1n, 2n, 1n, 4n, w.now);
  const R = w.state().rounds.lookup(rd.id);
  assert.equal(R.houseBy, w.now + HOUSE);
  assert.equal(R.answerBy, w.now + HOUSE + ANSWER);
});

test('a round needs a player and two seats: with no player every seed would be the house\'s', () => {
  const w = world();
  refused(() => dealt(w, { seats: ['house', 'house'] }), /needs a player/);
  refused(() => dealt(w, { seats: ['player'] }), /two seats/);
});

test('the deployment: bad windows are refused, and nothing here can change them', () => {
  const c = new Contract(witnesses);
  const go = (seal, open, call, house, answer, slack) => c.initialState(createConstructorContext({}, COIN), b32(), seal, open, call, house, answer, slack);
  const ok = [240n, 180n, 900n, 240n, 240n, 180n];
  go(...ok);
  refused(() => go(240n, 180n, 900n, 3600n, 240n, 301n), /clock slack must be/); // with a house window long enough that only the slack's own limit can refuse it
  go(240n, 180n, 900n, 360n, 240n, 300n);
  go(120n, 60n, 300n, 90n, 120n, 30n);
  go(3600n, 3600n, 14400n, 3600n, 3600n, 300n);
  for (const [at, bad, re] of [
    [5, 0n, /clock slack must be/], [5, 29n, /clock slack must be/],
    [0, 119n, /seal window/], [0, 3601n, /seal window/],
    [1, 59n, /open window/], [1, 3601n, /open window/],
    [2, 299n, /call window/], [2, 14401n, /call window/],
    [3, 239n, /house's answer window/], [3, 3601n, /house's answer window/],
    [4, 119n, /players' answer window/], [4, 3601n, /players' answer window/],
    [4, 2n ** 62n, /players' answer window/],
  ]) {
    const a = [...ok];
    a[at] = bad;
    refused(() => go(...a), re);
  }
  const circuits = Object.keys(c.impureCircuits).sort();
  assert.deepEqual(circuits, ['callLiar', 'commitCup', 'finish', 'openHouse', 'openRound', 'proveCount', 'showCup', 'voidRound']);
});

// ---------- 1s wild ----------

test('1s wild: a cup of five 1s counts five for every face', () => {
  const w = world();
  const rd = dealt(w, { rig: { seat: 1, wanted: (d) => d.every((x) => x === 1) } });
  assert.deepEqual(rd.dice(rd.cups[1]), [1n, 1n, 1n, 1n, 1n]);
  for (const f of [2n, 3n, 4n, 5n, 6n]) assert.equal(P.countOf(rd.dice(rd.cups[1]), f), 5n);
  rd.call(1, 2, 5, 6);
  rd.prove(rd.cups[0], 6);
  w.as('proveCount: five wilds'); w.call(rd.cups[1], 'proveCount', rd.cups[1].cup, 5n);
  rd.finish();
  assert.equal(rd.result().verdict, Verdict.holds);
});

test('1s wild: wilds and the face add up, and the other faces don\'t count', () => {
  const w = world();
  const rd = dealt(w, { rig: { seat: 2, wanted: (d) => d.filter((x) => x === 1).length === 2 && d.filter((x) => x === 5).length === 2 && !d.includes(6) } });
  const c = rd.cups[2];
  rd.call(1, 2, 1, 5);
  rd.prove(rd.cups[0], 5);
  refused(() => w.call(c, 'proveCount', c.cup, 2n), /not this cup's count/); // the 5s without the 1s
  refused(() => w.call(c, 'proveCount', c.cup, 5n), /not this cup's count/);
  w.as('proveCount: two 1s and two 5s'); w.call(c, 'proveCount', c.cup, 4n);
});

test('1s wild: every possible cup, every face, against plain arithmetic', () => {
  for (let n = 0; n < 6 ** 5; n += 1) {
    const d = [1, 6, 36, 216, 1296].map((p) => (Math.floor(n / p) % 6) + 1);
    const dd = d.map(BigInt);
    for (const f of [2, 3, 4, 5, 6]) assert.equal(Number(P.countOf(dd, BigInt(f))), d.filter((x) => x === f || x === 1).length);
  }
});

test('nobody can bid on the wild itself', () => {
  const w = world();
  const rd = dealt(w);
  refused(() => rd.call(1, 2, 1, 1), /face from 2 to 6/);
  refused(() => rd.call(1, 2, 1, 0), /face from 2 to 6/);
});

// ---------- the arithmetic ----------

test('dice: every word lands on a face, and no face is off by more than 1 part in 16,384', () => {
  const tally = [0, 0, 0, 0, 0, 0, 0];
  for (let hi = 0; hi < 256; hi++) {
    for (let lo = 0; lo < 256; lo++) {
      const d = P.dieOf(BigInt(hi), BigInt(lo));
      assert.ok(d >= 1n && d <= 6n);
      assert.equal(Number(d), J.dieOf(hi, lo));
      tally[Number(d)] += 1;
    }
  }
  assert.deepEqual(tally.slice(1), [10923, 10923, 10922, 10923, 10923, 10922]);
  for (const n of tally.slice(1)) assert.ok(Math.abs(n * 6 - 65536) / 65536 <= 1 / 16384);
});

test('dice: uniform over real rolls, 20,000 cups', () => {
  const tally = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 20000; i++) for (const d of J.diceOf(J.rollOf(b32(), b32(), i % 6))) tally[d] += 1;
  for (const n of tally.slice(1)) assert.ok(Math.abs(n - 100000 / 6) < 600, `face count ${n}`); // five standard deviations
});

test('plain JavaScript matches the circuits, bit for bit', () => {
  for (let i = 0; i < 200; i++) {
    const seed = b32(), other = b32(), id = { table: BigInt(1 + (i * 7919) % 100000), round: BigInt(1 + i) }, seat = BigInt(i % 6), cup = { ...id, seat };
    assert.equal(hex(J.keyId(seed)), hex(P.keyId(seed)));
    assert.equal(hex(J.houseCommitOf(seed, id)), hex(P.houseCommitOf(seed, id)));
    assert.equal(hex(J.commitOf(seed, cup, other)), hex(P.commitOf(seed, cup, other)));
    const cups = Array.from({ length: 6 }, (_, k) => (k === i % 6 ? ZERO : b32()));
    assert.equal(hex(J.preSealOf(other, cup)), hex(P.preSealOf(other, cup)));
    assert.equal(hex(J.saltOf(seed, id, cups, other)), hex(P.saltOf(seed, id, cups, other)));
    const roll = P.rollOf(other, seed, seat);
    assert.equal(hex(J.rollOf(other, seed, seat)), hex(roll));
    assert.deepEqual(J.diceOf(roll).map(BigInt), P.diceOf(roll));
  }
});

test('the vectors the Worker tests against are current', () => {
  const v = JSON.parse(readFileSync(new URL('./dice-vectors.json', import.meta.url), 'utf8'));
  assert.ok(v.length >= 5);
  const un = (s) => new Uint8Array(Buffer.from(s, 'hex'));
  for (const x of v) {
    const id = { table: BigInt(x.table), round: BigInt(x.round) }, cup = { ...id, seat: BigInt(x.seat) };
    assert.equal(hex(P.keyId(un(x.seed))), x.keyId);
    assert.equal(hex(P.houseCommitOf(un(x.houseSeed), id)), x.houseCommit);
    assert.equal(hex(P.commitOf(un(x.seed), cup, un(x.self))), x.commit);
    assert.equal(hex(P.preSealOf(un(x.commit), cup)), x.preseal);
    assert.equal(hex(P.saltOf(un(x.houseSeed), id, x.cups.map(un), un(x.self))), x.salt);
    assert.equal(hex(P.rollOf(un(x.salt), un(x.seed), cup.seat)), x.roll);
    assert.deepEqual(P.diceOf(un(x.roll)).map(Number), x.dice);
  }
});

// ---------- privacy ----------

const scan = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v));

test('a shut cup: its seed appears nowhere public, in the ledger or in anything the proof server is told to publish', () => {
  const w = world();
  const rd = dealt(w);
  const [bot, a, b] = rd.cups;
  rd.call(1, 2, 1, 4);
  rd.prove(bot, 4);
  const r = w.build(a, 'proveCount', a.cup, rd.count(a, 4));
  const seed = hex(a.seed);
  const pub = scan({ input: r.proofData.input, output: r.proofData.output, transcript: r.proofData.publicTranscript });
  assert.equal(pub.includes(seed), false, 'the seed is not in the public part of the proof data');
  assert.equal(scan(r.proofData.privateTranscriptOutputs).includes(seed), true, 'the same scan does find it in the private part, so the scan works');
  w.land(r);
  rd.prove(b, 4);
  rd.finish();
  const L = w.state();
  const onChain = scan([...L.commits].concat([...L.answers], [...L.rounds], [...L.results]));
  for (const c of [bot, a, b]) assert.equal(onChain.includes(hex(c.seed)), false, 'no seed in the ledger');
  assert.equal(L.answers.lookup(a.cup).shown, false);
  assert.deepEqual(L.answers.lookup(a.cup).dice, [0n, 0n, 0n, 0n, 0n], 'no dice in the ledger');
  // What the chain knows about a shut cup is its count of one face.
  assert.equal(L.answers.lookup(a.cup).count, rd.count(a, 4));
});

test('the same-block case: seats answering at once don\'t knock each other out', () => {
  const w = world();
  const rd = dealt(w, { seats: ['player', 'player', 'player'] });
  rd.call(0, 1, 1, 4);
  const [a, b, c] = rd.cups;
  const ra = w.build(a, 'proveCount', a.cup, rd.count(a, 4));
  const rb = w.build(b, 'showCup', b.cup, rd.dice(b));
  const rc = w.build(c, 'proveCount', c.cup, rd.count(c, 4));
  assert.equal(w.land(rc), true);
  assert.equal(w.land(ra), true);
  assert.equal(w.land(rb), true);
  assert.equal(w.state().results.member(rd.id), false);
  rd.finish();
  assert.equal(rd.result().total, rd.total(4));
  // Sealing too.
  const x = world();
  const s = round(x, { seats: ['player', 'player'] });
  s.open();
  const r0 = x.build(s.cups[0], 'commitCup', s.cups[0].cup, P.commitOf(s.cups[0].seed, s.cups[0].cup, SELF));
  const r1 = x.build(s.cups[1], 'commitCup', s.cups[1].cup, P.commitOf(s.cups[1].seed, s.cups[1].cup, SELF));
  assert.equal(x.land(r1), true);
  assert.equal(x.land(r0), true);
});

test('a stale build can\'t land: each of these would otherwise change what the chain says', () => {
  // A finish built before another cup's answer lands. Its count is out of date, so it's refused, and a new one says the right thing.
  const w = world();
  const rd = dealt(w, { rig: { seat: 0, wanted: (d) => J.countOf(d, 4) >= 1 } });
  rd.call(1, 2, 1, 4);
  rd.prove(rd.cups[0], 4);
  const early = w.build({}, 'finish', rd.id);
  rd.prove(rd.cups[1], 4);
  assert.equal(w.land(early), false);
  rd.finish();
  assert.equal(rd.result().answered, 2n);

  // A seal built in time that lands after the seed opened. It can't move the salt.
  const x = world();
  const s = round(x);
  s.open();
  s.seal(s.cups[1]);
  const late = x.build(s.cups[2], 'commitCup', s.cups[2].cup, P.commitOf(s.cups[2].seed, s.cups[2].cup, SELF));
  x.wait(SEAL_ALL);
  s.reveal();
  const salt = s.salt();
  assert.equal(x.land(late), false);
  assert.deepEqual(s.salt(), salt);

  // An answer built in time that lands after the window. It's refused when it lands, whatever the client thought.
  const y = world();
  const t = dealt(y);
  t.call(1, 2, 1, 4);
  const slow = y.build(t.cups[0], 'proveCount', t.cups[0].cup, t.count(t.cups[0], 4));
  y.wait(HOUSE);
  assert.equal(y.land(slow), false);
  assert.equal(y.state().answers.member(t.cups[0].cup), false);
});

// ---------- the circuit checker: what a cheat's own code can get past ----------

const cache = new Map();
const keysFor = (name) => cache.get(name) ?? (cache.set(name, zkir.jsonIrToBinary(readFileSync(`${dir}zkir/${name}.zkir`, 'utf8'))), cache.get(name));
const provider = {
  async lookupKey(c) { return { ir: keysFor(c), proverKey: new Uint8Array(), verifierKey: new Uint8Array() }; },
  async getParams() { throw new Error('checking needs no parameters'); },
};
const check = (name, r) => zkir.check(proofDataIntoSerializedPreimage(r.proofData.input, r.proofData.output, r.proofData.publicTranscript, r.proofData.privateTranscriptOutputs, name), provider);
const failsCheck = async (name, r) => { await assert.rejects(check(name, r), `the checker must refuse this ${name}`); };

/** The compiled contract with every refusal taken out: what a cheat gets by editing the JavaScript. */
const CHEAT = `${root}contracts/managed/dice-proof-cheat`;
mkdirSync(CHEAT, { recursive: true });
writeFileSync(`${CHEAT}/index.js`, readFileSync(`${dir}contract/index.js`, 'utf8').replaceAll('__compactRuntime.assert(', '((..._a) => {})('));
const cheat = await import(`${CHEAT}/index.js`);

function cheatWorld(prepare) {
  // The honest contract gets the round to the point of the attack. Then the cheat's code builds on the same state.
  const w = world();
  const rd = prepare(w);
  const bad = new cheat.Contract(witnesses);
  const build = (who, name, ...args) => {
    const cc = { ...w.ctx, currentPrivateState: who };
    cc.currentQueryContext.block = { ...cc.currentQueryContext.block, secondsSinceEpoch: w.now };
    return bad.impureCircuits[name](cc, ...args);
  };
  return { w, rd, build };
}
const called = (w, opts) => { const rd = dealt(w, opts); rd.call(1, 2, 15, 4); return rd; };

test('checker: first, the honest answer passes, through the cheat\'s code too, so the refusals below mean something', async () => {
  const { rd, build } = cheatWorld(called);
  const bot = rd.cups[0];
  await check('proveCount', build(bot, 'proveCount', bot.cup, rd.count(bot, 4)));
  await check('showCup', build(bot, 'showCup', bot.cup, rd.dice(bot)));
});

test('checker: a swapped seed is refused, whatever the client\'s code says', async () => {
  const { rd, build } = cheatWorld(called);
  const bot = rd.cups[0], other = { seed: b32() };
  const count = P.countOf(P.diceOf(P.rollOf(rd.salt(), other.seed, bot.seat)), 4n);
  await failsCheck('proveCount', build(other, 'proveCount', bot.cup, count));
  await failsCheck('showCup', build(other, 'showCup', bot.cup, P.diceOf(P.rollOf(rd.salt(), other.seed, bot.seat))));
});

test('checker: a wrong count is refused, one more and one fewer', async () => {
  const { rd, build } = cheatWorld(called);
  const bot = rd.cups[0], n = rd.count(bot, 4);
  await failsCheck('proveCount', build(bot, 'proveCount', bot.cup, n + 1n));
  await failsCheck('proveCount', build(bot, 'proveCount', bot.cup, n === 0n ? 2n : n - 1n));
});

test('checker: dice that aren\'t the cup\'s are refused, including with the right seed', async () => {
  const { rd, build } = cheatWorld(called);
  const bot = rd.cups[0], d = rd.dice(bot);
  await failsCheck('showCup', build(bot, 'showCup', bot.cup, d.map((x) => (x === 6n ? 5n : x + 1n))));
  await failsCheck('showCup', build(bot, 'showCup', bot.cup, [1n, 1n, 1n, 1n, 1n].some((x, i) => x !== d[i]) ? [1n, 1n, 1n, 1n, 1n] : [2n, 2n, 2n, 2n, 2n]));
});

test('checker: a different house seed is refused', async () => {
  const { rd, build } = cheatWorld((x) => { const r = round(x); r.open(); for (const c of r.players()) r.seal(c); return r; });
  await failsCheck('openHouse', build({}, 'openHouse', rd.id, b32()));
  await check('openHouse', build({}, 'openHouse', rd.id, rd.houseSeed));
});

test('checker: sealing a player\'s cup without their key is refused, and so is the house\'s work without the house key', async () => {
  const { w, rd, build } = cheatWorld((x) => { const r = round(x); r.open(); return r; });
  const a = rd.cups[1];
  const seal = P.commitOf(a.seed, a.cup, SELF);
  await failsCheck('commitCup', build(w.house, 'commitCup', a.cup, seal));
  await failsCheck('commitCup', build(a, 'commitCup', a.cup, b32())); // the right key, and not the seal it named
  await check('commitCup', build(a, 'commitCup', a.cup, seal));
  const other = { table: 9n, round: 9n };
  await failsCheck('openRound', build({ sk: b32() }, 'openRound', other, b32(), rd.init, w.now));
  await check('openRound', build(w.house, 'openRound', other, b32(), rd.init, w.now));
});

test('checker: finishing early, or answering after the window, is refused', async () => {
  const { w, rd, build } = cheatWorld(called);
  await failsCheck('finish', build({}, 'finish', rd.id));
  const a = rd.cups[1];
  await failsCheck('proveCount', build(a, 'proveCount', a.cup, rd.count(a, 4))); // the house seat hasn't answered yet
  w.wait(HOUSE + ANSWER);
  await failsCheck('proveCount', build(a, 'proveCount', a.cup, rd.count(a, 4))); // too late
});

// A house that runs a changed circuit, not just a changed client. Each is a real compile of a changed source. The transcript it produces
// is checked against the real circuit, which is all the chain has: its verifier keys come from the real circuit.
const SOURCE = readFileSync(`${root}contracts/dice-proof.compact`, 'utf8');
const EVIL = {
  'no wilds in the count': ['(d == face || d == 1)', '(d == face)'],
  'a shut cup counts one more': ['record(c, Answer { count: n, shown: false,', 'record(c, Answer { count: (n + 1) as Uint<8>, shown: false,'],
  'finish always says the bid holds': ['if (known >= r.bidCount) close(i, r, Phase.finished, Verdict.holds, Why.counted);', 'if (known >= 0) close(i, r, Phase.finished, Verdict.holds, Why.counted);'],
  'the dice ignore the sealed seed': ['return diceOf(rollOf(r.salt, seed, cup.seat));', 'return diceOf(rollOf(r.salt, default<Bytes<32>>, cup.seat));'],
  'no commitment check': ['assert(disclose(commitOf(seed, cup, kernel.self().bytes) == commits.lookup(cup)), "this is not the seed sealed for this cup");', ''],
  'the salt ignores the players': ['saltOf(seed, i, [sealedAt(i, 0), sealedAt(i, 1), sealedAt(i, 2), sealedAt(i, 3), sealedAt(i, 4), sealedAt(i, 5)], kernel.self().bytes)', 'saltOf(seed, i, default<Vector<6, Bytes<32>>>, kernel.self().bytes)'],
  'a seat can post any seal': ['assert(preSealOf(seal, c) == h.preseal, "this is not the seal named when the round opened");', ''],
  'a silent bot voids a call the house would lose': ['if (houseQuiet && bidderHouse && !callerHouse) close(i, r, Phase.finished, Verdict.falls, Why.houseSeatSilent);', 'if (houseQuiet && bidderHouse && !callerHouse) close(i, r, Phase.voided, Verdict.voided, Why.thirdSilent);'],
};
function compileEvil(name, [from, to]) {
  assert.ok(SOURCE.includes(from), `the mutation "${name}" no longer applies`);
  const d = `${root}contracts/managed/dice-proof-evil/${name.replaceAll(' ', '-')}`;
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(`${d}/src.compact`, SOURCE.replace(from, to));
  execFileSync('compact', ['compile', '--skip-zk', `${d}/src.compact`, `${d}/out`], { stdio: 'pipe' });
  return import(`${d}/out/contract/index.js`);
}
for (const [name, mutation] of Object.entries(EVIL)) {
  test(`checker: a house running its own circuit: ${name}`, { timeout: 120_000 }, async () => {
    const evil = await compileEvil(name, mutation);
    const w = world();
    const bad = new evil.Contract(witnesses);
    const build = (who, circuit, ...args) => {
      const cc = { ...w.ctx, currentPrivateState: who };
      cc.currentQueryContext.block = { ...cc.currentQueryContext.block, secondsSinceEpoch: w.now };
      return bad.impureCircuits[circuit](cc, ...args);
    };
    const rd = name.includes('salt') || name.includes('any seal') || name.includes('silent bot') ? null : dealt(w, { rig: { seat: 0, wanted: (d) => d.includes(1) && d.includes(4) } });
    if (name === 'the salt ignores the players') {
      const r2 = round(w);
      r2.open();
      for (const c of r2.players()) r2.seal(c);
      await failsCheck('openHouse', build({}, 'openHouse', r2.id, r2.houseSeed));
      return;
    }
    if (name === 'a seat can post any seal') {
      const r2 = round(w, { table: 2n });
      r2.open();
      await failsCheck('commitCup', build(r2.cups[1], 'commitCup', r2.cups[1].cup, b32()));
      return;
    }
    if (name === 'a silent bot voids a call the house would lose') {
      const r2 = dealt(w, { table: 3n, seats: ['house', 'house', 'player'] });
      const known = r2.count(r2.cups[0], 4) + r2.count(r2.cups[2], 4);
      r2.call(0, 2, known + 1n, 4); // the bot bids, the player calls, the other bot goes quiet
      r2.prove(r2.cups[0], 4);
      w.wait(HOUSE);
      r2.prove(r2.cups[2], 4);
      w.wait(ANSWER);
      await failsCheck('finish', build({}, 'finish', r2.id));
      return;
    }
    const bot = rd.cups[0];
    rd.call(1, 2, 15, 4);
    if (name === 'finish always says the bid holds') {
      await failsCheck('finish', build({}, 'finish', rd.id));
      return;
    }
    if (name === 'the dice ignore the sealed seed') { // a count could match by chance, but five dice in order won't
      await failsCheck('showCup', build(bot, 'showCup', bot.cup, P.diceOf(P.rollOf(rd.salt(), ZERO, bot.seat))));
      return;
    }
    if (name === 'no commitment check') {
      const other = { seed: b32() };
      await failsCheck('proveCount', build(other, 'proveCount', bot.cup, P.countOf(P.diceOf(P.rollOf(rd.salt(), other.seed, bot.seat)), 4n)));
      return;
    }
    const n = name === 'no wilds in the count' ? evil.pureCircuits.countOf(rd.dice(bot), 4n) : rd.count(bot, 4);
    await failsCheck('proveCount', build(bot, 'proveCount', bot.cup, n));
  });
}

// ---------- every path through the same check, last, so it covers the runs above ----------

test('every circuit took the check on a real path', async () => {
  const w = world();
  w.as('openRound'); const rd = round(w); rd.open();
  w.as('commitCup'); rd.seal(rd.cups[1]); rd.seal(rd.cups[2]);
  rd.reveal();
  w.as('callLiar: a later one'); rd.call(1, 2, 1, 4);
  const x = world(); const v = round(x); v.open(); x.wait(SEAL_ALL + OPEN); x.as('voidRound: house silent'); x.call({}, 'voidRound', v.id);
  const names = readdirSync(`${dir}zkir`).filter((f) => f.endsWith('.zkir')).map((f) => f.replace('.zkir', ''));
  assert.equal(names.length, 8);
  for (const n of names) assert.ok(runs.some((r) => r.circuit === n), `no run of ${n}`);
  for (const r of runs) await zkir.check(proofDataIntoSerializedPreimage(r.p.input, r.p.output, r.p.publicTranscript, r.p.privateTranscriptOutputs, r.circuit), provider);
  assert.ok(runs.length >= 20, `only ${runs.length} paths`);
});
