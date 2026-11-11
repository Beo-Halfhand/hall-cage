# Cage v4b: preprod rehearsal

**Every step from 2 on sends a transaction on preprod, with test money.** It deploys a throwaway locked cage with the real parameters, separate from everything live. It doesn't touch the running judges, the `judge` wallet, launchd, staging or the live Worker.

**Why v4b:** the 14-circuit v4 deploy was refused by preprod with `1010 … Transaction would exhaust the block limits`: one transaction may use at most 63.99% of any one block limit, which is 31,997 bytes written, and v4 wrote about 36,300. v4b has 11 circuits: a move is `seatByJudge` with a from-table, a revoke is a deposit of 0 with the empty permit, and a single settle is a batch of one. It also adds F5: no rescue of a balance while its permit is live. **And a batch holds 4 entries, not 8:** preprod lets a transaction take at most 2 µs a byte (15 ms at least) to dismiss, the 8-entry proof took 25.2 ms whatever it carried, so a settle under 12,594 bytes was refused (the first run, below). The 4-entry proof should take about 16.9 ms.

**And since 2026-11-06, L1:** a permit runs at most `maxGrant` (30 days) past the block's clock, so the deploy takes a ninth parameter, and the third run adds step 5b (one second over: refused) and puts step 7's grant on the bound (exactly 720 hours: lands).

**What it proves, for the first time anywhere:** a locked deploy, `acceptJudge`, a deposit with a permit, `seatByJudge` as a seat and as a move, a revoke as a deposit, a stand ending a permit, F5 refusing a rescue, and settles on v4's state layout, including the small ones: a two-player round (step 12) and settles of one line (steps 17 and 20).

**Where the numbers come from:** `test/permit.test.mjs`, "the preprod rehearsal", runs this same sequence in the simulator, and it passes. The printed lines are read from `scripts/cage.mjs`, so small differences in wording are possible. **The numbers and the `SucceedEntirely` status are what matter.**

## Third run, 2026-11-06 morning: every step matched, with L1

Rehearsal cage `7ed190d7a34035d312f8e561aecd81f11a25ae9cfed84e2c063b6f80ab1ae96c` (`CAGE_FILE=deployment.cage4b3-rehearsal.json`), locked, `maxGrant 2592000s` on chain.
- **The deploy:** 29,083 bytes written, the same in step 1b's dry run and on the landed deploy, out of 31,997, so 2,914 to spare.
- **Step 5b** was refused when built (`failed assert: a permit runs at most maxGrant`), with nothing proven or sent, and `a` still had `balance 0 · payTo none`.
- **Step 7, on the bound,** landed: `until` was the build's clock plus exactly 2,592,000 s, and the block came 39 s later.
- **Steps 8, 9, 13 and 15** were refused with nothing sent.
- **Step 11b** priced the two-player settle at 15,661 bytes, and the ledger's fee check passed it.
- **At step 22** the cage held nothing and no table was alive.

The contract source was changed after the deploy, in comments only. Built again, its zkir, keys, types and compiler info are byte-identical to what was deployed, and its `index.js` is identical apart from the source line numbers in local error messages.

| Step | Transaction | Block |
|---|---|---|
| 2 deploy | `ba9a970942e5c23806d93354ae0e05b9f1c3af0c432a5a97a0da36b85e6a64ee` | 3306873 |
| 3 proposeJudge | `0e8438739b267558df25c9bb2543f6fb21efd06afe6c11c08261977c789e4afc` | 3306894 |
| 4 acceptJudge | `939ab6137654d2040ec606cbd456617dc3cfd8d59a4094c7037e6c7bd1c1db7f` | 3307357 |
| 5 deposit, `b`'s permit (24 hours) | `48930a604b00078a06e46a57c466284348fd21b2c0641c99b3169a927cfcf112` | 3307381 |
| 6 sit | `6f30e8caa6d65eb59ce634057f3ac9b9d4d2a30f31dec245abe52183d16960a2` | 3307435 |
| 7 deposit, `a`'s permit for exactly `maxGrant` | `95ba17c276ffed1fb914c8b0e9591a32f1833fc473575c9107e76b0c4880c0ac` | 3307458 |
| 10 seatByJudge, a seat | `87d60324528312f149f410d635e8d2d6e4e22b4963dc629462d4b0c2b16ebd96` | 3307520 |
| 11 seatByJudge, a move | `171f03890dd02c973df3bc3cea8840fd6d0e5e8029d4c6a51b115c9151921c97` | 3307540 |
| 12 settleBatch, a two-player round | `12d73c0361a290237b66d3d44b39f28480d9407494bc76ca7133c5541c35e471` | 3307579 |
| 14 deposit, a revoke while seated | `d5ebc926996ebfec819c2dd782fab91c790af03cc7ce50f1f0b7dd0c42439056` | 3307616 |
| 16 stand | `bd8507b758fbe7834c3f4fb6d48d6288986964da320e46a4a45b6c61e44ac9ce` | 3307652 |
| 17 settleBatch, a settle of one | `72ae8fc66baa54e50e3e853fe8d22bd1d34a9be4af8106e40e7ed8b2b777b178` | 3307673 |
| 18 withdraw | `6e09d9bbab15b353b078ff3528e8ef9cfe6dbb897c4c8ad1e05c9ded946689e1` | 3307694 |
| 19 stand, ending `b`'s permit | `b362c0383da8fec94f94e0e02cbdeb039512e1b60c10312733b4370df4ae8898` | 3307715 |
| 20 settleBatch, a settle of one | `e2d5a353ca0a211fd6115cc1eb714ec740e15384c48ce70af9ef530d57667323` | 3307737 |
| 21 withdraw | `3cacda5f93521a2ae51dba9978ca6d3b65046006d1ab174386e6ce8bc657f708` | 3307758 |

## Second run, 2026-11-05 evening: every step matched, with the 4-entry settleBatch

Rehearsal cage `897dc8b1a8ef404c6c7b4acc86b5b257131ce62d752c7a315e89aad7ba0d3447` (`CAGE_FILE=deployment.cage4b2-rehearsal.json`), locked, 28,997 bytes written as measured in step 1b. Steps 8, 9, 13 and 15 were refused with nothing sent, as they should be. Step 11b priced the two-player settle at 12,658 bytes, and the ledger's fee check passed it. At step 22 the cage held nothing and no table was alive.

| Step | Transaction | Block |
|---|---|---|
| 2 deploy | `746a2bfbc7886c3929b133b137a1c1100ad73242301ad8e0a484194861239485` | 3300900 |
| 3 proposeJudge | `1fb4471b342123ff823bba1e521bf17245e9008b000f48b1d015a2af7f1fba2a` | 3300923 |
| 4 acceptJudge | `79a986659f0f95bbe9b56236962210beb18a166eb612cc294f83963a2d16978c` | 3301380 |
| 5 deposit, `b`'s permit | `0f127c71756904d5fd7f5dd0260a76d2832ffc507453100e642c188080f5f32d` | 3301404 |
| 6 sit | `ef9c6aa70ea31ee1b3c1f07cd8eb22d21c8f20714d2adcda71167df74ab98ea3` | 3301428 |
| 7 deposit, `a`'s permit | `157bd442831c7ec856b7a5cbf01c74d1ed7cc72eee6cc6ea70f6b847c6e25b47` | 3301452 |
| 10 seatByJudge, a seat | `ffa8fe408e2860d905d75e0e19362e699bfadef35bb94ffb07b4b68845a5eafb` | 3301510 |
| 11 seatByJudge, a move | `d526dabdcd653dc0ca658fa38711cbb67e13cbdf31bbe4bd3c7a7d57682a1e48` | 3301532 |
| 12 settleBatch, a two-player round | `3a81ca5033f38dccf2d839c3befc9caf1523fc70ce05c18733da440c59c7add3` | 3301570 |
| 14 deposit, a revoke while seated | `5c20b17d9d72e217bf32d4dd483f76f37c70f286cfed46230a61b0373aaf66e3` | 3301606 |
| 16 stand | `98342ec1a1ae8bbe5550edf97b5b8ce5a36416da0d468a5dc782c165481d91b0` | 3301641 |
| 17 settleBatch, a settle of one | `420de016afb3f2c9882a64eb6c147ff0cf016543746aea2ca3017b7cdb8611e2` | 3301661 |
| 18 withdraw | `4ae2c8c520bd21f0dc7bfb7778f575eddee0fcc140de9ca92dd66f7ee49b904f` | 3301681 |
| 19 stand, ending `b`'s permit | `1c463c7ae9e25210e138eb86be21c6b8c66b4de0dc63e493c85c7c52ab5ba55e` | 3301701 |
| 20 settleBatch, a settle of one | `a444f4e6f31c033f2459d3f75d9207ebd9e4f9316e845f20ffc2eb8460c15dad` | 3301722 |
| 21 withdraw | `c8c3c7b8bf047ef255b625dad5e873bece76a700b75c4212f2c7a2f2c5eaa5f9` | 3301744 |

## First run, 2026-11-05: stopped at step 12, with the 8-entry settleBatch

**Steps 0 to 11 matched.** The locked 11-circuit deploy landed (28,997 bytes written, as measured in step 1b), and so did the first `acceptJudge`, a deposit with a permit, `seatByJudge` as a seat and as a move, and F5's refusal. Rehearsal cage `12bb4f1202233ed2d523544c5b070f725e3cfd0332fe2fde075b36b4b1adf3a0`.

**Step 12 was refused before the pool, nothing spent:** `1010 Invalid Transaction | "Custom error: 168"`, the ledger's fee calculation. `CAGE_DRY_RUN=1` on the same command shows why: `exceeded the maximum time to dismiss for transaction size; this transaction would take 25.187ms to dismiss, but given its size of 12584 bytes, it may take at most 25.168ms`. Preprod lets a transaction take at most 2 µs per byte (15 ms at least) to validate before it can be refused. `settleBatch` declares 14,687 public inputs, whatever it carries, so it always takes 25.187 ms, and any settle under 12,594 bytes is refused: a settle of nothing, and most two-player rounds. Cage #3's `settleBatch` declares 8,833 and lands. **Fixed since:** `settleBatch` takes 4 entries, so the rehearsal runs again on a new cage, with `CAGE_FILE=deployment.cage4b2-rehearsal.json`. See "v4b" in `docs/CAGE-V4-PLAN.md`.

**Left in the rehearsal cage:** `a` 10 tNIGHT and `b` 5 tNIGHT, seated at table 2, which went quiet at 18:58 PT, so both seats are void. To take it home: `node scripts/cage.mjs a withdraw 10` and `node scripts/cage.mjs b withdraw 5`, with `CAGE_FILE=deployment.cage4b-rehearsal.json`.

## Before you start

- **Time:** about 1 hour 15 minutes. Step 4 needs a 45-minute wait, the real `judgeDelay`. Steps 6 to 21 need one sitting: a table with no settle for 30 minutes goes dead. Allow about a minute a transaction.
- **Wallets:** only `a` and `b`. **Never use `judge`: the running judge owns it.** After step 4, `b` is the judge, and it also plays the other side of the table.
- **Money:** `a` needs at least 10 tNIGHT, `b` at least 5, plus DUST. It all comes back at the end, less fees.
- **One command at a time.** Wait for each to finish, and don't run anything else on `a` or `b`.
- **The proof server** is `127.0.0.1:6300`, shared with the running judge. Your proofs add brief load and nothing else.

**After every transaction:** the line to check is `TX <circuit> · hash … · id … · block … · SucceedEntirely`. Below it the script prints the cage's state.

**Stop if you see:**

| You see | It means | Do |
|---|---|---|
| `landed but the call was NOT applied` | The fee is spent, and the cage didn't change | Stop. Send me the output |
| `submit outcome unknown` | It may still land | **Don't resend.** Run `node scripts/cage.mjs a state` and see |
| `170` or `InvalidDustSpendProof` | The wallet's DUST view lags, and nothing was spent | Wait a minute and run it again |
| A refusal where this says it should land, or a landing where it says refused | Something's different from the simulator | Stop. Send me the output. `CAGE_DRY_RUN=1` before the same command builds, proves and prices it the way the node does, and sends nothing |

## The steps

### 0. Set up
```bash
pgrep -fl 'e2e-'
cd ../sealed-cage-v4b
ls -la .wallets          # a link to ../sealed-cage/.wallets; make it with: ln -s ../sealed-cage/.wallets .wallets
export CAGE_FILE=deployment.cage4b3-rehearsal.json     # the third run, with L1. The earlier runs' files stay as they are
```
- **Should print:** nothing from `pgrep`. If it prints a driver, wait: it may be using `a` or `b`.
- **Undo:** `unset CAGE_FILE`. If the `export` is lost in a new terminal, set it again before going on.

### 1. Check the wallets (no transaction)
```bash
node scripts/cage.mjs a balance
```
```bash
node scripts/cage.mjs b balance
```
- **Should print:** `synced · tNIGHT <n> tNIGHT · DUST(raw) <n> · NIGHT coins <n> (registered for DUST <n>)`. `a` has at least 10 tNIGHT, `b` at least 5, and DUST above 0 on both.
- **If DUST is 0:** `node scripts/cage.mjs a dust`, then wait for `DUST READY`.

### 1b. Measure the deploy (no transaction)
```bash
node scripts/cage.mjs a deploy-size 1800 2700 0 1000 300 2592000
```
- **Should print:** `DEPLOY SIZE … bytesWritten <about 29,000> (<about 58%> of the block) · the most one transaction may use: 31997 bytesWritten · headroom <about 3,000> · … · FITS`, then `released: … nothing was sent`. It builds, proves and balances the exact deploy of step 2, prices it the way the node does, and hands the DUST back.
- **If it says `DOES NOT FIT`:** stop. Step 2 would be refused.

### 2. Deploy v4b, locked, with `judgeDelay` 2700 and `maxGrant` 30 days
```bash
node scripts/cage.mjs a deploy 1800 2700 0 1000 300 2592000
```
- **Should print:**
  ```
  deploying, locked · escape 1800s · judgeDelay 2700s · maxRake 0 · roundCap 1000 tNIGHT · slack 300s · maxGrant 2592000s · 6 seats · house = judge id. Proving takes a minute…
  TX deploy · hash … · SucceedEntirely
  DEPLOYED <address> · saved deployment.cage4b3-rehearsal.json
    judge <a's id>… · house <a's id>… · maxRake 0 tNIGHT · roundCap 1000 tNIGHT · escape 1800s · slack 300s · judgeDelay 2700s · seats 6 · maxGrant 2592000s
    maintenance authority: LOCKED · committee 0 · threshold 1 · counter 0
    pending judge: none
  ```
- **The first locked deploy.** If it's refused, stop and send me the output. Nothing is lost.
- **Undo:** it can't be undeployed or changed. With no money in it, just leave it: `mv deployment.cage4b3-rehearsal.json deployment.cage4b3-rehearsal.abandoned.json`, and `deploy` makes a new one if you run it again.

### 3. Propose `b` as the judge
```bash
node scripts/cage.mjs a propose b
```
- **Should print:** `TX proposeJudge … SucceedEntirely`, then `pending judge: <b's id>… since <T>`. **Write down `T`**, and find out when you can go on: `date -r $((T + 2760))`. That's `T` plus 2700, plus a minute.
- **Undo:** `node scripts/cage.mjs a cancel`. It prints `pending judge: none`.

### 4. Accept the judge, after the wait
```bash
node scripts/cage.mjs b accept
```
- **Should print:** `TX acceptJudge … SucceedEntirely`, then `judge <b's id>…` and `pending judge: none`. `b`'s line ends in `· JUDGE`. **First `acceptJudge` ever on preprod.**
- **Don't try it early:** the chain refuses it.

### 5. `b` puts money in, with a permit for itself
5 tNIGHT, a cap of 2, for 24 hours. It's the judge's own permit, there so that step 19 can show a stand ending one on chain:
```bash
node scripts/cage.mjs b deposit 5 2 24
```
- **Should print:** `TX deposit … SucceedEntirely`, then `b` with `balance 5 tNIGHT · payTo bound · no seat · permit cap 2 tNIGHT floor 3 tNIGHT until <unix time>`.
- **Undo:** `node scripts/cage.mjs b revoke`, then `node scripts/cage.mjs b withdraw 5`.

### 5b. L1: `a` asks for a permit one second over `maxGrant` (refused, nothing sent)
10 tNIGHT, a cap of 5, for 2,592,001 seconds counted from the build:
```bash
CAGE_DRY_RUN=1 node scripts/cage.mjs a deposit 10 5 2592001s
```
- **Should print:** `deposit as a: DRY RUN, proving and balancing, nothing is sent…`, then `permit until <unix time> … 2592001s from the build · this cage's maxGrant 2592000s: over it by 1s, so the build should be refused`, then `FAILED:` with `a permit runs at most maxGrant`. There's **no** `TX` line and no `DRY RUN deposit (ledger parameters …)` line, and the exit code is 1. `a`'s line in `node scripts/cage.mjs a state` still shows `balance 0 tNIGHT · payTo none`. **New with L1.**
- **Why counted from the build:** the cage checks `until` against the clock at the moment the circuit runs, and the wallet sync before that takes minutes. So `cage.mjs` works out `until` last, after the dry run's own setup, at the start of a second. The build reads the clock after one indexer query, normally in the same second. A refusal shows that it did: a build in a later second would have found the grant on the bound and built it.
- **Why `CAGE_DRY_RUN=1`:** the refusal comes from the circuit, before anything is proven, so the flag makes no difference to a refusal. If the build ran into the next second instead, the flag makes it print `DRY RUN deposit (ledger parameters …)` and release the DUST instead of sending. Then run it again. Seeing that every time would mean something is slow between `until` and the build.

### 6. `b` sits at cards, table 2. **The 30-minute clock starts here**
```bash
node scripts/cage.mjs b sit 2 5
```
- **Should print:** `b` with `seat table 2 epoch 1 atRisk 5 tNIGHT standing false`, and `table 2: epoch 1 · lastRound 0 · … · seated 1`. Its own sit isn't held to its permit's cap.
- **If you're past 25 minutes before step 12:** the table will die. See "If a table goes dead".

### 7. `a` deposits with a cap and an `until` on the bound
10 tNIGHT, a cap of 5, for exactly `maxGrant`, 720 hours (it was 24 in the earlier runs):
```bash
node scripts/cage.mjs a deposit 10 5 720
```
- **Should print:** `permit until <U> … 2592000s from the build · this cage's maxGrant 2592000s` with no "over it", then `TX deposit … SucceedEntirely`, then `a` with `balance 10 tNIGHT · payTo bound · no seat · permit cap 5 tNIGHT floor 5 tNIGHT until <U>`, with **no** `(names another judge)`. **New with L1:** the bound's edge against the real block clock. `until` is this machine's clock at the build plus exactly `maxGrant`, and the block that takes it comes about a minute later, after the proof. So it lands unless this clock runs more than that ahead of the chain's. If it fails with `a permit runs at most maxGrant`, or lands not applied, stop and send me the output, then run it again with 24 hours.

### 8. The judge tries to go over the cap (refused, nothing sent)
```bash
node scripts/cage.mjs b seat-by-judge a 1 6
```
- **Should print:** `FAILED:` with `atRisk over the permit's cap`, **no** `TX` line, exit code 1. If it lands, stop.

### 9. F5: nobody can send `a` home while the permit is live (refused, nothing sent)
```bash
node scripts/cage.mjs b rescue a
```
- **Should print:** `FAILED:` with `a permit is live: rescue after it runs out`, no `TX` line. **New in v4b.** If it lands, stop: `a`'s money would have gone home.

### 10. A seat by the judge: `b` seats `a` at dice, table 1. `a` signs nothing
```bash
node scripts/cage.mjs b seat-by-judge a 1 4
```
- **Should print:** `TX seatByJudge … SucceedEntirely`, then `a` with `seat table 1 epoch 1 atRisk 4 tNIGHT standing false`, and `table 1: … · seated 1`.
- **Undo:** `node scripts/cage.mjs b release 1 a`.

### 11. A move by the judge: dice to cards, in one transaction
```bash
node scripts/cage.mjs b move-by-judge a 1 2 5
```
- **Should print:** `TX seatByJudge … SucceedEntirely` (a move is `seatByJudge` with a from-table), then `a` with `seat table 2 epoch 1 atRisk 5 tNIGHT`, `table 1: … · seated 0`, and `table 2: … · seated 2`.
- **Undo:** `node scripts/cage.mjs b move-by-judge a 2 1 5`.

### 11b. Price the settle before sending it (no transaction)
```bash
CAGE_DRY_RUN=1 node scripts/cage.mjs b settle 2 1 a:-2 b:+2
```
- **Should print:** `DRY RUN settleBatch (…): {"node":{"bytes":<about 12,500>,…,"fits":true},…}`, then `released: … nothing was sent`. It builds, proves and balances step 12's settle, and runs the ledger's own fee calculation on it, which is where the first run's 168 came from.
- **If it prints `exceeded the maximum time to dismiss`:** stop. Step 12 would be refused.

### 12. A settle at cards: `a` loses 2 to `b`
```bash
node scripts/cage.mjs b settle 2 1 a:-2 b:+2
```
- **Should print:** `entry table 2 round 1: a:-2 b:+2 · debits 2 tNIGHT · credits 2 tNIGHT`, then `TX settleBatch … SucceedEntirely`. `a` has `balance 8 tNIGHT` and `atRisk 3 tNIGHT`, `b` has `balance 7 tNIGHT`, and `table 2: … lastRound 1`. This also resets the 30-minute clock.

### 13. `a` tries to withdraw while seated (refused, nothing sent)
```bash
node scripts/cage.mjs a withdraw 1
```
- **Should print:** `FAILED:` with `seated: stand first`, no `TX` line.

### 14. A revoke, while seated: `a` ends the permit
```bash
node scripts/cage.mjs a revoke
```
- **Should print:** `TX deposit … SucceedEntirely` (a revoke is a deposit of 0 with the empty permit), then `a` with `balance 8 tNIGHT · payTo bound · seat table 2 epoch 1 atRisk 3 tNIGHT standing false` and **no `permit`**. The seat stays, and no money moved. A deposit with money is refused while seated; a revoke isn't.

### 15. The judge tries to move `a` after the revoke (refused, nothing sent)
```bash
node scripts/cage.mjs b move-by-judge a 2 1 1
```
- **Should print:** `FAILED:` with `no permit`, no `TX` line. If it lands, stop.

### 16. A stand: `a` asks to leave
```bash
node scripts/cage.mjs a stand 2
```
- **Should print:** `TX stand … SucceedEntirely`, then `a` with `standing true since <T>`.

### 17. A settle naming `a` frees the seat
```bash
node scripts/cage.mjs b settle 2 2 a:+0
```
- **Should print:** `TX settleBatch … SucceedEntirely`, then `a` with `no seat`, and `table 2: … lastRound 2 · … seated 1`. `a`'s balance is still 8.

### 18. A withdraw: `a` takes everything home
```bash
node scripts/cage.mjs a withdraw 8
```
- **Should print:** `TX withdraw … SucceedEntirely`, then `a` with `balance 0 tNIGHT · payTo bound · no seat`.

### 19. `b` stands, and the stand ends `b`'s permit
```bash
node scripts/cage.mjs b stand 2
```
- **Should print:** `TX stand … SucceedEntirely`, then `b` with `standing true since <T>` and **no `permit`** on the line.

### 20. A settle naming `b` frees its seat
```bash
node scripts/cage.mjs b settle 2 3 b:+0
```
- **Should print:** `TX settleBatch … SucceedEntirely`, `b` with `no seat`, `table 2: … lastRound 3 · … seated 0`.

### 21. `b` takes its money home
```bash
node scripts/cage.mjs b withdraw 7
```
- **Should print:** `TX withdraw … SucceedEntirely`, then `b` with `balance 0 tNIGHT · no seat`.

### 22. Check nothing is left (no transaction)
```bash
node scripts/cage-balances.mjs $(node -p "require('./'+process.env.CAGE_FILE).address")
```
- **Should print:** `authority: committee 0 · threshold 1 · LOCKED`, `ids with money: 0 · 0 tNIGHT`, and `tables alive: 0`.

**When you're done with it:** the empty cage can stay on chain, as it costs nothing. `unset CAGE_FILE`. Keep the `.wallets` link, because the real deploy needs it.

## If a table goes dead

Thirty minutes with no settle, and the table's seats stop binding. Nothing is lost, and every balance stays free to withdraw.

| State | Do |
|---|---|
| `a` and `b` have seats on a dead table | `b sit 2 5` and `b seat-by-judge a 2 5` take new seats at a new epoch, if `a`'s permit is still there. Round numbers carry on from `lastRound` |
| A `settle` says `table is dead or empty` | The same, then settle with the next round number |

## What this doesn't cover

- **Races:** a settle and a stand in flight together, or two sits for one seat. Only simulated. They need more wallets and two terminals. They're in `docs/CAGE-V4-PLAN.md`, under "Rehearsal".
- **A stand running out by the clock,** which takes 30 real minutes, and **F5 opening after `until`**, which takes 24 hours for `b`'s permit and 30 days for `a`'s (simulated to the second in `test/permit.test.mjs`). Both permits end sooner here anyway: `a` revokes at step 14 and `b`'s stand ends its permit at step 19.
- **The judge service and the Hall.** This drives circuits by hand.
