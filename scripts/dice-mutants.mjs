// A sweep over contracts/dice-proof.compact: changes one line, recompiles (no keys), and runs the tests against that build. A mutant that no
// test catches is either a hole in the tests, or a change that makes no difference, and each one left alive has to say which.
//   node scripts/dice-mutants.mjs            all of them
// Works on a copy of the tree's test and contract, under contracts/managed/dice-proof-mut, so the real build is never touched.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url).pathname;
const SRC = readFileSync(`${root}contracts/dice-proof.compact`, 'utf8');
const TEST = readFileSync(`${root}test/dice-proof.test.mjs`, 'utf8');
const M = [
  // the dice
  ['wild not counted', '(d == face || d == 1)', '(d == face)'],
  ['face not counted', '(d == face || d == 1)', '(d == 1)'],
  ['a die range moved', 'w >= 21846', 'w >= 21847'],
  ['a die range moved 2', 'w >= 54614', 'w >= 54613'],
  ['dice from the wrong bytes', 'dieOf(roll[8], roll[9])', 'dieOf(roll[9], roll[8])'],
  ['first die repeated', 'dieOf(roll[2], roll[3])', 'dieOf(roll[0], roll[1])'],
  // the hashes
  ['commit ignores the seat', '[pad(32, "cup-and-claim:commit:v2"), seed, cup, self]', '[pad(32, "cup-and-claim:commit:v2"), seed, CupId { table: cup.table, round: cup.round, seat: 0 }, self]'],
  ['commit ignores the round', '[pad(32, "cup-and-claim:commit:v2"), seed, cup, self]', '[pad(32, "cup-and-claim:commit:v2"), seed, CupId { table: cup.table, round: 0, seat: cup.seat }, self]'],
  ['commit ignores the contract', '[pad(32, "cup-and-claim:commit:v2"), seed, cup, self]', '[pad(32, "cup-and-claim:commit:v2"), seed, cup, default<Bytes<32>>]'],
  ['house commit ignores the round', '[pad(32, "cup-and-claim:house:v2"), seed, id]', '[pad(32, "cup-and-claim:house:v2"), seed, RoundId { table: id.table, round: 0 }]'],
  ['roll ignores the seat', 'pad(32, "cup-and-claim:roll:v2"), salt, seed, seat]', 'pad(32, "cup-and-claim:roll:v2"), salt, seed, 0]'],
  ['roll ignores the salt', 'pad(32, "cup-and-claim:roll:v2"), salt, seed, seat]', 'pad(32, "cup-and-claim:roll:v2"), default<Bytes<32>>, seed, seat]'],
  ['salt ignores the players', 'saltOf(seed, i, [sealedAt(i, 0), sealedAt(i, 1), sealedAt(i, 2), sealedAt(i, 3), sealedAt(i, 4), sealedAt(i, 5)], kernel.self().bytes)', 'saltOf(seed, i, default<Vector<6, Bytes<32>>>, kernel.self().bytes)'],
  ['salt ignores the contract', 'sealedAt(i, 5)], kernel.self().bytes)', 'sealedAt(i, 5)], default<Bytes<32>>)'],
  ['preseal ignores the seat', '[pad(32, "cup-and-claim:preseal:v2"), commit, cup]', '[pad(32, "cup-and-claim:preseal:v2"), commit, CupId { table: cup.table, round: cup.round, seat: 0 }]'],
  ['preseal ignores the round', '[pad(32, "cup-and-claim:preseal:v2"), commit, cup]', '[pad(32, "cup-and-claim:preseal:v2"), commit, CupId { table: cup.table, round: 0, seat: cup.seat }]'],
  ['salt skips the last seat', 'sealedAt(i, 4), sealedAt(i, 5)]', 'sealedAt(i, 4), default<Bytes<32>>]'],
  // the guards
  ['anyone can open a round', 'export circuit openRound(id: RoundId, houseCommit: Bytes<32>, seats: Vector<6, SeatInit>, now: Uint<64>): [] {\n  houseOnly();', 'export circuit openRound(id: RoundId, houseCommit: Bytes<32>, seats: Vector<6, SeatInit>, now: Uint<64>): [] {'],
  ['anyone can post a call', 'export circuit callLiar(id: RoundId, bidder: Uint<8>, caller: Uint<8>, count: Uint<8>, face: Uint<8>, now: Uint<64>): [] {\n  houseOnly();', 'export circuit callLiar(id: RoundId, bidder: Uint<8>, caller: Uint<8>, count: Uint<8>, face: Uint<8>, now: Uint<64>): [] {'],
  ['a round can be reopened', 'assert(!rounds.member(i), "this round has already been opened");', ''],
  ['no player needed', 'assert(ps >= 1, "a round needs a player: with none, every seed would be the house\'s");', ''],
  ['no two seats needed', 'assert(hs + ps >= 2, "a round needs two seats");', ''],
  ['anyone can seal any seat', 'assert(disclose(keyId(seatKey()) == h.key), "this seat belongs to someone else");', ''],
  ['a cup can be resealed', 'assert(!commits.member(c), "this cup is already sealed");', ''],
  ['any seal goes', 'assert(preSealOf(seal, c) == h.preseal, "this is not the seal named when the round opened");', ''],
  ['a zero seal goes', 'assert(seal != default<Bytes<32>>, "a cup must be sealed with a commitment");', ''],
  ['a player names no seal', 'assert(init.holder != default<Bytes<32>> && init.seal != default<Bytes<32>>, "a player seat names its holder and the hash of its seal");', 'assert(init.holder != default<Bytes<32>>, "a player seat names its holder and the hash of its seal");'],
  ['a player names no holder', 'assert(init.holder != default<Bytes<32>> && init.seal != default<Bytes<32>>, "a player seat names its holder and the hash of its seal");', 'assert(init.seal != default<Bytes<32>>, "a player seat names its holder and the hash of its seal");'],
  ['a bot with no seal', 'assert(init.seal != default<Bytes<32>>, "a house seat is sealed when the round opens");', ''],
  ['no house seal', 'assert(hc != default<Bytes<32>>, "the house must seal a seed");', ''],
  ['seal after the window', 'assert(blockTimeLt(r.sealBy), "too late to seal this cup");', ''],
  ['seal after the deal', 'assert(r.phase == Phase.sealing, "the deal has closed");', ''],
  ['open any seed', 'assert(houseCommitOf(seed, i) == r.houseCommit, "this is not the seed the house sealed");', ''],
  ['open early', 'assert(inn == r.playerSeats || blockTimeGte(r.sealBy), "players can still seal their cups");', ''],
  ['open late', 'assert(blockTimeLt(r.openBy), "too late: the house missed its window, and the round can be voided");', ''],
  ['open twice', 'assert(r.phase == Phase.sealing, "this round is not waiting to open");\n  assert(blockTimeLt(r.openBy)', 'assert(blockTimeLt(r.openBy)'],
  ['void early', 'assert(blockTimeGte(r.openBy), "the house still has time to open");', ''],
  ['void a round in play', 'assert(r.phase == Phase.dealt, "this round can\'t be voided");', ''],
  ['void before the call window ends', 'assert(blockTimeGte(r.callBy), "this round still has time for a call");', ''],
  ['a late call', 'assert(blockTimeLt(r.callBy), "too late: the time for a call has passed");', ''],
  ['no call counts as a fault', 'close(i, r, Phase.voided, Verdict.voided, Why.noCall);', 'close(i, r, Phase.voided, Verdict.voided, Why.noCall); houseFaults.increment(1);'],
  ['call window of nothing', 'callBy: (openBy + callSecs) as Uint<64>,', 'callBy: openBy,'],
  ['void costs the house nothing', 'houseFaults.increment(1);', ''],
  ['too few cups goes on', 'if (inn == 0 || dealt < 2) {', 'if (false) {'],
  ['bid on the wild', 'assert(f >= 2 && f <= 6, "a bid names a face from 2 to 6");', 'assert(f <= 6, "a bid names a face from 2 to 6");'],
  ['bid on seven', 'assert(f >= 2 && f <= 6, "a bid names a face from 2 to 6");', 'assert(f >= 2, "a bid names a face from 2 to 6");'],
  ['bid of nothing', 'assert(k >= 1 && k <= r.dealt * 5,', 'assert(k <= r.dealt * 5,'],
  ['bid past the table', 'assert(k >= 1 && k <= r.dealt * 5,', 'assert(k >= 1,'],
  ['call your own bid', 'assert(b != c, "a seat can\'t call its own bid");', ''],
  ['a bidder with no cup', 'assert(commits.member(cupAt(i, b)), "the bidder has no cup");', ''],
  ['a caller with no cup', 'assert(commits.member(cupAt(i, c)), "the caller has no cup");', ''],
  ['call out of phase', 'assert(r.phase == Phase.dealt, "this round has no open bidding");', ''],
  ['answer with no call', 'assert(r.phase == Phase.called, "no call to answer");', ''],
  ['answer with no cup', 'assert(commits.member(cup), "no cup at this seat");', ''],
  ['answer twice', 'assert(!answers.member(cup), "this cup has already answered");', ''],
  ['answer late', 'assert(blockTimeLt(r.answerBy), "too late: the answer window has closed");', ''],
  ['a house seat answers late', 'if (houseRun.member(cup)) assert(blockTimeLt(r.houseBy), "too late: the house\'s answer window has closed");\n  else', 'if (!houseRun.member(cup))'],
  ['players needn\'t wait for the house', 'else assert(houseAnswered.lookup(id).read() == r.houseSeats || blockTimeGte(r.houseBy), "the house\'s seats answer first");', ''],
  ['players wait for the house for ever', 'houseAnswered.lookup(id).read() == r.houseSeats || blockTimeGte(r.houseBy)', 'houseAnswered.lookup(id).read() == r.houseSeats'],
  ['no commitment check', 'assert(disclose(commitOf(seed, cup, kernel.self().bytes) == commits.lookup(cup)), "this is not the seed sealed for this cup");', ''],
  ['any count', 'assert(disclose(countOf(rollCup(c, r), r.bidFace) == n), "that is not this cup\'s count");', 'assert(disclose(n <= 5), "that is not this cup\'s count");'],
  ['any dice', 'assert(disclose(rollCup(c, r) == shown), "those are not this cup\'s dice");', 'assert(disclose(shown == shown), "those are not this cup\'s dice");'],
  ['show moves the count', 'record(c, Answer { count: countOf(shown, r.bidFace), shown: true, dice: shown });', 'record(c, Answer { count: 5, shown: true, dice: shown });'],
  ['house answers aren\'t counted', 'if (houseRun.member(cup)) houseAnswered.lookup(id).increment(1);', ''],
  ['answers aren\'t added', 'totals.lookup(id).increment(a.count as Uint<16>);', ''],
  ['answers aren\'t counted', 'answered.lookup(id).increment(1);', ''],
  // finish
  ['finish before the window', 'assert(blockTimeGte(r.answerBy), "cups can still answer");', ''],
  ['finish with no call', 'assert(r.phase == Phase.called, "no call to finish");', ''],
  ['holds a die short', 'if (known >= r.bidCount) close', 'if (known + 1 >= r.bidCount) close'],
  ['falls wrongly early', 'known + pending * 5 < r.bidCount', 'known + pending * 4 < r.bidCount'],
  ['falls wrongly late', 'known + pending * 5 < r.bidCount', 'known + pending * 5 + 1 < r.bidCount'],
  ['silent bidder wins', 'else if (!bidderIn) close(i, r, Phase.finished, Verdict.falls, Why.bidderSilent);', 'else if (!bidderIn) close(i, r, Phase.finished, Verdict.holds, Why.bidderSilent);'],
  ['silent caller wins', 'else if (!callerIn) close(i, r, Phase.finished, Verdict.holds, Why.callerSilent);', 'else if (!callerIn) close(i, r, Phase.finished, Verdict.falls, Why.callerSilent);'],
  ['both silent decides', 'if (!bidderIn && !callerIn) close(i, r, Phase.voided, Verdict.voided, Why.bothSilent);', 'if (!bidderIn && !callerIn) close(i, r, Phase.finished, Verdict.holds, Why.bothSilent);'],
  ['third silent decides', 'else close(i, r, Phase.voided, Verdict.voided, Why.thirdSilent);', 'else close(i, r, Phase.finished, Verdict.falls, Why.thirdSilent);'],
  ['a silent bot voids when the house bid', 'if (houseQuiet && bidderHouse && !callerHouse) close(i, r, Phase.finished, Verdict.falls, Why.houseSeatSilent);', 'if (houseQuiet && bidderHouse && !callerHouse) close(i, r, Phase.voided, Verdict.voided, Why.thirdSilent);'],
  ['a silent bot voids when the house called', 'else if (houseQuiet && callerHouse && !bidderHouse) close(i, r, Phase.finished, Verdict.holds, Why.houseSeatSilent);', 'else if (houseQuiet && callerHouse && !bidderHouse) close(i, r, Phase.voided, Verdict.voided, Why.thirdSilent);'],
  ['a silent player costs the house', 'const houseQuiet = houseAnswered.lookup(i).read() != r.houseSeats;', 'const houseQuiet = true;'],
  ['the house on both sides pays', 'if (houseQuiet && bidderHouse && !callerHouse)', 'if (houseQuiet && bidderHouse)'],
  ['the house on both sides wins', 'else if (houseQuiet && callerHouse && !bidderHouse)', 'else if (houseQuiet && callerHouse)'],
  // the clock and the deployment
  ['future time allowed', 'assert(blockTimeGte(n), "declared time is in the future");', ''],
  ['stale time allowed', 'assert(blockTimeLt((n + clockSlack) as Uint<64>), "declared time is stale");', ''],
  ['seal window of nothing', 'const sealBy = (n + clockSlack + sealSecs) as Uint<64>;', 'const sealBy = n;'],
  ['back-dating eats the seal window', 'const sealBy = (n + clockSlack + sealSecs) as Uint<64>;', 'const sealBy = (n + sealSecs) as Uint<64>;'],
  ['open window of nothing', 'const openBy = (sealBy + openSecs) as Uint<64>;', 'const openBy = sealBy;'],
  ['house window of nothing', 'const houseBy = (n + houseSecs) as Uint<64>;', 'const houseBy = n;'],
  ['answer window of nothing', 'answerBy: (houseBy + answerSecs) as Uint<64> }', 'answerBy: houseBy }'],
  ['constructor: slack short', 'disclose(slack) >= 30 && disclose(slack) <= 300', 'disclose(slack) <= 300'],
  ['constructor: slack huge', 'disclose(slack) >= 30 && disclose(slack) <= 300', 'disclose(slack) >= 30'],
  ['constructor: seal short', 'disclose(seal) >= 120 && disclose(seal) <= 3600', 'disclose(seal) <= 3600'],
  ['constructor: seal huge', 'disclose(seal) >= 120 && disclose(seal) <= 3600', 'disclose(seal) >= 120'],
  ['constructor: open short', 'disclose(open) >= 60 && disclose(open) <= 3600', 'disclose(open) <= 3600'],
  ['constructor: open huge', 'disclose(open) >= 60 && disclose(open) <= 3600', 'disclose(open) >= 60'],
  ['constructor: call short', 'disclose(call) >= 300 && disclose(call) <= 14400', 'disclose(call) <= 14400'],
  ['constructor: call huge', 'disclose(call) >= 300 && disclose(call) <= 14400', 'disclose(call) >= 300'],
  ['constructor: house short', 'disclose(houseAnswer) >= disclose(slack) + 60 && disclose(houseAnswer) <= 3600', 'disclose(houseAnswer) <= 3600'],
  ['constructor: house huge', 'disclose(houseAnswer) >= disclose(slack) + 60 && disclose(houseAnswer) <= 3600', 'disclose(houseAnswer) >= disclose(slack) + 60'],
  ['constructor: answer short', 'disclose(playerAnswer) >= 120 && disclose(playerAnswer) <= 3600', 'disclose(playerAnswer) <= 3600'],
  ['constructor: answer huge', 'disclose(playerAnswer) >= 120 && disclose(playerAnswer) <= 3600', 'disclose(playerAnswer) >= 120'],
];
const work = `${root}contracts/managed/dice-proof-mut`;
const killed = [], alive = [], broke = [];
const only = process.argv[2];
for (const [name, from, to] of M) {
  if (only && !name.includes(only)) continue;
  if (!SRC.includes(from)) { broke.push(`${name}: no longer applies`); continue; }
  rmSync(work, { recursive: true, force: true });
  mkdirSync(`${work}/src`, { recursive: true });
  writeFileSync(`${work}/src/dice-proof.compact`, SRC.replace(from, to));
  try { execFileSync('compact', ['compile', '--skip-zk', `${work}/src/dice-proof.compact`, `${work}/build`], { stdio: 'pipe' }); }
  catch { killed.push(`${name} (the compiler refuses it)`); continue; }
  // The tests use the mutant's JavaScript, with the real ZKIR, so a changed rule is seen by the same checks a cheat is.
  mkdirSync(`${work}/test`, { recursive: true });
  const test = TEST
    .replace("await import('../contracts/managed/dice-proof/contract/index.js')", `await import('${work}/build/contract/index.js')`)
    .replace("const dir = `${root}contracts/managed/dice-proof/`;", `const dir = \`${work}/build/\`;`)
    .replace("import * as J from '../scripts/dice-fair.mjs';", `import * as J from '${root}scripts/dice-fair.mjs';`)
    .replace("new URL('./dice-vectors.json', import.meta.url)", `new URL('file://${root}test/dice-vectors.json')`)
    .replace("const SOURCE = readFileSync(`${root}contracts/dice-proof.compact`, 'utf8');", 'const SOURCE = readFileSync(`' + work + '/src/dice-proof.compact`, \'utf8\');')
    .replace("const EVIL = {", 'const EVIL = {}; const _unused = {') // the changed-circuit tests are the sweep's own subject
    .replace("const root = new URL('../', import.meta.url).pathname;", `const root = '${root}';`);
  writeFileSync(`${root}test/.mut-run.test.mjs`, test);
  const run = spawnSync('node', ['--test', `${root}test/.mut-run.test.mjs`], { encoding: 'utf8', timeout: 120000 });
  if (run.status === 0) { alive.push(name); console.log(`ALIVE  ${name}`); } else killed.push(name);
}
rmSync(`${root}test/.mut-run.test.mjs`, { force: true });
rmSync(work, { recursive: true, force: true });
console.log(`${M.length} mutants · ${killed.length} caught · ${alive.length} alive · ${broke.length} didn't apply`);
for (const x of broke) console.log(`  ${x}`);
for (const x of alive) console.log(`  alive: ${x}`);
