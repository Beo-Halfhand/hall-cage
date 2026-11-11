# Cage v4: deploy and migration plan

**Status: not deployed.** Every chain step needs the owner's go. **The contract to deploy is v4b**, on branch `cage-v4b` (worktree `../sealed-cage-v4b`). The judge wired to it is branch `v4b-wire` (worktree `../sealed-cage-v4b-wire`), and the Hall's is `v4-staging` in sealed-hand.

## v4b, 2026-11-05: 11 circuits, so the locked deploy fits one transaction

The 14-circuit v4 deploy was refused on preprod: `1010 Invalid Transaction | "Transaction would exhaust the block limits"`. One transaction may use at most 63.99% of any one block limit: the node weighs a transaction as its largest share of a block limit times the block's weight, plus a flat 1%, against a normal-class cap of 65% (75% of the block, less 10% for initialization). For a deploy the limit that binds is `bytesWritten`, 50,000 a block, so **31,997 bytes written** in one transaction. A deploy writes about 1.2 times its verifier keys. `scripts/measure-deploy.mjs` reads all of this from the node and the indexer, and `cage.mjs <wallet> deploy-size` prices the real deploy without sending it.

| Deploy | Bytes written | Of the 31,997 allowed |
|---|---|---|
| Cage #3, 11 circuits, landed | 28,036 | 3,961 to spare |
| v4, 14 circuits | about 36,280 | 4,284 over: refused |
| v4b with 12 circuits (built and measured unbalanced, not chosen) | about 31,230 | about 770 to spare |
| **v4b, 11 circuits, built, proven and balanced, not sent** | **28,997** | **3,000 to spare** |

What changed, and nothing else:
- **A move is `seatByJudge` with a from-table.** `seatByJudge(id, fromTable, table, atRisk, now)`: `fromTable` none is v4's seat, `fromTable` some is v4's `moveByJudge`, the same checks and the same reads.
- **A revoke is a deposit of 0 with the empty permit.** `deposit(payout, 0, judge, 0, until)` ends the caller's permit, moves no money and reads only that permit, as `revoke()` did. `payout`, `judge` and `until` are ignored. A grant (cap above 0) still has to bring money.
- **A single settle is a batch of one.** `settleRound` is gone. It had never landed, and the judge only ever sends `settleBatch`.
- **F5 is fixed:** `rescue` is refused while a permit is live (there, and `until` not passed by the block's clock). A lost-key player with a permit waits for `until`. House floats still deposit with the empty permit, so they can still be sent home: see F5 below.

**Found in the first rehearsal (2026-11-05, step 12), and fixed: a small settle couldn't land.** Preprod refuses a transaction that would take longer to validate than 2 µs per byte of its size, with a 15 ms floor (`OutsideTimeToDismiss`, which the node sends as `1010 … Custom error: 168`). Proof verification is a large part of that time, at 4.555 µs per declared public input divided by a parallelism factor of 4, and `settleBatch` declares a fixed 14,687 of them, so it always takes 25.187 ms (measured). A settle needs at least 12,594 bytes, and a settle of nothing (12,291) or a two-line round (12,584) is refused. v4 had the same `settleBatch`, which had never been sent, so this isn't from the merges. Cage #3's declares 8,833.

| `settleBatch` | Public inputs | Time to dismiss (model fitted to the measurement) | Smallest transaction it can land in |
|---|---|---|---|
| 8 entries (v4, v4b) | 14,687 | 25.19 ms (measured 25.187) | 12,594 bytes |
| 6 entries | 11,029 | 21.0 ms | 10,511 bytes |
| **4 entries** | **7,371** | **16.9 ms** | **8,428 bytes**, under every settle measured |
| 3 entries | 5,542 | 14.8 ms | the 15 ms floor: any size |
| v4's `settleRound` | 1,884 | 10.6 ms | the 15 ms floor: any size |
| cage #3, 8 entries | 8,833 | 18.5 ms | 9,261 bytes |

**The fix, built and rehearsed** (the second run in `docs/CAGE-V4-REHEARSAL.md`: every step matched, including a two-player round and two settles of one): `settleBatch` takes 4 entries, and `ENTRIES_PER_BATCH` in `judge-plan.mjs` is 4 to match. Still 11 circuits, and the deploy is the same size (28,997 bytes written, measured again before sending). The judge fills one batch a cycle, so with more than 4 tables waiting the rest go in the next cycle, about 4 s later (`test/wire.test.mjs` on `v4b-wire`). The time to dismiss comes from the proof's declared public inputs: 257 for each line slot, 287 for each entry slot, 55 fixed, used or not. `test/zkir.test.mjs` now checks every circuit's predicted time against preprod's rule, so a wider batch can't come back by accident. `CAGE_DRY_RUN=1 node scripts/cage.mjs …` prices any call the way the node does without sending it.

## L1, 2026-11-06: a permit runs at most 30 days

**The owner's decision (2026-11-06, 6:01 AM): bound `until` on chain.** The review's L1: `deposit` took any `until`, and F5 refuses a rescue while block time is at or before it, so a lost-key player could be held for any length of time. A page passing milliseconds where seconds are meant would hold them about 60,000 years.

- **The rule:** a grant (cap above 0) needs `until <= block time + maxGrant`. In `deposit`: `if (c > 0) assert(disclose(until) <= maxGrant || blockTimeGte((disclose(until) - maxGrant) as Uint<64>), "a permit runs at most maxGrant")`. The first test keeps the subtraction from going below 0, and an until that small has passed anyway. `blockTimeGte(x)` is "block time is not before x". So the whole test is exactly `until <= block time + maxGrant`, with only the block's clock and no overflow.
- **No new knock-out.** Block time only goes up, so a grant that passes when built still passes when it lands (tested built at T, landed at T+1, on the bound). A grant is checked against the builder's clock when it's built, so `cage.mjs` counts a permit's length from the build, not from when the command started: the wallet sync before it takes minutes. `maxGrant` is sealed, so nothing changes it. The one knock-out is a builder whose clock runs ahead of the chain, with `until` within that lead of the bound. Callers stay well inside the bound: the Hall's permits are at most 24 hours.
- **The proof holds its half.** The proof says the clock answered "not before until - maxGrant", and the chain checks that answer against the block's clock. A proof that claims the other answer fails the circuit check (`test/zkir.test.mjs`).
- **`cap = 0` is untouched:** a plain deposit, a top-up under a permit, and a revoke carry any `until`, read neither `maxGrant` nor the clock, and a revoke still reads only the caller's permit.
- **`maxGrant` is a sealed constructor parameter**, the ninth, in seconds. The real deploy uses 2,592,000 (30 days), which `cage.mjs deploy` passes by default. The constructor refuses 0, and anything over 365 days. **That check runs only on the deployer's machine**, because a deploy carries its own initial state. It also takes 720, 30 days in hours, as 12 minutes. So `cage.mjs deploy` deploys only 2,592,000 unless `CAGE_ALLOW_MAX_GRANT=1` (`scripts/deploy-params.mjs`, tested), and checks the value on chain after.
- **What L1 doesn't bound:** a seat that binds holds a balance as it did before. A judge key that seats a lost-key player before `until`, and keeps the table alive with settles, holds them for as long as it does that (`test/permit.test.mjs`, the KNOWN test). The honest judge releases them. So L1 bounds F5's own hold, not the trust in the judge.
- **Costs:** most writes are up to 26 bytes bigger, in bytes written, bytes deleted or both (a top-up is unchanged), as the new cell sits in the first group, which every write rewrites. That is fees only. `maxGrant` is read twice, once for each test. Reading it once would declare 512 public inputs, not 524. That isn't done: it would change `deposit`'s keys after the rehearsal, for about 14 µs.
- **Placed after `roundCap`, not after `permits` as the review suggested.** The compiler keeps the last 15 ledger fields in a group of their own, so a 20th field at the end would push `escapeSecs` into the first group and renumber 14 fields, moving every circuit's state paths. After `roundCap`, no other field moves. **Every circuit but `deposit` compiles to the same zkir and verifier key as the build rehearsed on 2026-11-05.** `deposit` declares 524 public inputs, up from 485 (about 9.1 ms to dismiss, under the 15 ms floor).
- Still 11 circuits, compiler 0.31.1. **Built and rehearsed:** the third run in `docs/CAGE-V4-REHEARSAL.md` matched every step. The deploy wrote 29,083 bytes, measured before sending and again on landing, of 31,997. A grant one second over `maxGrant` was refused when built, and one of exactly `maxGrant` landed.
- **The Hall, for the cut-over** (`sealed-hand` `v4-staging` at `60ad8ac`; listed here, not made. That commit already builds against `v4b-wire`'s L1 build and refuses anything older than v4b):
  1. **The wallet app's contract:** the bundle on `60ad8ac` was built from `v4b-wire` `78eb20e`. Its zkir and keys are byte-identical to the final build (`2e3e267`), and its `index.js` differs only in source line numbers. Rebuild from the final build for tidiness, and serve that build's keys at `/wallet-app/zk`. Of the 11 circuits, `deposit`'s keys are the ones L1 changed.
  2. **`scripts/cage-build-check.mjs`, `requireV4b`:** it already reads `maxGrant` (`cageBuildOf`). Also stop when it is missing: the 4-entry v4b build from before L1 passes today, and its `deposit` can't prove for this cage.
  3. **`public/js/cage-session.js:68-71`, `depositArgs`:** keep `until` a whole number of seconds and clamp it to `nowSecs()` + 30 days − 1 hour. Today it is the door's expiry (at most 24 hours, `src/platform/door.js:58`) or `nowSecs()` + 12 hours, already inside. The clamp is so a door expiry in milliseconds, or a longer door, can't make a grant the cage refuses.
  4. **`public/js/wallet-core.js:357`, `explainTrouble`:** the cage's own refusal before anything is sent (`failed assert: a permit runs at most maxGrant`, and the other asserts) falls through to "Your wallet said no", which blames the wallet. Add a card for "the cage refused it before anything was sent; nothing was spent".
  5. **`src/platform/door.js:13`, `MAX_DOOR_SECS`** (24 hours): the page uses the door's expiry as the permit's `until`, so pin it at or under `maxGrant` with a test.
  6. **Optional:** read `L.maxGrant` with the permit (`wallet-app/src/cage-read.js:22`), check it is 2,592,000 on the cage the page talks to, and say on the permit tile that a permit runs at most 30 days.
  7. **No test change needed:** `test/v4-acceptance.test.js` takes `sim-chain.mjs` from `v4b-wire`, which now deploys with `maxGrant`. At `3609fbc`, exported to a scratch folder, it passed 4 of 4 against this build, with the same wallet prompts as before.

The rest of this plan was written for v4 and still holds, read with the names above. The judge and Hall wiring (the two lists below, with the owner's decisions of 2026-11-05) was built on `v4-wire` and moved onto v4b as `v4b-wire` and the Hall's `v4-staging`.

<!-- v4-wire status line, kept for history: **Status: not deployed. Nothing in this plan has been run on a chain.** Every chain step needs the owner's go. The contract is on branch `cage-v4`. The judge and Hall wiring (the two lists below, with the owner's decisions of 2026-11-05) is on `v4-wire` in both repos, tested in the simulator only. -->

## What changes for anything that calls the cage

| Change | Who it affects | What they must do |
|---|---|---|
| `stand(tableId)` is now `stand(tableId, now)` | Hall wallet page, `cage.mjs` (done), `e2e-table.mjs` (goes through `cage.mjs`) | Pass a declared time, as `sit` does |
| `Seat` gains `standAt` and loses `atRisk`. `Table` loses `epoch` and `seated`. New maps: `risks`, `epochs`, `seats` (a Counter) | Anything reading state through the compiled contract: `wallet-app/src/cage.js:125-160`, `cage.mjs`, `expect.mjs`, `judge.mjs`, `cage-balances.mjs` (the last four done) | Read `L.risks.lookup(id)`, `L.epochs.lookup(t)`, `L.seats.lookup(t).read()` |
| `deposit` is refused while a seat binds | Hall wallet page | Disable "add tNIGHT" while seated |
| `stand` is refused the second time | Hall wallet page | Treat "already standing" as done, not as an error |
| A stand expires `escapeSecs` after its declared time | Worker, judge (done) | No round may outlast it. See below |
| An expired stand's withdraw doesn't take the seat off the table's count | Judge (done) | It releases the seat once no round is waiting |
| `judgeDelay ≥ escapeSecs + clockSlack` | Deploy parameters | Use the values below |
| Verifier keys are new, and the address is new | Worker, wallet page, receipts, sponsor, agents | See the list below |
| `deposit(payout, amount)` is now `deposit(payout, amount, judge, cap, until)` | Hall wallet page, `cage.mjs` and `judge.mjs` (done) | Pass the permit. `judge = 32 zero bytes, cap = 0, until = 0` is the empty permit, which grants nothing and leaves any permit already there |
| New circuit: `seatByJudge`, which also moves (v4b). A revoke is a deposit of 0. `settleRound` is gone. 11 circuits, as cage #3 | Judge, Worker, wallet page | See "Seat authority" and v4b above |
| A line naming an expired stand is dropped, and the rest of the entry settles | Judge (done), Worker | See "Rule for an expired stand (F4)" |

Player ids don't change: `playerId` keeps its domain string, so a player key has the same id in v4. A player still has to deposit again, and their first deposit there binds the payout address.

## Seat authority

Built as the owner decided on 2026-11-04: option B, the permit travels on the deposit. A first visit is one approval and one signature, then play anywhere with no wallet prompts.

| Circuit | Who | Rule |
|---|---|---|
| `deposit(payout, amount, judge, cap, until)` | player | As before. `cap > 0` records `permits[id] = { judge, cap, until, floor }`, with `until` at most `maxGrant` past the block's clock (L1), replacing any permit there, with `floor = balance after this deposit - cap`, or 0 if the cap is that balance or more. `cap = 0` is the empty permit: any permit there stays, and its floor rises by the amount deposited |
| `seatByJudge(id, table, atRisk, now)` | judge | Judge only. The permit must name this judge and not have run out. `0 < atRisk <= cap`, `atRisk <= balance`, `atRisk + floor <= balance`. No seat binding, none standing. Writes the seat exactly as `sit` does |
| `moveByJudge(id, from, to, atRisk, now)` | judge | The same checks. The seat must be at `from`, not standing, and `to` must be another table. Releases and seats in one transaction |
| `stand(tableId, now)` | player | As before, and **it ends any permit** |
| `revoke()` | player | Removes the caller's permit. A seat already held stays until it is settled, released or stood from |

**The floor** is what makes `cap` the most a permit can lose. The judge can never place anything that a loss would take below it. The owner's decision 1. Things to know:

- **A win sits above the floor,** so it can be placed at risk too. The bound is `cap` plus any wins since the grant.
- **A release gives nothing back,** and neither does a hop: only what was actually lost counts.
- **It binds the judge, not the player.** A player's own `sit` isn't held to it.
- **A withdraw leaves it where it is,** so the judge can place less, or nothing, until a new grant. A stranger's `rescue` does the same, so after F5 griefing the player has to grant again: the page's deposit must pass a cap, not an empty permit.
- **Using up the cap costs one new approval:** a deposit with a new cap, and a new floor from the balance then. So a re-grant restores the whole cap: across grants, the bound is the sum of the caps.
- **Exactly what a stolen key can take under one grant:** `balance - floor`, which is `cap` plus net wins since the grant, less withdrawals and losses at the player's own seats. The second audit tried to get past this and couldn't, with 36,000 fuzz steps behind it.
- **`until` should be short,** as it bounds how long a stolen key can interfere. Since L1 the contract refuses one more than `maxGrant` (30 days) past the block's clock, but that is a ceiling, not a target. The page uses the door's 12 to 24 hours.

**A permit names a key, not "the current judge"** (The owner's decision 5). After a rotation the new key can't use old permits, so every player grants again, one prompt each. A rotated-in thief inherits nothing, and a permit can name a proposed judge in advance.

**Other choices:**

- **`until` is checked against the block's clock,** because a declared `now` can lag by `clockSlack`, which would stretch every permit by 5 minutes.
- **A standing seat can't be seated over or moved.** A player can only reach this with a new grant after their stand ran out. The old seat may still be on its table's count, and only their own `sit` or a `release` takes it off.
- **`revoke` reads only the caller's own permit,** so nothing the judge or a stranger does can keep it off the chain. After a stand it fails with "no permit", which means it's already done.

`sit`, `withdraw`, `release`, `settleRound`, `settleBatch`, `rescue` and the rotation circuits have the same source as before, apart from `sit` being split into two helpers. **Their zkir and verifier keys are not byte-identical to the build before permits:** adding a ledger field moves state paths (`settleBatch` +105 instructions, 0.3%).

### What a stolen judge key can do under a live permit

| | Without a permit | With a live permit |
|---|---|---|
| What it can take | Each seat's `atRisk`, which the player chose per sit | **`cap`, plus any wins since the grant,** to a mule at the same tables |
| Keeping a player in | At most `escapeSecs` once they stand | The same once a stand lands. **It can knock out a stand in flight by moving the seat first** |
| The way out | `stand`, then wait or be settled, then `withdraw` | The same. If a stand keeps failing, `revoke` first: it can't be blocked, and it ends the moves |
| What it can never do | Withdraw, or change the payout address | The same. All money still leaves only to the bound address |

### The page's way out

**`stand`, then `withdraw`. No `revoke` needed:** a stand ends the permit. `public/js/wallet.js` already has both buttons and needs no new step for this.

**The page must have one fallback, or a stolen key can hold a player until `until`.** A move rewrites what a stand reads, so a thief can knock out every stand (the second audit: 200 of 200). If a `stand` fails because the seat moved, try again. If it fails again, offer `revoke`, then `stand`. An honest judge moves a seat only when the player asks, so a repeated failure means something is wrong. No judge action can knock out a `revoke`. No loss beyond the floor comes from this: it's a hold-up. `test/permit.test.mjs` pins it: 20 stands knocked out by 20 moves, then the revoke lands.

### Judge changes (built on `v4-wire`, simulator only)

**Since the 4-entry batch (review of v4b, 2026-11-05):**
- **H-1, fixed:** the judge used to fill each settle batch first come, first served, in the Worker's table order. At 4 slots, four busy tables listed earlier could starve the next one past its keep-alive or its hold, so a loser's line was dropped. `fillBatch` in `judge-cycle.mjs` now puts a table with a stand about to run out first, then the earliest deadline, and takes one item from each table in turn. `test/wire.test.mjs` pins it, and the reviewer's starvation, drain and F4 scripts all hold.
- **L-1, fixed:** `judge.mjs` stops at start if the compiled cage's `settleBatch` width isn't `ENTRIES_PER_BATCH` (`checkBatchWidth`).
- **L-2 and M-2, fixed:** a table that settles every cycle used to skip its releases, so a player who had left stayed bound while the table played on. With fair batches that would have been every busy table. A table settled this cycle is now planned again on the chain as it is after the settle, and its releases go out. The fresh plan still holds back anyone who owes a line.
- **H-2, fixed (the re-review of the fair batch):** a table whose settle the cage keeps refusing never moves its heartbeat, so by deadline it went first in every batch and took the tables beside it down. A table whose last settle failed is now settled on its own until one lands: the clean tables settle together, then the neediest suspect alone.
- **H-3, judge side fixed:** the cage frees a standing seat at its first line, and a line is capped at `roundCap`, so a standing seat can never pay more than `roundCap`. The judge now never seats more than `roundCap` at risk, `checkClaim` refuses a seat over it, and a planned line over it blocks the table with an alert instead of being sent again and again. The contract can't change, so a player's own `sit` can still go over it. Such a seat is just never dealt in.
- **M-3, fixed:** while a table's round is in flight, no stray release is sent there either. The round out there may name the seat.
- **M-1, fixed (2026-11-06):** one batch holds 4 entries, so over 4 rounds a cycle a backlog grew without end (160 of 240 settled at 6 busy tables in the reviewer's sim). The judge now sends a second settle in the same cycle, `SETTLES_PER_CYCLE` = 2 in all, counting a suspect's settle alone. It goes only after the first landed, only while rounds are left over (keep-alives alone don't count), and only with DUST at `SECOND_SETTLE_RESERVE` (2) times `MIN_DUST`, the reserve below which seats already stop. The clean tables are planned again on the chain after the first settle, so the tables it left out are nearest their deadlines and go first. Ties still go to the round that has waited longest, then to the table settled less this cycle. The sim now settles 240 of 240 at 6 busy tables and 320 of 320 at 8. Past 8 rounds a cycle a backlog still builds (320 of 400 at 10). On preprod the gain depends on how long a settle takes against the rest of a cycle: both settles share one wallet, and seats and releases wait behind the second.
- **L-3, open, older than this:** a lost socket's outcome is waited on for 240 s, longer than the 180 s hold margin, so a line lost at a hold's end is dropped. The fix is to resolve unknowns inside the hold margin, or widen the margin.

In `scripts/judge-plan.mjs` (`planAsk`, `planAsks`, the journal's seat records) and `scripts/judge-cycle.mjs`. Tested in `test/wire.test.mjs`. As built, stops seating at twice `MIN_DUST`, so settles keep a reserve. On a seat refused for low DUST the page falls back to the player's own sit.

1. **`chainFor`:** read `L.permits` and expose `permit(id)`. `answerDoors` passes `{cap, until, floor}` so the Hall can show what is left to place.
2. **`planTable`:** new outputs `seats` and `moves`, from new Worker requests. Each checks what the contract will check, before spending a proof: the permit exists, names this judge and has more than a landing's margin left (allow 90 s); `0 < atRisk <= cap`; `atRisk <= balance - floor`; not bound and not standing (seat) or at `from` and not standing (move); `to` has room. When `balance - floor` is under what the table wants, the door asks for a new grant.
3. **Settle first, always.** The contract can't see a live round. A move needs no entry naming that seat pending, journaled or in flight at `from`, and the Worker's round there over. Otherwise it voids a loser's debit, silently since the rule for someone who has left and whose seat has gone, and resets their `atRisk`. A player must not be able to hop away from a loss. There is no contract check behind this, so it needs its own test when built.
4. **Order on one wallet.** Both tables in a move count as busy: skip if either is in `journal.tablesInFlight()`. A seat at table T reads T's heartbeat, so a settle landing first fails it. Same cycle: settles, then one seat or move, so a queue of hops can't hold up a round. Same idea as `floatStep`.
5. **Failures are separate from settle failures.** A player's own deposit, withdraw or a stranger's rescue fails a seat or move (`test/permit.test.mjs` shows it). That must not feed `tries`, or one griefer pauses a table for everyone. Back off per player instead.
6. **Lost socket:** never resend. Read the seat back from the chain: at the target table means done. A seat needs no round number, so the journal isn't the guard here. Log it there anyway for receipts.
7. **DUST is now spent on players' behalf.** Each hop is a judge-paid transaction. Rate-limit per player (one hop per in-flight round, say) and stop seating below `MIN_DUST`, as settles do. Today a player pays for their own sit.
8. **Strays:** today's rule frees only standing seats. A judge-made seat whose claim was cancelled or timed out isn't standing, so it would bind with nobody playing. Add: seats the judge made with no holder and no live claim get released.
9. **`checkClaim` stays the read-back.** Judge seats first, and the claim confirms it on the next cycle. `CLAIM_PATIENCE_MS` (5 min) covers a 40 s seat, so it doesn't change.
10. **On Leave: release, unless the next table is already known.** Then move. A release opens the F5 gap between seats. A parked seat is the alternative, but it takes up a seat, stays bound while others keep the table alive, and blocks a withdraw until someone releases it. Per the existing rule a player's seat is never kept alive by a settle of nothing. A parked seat should follow that.
11. **Rotation:** a permit naming the old key fails `seatByJudge`. The door should say so and ask for a new grant, not retry.

### Hall sit and hop flow (built on `v4-wire` in the Hall repo, simulator only)

Item 9's `e2e-*` scripts were already out of date against the page's ids before this, and they need preprod. They aren't updated. The acceptance test is `test/v4-acceptance.test.js` in the Hall repo.

1. **Deposit:** `wallet-app/src/cage.js` and `public/js/wallet.js` pass five arguments: `judge` from `L.judge`, `cap` from the tile, `until` from the door session's expiry (12 hours).
2. **The tile** states the cap: the most this permit can lose, plus anything you win while it's live. It must not say the risk ends at `until` (a seat placed before it stays debitable). Each deposit that grants passes a cap; a top-up with no cap adds nothing the judge can place.
3. **A new Worker op,** "ask the judge to seat me": `cage-seat` with a door token and `atRisk`, in place of "I have sat, read it". `cageWork` lists seat and move requests. Falls back to today's `sit` prompt when there is no good permit.
4. **Hop:** Leave marks the holder as moving; the judge settles, then moves; the holder comes off the old table and on at the new one, using the new `atRisk`. `clampHolder` reads the new `atRisk`.
5. **The window:** "The judge seats you" and no approve stage when the permit is good. About 40 s, as a sit is today.
6. **My cage:** a Revoke button, and the way out above: `stand`, then `withdraw`, with `revoke` as the fallback. Treat "no permit" from a revoke as done.
7. **Raising a cap needs an unbound seat:** `deposit` is refused while a seat binds, so the flow is the judge releasing at the round's end, then the deposit, which is one prompt.
8. **Receipts:** "seated by the judge under your permit of <date>" with the transaction link.
9. **`e2e-page.mjs`, `e2e-dice.mjs`, `e2e-topup.mjs`** drive the page, so they follow it. The owner's acceptance test (dice, leave, cards, sit, play, back to dice, zero prompts) doesn't exist yet and goes with this.

## Audit findings

### Second audit, on the final contract

`compact-core:security-reviewer` on sha `ead604b81fb3b17d`, in a clean folder with only the contract, the spec and `judge-plan.mjs`: no tests, no docs, no earlier findings. Another Claude, not a human auditor, in the simulator. **No Critical, and no way past the floor:** 36,000 fuzz steps, 9,799 landed, with no violation of the floor, money conservation or seat counts, and no failed exit.

| # | Severity | What | Status |
|---|---|---|---|
| H-1 | High | A loser can run a round out of time and void it | **Fixed** in `judge-plan.mjs`: see "A round can't be run out of time". No contract change. The same reviewer attacked the fix: its three timelines are closed, and it found the items listed there |
| M-1 | Medium, **High for a stand-only page** | A stolen key can knock out every stand and withdraw while a permit lives | **Reported:** it's a hold-up, with no loss past the floor. The page needs the fallback under "The page's way out". The contract is unchanged |
| M-2 | Medium | A stranger can `rescue` any unseated balance, again and again | F5, accepted on preprod. Worth weighing for mainnet: the reviewer's fix refuses `rescue` while a permit is live, and it compiled and behaved in its test, at the cost of a lost-key player waiting for `until` |
| M-3 | Medium | Rotation can't remove a thief who's paying attention | By design, on a contract nobody can patch: after a theft, tell players to stand and leave, and deploy a new cage |
| M-4 | Medium | Cheap table-full griefing, and expired stands hold seats with no money | Open, availability only (also first audit's M-2). The comment on `strays` is stale: a sit no longer breaks a settle |
| M-5 | Medium | A line naming a vanished seat blocks the table | **Fixed** with H-1, for someone who has left. The re-check's N-1 asked whether a release or a move could use this to void a loss. A release can't: `releasesDue` refuses anyone who owes a line, `judge.mjs` holds releases while a settle is out, and the plan now refuses too. Moves aren't built: see judge change 3 |
| M-6 | Medium | A standing seat pays at most one line, capped by `roundCap`, and the plan doesn't check that | Open. Clip merged debits to `roundCap` and shave the other side. Only matters for a backlog over 1000 tNIGHT, and a settle before each deal avoids one |
| L-1 | Low | A lost key at a table the judge keeps alive depends on its `release` | By design. The judge should release idle seats |
| L-2 | Low | Rotating A to B to A revives A's permits, and a proposal never expires | Don't reuse judge keys. Cancel what you don't accept |
| L-3 | Low | The constructor allows a slack just under the escape | The planned 300 and 1800 are fine |
| L-4 | Low | `door: true` and the claim message | **Checked in the Worker, not a problem:** it sets `door` itself from a verified session, takes the id from that session, and builds the message itself |
| L-5 | Low | Rake paths | Not live at `maxRake` 0 |

### First audit, what became of it

`/compact-core:audit-compact` on the earlier contract (sha `3c0188ac59eeafbb`). Another Claude, not a human auditor, in the simulator.

| # | Severity | What | Status |
|---|---|---|---|
| H-1 | High | The cap limited each seat, not the total | **Closed:** the floor (The owner's decision 1) |
| M-1 | Medium | A landed stand didn't stop a live permit | **Closed:** a stand ends the permit (decision 2) |
| M-2 | Medium | Sybils fill a table for 6 STAR, refundable. Expired stands can then hold the seats with no money behind them | Open, availability only. Off-chain: abandon a squatted table id, and reap unknown non-standing seats |
| M-3 | Medium | `rescue` griefing | F5, below: accepted on preprod, fix before mainnet |
| M-4 | Medium | Joining doesn't extend a table's deadline, so a round started late can be voided by the clock. Winners lose the round's debit | Worker: don't deal a round that can't finish before `heartbeat + escapeSecs`, or settle at its start first. **Part of item 4 below** |
| M-5 | Medium | A locked contract can't re-key, so a fork that retires its key version would strand the funds | **Decide before mainnet (The owner's decision 4).** Source check: possible, not planned. See below. Preprod stays as planned |
| L-1 | Low | A judge proposal never expires | Ops rule: cancel what you don't accept |
| L-2 | Low | `until` limits seating, not exposure | By design. The tile must not say the risk ends at `until` |
| L-3 | Low | A standing seat pays at most `roundCap` more | `planTable` should check `roundCap` |
| L-4 | Low | A lost key at a table kept alive depends on the judge's `release` | By design |
| L-5 | Low | A stolen key can contest a rotation for ever | Accepted as F9 |

**M-5, the source check.** In `midnight-ledger`, nothing inside a running ledger can change a contract's keys except a maintenance update, and with an empty committee nobody can sign one. A key version can only be retired by a code change in a new ledger release. Practice so far is to keep old keys working: 7 to 8 left them unchanged, 8 to 9 carries them over and verifies old proofs with the old stack, and the ledger-10 branch still does. The node's notes say mainnet has always run ledger 8 onwards. **No published policy promises this, and current code can't prove what a future fork will do.** For real money, either keep a real committee (an offline or multisig key is the only recovery path found), or lock and publish a plan to drain before any such fork. `threshold` must stay at 1: a threshold of 0 would let anyone send maintenance updates.

## Rule for an expired stand (F4)

The owner's decision, built in `judge-plan.mjs` (`dropExpiredLines`) with tests. **No contract change.**

The judge drops any line naming a stand that has run out, or would by the time the settle lands (`DEAD_MARGIN_SECS`). That player's balance and `atRisk` are untouched, and the rest of the entry settles.

**One thing the owner's rule didn't say, because the contract forces it:** `debits` must equal `credits`, so what was dropped has to come off the other side. I chose to share it by size, in whole chips, with the largest remainder first and then line order. An expired loser means the winners get less. An expired winner means the losers pay less, and that winner goes unpaid. A line shaved to nothing stays in, because it may be what frees a standing seat. Tell me if the rule should be different.

| Case | What happens |
|---|---|
| Other lines remain | They settle, shaved to add up. Logged |
| Only expired lines | A zero line for a seated, non-standing holder carries the round, because an entry with no lines is refused by the node |
| Only expired lines, nobody else seated | Blocked, alert to a person |
| The entry never added up | Blocked, alert to a person. It's a fault, not something to shave |
| Someone who has left, and whose seat has gone (back at another table, or freed by the settle that ended a hold) | The same as an expired stand: dropped, and the rest settles. Blocking would only let the table die with everyone's rounds. Someone who hasn't left still blocks, as a fault |

**A round can't be run out of time (second audit's H-1, fixed in `judge-plan.mjs`).** Before this fix, a hold for a standing player settled nothing and refreshed nothing, so a loser could stall until the table died or the stand ran out, and every finished round went with it. Now:

- **A table with a round in play or on hold gets a settle of nothing** 10 minutes before it would go quiet, naming someone not standing.
- **A hold ends 3 minutes before the stand's deadline or the table's,** whichever comes first, and what's finished settles, naming the standing seat. Their loss lands.
- **A seat that still owes a line is never released.** The Worker doesn't list one anyway (`releasesDue`), and the plan doesn't rely on that.
- **A seated player with no round going still gets no settle of nothing.** Their escape is theirs, and anyone can stand to leave.

**What this fix leaves open, all rated Medium or below by the re-check.** All come from one fact: a back-dated stand leaves a hold of 1321 s, and a slow round is about 1380 s.

| # | What | What closes it |
|---|---|---|
| N-2 | A stand in the first minute of a slow round can outlast the hold. If an earlier round is pending, its settle frees the seat mid-round, and that player's line for the round in play is dropped. A free roll: a loser walks, and a winner can re-sit with 1 chip and collect | The Worker: fold a standing player out at the hold's end, so their line exists; don't deal a round that can't finish. A flag for "freed by a settle" closes the re-sit |
| N-3 | Friends named in an entry can each knock it out once in the 150 s left after a hold ends: about 3 friends at a 50 s settle cycle. The stand then runs out and the line is dropped | A wider `HOLD_MARGIN_SECS`, about 30 s plus 5 settle cycles, once real cycle times are known |
| N-4 | **An honest player can lose a win this way:** one who stands 300 s after someone back-dated, both named in a pending entry, is freed by the other's deadline, and their +50 is dropped | As N-2 |
| N-5 | A backlog over `roundCap` can't land, and that also stops the settle of nothing, so the table dies with everyone's rounds. Worse than M-6 alone | Clip to `roundCap` and shave, and allow a settle of nothing when an entry can't land |
| N-6 | Low. A carrier's stand landing between the plan and the build: the zero line frees them | Re-check the carrier at build time |
| N-7 | Low. A stuck `inRound` means settles of nothing for as long as it lasts: 17 in 6 hours. A player can still stand, but a lost-key player has no way out without a release | Stop once a round is past its longest possible age |

**The owner's decision, 2026-11-05: `escapeSecs` stays 1800,** and N-2 and N-4 are handled in the Worker (`v4-wire`): a round is ended 240 s before a stand or the table runs out, a carried pot goes back for someone going for good, and a settle that names a standing seat marks them `freed`, so a re-sit can't collect. N-7 is closed too. N-3 and N-5 are still open. **Also his decision: a page fallback for a knocked-out stand, and F4 reaching a departed player's dead line,** both as built.

**Worker change needed:** `/settled` now also carries `dropped` and the `lines` that actually landed when a line was dropped. Today's `cageSettled` ignores them and logs its own `e.lines`, so **receipts and table stacks would show the unshaved numbers** until it uses them.

## F5: fixed in v4b for permits; still open for house floats

**v4b:** `rescue` is refused while a permit is live, so a granted player can't be sent home between seats. **Still open:** a house float deposits with the empty permit, so a stranger can still send it home between its deposit and its sit (`test/permit.test.mjs` pins it). The judge can close that without a new cage: deposit floats with a short permit naming itself. The text below is the v4 history.

**The owner's decision then: accepted on preprod, and it must be fixed before mainnet.** With the floor it costs a little more: the permit is still there, but its floor stays where it was, so the player has to grant again, not just deposit. `rescue` needs no key, so a stranger can send anyone with no binding seat home, for one transaction fee each time. The money goes to their own bound address, so nothing is lost. It is availability only, and `test/permit.test.mjs` pins it.

| Who | Window | Effect |
|---|---|---|
| A player | Between deposit and first seat | Their money goes home. They approve and deposit again |
| A player, with seat authority | **Every gap between seats, when the judge releases instead of moving.** This window is new, and far longer than a sit | Same, and they have to grant again. `moveByJudge` leaves no gap |
| **A house float** | Between the float's deposit and its sit | The float goes back to the judge wallet, the warm table starts again, and the judge pays another deposit. It costs the griefer about one fee to cost the judge two. A griefer can keep a warm table from ever being ready |

**The fix, when it comes:** a last-deposit time and a wait on `rescue`, which slows the lost-key path a little. It needs a contract change, so a new cage.

## Parameters

| Parameter | Cage #3 | v4 | Why |
|---|---|---|---|
| `escapeSecs` | 1800 | 1800 | No reason to change it, if the Worker change below is made |
| `clockSlack` | 300 | 300 | |
| `judgeDelay` | 1800 | **2700** | The owner's decision, 2026-11-04. The floor is 2100. A proposal can be back-dated by the slack, and a player needs time to see it and stand: `2700 = 1800 + 300 + 600` |
| `roundCap` | 1000 tNIGHT | 1000 tNIGHT | `cage.mjs` defaults to 756, so pass it (NOTES.md) |
| `maxRake` | 0 | 0 | |
| Seats | 6 | 6 | |
| `maxGrant` | none | **2,592,000 s (30 days)** | v4b with L1: the longest a permit runs, so the longest F5 holds a lost-key player. The owner's decision, 2026-11-06. `cage.mjs deploy` passes it by default |
| Compiler | 0.31.1 | 0.31.1 | Peer docs say newer toolchains don't work with preprod. Not verified. Don't upgrade as part of this |

## Must be done before the deploy

**In `sealed-hand-dice` (another job owns it, so nothing there is edited here):**

0. **`wallet-app/src/cage.js:125-160`:** read `atRisk`, the epoch and the seat count from their new places (see the first table). Line numbers in this repo move: another job is editing it.
1. **`public/js/wallet.js:651`:** `stand` passes `now`, worked out per try as `sit` does at `:647`.
2. **`public/js/wallet.js:495,500`:** `deposit`, `bring-deposit-go` and `bring-add-go` disabled while seated. The cage refuses it anyway, before anything is sent, so this is about not offering a button that can't work.
3. **`wallet-app/scripts/copy-contract.mjs`:** run it with `SEALED_CAGE_DIR=../sealed-cage-v4`, then rebuild. By default it reads the main checkout.
4. **`src/platform/cage-table.js:119`, the `standing` op:** the judge now sends `standUntil`, unix seconds. The Worker has to get that player's last entry out before then, or their loss can't be debited. This is the one that matters: a player who sees a bad hand can stand and then use the turn clock.
   - 15 s turns put a slow round at 23 minutes (NOTES.md), and a stand can be back-dated to leave 25. That fits, narrowly.
   - A carried pot produces no entry until it's paid (`platform/cage.js:155`), so a standing player in a carried pot could run past the deadline. Their last round must end with an entry, whatever the pot does.
   - The fix: on `standing`, the player plays no new round, and the table doesn't start a round that can't finish before the earliest of `standUntil` and the table's own deadline. That also closes Finding D, and audit M-4.
   - **It matters more since F4:** a loser who outlasts their stand now has their loss forgiven at the winners' expense.
   - **And since the hold has an end:** fold a standing player out by the time it ends, or they're freed mid-round. See N-2 and N-4.
5. **A drain switch:** a way to refuse new tNIGHT tables while the judge API stays up. `TNIGHT_TABLES` can't do this: turning it off also turns off `/judge` (`judge-api.js:31`).
6. **Receipts:** the book is keyed on `${CAGE_ADDRESS}:${table}` (`receipts.js:43`), so changing the address hides cage #3's receipts. Decide whether they stay readable.
7. **A new `CAGE_ADDRESS`** in `wrangler.staging.toml:18` and `wrangler.tnight.toml:16`. Door and seat signatures name the address (`checkDoor` and `checkClaim` in `judge-plan.mjs`), so players sign again.

**Elsewhere:**

8. `sealed-sponsor/policy.json:6` and `hall-agents/scripts/challenge-demo.mjs:53` name cage #3.
9. **Judge, not done here:** rank 6 of the Omega report (don't pause near the deadline, retry a failed batch one table at a time). With v4 a settle breaks at most once per seat it names, and only if that player stands just then. So three failures, and with them a 3-minute pause, need at least three colluding players in one round, or in one batch across tables. A failed batch still fails every table in it, so do this before the deploy. It needs no redeploy.
10. **The judge goes under launchd when v4 deploys (The owner's decision).** `judge.mjs` exits with 75 on a stuck sync and nothing restarts it today, so the tables die 30 minutes later. `launchd/com.example.sealed-cage-judge.plist` now points at v4. **Written, not loaded:** the steps are in cut-over step 7.

## Decide before the deploy

The contract is locked once deployed, so these are the last chance. Findings are from the independent review. F4 and F5 are decided: see their sections above. What's still open is whether `cap` is per seat or a total (under "Seat authority"), whether a stand ends the permit (M-1), and what M-5 means for real money. See "Audit findings".

| # | What | Recommendation |
|---|---|---|
| F6 | With rake on, anyone can break a rake settle with `rescue(houseId)`, once per landed rake settle, and rake settles at different tables collide | No effect at `maxRake` 0. Don't turn rake on in this cage |
| F8 | A settle can move the heartbeat backwards, by up to the slack | Accept. Only the judge can do it, and it only shortens its own window |
| F9 | A stolen judge key can contest a rotation for ever | Accept. Players can now always stand and leave, and a new cage is the way out |
| F10 | Expired stands hold their place on the count until reaped | Accept. The judge reaps them when no round is waiting |

**Still true with v4, for a player with no live permit:** a stolen judge key can take each seat's `atRisk`, and can hold a player for at most the stand's `escapeSecs` once they stand. A stand can't be pushed off the chain except by a `release`, which frees the seat. **With a live permit, none of that holds until the player revokes:** see "Seat authority" and audit M-1.

## Rehearsal on preprod (throwaway cage, needs the owner's go)

**Start with `docs/CAGE-V4-REHEARSAL.md`:** the walk-through with wallets `a` and `b`, with what each step should print and how to undo it. The table below is the fuller list, including the races. **It needs more wallets than exist:** only `a`, `b` and `judge` do, and `judge` belongs to the running judge. New ones take `address`, funding, and about an hour's first sync.

`acceptJudge` and `settleRound` have never landed on preprod. A locked deploy, a `Counter` table, `withdraw` of an expired stand and the races below haven't either. Proofs for `stand`, `deposit`, `sit`, `withdraw` and a full `settleBatch` have been made locally with throwaway keys, and none has gone to a network. Use a separate wallet so the running judge isn't touched, and keep the escape short so the waits are short. **Slack has to stay well under escape, and above the 60 s that `cage.mjs` declares behind the clock:**

```bash
cd ../sealed-cage-v4
ln -s ../sealed-cage/.wallets .wallets     # the wallets stay in one place. Never run two processes on one wallet
export CAGE_FILE=deployment.cage4-test.json
node scripts/cage.mjs a deploy 300 600 0 1000 120
```

| # | Do | Must see |
|---|---|---|
| 1 | `node scripts/cage.mjs a state` | `LOCKED`, committee 0, threshold 1 |
| 2 | `b` and `c` deposit and sit | Both seated |
| 3 | `b` deposits again | Refused before anything is sent |
| 4 | `a settleRound` with lines for `b` and `c` | Lands: **first ever** |
| 5 | `a settle` (the batch circuit) | Lands. Worst-case proof here was 8.5 s, against 4.3 s for cage #3: its key doubled, so a batch is about twice as slow to build. A real settle is what counts, so note the time |
| 6 | `b stand`, then wait 5 minutes with `c` playing | `b` withdraws, and `a settle` naming `b` is refused |
| 7 | `a propose d`, wait 10 minutes, `d accept`, then `d settle` | Lands: **first ever `acceptJudge`**. `a` can no longer settle |
| 8 | Race: a settle naming `c` while `b`'s withdraw is in flight | The withdraw still lands |
| 9 | Race: `e` sits at the table while a settle is in flight | **Both land.** This is the point of the `Counter`, and it has only been shown in simulation |
| 10 | Race: `c stand` while a settle debiting `c` is in flight, in both orders | Stand first: the settle fails once, and the next lands. Settle first: **both land** |
| 11 | Two sits for the last seat | One lands, one fails |
| 12 | `e` deposits with a permit: `node scripts/cage.mjs e deposit 5 3 1` (5 tNIGHT, cap 3, 1 hour), then `a seat-by-judge e 2 2` | Lands: **first ever.** `e` was never asked. `floor 2` on `e`'s line |
| 13 | `a move-by-judge e 2 3 1` | Lands: **first ever.** One transaction, count down at 2 and up at 3 |
| 14 | `a seat-by-judge e 4 4` while seated, or over the cap | Refused before anything is sent |
| 15 | Race: a settle naming `e` in flight while `a` moves `e` | Whichever lands second fails, safely. The judge must not do this: it's why it settles first |
| 16 | Race: `e stand` while a move of `e` is in flight, then `e revoke` while another is | The move beats the stand, as simulated. **The revoke lands, and the move after it is refused** |
| 17 | The deploy itself: v4b, **11 circuits, 28,997 bytes written of 31,997** | v4's 14 were refused at the block limit (2026-11-05). `cage.mjs deploy-size` checks first |

## Cut-over, one step at a time

The chain facts behind this: `rescue` needs no key, pays only to the address bound at first deposit, and has landed on preprod (`BUILD-LOG.md` row 23). A seat stops binding at most 30 minutes after the judge stops.

As of 2026-11-04 09:54 PT, cage #3 holds **176 tNIGHT across 2 ids, out of 20 ids ever seen**, with one seat binding, on warm table 113. The numbers look like house floats (60 is a two-bot float), but I can't tell from public data. Check for yourself with the script in step 2.

**1. Freeze.** Turn on the drain switch (item 5). Restart the judge with `JUDGE_PREWARM=0`.
*Check:* no new tables in `GET /judge/tables`.

**2. Drain.** Players finish, and the judge settles and frees seats as usual.
```bash
cd ../sealed-cage-v4 && npm run -s compile:cage3
CAGE_BUILD=contracts/managed/cage3 node scripts/cage-balances.mjs 802bf6bb1759ced14f3ffd39dcb56bc6e4051ff09bea1194f9b16967fcfe5bf6
```
*Check:* no table with a player on it.

**3. Stop the cage #3 judge.** `kill -TERM <pid>`. It finishes its cycle. Wait 30 minutes so every seat goes void.
*Check:* the script above says `tables alive: 0`, and every id is `free`.

**4. Everyone's money goes home.** Run from the **main checkout**, because cage #3 needs cage #3's keys. This needs one new line in its `cage.mjs`, next to `rescue`:
```js
} else if (mode === 'rescue-id') { await call('rescue', cageKey(), [Buffer.from(args[0], 'hex')]);
```
```bash
cd ../sealed-cage
CAGE_FILE=deployment.cage3.json node scripts/cage.mjs judge rescue-id <id>     # for each id the script lists
```
*Check:* the script says `ids with money: 0`.

No player has to do anything, and nobody's key is used. Each id's whole balance goes to its own bound address. Don't compile v4 in the main checkout: it would break this step.

**5. Deploy v4.**
```bash
cd ../sealed-cage-v4
ln -sfn ../sealed-cage/.wallets .wallets
CAGE_FILE=deployment.cage4.json node scripts/cage.mjs judge deploy-size 1800 2700 0 1000 300 2592000
CAGE_FILE=deployment.cage4.json node scripts/cage.mjs judge deploy 1800 2700 0 1000 300 2592000
CAGE_FILE=deployment.cage4.json node scripts/cage.mjs judge state
node scripts/cage-balances.mjs <new address>
```
*Check:* `FITS` from `deploy-size` (about 29,000 of 31,997 bytes written), then `LOCKED`, escape 1800, delay 2700, roundCap 1000, slack 300, maxGrant 2592000s, 6 seats, and the judge is the judge's id. **The worktree and the plist:** these commands, and `launchd/com.example.sealed-cage-judge.plist` (`WorkingDirectory`), still name `../sealed-cage-v4`, the 14-circuit v4. The cage to deploy is v4b with L1, and its judge is `v4b-wire`: point them at `../sealed-cage-v4b-wire` before the cut-over.

**6. Point the Worker at it.** Set `CAGE_ADDRESS` (item 7), deploy the Worker and the rebuilt wallet page, and turn off the drain switch.
*Check:* `address` in `GET /judge/tables` is the new one.

**7. Start the judge on v4, under launchd,** from the worktree. It gets a fresh `.judge/` there, so the cage #3 journal is left alone. The plist's Worker and token file are the ones the running judge uses (pid 155 today), and the judge stops if the Worker's address isn't the cage's. launchd doesn't read your shell profile, so the endpoints come from `../halfhand-notary/.env`, as `endpoints.mjs` already reads them. Check first that nothing the old judge needed came from the shell.

The old judge has to be gone first (step 3). The label is the same as cage #3's plist on purpose: launchd keeps one job per label, so the two can't both be loaded on one wallet.
```bash
pgrep -fl 'scripts/judge.mjs'                    # CHECK: prints only the preview judge, if that's running. Not the cage #3 one
cd ../sealed-cage-v4
mkdir -p logs
plutil -lint launchd/com.example.sealed-cage-judge.plist
ls .wallets/judge.staging-token deployment.cage4.json
```
```bash
cp launchd/com.example.sealed-cage-judge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.sealed-cage-judge.plist
launchctl print gui/$(id -u)/com.example.sealed-cage-judge | grep -E 'state|pid'
tail -5 logs/judge.launchd.log | cut -c1-120
```
*Check:* `state = running`, the first log line names the new cage, and a warm table appears.

**To stop it:** `launchctl bootout gui/$(id -u)/com.example.sealed-cage-judge`. A plain `kill` isn't enough: `KeepAlive` starts it again within 60 s (`ThrottleInterval`). It stops at the end of its cycle on the SIGTERM that `bootout` sends. Any exit, including a clean one, restarts it while it's loaded, which is what's wanted for code 75.

**Before the first load:** cage #3's copy of this plist in `~/Library/LaunchAgents` must not be loaded. `launchctl print gui/$(id -u)/com.example.sealed-cage-judge` should say it can't find the service.

**8. Prove it end to end.** `e2e-page.mjs`, `e2e-dice.mjs` and `e2e-table.mjs` on staging, plus a stand and a withdraw from the wallet page.

**9. Publish.** Add v4 to `deployment.public.json` with `locked: true`, a row to `BUILD-LOG.md`, and a line to the README.

**10. Sweep again** at +1 hour and +24 hours for anything that arrived late, using steps 2 and 4.

## If it goes wrong

| When | What to do |
|---|---|
| Before step 5 | Nothing has changed. Restart the cage #3 judge from the main checkout |
| After step 5, nothing played | Point the Worker back and restart the old judge. A locked cage with no money in it can just be left |
| After players deposit in v4 | Their money comes out by `stand` then `withdraw`, or by `rescue`, as before. Sweep v4 the same way, then go back |
| A bug in v4 | It can't be patched: that's what locking means. Ship a new cage and repeat this plan. We already redeploy for every change, so nothing real is lost |

Never run two judges or a judge and `cage.mjs` on one wallet at the same time: they spend the same coins.

Cage #3 can't be locked now, and its maintenance key is probably gone (Omega report §1). So say this plainly when publishing: cage #3 stays "probably unchangeable, not provably", and v4 is the first provably locked cage.
