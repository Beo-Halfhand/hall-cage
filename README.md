# hall-cage

## For judges

The money side of the Hall. `contracts/sealed-cage.compact` is the **cage** (v4b, 11 circuits): players deposit tNIGHT, sit with a declared `atRisk`, and a judge key settles rounds by moving balances inside the contract. Every debit is matched by credits plus a capped rake, bounded by `roundCap` and each player's `atRisk`, with escape hatches per table and per seat. `contracts/dice-proof.compact` checks Cup & Claim dice on chain. `scripts/judge.mjs` is the judge service that runs the live Hall's tNIGHT tables (two sites, one process). `packages/cage-l8` calls the deployed pre-fork builds from Midnight.js 5 after the Ledger 9 upgrade. `contracts/legacy/cage3.compact` is the older cage #3, kept for the attack tests and old receipts.

| | |
|---|---|
| **Live** | https://halfhand.app (the Hall: Sealed Hand and Cup & Claim; play chips for free, or tNIGHT with a Midnight wallet) |
| **Network** | Midnight **Preprod**, Ledger 9 (Preprod was upgraded in place to Ledger 9 on 2026-11-09; the contracts below were deployed before that and run unchanged) |
| **Cage contract (v4b, live)** | `3ac0427139f8008df29a7aec1476e7efaca05c69f8dd1a3968edd6cdbe5cd6e4` (deployed 2026-11-06) |
| **Dice-proof contract** | `c2459aac56301d3714f5bbc313534046b39c79e666d38e7fbe57445bfe5321c9` (deployed 2026-11-05; proof tables are a staging feature, off on halfhand.app, where a shut cup's count is house-attested) |
| **Compiler** | Compact `compactc` 0.31.1 for both contracts (`.compact-version` in hall-cage). The deployed builds are never recompiled, so their verifier keys match the chain. Off-chain tooling: Midnight.js 5, wallet SDK 2, ledger-v9, proof server 9 |
| **Repos** | [the-hall](https://github.com/Beo-Halfhand/the-hall) (site and games) · [hall-cage](https://github.com/Beo-Halfhand/hall-cage) (contracts and judge) · [hall-agent](https://github.com/Beo-Halfhand/hall-agent) (bring your own agent) |
| **License** | MIT (see `LICENSE`) |

### How to run

```sh
npm ci                 # pnpm workspace (packages/cage-l8)
npm run compile        # cage v4b -> contracts/managed/sealed-cage   (Compact 0.31.1)
npm run compile:dice   # dice-proof -> contracts/managed/dice-proof
npm test               # contract rules, attacks, judge, settle wire format
```
To talk to the live contracts, `packages/cage-l8/sealed-cage` and `packages/cage-l8/dice-proof` have to be the deployed 0.31.1 builds (copied from `contracts/managed/...` after a 0.31.1 compile; they are git-ignored because of their size). `zkir.test.mjs`, `dice-proof.test.mjs` and `lock.test.mjs` also need `@midnight-ntwrk/zkir-v2` and the Midnight.js 4 `./ledger` export, so they fail on a plain Midnight.js 5 install. Running a judge needs a funded Preprod wallet and a proof server: see "The judge service" below.

---

## The cage, in detail

A deposit bank ("cage") for Sealed Hand tables on Midnight **preprod**, test NIGHT only.

Players deposit tNIGHT once, sit at a table with a declared exposure (`atRisk`), and a judge key settles each round by moving balances inside the contract. NIGHT only moves on `deposit`, `withdraw` and `rescue`; a settle moves no NIGHT. No circuit lets the judge or the deployer take anyone's balance: a settle can only debit a seated player, up to `roundCap` per round and up to that player's remaining `atRisk` in total, and every debit must be matched by credits to other seated players plus a capped rake.

**Status:** v0 prototype. Compact 0.31.1 (`.compact-version`), 11 circuits (v4b: the 14 of v4 didn't fit one preprod transaction; `scripts/measure-deploy.mjs` shows why). Not audited. Not for real funds.  the preprod spike is logged in BUILD-LOG.md once it has run.

## The rules

| Circuit | Who | Rule |
|---|---|---|
| `deposit(payout, amount, judge, cap, until)` | player (needs the player's cage key) | takes `amount` tNIGHT in; the payout address is fixed at the first deposit. `cap > 0` records a permit for that judge key, replacing any there, with `floor = balance - cap`, and **`until` (unix seconds) at most `maxGrant` past the block's clock** (L1: checked against the builder's clock when it's built, so an over-long grant is refused before anything is sent, and against the block's when it lands); `cap = 0` leaves it there and raises its floor by the amount, whatever `until` says. Refused while a seat binds: a settle reads a seated balance, so a loser's deposit would make it fail. **Amount 0 with `cap = 0` is a revoke:** it ends the caller's permit, as a `stand` also does, moves no money, and reads only that permit, so nothing can keep it off the chain |
| `sit(tableId, atRisk, now)` | player | one seat per player, `atRisk ≤ balance`, at most 6 seats; a dead or empty table opens a new epoch |
| `stand(tableId, now)` | player | intent only: the next settle naming the seat releases it (a loser can't leave between the deal and the settle), and if none comes within `escapeSecs` the seat is free anyway. Once only. It reads only the seat, so no settle can make it fail unless that settle frees the seat It also ends any permit. |
| `withdraw(amount)` | player | refused while seated; pays the bound address |
| `rescue(id)` | anyone | the whole balance to the bound address; refused while seated, and **refused while a permit is live** (F5: there and `until` not passed by the block's clock), so a lost-key player with a permit waits for `until`, at most `maxGrant` (30 days) after their latest grant. A seat that binds holds the balance as before, until the judge releases it or its table goes quiet (a settle frees only a standing seat, and a lost-key player can't stand) |
| `settleBatch(entries[4], now)` | judge | up to 4 entries, at one table or several; a single round is a batch of one (v4b dropped `settleRound`). 4, not 8, so a small settle's proof can be dismissed in time on preprod. Per entry: `roundNo = last + 1`, only seated players, `Σ debits = Σ credits + houseCut`, `houseCut ≤ maxRake`, each debit `≤ roundCap`, `≤ balance`, `≤ remaining atRisk`; standing seats are released |
| `release(tableId, id)` | judge | frees a seat with no settle |
| `seatByJudge(id, fromTable, tableId, atRisk, now)` | judge, under the player's permit | `fromTable` none, a seat; `fromTable` some table, a move off it and onto `tableId` in one transaction, never a standing seat. No wallet prompt: `0 < atRisk <= cap`, `atRisk + floor <= balance`, before `until` by the block's clock, no seat binding and none standing. So a permit can lose at most `cap`, wins aside |
| `proposeJudge(newId, now)` / `cancelJudge()` / `acceptJudge()` | judge / judge / the proposed key | rotation behind a timelock of `judgeDelay ≥ escapeSecs + clockSlack` |

**Escape hatch, per table:** a table with no settle for `escapeSecs` is dead. Its locks void, its players withdraw, and the judge can no longer settle it. Nothing but the server's silence can trigger it. Production value 30 min; the spike uses 300 s.

**Escape hatch, per seat:** a stand that isn't settled within `escapeSecs` of its declared time is free, however long the judge keeps the table alive. The seat stays on the table's count until its owner sits again or the judge releases it.

**What can make what fail.** A transaction fails if anything it read has changed by the time it lands, so the ledger is split to keep the ways out and the settles apart. `tables` holds the last round and heartbeat, `epochs` the epoch, `seats` a Counter of who's sitting, and `risks` what a seat can still lose. A settle only reads whether anyone is sitting, so a sit or an exit doesn't disturb it. The one thing a seated loser can do is stand once, which breaks one settle. A debit writes `risks` and not `seat`, so no settle can fail a stand. An expired stand's withdraw or rescue, and a stale epoch's, read neither `tables` nor `seats`, so a judge landing settles can't push them off the chain.

**Declared time:** Compact 0.23 can compare block time but not read it, so `sit` and the settles take a `now` the chain checks is not in the future and at most `clockSlack` behind.

**`maxGrant`** (constructor, sealed, seconds; the real deploy uses 2,592,000 = 30 days): the longest a permit may run. The constructor refuses 0 or over 365 days, but that check runs only on the deployer's machine (a deploy carries its own initial state), and it takes 720, 30 days in hours, as 12 minutes. So `cage.mjs deploy` deploys only 2,592,000 unless `CAGE_ALLOW_MAX_GRANT=1`, and checks the value on chain after. `deposit` checks `until <= maxGrant || blockTimeGte(until - maxGrant)`, which is `until <= block time + maxGrant` with nothing going below 0. Block time only goes up, so a grant that passes when built passes when it lands. The one way to knock it out is a builder whose clock runs ahead of the chain, with `until` within that lead of the bound: callers keep well inside it (the Hall's permits run at most 24 hours). L1 bounds F5's hold, not a seat's: a judge key that seats a lost-key player before `until` and keeps their table alive holds them for as long as it does that, as before L1, and the honest judge releases them. The field sits after `roundCap`, not after `permits`: the compiler keeps the last 15 fields in a group of their own, so a 20th field at the end would move 15 fields (`escapeSecs` into the first group, and the 14 after it), and here every circuit but `deposit` compiles to the same zkir as before.

**roundCap** for Sealed Hand at 6 seats is 756 chips: 1 ante + 5 bet windows × (25 own raise + 5 × 25 matches) + one 5-chip sting. See NOTES.md.

**Cage #3 uses a roundCap of 1000 tNIGHT, not the engine's current 781.** A raise on the claim lap is being built in another tab, which raises the per-round maximum, and `roundCap` is fixed at deployment. It's a sanity limit on one debit. `atRisk` stays the real per-player bound. Cage #3 is `802bf6bb1759ced14f3ffd39dcb56bc6e4051ff09bea1194f9b16967fcfe5bf6` (`deployment.cage3.json`, gitignored, public fields in `deployment.public.json`).

## Build and test
```bash
npm ci && npm run compile && npm test
```

## Preprod spike (self-funded, own node and proof server)
Endpoints come from the shell or an env file, as in sworn-escrow (`scripts/endpoints.mjs`); nothing is printed. Each wallet is a file set under `.wallets/` (seed, saved state, cage key; mode 600, gitignored).
```bash
node scripts/cage.mjs judge address            # creates the wallet files, prints the faucet address only
node scripts/cage.mjs judge sync               # first sync, about an hour
node scripts/cage.mjs judge dust               # register NIGHT for DUST (one tx)
node scripts/cage.mjs judge deploy 300 900     # escapeSecs 300, judgeDelay 900, maxGrant 30 days unless given last. Deploys locked: see docs/CAGE-V4-PLAN.md
node scripts/cage.mjs a deposit 3 && node scripts/cage.mjs a sit 1 2
node scripts/cage.mjs judge settle 1 1 a:-1 b:+1
node scripts/cage.mjs a state
```
Every landed transaction prints one line: `TX <step> · hash <explorer hash> · id <ledger id> · block <n> · <status>`.

## The judge service
`scripts/judge.mjs` is one long-running wallet that settles a Sealed Hand Worker's tNIGHT tables. It reads the tables through the Worker's authenticated `/judge/` routes, reads the cage, confirms seat claims, batches finished rounds into `settleBatch`, frees seats that are done, and writes each tx hash back to the table's log. Decisions live in `scripts/judge-plan.mjs`, tested in `test/judge.test.mjs` with no network.

```bash
JUDGE_WORKER_URL=https://sealed-hand-staging.halfhand.workers.dev,https://halfhand.app node scripts/judge.mjs
node scripts/judge-health.mjs            # per Worker: OK or NOT, from the heartbeat lines in logs/judge.launchd.log
```

**One judge, two Workers (11-10).** `JUDGE_WORKER_URL` is a comma-separated list, checked against the allowlist in `scripts/judge-sites.mjs`: the staging Worker and live (`halfhand.app`, or `sealedhand.halfhand.dev`, never both). Any other host stops the judge at start. One process, one wallet, one transaction at a time; each Worker gets its own cycle in turn, **live first**, and between staging's transactions (after its settles) a live player waiting stops staging's cycle there. Each Worker owns its table numbers (staging 101..1000, live 1001 and up, from `CAGE_TABLE_BASE`); a table outside its Worker's range is refused and logged, never settled. A Worker that doesn't answer (or has no judge routes yet: 404) is backed off 15/30/60/120 s and the other keeps going. Every minute the log has `heartbeat site=… host=… state=ok|waiting|refused|down lastOkSecs=…` per Worker. Tokens: `.wallets/judge.staging-token` and `.wallets/judge.live-token` (600), or `JUDGE_TOKEN_FILE` with one file per Worker in the same order; a missing token file means that Worker waits, and it is read again without a restart. The journal is one file: every line names its `site`, lines from before 11-10 are staging's, and a receipt only ever goes back to its own Worker. `scripts/e2e-hop.mjs <worker> <wallet>` runs the judge-paid path (permit, door, seat, rounds, a hop, leave, cash out) for one wallet; run two at once to test both Workers.

| Guarantee | How |
|---|---|
| A round is never settled twice | `.judge/journal.jsonl` records each batch's rounds before it's built and its id before it leaves. A round in a live or landed batch is never planned again. The contract's round number is only a counter, so if the journal were lost and the chain ran ahead of what the Worker and journal know, the table is blocked for a person |
| Restart-safe | The journal is replayed on start. A batch that left is looked up by id. A receipt not yet delivered is delivered |
| One try per transaction | A lost socket is never resent. The indexer is asked instead |
| DUST view lag (error 170) | Waits for the wallet's DUST view to move after each tx. A 170 spends nothing, so it waits and rebuilds without counting against the rounds |
| Low DUST | Under `JUDGE_MIN_DUST` (default 10) it writes `.judge/STOP-dust-low` and stops sending |
| Preprod only | Refuses a cage file that isn't preprod, endpoints whose host doesn't say preprod, and any Worker not on the allowlist (`judge-sites.mjs`) |
| A player can't hop away from a loss | `moveByJudge` goes out only when the Worker lists them as free to release at the old table, no entry names them, and neither table has a transaction out. The contract can't see a live round, so this is the only guard, and `test/wire.test.mjs` pins it |
| A seat or move never goes out twice | It has no round number, so the chain's read-back is the guard: at the target table means done. One seat or move a cycle, after the settles. A failure backs off for that player and never pauses a table |

The loop itself is in `scripts/judge-cycle.mjs`, with its wallet and network passed in, so `test/wire.test.mjs` and the Hall's acceptance test run this code against the real circuits in the simulator. `scripts/judge.mjs` supplies the wallet, the journal file and the Worker.

Each Worker's token file (600) holds, the same value as the Worker's `JUDGE_TOKEN` secret. Never print it. Only one judge may run per wallet, and `cage.mjs judge ...` must not run alongside it: they share `.wallets/judge.state.json`.

**LaunchAgent:** `launchd/com.example.sealed-cage-judge.plist` points at cage v4, is written, and isn't loaded. The steps, including how to stop it, are in `docs/CAGE-V4-PLAN.md`, cut-over step 7.

## Keys
Nothing secret belongs in this repo. Seeds, wallet state and cage keys live in `.wallets/` and are ignored by git. Never commit them, `.env` files, `.judge/`, or `deployment.*.json` (except `deployment.public.json`).

## Credits
The transaction path and the keyless-pot idea come from [sworn-escrow](https://github.com/Beo-Halfhand/sworn-escrow). Game rules: Sealed Hand.

## License
MIT
