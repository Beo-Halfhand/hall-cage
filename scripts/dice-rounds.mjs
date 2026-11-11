// dice-proof on PREPROD: deploy it locked, and run real rounds with real proofs on wallets a and b. No money moves, only DUST for fees.
//   node scripts/dice-rounds.mjs balance
//   node scripts/dice-rounds.mjs deploy          [sealSecs openSecs callSecs houseSecs answerSecs slack]
//   node scripts/dice-rounds.mjs verify          the deployment against this source: locked, and every verifier key the same as the local one
//   node scripts/dice-rounds.mjs honest <first table>     a round that holds, one that falls, and 1s wild, at three seats
//   node scripts/dice-rounds.mjs timeouts <first table>   a silent third seat, bidder, caller and bot; a player who never seals; a house that never opens; no call
//   node scripts/dice-rounds.mjs attacks <first table>    a swapped seed and a wrong count at the real proof server; a changed circuit at the real node
//   node scripts/dice-rounds.mjs finish <table> <round…>  close called rounds whose answer window has passed. No key and no dice: anyone can
//
// The driver plays every seat, so it knows every seed: that is how it can check the chain's answer and how it can rig a cup for the 1s test.
// In a real round nobody knows anyone else's seed. Every landed transaction prints a TX line and goes in logs/dice-rounds.jsonl.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { call, compiledFrom, contractModule, cupKey, DEPLOY_FILE, hex, log, nowSec, openWallet, providersFor, rawState, readLedger, receipt, secretFile, sleep, STATE_DIR, stop, unhex, ZK, CompiledContract } from './dice-chain.mjs';
import * as J from './dice-fair.mjs';

const { pureCircuits: P, Phase, Verdict, Why, SeatKind } = contractModule;
const [mode = 'balance', ...args] = process.argv.slice(2);
const b32 = () => new Uint8Array(randomBytes(32));
const ZERO = new Uint8Array(32);
const name = (e, v) => Object.keys(e).find((k) => e[k] === v);

const houseKey = () => secretFile('house.key');
const seatKeyOf = (who) => secretFile(`${who}.seat-key`);

const addressOf = () => JSON.parse(readFileSync(DEPLOY_FILE, 'utf8')).address;
const checks = [];
const expect = (ok, what) => { checks.push({ ok, what }); log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) process.exitCode = 1; };

/** One round's seats. Every wallet here is one driver process's, so `seeds` holds what would really be on three separate machines. */
function plan({ table, round, seats, rig, address }) {
  const self = unhex(address);
  const id = { table: BigInt(table), round: BigInt(round) };
  const houseSeed = b32();
  const cups = seats.map((who, s) => (who === null ? null : { who, seat: BigInt(s), seed: b32(), cup: { ...id, seat: BigInt(s) } }));
  const seal = (c) => J.commitOf(c.seed, c.cup, self);
  const vector = () => Array.from({ length: 6 }, (_, s) => (cups[s] ? seal(cups[s]) : ZERO));
  if (rig) { // only possible because this driver holds every seed
    const c = cups[rig.seat];
    for (let i = 0; i < 2_000_000; i++) {
      c.seed = b32();
      if (rig.wanted(J.diceOf(J.rollOf(J.saltOf(houseSeed, id, vector(), self), c.seed, rig.seat)))) break;
    }
  }
  const init = Array.from({ length: 6 }, (_, s) => {
    const c = cups[s];
    if (!c) return { kind: SeatKind.empty, holder: ZERO, seal: ZERO };
    if (c.who === 'house') return { kind: SeatKind.house, holder: ZERO, seal: seal(c) };
    return { kind: SeatKind.player, holder: P.keyId(seatKeyOf(c.who)), seal: J.preSealOf(seal(c), c.cup) };
  });
  return { id, table, round, houseSeed, cups, init, seal, vector, self, live: () => cups.filter(Boolean) };
}
const privateFor = (c) => ({ sk: c.who === 'house' ? houseKey() : seatKeyOf(c.who), seeds: { [cupKey(c.cup)]: c.seed } });
const walletFor = (c, W) => (c.who === 'b' ? W.b : W.a); // wallet a pays for the house and its seats, and for its own seat

function ops(W, address, p) {
  const tag = (s) => `t${p.table}r${p.round} ${s}`;
  const opt = { address };
  const dice = (c, salt) => J.diceOf(J.rollOf(salt, c.seed, Number(c.seat)));
  return {
    open: () => call(W.a, 'openRound', { sk: houseKey() }, [p.id, J.houseCommitOf(p.houseSeed, p.id), p.init, nowSec()], tag('open: the house seals its seed and its seats'), opt),
    seal: (c) => call(walletFor(c, W), 'commitCup', privateFor(c), [c.cup, p.seal(c)], tag(`seal seat ${c.seat} (${c.who})`), opt),
    reveal: () => call(W.a, 'openHouse', {}, [p.id, p.houseSeed], tag('the house opens its seed'), opt),
    liar: (bidder, caller, count, face) => call(W.a, 'callLiar', { sk: houseKey() }, [p.id, BigInt(bidder), BigInt(caller), BigInt(count), BigInt(face), nowSec()], tag(`call: seat ${caller} calls seat ${bidder}'s ${count} of ${face}`), opt),
    prove: (c, salt, face) => call(walletFor(c, W), 'proveCount', privateFor(c), [c.cup, BigInt(J.countOf(dice(c, salt), face))], tag(`seat ${c.seat} (${c.who}) proves, cup shut`), opt),
    show: (c, salt) => call(walletFor(c, W), 'showCup', privateFor(c), [c.cup, dice(c, salt).map(BigInt)], tag(`seat ${c.seat} (${c.who}) shows`), opt),
    finish: (who) => call(who, 'finish', {}, [p.id], tag('finish: the chain adds it up'), opt),
    voidIt: (who, why = 'the house never opened') => call(who, 'voidRound', {}, [p.id], tag(`void: ${why}`), opt),
  };
}
const readRound = async (address, id) => { const L = await readLedger(address); return { L, R: L.rounds.lookup(id), result: L.results.member(id) ? L.results.lookup(id) : null }; };
async function waitUntil(sec, what) {
  const left = Number(sec) - Math.floor(Date.now() / 1000);
  if (left > 0) { log(`waiting ${left}s: ${what}`); await sleep((left + 5) * 1000); }
}

/** Everything that happens before a call: sealed, opened, read back. Returns the salt. */
async function deal(W, address, p, op, { sealers = null, parallel = true } = {}) {
  await op.open();
  const players = (sealers ?? p.live().filter((c) => c.who !== 'house'));
  if (parallel) await Promise.all(players.map((c) => op.seal(c)));
  else for (const c of players) await op.seal(c);
  await op.reveal();
  const { R } = await readRound(address, p.id);
  expect(R.phase === Phase.dealt, `${p.table}-${p.round}: the chain says dealt`);
  expect(hex(R.houseSeed) === hex(p.houseSeed), `${p.table}-${p.round}: the opened seed is the sealed one`);
  expect(hex(R.salt) === hex(J.saltOf(p.houseSeed, p.id, p.vector(), p.self)), `${p.table}-${p.round}: the chain's salt is what plain arithmetic gets, from everything sealed and this contract's address`);
  return R.salt;
}

async function honest(W, address, first) {
  const table = BigInt(first);
  // Round 1: three seats, the bid holds. Everyone keeps their cup shut, and a and b answer at the same moment.
  {
    const p = plan({ table, round: 1, seats: ['house', 'a', 'b'], address });
    const op = ops(W, address, p);
    const salt = await deal(W, address, p, op);
    const face = 4, [bot, a, b] = p.cups;
    const total = p.live().reduce((n, c) => n + J.countOf(J.diceOf(J.rollOf(salt, c.seed, Number(c.seat))), face), 0);
    const bid = Math.max(total, 1);
    await op.liar(1, 2, bid, face);
    await op.prove(bot, salt, face);
    await Promise.all([op.prove(a, salt, face), op.prove(b, salt, face)]); // the same block, if the chain obliges
    await op.finish(W.b);
    const { R, result, L } = await readRound(address, p.id);
    expect(R.phase === Phase.finished, `${table}-1: finished`);
    expect(Number(result.total) === total, `${table}-1: the chain's total ${result.total} is the dice's total ${total}, and no die went on chain`);
    expect(result.verdict === (total >= bid ? Verdict.holds : Verdict.falls), `${table}-1: the bid of ${bid} ${name(Verdict, result.verdict)}`);
    expect(!L.answers.lookup(a.cup).shown && L.answers.lookup(a.cup).dice.every((d) => d === 0n), `${table}-1: a's cup is still shut on chain`);
  }
  // Round 2: the bid falls by one, with a's cup shown.
  {
    const p = plan({ table, round: 2, seats: ['house', 'a', 'b'], address });
    const op = ops(W, address, p);
    const salt = await deal(W, address, p, op);
    const face = 6, [bot, a, b] = p.cups;
    const diceA = J.diceOf(J.rollOf(salt, a.seed, 1));
    const total = p.live().reduce((n, c) => n + J.countOf(J.diceOf(J.rollOf(salt, c.seed, Number(c.seat))), face), 0);
    await op.liar(0, 1, total + 1, face);
    await op.prove(bot, salt, face);
    await op.show(a, salt);
    await op.prove(b, salt, face);
    await op.finish(W.a);
    const { result, L } = await readRound(address, p.id);
    expect(result.verdict === Verdict.falls && Number(result.total) === total, `${table}-2: the bid of ${total + 1} falls at ${result.total}`);
    expect(L.answers.lookup(a.cup).dice.map(Number).join() === diceA.join(), `${table}-2: a's shown dice on chain are ${L.answers.lookup(a.cup).dice.join(' ')}, the sealed ones`);
    expect(!L.answers.lookup(b.cup).shown, `${table}-2: b's cup stays shut beside it`);
  }
  // Round 3: 1s wild. The driver rigs b's cup, since it holds every seed: three or more wilds and no plain sixes.
  {
    const p = plan({ table, round: 3, seats: ['house', 'a', 'b'], address, rig: { seat: 2, wanted: (d) => d.filter((x) => x === 1).length >= 3 && !d.includes(6) } });
    const op = ops(W, address, p);
    const salt = await deal(W, address, p, op);
    const face = 6, [bot, a, b] = p.cups;
    const diceB = J.diceOf(J.rollOf(salt, b.seed, 2));
    const wilds = diceB.filter((x) => x === 1).length;
    log(`${table}-3: b's rigged cup holds ${wilds} ones and no six`);
    await op.liar(2, 1, wilds, face);
    await op.prove(bot, salt, face);
    await op.prove(b, salt, face);
    const { L } = await readRound(address, p.id);
    expect(Number(L.answers.lookup(b.cup).count) === wilds, `${table}-3: the proof says b holds ${L.answers.lookup(b.cup).count} sixes: all of them wild`);
    await op.finish(W.b); // what's proven already reaches the bid, so a never has to answer
    const { result } = await readRound(address, p.id);
    expect(result.verdict === Verdict.holds && result.why === Why.counted, `${table}-3: the bid of ${wilds} sixes holds on wilds alone, and a never had to answer`);
    void a;
  }
}

async function timeouts(W, address, first) {
  const table = BigInt(first);
  const face = 3;
  const wanted = [];
  // A round with no call comes first: its window is the longest, so the rest of this runs inside it. It can't be closed yet, and at the end a late call is refused.
  const noCall = plan({ table, round: 7, seats: ['house', 'a', 'b'], address });
  const noCallOp = ops(W, address, noCall);
  await deal(W, address, noCall, noCallOp);
  try { await noCallOp.voidIt(W.b, 'no call'); expect(false, 'a void before the call window ended should have been refused'); }
  catch (e) { expect(/still has time for a call/.test(String(e?.message ?? e)), `${table}-7: the round can't be closed while a call could still come: "${String(e?.message ?? e).slice(0, 70)}"`); }

  // A third seat, b, never answers. The bid is one more than the answering cups hold, so only b's cup could make it.
  const silentRound = async (round, seats, silent, bidder, caller) => {
    const p = plan({ table, round, seats, address });
    const op = ops(W, address, p);
    const salt = await deal(W, address, p, op);
    const answering = p.live().filter((c) => !silent.includes(Number(c.seat)));
    const known = answering.reduce((n, c) => n + J.countOf(J.diceOf(J.rollOf(salt, c.seed, Number(c.seat))), face), 0);
    await op.liar(bidder, caller, known + 1, face);
    for (const c of answering.filter((x) => x.who === 'house')) await op.prove(c, salt, face);
    if (p.cups.some((c) => c?.who === 'house' && silent.includes(Number(c.seat)))) { // the players wait out the house's window, as the chain makes them
      await waitUntil((await readRound(address, p.id)).R.houseBy, `the house's window of ${table}-${round}, with a bot quiet`);
    }
    for (const c of answering.filter((x) => x.who !== 'house')) await op.prove(c, salt, face);
    return { p, op };
  };
  const third = await silentRound(1, ['house', 'a', 'b'], [2], 0, 1);
  wanted.push({ ...third, why: Why.thirdSilent, verdict: Verdict.voided, what: 'a third seat never answers: void' });
  const bidder = await silentRound(2, ['house', 'a', 'b'], [2], 2, 1);
  wanted.push({ ...bidder, why: Why.bidderSilent, verdict: Verdict.falls, what: 'the bidder never answers: the bid falls' });
  const caller = await silentRound(3, ['house', 'a', 'b'], [2], 1, 2);
  wanted.push({ ...caller, why: Why.callerSilent, verdict: Verdict.holds, what: 'the caller never answers: the bid holds' });

  // A bot goes quiet to dodge a call the house would lose. The bot bids, a calls, the other bot says nothing. That loses it for the house.
  const quietBot = await silentRound(6, ['house', 'house', 'a'], [1], 0, 2);
  wanted.push({ ...quietBot, why: Why.houseSeatSilent, verdict: Verdict.falls, what: 'a bot goes quiet and the house had bid: the bid falls', silentSeat: 1 });

  // Nobody can finish the last round called yet. The refusal comes from the contract's own code, before anything is sent. Those windows are real
  // minutes, and earlier rounds' have closed by now, so this reads the chain first: run late, it would close the round instead of testing anything.
  const left = Number((await readRound(address, quietBot.p.id)).R.answerBy) - Math.floor(Date.now() / 1000);
  if (left < 60) throw new Error(`${table}-6's answer window has ${left}s left, too late to test an early finish`);
  try { await quietBot.op.finish(W.a); expect(false, 'finish before the window closed should have been refused'); }
  catch (e) { expect(/can still answer/.test(String(e?.message ?? e)), `${table}-6: finish with ${left}s of its window left is refused: "${String(e?.message ?? e).slice(0, 70)}"`); }

  // A seat tries to swap its seal for another after the round opened: the grinding the named seal stops. It's refused before anything is sent.
  const grind = plan({ table, round: 8, seats: ['house', 'a', 'b'], address });
  const grindOp = ops(W, address, grind);
  await grindOp.open();
  try { await call(W.b, 'commitCup', privateFor(grind.cups[2]), [grind.cups[2].cup, new Uint8Array(randomBytes(32))], `${table}-8 a different seal`, { address }); expect(false, 'a different seal should have been refused'); }
  catch (e) { expect(/not the seal named/.test(String(e?.message ?? e)), `${table}-8: a seal other than the one named is refused: "${String(e?.message ?? e).slice(0, 70)}"`); }

  // A player never seals: the round goes on without them once the window closes.
  const noSeal = plan({ table, round: 4, seats: ['house', 'a', 'b'], address });
  const noSealOp = ops(W, address, noSeal);
  await noSealOp.open();
  await noSealOp.seal(noSeal.cups[1]);
  // A house never opens its seed.
  const noOpen = plan({ table, round: 5, seats: ['house', 'a', 'b'], address });
  const noOpenOp = ops(W, address, noOpen);
  await noOpenOp.open();
  await noOpenOp.seal(noOpen.cups[1]);
  await noOpenOp.seal(noOpen.cups[2]);
  try { await noOpenOp.voidIt(W.b); expect(false, 'void before the window closed should have been refused'); }
  catch (e) { expect(/still has time/.test(String(e?.message ?? e)), `void before the house's window closes is refused: "${String(e?.message ?? e).slice(0, 70)}"`); }

  const a = await readRound(address, noSeal.id);
  await waitUntil(a.R.sealBy, 'the seal window of the round with a missing player');
  await noSealOp.reveal();
  const afterSeal = await readRound(address, noSeal.id);
  expect(afterSeal.R.phase === Phase.dealt && afterSeal.R.dealt === 2n, `${table}-4: a player who never sealed is not dealt in: 2 cups of 3`);
  try { await noSealOp.seal(noSeal.cups[2]); expect(false, 'a late seal should have been refused'); }
  catch (e) { expect(/deal has closed/.test(String(e?.message ?? e)), `${table}-4: a late seal is refused: "${String(e?.message ?? e).slice(0, 70)}"`); }

  const b = await readRound(address, noOpen.id);
  await waitUntil(b.R.openBy, 'the open window of the round whose house stays quiet');
  await noOpenOp.voidIt(W.b);
  const afterVoid = await readRound(address, noOpen.id);
  expect(afterVoid.result.why === Why.houseSilent, `${table}-5: the house never opened: anyone can void it, here b. Faults on chain: ${afterVoid.L.houseFaults}`);

  const nc = await readRound(address, noCall.id);
  await waitUntil(nc.R.callBy, 'the call window of the round nobody called');
  try { await noCallOp.liar(1, 2, 1, face); expect(false, 'a late call should have been refused'); }
  catch (e) { expect(/time for a call has passed/.test(String(e?.message ?? e)), `${table}-7: a late call is refused: "${String(e?.message ?? e).slice(0, 70)}"`); }
  await noCallOp.voidIt(W.b, 'no call');
  const afterNoCall = await readRound(address, noCall.id);
  expect(afterNoCall.result.why === Why.noCall, `${table}-7: past its call window anyone can close the round, here b`);

  for (const x of wanted) {
    const { R } = await readRound(address, x.p.id);
    await waitUntil(R.answerBy, `the answer window of ${x.p.table}-${x.p.round}`);
    await x.op.finish(W.b);
    const { result, L } = await readRound(address, x.p.id);
    expect(result.verdict === x.verdict && result.why === x.why, `${x.p.table}-${x.p.round}: ${x.what}. Chain says ${name(Verdict, result.verdict)}, ${name(Why, result.why)}`);
    const silentCup = x.p.cups[x.silentSeat ?? 2];
    expect(!L.answers.member(silentCup.cup), `${x.p.table}-${x.p.round}: the silent cup has no answer on chain, and its dice were never shown`);
  }
}

/** The cheats, for real. Each must be refused somewhere that isn't the cheat's own code. */
async function attacks(W, address, first) {
  const table = BigInt(first);
  const face = 5;
  const p = plan({ table, round: 1, seats: ['house', 'a', 'b'], address });
  const op = ops(W, address, p);
  const salt = await deal(W, address, p, op);
  const [bot, a, b] = p.cups;
  await op.liar(1, 2, 1, face);

  // 1. A client with its refusals taken out, at the real proof server.
  const dir = new URL('../contracts/managed/dice-proof-cheat-chain', import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/index.js`, readFileSync(`${ZK}/contract/index.js`, 'utf8').replaceAll('__compactRuntime.assert(', '((..._a) => {})('));
  const cheat = await import(`${dir}/index.js`);
  const cheatCompiled = compiledFrom(cheat, ZK);
  const realCount = J.countOf(J.diceOf(J.rollOf(salt, bot.seed, 0)), face);
  const attempt = async (label, circuit, state, callArgs, opts) => {
    const before = await readRound(address, p.id);
    const t = Date.now();
    try {
      const row = await call(W.a, circuit, state, callArgs, `${table}-1 CHEAT ${label}`, { address, ...opts });
      expect(false, `${label}: LANDED, hash ${row.hash}. This must not happen.`);
    } catch (e) {
      const m = String(e?.message ?? e);
      receipt({ label: `CHEAT ${label}`, circuit, refused: m.slice(0, 300), ms: Date.now() - t });
      const after = await readRound(address, p.id);
      const same = after.L.answers.member(bot.cup) === before.L.answers.member(bot.cup);
      expect(same && !e?.notApplied, `${label}: refused, nothing changed. "${m.replace(/\s+/g, ' ').slice(0, 150)}"`);
    }
  };
  const swapped = { sk: houseKey(), seeds: { [cupKey(bot.cup)]: b32() } };
  const swappedCount = BigInt(J.countOf(J.diceOf(J.rollOf(salt, swapped.seeds[cupKey(bot.cup)], 0)), face));
  await attempt('the house swaps a sealed seat\'s seed, at the real proof server', 'proveCount', swapped, [bot.cup, swappedCount], { compiledContract: cheatCompiled });
  await attempt('the house claims one more than the cup holds, at the real proof server', 'proveCount', privateFor(bot), [bot.cup, BigInt(realCount + 1)], { compiledContract: cheatCompiled });

  // 2. A house with its own circuit and its own valid keys, at the real node. The proof is good, for the wrong circuit.
  const evilDir = new URL('../contracts/managed/dice-proof-evil-keys', import.meta.url).pathname;
  rmSync(evilDir, { recursive: true, force: true });
  mkdirSync(evilDir, { recursive: true });
  const source = readFileSync(new URL('../contracts/dice-proof.compact', import.meta.url), 'utf8');
  const from = 'assert(disclose(countOf(rollCup(c, r), r.bidFace) == n), "that is not this cup\'s count");';
  assert.ok(source.includes(from), 'the changed circuit no longer applies');
  writeFileSync(`${evilDir}/src.compact`, source.replace(from, 'assert(disclose(n <= 5), "a count is at most five"); // any count at all'));
  log('compiling a changed proveCount that accepts any count, with its own proving keys…');
  execFileSync('compact', ['compile', `${evilDir}/src.compact`, `${evilDir}/out`], { stdio: 'pipe' });
  const evil = await import(`${evilDir}/out/contract/index.js`);
  const evilCompiled = compiledFrom(evil, `${evilDir}/out`);
  await attempt('the house proves a false count with its own circuit and keys, at the real node', 'proveCount', { sk: houseKey(), seeds: {} }, [bot.cup, BigInt(realCount + 1)], { compiledContract: evilCompiled, dir: `${evilDir}/out` });

  // The round still works after all of that.
  await op.prove(bot, salt, face);
  await op.prove(a, salt, face);
  await op.prove(b, salt, face);
  await op.finish(W.a);
  const { result } = await readRound(address, p.id);
  const total = p.live().reduce((n, c) => n + J.countOf(J.diceOf(J.rollOf(salt, c.seed, Number(c.seat))), face), 0);
  expect(Number(result.total) === total, `${table}-1: after the cheats the round finished honestly, total ${result.total}`);
}

async function verify(address) {
  const cs = await rawState(address);
  const auth = cs.maintenanceAuthority;
  expect(auth.threshold > auth.committee.length, `authority: committee ${auth.committee.length}, threshold ${auth.threshold}: LOCKED, no key can ever change a verifier key`);
  const names = ['callLiar', 'commitCup', 'finish', 'openHouse', 'openRound', 'proveCount', 'showCup', 'voidRound'];
  for (const n of names) {
    const op = cs.operation(n);
    const local = readFileSync(`${ZK}/keys/${n}.verifier`);
    const onChain = op?.verifierKey;
    expect(!!onChain && Buffer.from(onChain).equals(local), `${n}: the verifier key on chain is the one this source compiles to (${local.length} bytes)`);
  }
  const L = await readLedger(address);
  log(`windows on chain: seal ${L.sealSecs}s · open ${L.openSecs}s · call ${L.callSecs}s · house answers ${L.houseSecs}s · players answer ${L.answerSecs}s · slack ${L.clockSlack}s`);
  if (existsSync(`${STATE_DIR}/house.key`)) expect(hex(L.house) === hex(P.keyId(houseKey())), 'the house key on chain is this run\'s house key');
}

/** A stranger's check of one round, from the chain alone: no wallet, no key, nothing from the Worker. */
async function check(address, table, round) {
  const id = { table: BigInt(table), round: BigInt(round) };
  const L = await readLedger(address);
  if (!L.rounds.member(id)) throw new Error(`no round ${table}-${round} on chain`);
  const R = L.rounds.lookup(id);
  log(`round ${table}-${round}: ${name(Phase, R.phase)} · ${R.dealt} cups dealt`);
  if (R.salt.some((x) => x !== 0)) {
    expect(hex(J.houseCommitOf(R.houseSeed, id)) === hex(R.houseCommit), 'the opened house seed is the one sealed when the round opened');
    const cups = Array.from({ length: 6 }, (_, s) => { const c = { ...id, seat: BigInt(s) }; return L.commits.member(c) ? L.commits.lookup(c) : ZERO; });
    expect(hex(J.saltOf(R.houseSeed, id, cups, unhex(address))) === hex(R.salt), 'the salt is the house seed mixed with every sealed cup and this contract\'s address');
  }
  let sum = 0n, n = 0n;
  for (let s = 0; s < 6; s++) {
    const cup = { ...id, seat: BigInt(s) };
    if (!L.commits.member(cup)) continue;
    const who = L.houseRun.member(cup) ? 'house seat' : 'player seat';
    if (!L.answers.member(cup)) { log(`seat ${s} (${who}): sealed ${hex(L.commits.lookup(cup)).slice(0, 12)}…, no answer`); continue; }
    const a = L.answers.lookup(cup);
    sum += a.count; n += 1n;
    log(`seat ${s} (${who}): sealed ${hex(L.commits.lookup(cup)).slice(0, 12)}…, ${a.shown ? `showed ${a.dice.join(' ')}` : 'cup shut'}, count ${a.count}, proven on chain`);
    if (a.shown) expect(J.countOf(a.dice.map(Number), Number(R.bidFace)) === Number(a.count), `seat ${s}: the shown dice make that count, 1s wild`);
  }
  if (L.results.member(id)) {
    const r = L.results.lookup(id);
    log(`bid: seat ${R.bidder} said at least ${R.bidCount} of ${R.bidFace}. Seat ${R.caller} called it. Chain's answer: ${name(Verdict, r.verdict)}, ${name(Why, r.why)}, total ${r.total}`);
    expect(r.total === sum, `the total ${r.total} is the sum of the answers`);
    expect(r.answered === n, `${n} cups answered`);
    if (r.why === Why.counted) expect((r.verdict === Verdict.holds) === (r.total >= R.bidCount), 'the verdict follows from the total and the bid');
  }
  await verify(address);
}

const walletsBoth = async () => ({ a: await openWallet('a'), b: await openWallet('b') });
try {
  if (mode === 'balance') {
    const W = await walletsBoth();
    await stop(W.a, W.b);
  } else if (mode === 'deploy') {
    const [seal = '240', open = '180', callWindow = '900', house = '240', answer = '240', slack = '180'] = args;
    if (existsSync(DEPLOY_FILE)) throw new Error(`${DEPLOY_FILE} exists: deploy never overwrites. Set DICE_FILE for a new one.`);
    const { deployLocked } = await import('./deploy-locked.mjs');
    const A = await openWallet('a');
    const p = providersFor(A);
    const started = Date.now();
    log(`deploying, locked · seal ${seal}s · open ${open}s · call ${callWindow}s · house answers ${house}s · players answer ${answer}s · slack ${slack}s · wallet a pays`);
    const { address, finalized } = await deployLocked(p, { compiledContract: compiledFrom(), initialPrivateState: {}, args: [P.keyId(houseKey()), BigInt(seal), BigInt(open), BigInt(callWindow), BigInt(house), BigInt(answer), BigInt(slack)] });
    const prove = A.proofs.filter((x) => x.kind === 'prove');
    const row = { label: 'deploy', circuit: 'deploy', wallet: 'a', hash: finalized.txHash, id: A.lastId, block: Number(finalized.blockHeight), status: String(finalized.status), proveMs: prove.reduce((n, x) => n + x.ms, 0), proofBytes: prove.reduce((n, x) => n + x.bytes, 0), proofs: prove.length, txBytes: A.txBytes, totalMs: Date.now() - started };
    receipt(row);
    writeFileSync(DEPLOY_FILE, `${JSON.stringify({ address, txHash: finalized.txHash ?? null, txId: A.lastId ?? null, block: row.block, network: 'preprod', locked: true, sealSecs: Number(seal), openSecs: Number(open), callSecs: Number(callWindow), houseSecs: Number(house), answerSecs: Number(answer), clockSlack: Number(slack), deployedAt: new Date().toISOString() }, null, 1)}\n`, { flag: 'wx' });
    log(`TX deploy · hash ${row.hash} · block ${row.block} · ${row.status} · tx ${row.txBytes} bytes`);
    log(`DEPLOYED ${address} · saved ${DEPLOY_FILE}`);
    await stop(A);
    await verify(address);
  } else if (mode === 'verify') {
    await verify(args[0] ?? addressOf());
  } else if (mode === 'check') {
    if (!args[1]) throw new Error('usage: check <table> <round> [contract address]');
    await check(args[2] ?? addressOf(), args[0], args[1]);
    const failed = checks.filter((c) => !c.ok);
    log(`${checks.length - failed.length} of ${checks.length} checks held`);
  } else if (mode === 'finish') {
    if (!args[1]) throw new Error('usage: finish <table> <round> [round…]');
    const B = await openWallet('b'); // finish takes no key and no dice, so any wallet can pay for it
    const address = addressOf();
    for (const round of args.slice(1)) {
      const id = { table: BigInt(args[0]), round: BigInt(round) };
      await call(B, 'finish', {}, [id], `t${args[0]}r${round} finish: the chain adds it up`, { address });
      const { result } = await readRound(address, id);
      log(`${args[0]}-${round}: the chain says ${name(Verdict, result.verdict)}, ${name(Why, result.why)}, total ${result.total}, ${result.answered} cups answered`);
    }
    await stop(B);
  } else if (mode === 'honest' || mode === 'timeouts' || mode === 'attacks') {
    if (!args[0]) throw new Error(`usage: ${mode} <first table number>`);
    const W = await walletsBoth();
    const address = addressOf();
    if (mode === 'honest') await honest(W, address, args[0]);
    else if (mode === 'timeouts') await timeouts(W, address, args[0]);
    else await attacks(W, address, args[0]);
    await stop(W.a, W.b);
    const failed = checks.filter((c) => !c.ok);
    log(`${checks.length - failed.length} of ${checks.length} checks held${failed.length ? `. FAILED: ${failed.map((c) => c.what).join(' | ')}` : ''}`);
    log(`after: ${W.a.who}, ${W.b.who} state saved in .dice-state`);
  } else throw new Error(`unknown mode ${mode}`);
} catch (e) {
  log(`FAILED: ${e?.message ?? e}`);
  if (e?.cause) log(String(e.cause).slice(0, 800));
  process.exitCode = 1;
}
void unhex; void CompiledContract;
process.exit();
