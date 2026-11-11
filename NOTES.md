# Notes for other repos

## sealed-hand
- Cage tables should run with `turnMs: 15000` (15 s per action). With the default 60 s a slow round (every action at the
  limit) runs 91 min and outlives the cage's 30-min escape window, so the table loses its settle and must be re-sat.
  At 15 s the same round is 23 min. Decided by the owner 2026-11-02; not applied here because another session owns that repo.
- Engine numbers the cage relies on: ante 1, maxPasses 5, raiseLimit 25, callStake 5, so roundCap = 1 + 5 x (6 x 25) + 5 = 756 chips at 6 seats.
- Since the last call round (sealed-hand 27141de) the engine's worst round is 1 + 5 x (6 x 25) + 5 + 25 = 781 chips at 6 seats.
- Cage #3 runs with roundCap 1000, not 781 (The owner, 2026-11-03). A rule change adding raises to the claim lap is being built in another tab, which raises the
  per-round max, and roundCap can't change after deployment. atRisk stays the real per-player bound. Pass it explicitly: `cage.mjs` defaults to 756.
  Deployed 2026-11-03: `802bf6bb1759ced14f3ffd39dcb56bc6e4051ff09bea1194f9b16967fcfe5bf6`, escape 1800 s, judgeDelay 1800 s, maxRake 0, block 3263942.
- Claim-raise made the engine's worst round 786 at 6 seats. Then ante 5 and a 500 pot limit (The owner, 2026-11-03, merge-1103): a seat's worst round is `min(5 + 5 x (25 x seats) + 25, 500) + stings`, so 510 at 4 to 6 seats and 285 at 2. Under cage #3's 1000. 790 at 6 with no pot limit.
- A float is six antes a bot now, at most 100 tNIGHT a table: 60 for two bots at ante 5. The old 6 tNIGHT couldn't pay one ante.
- Winning doesn't raise a seat's atRisk, so a stack at a tNIGHT table is min(remaining atRisk, balance) and winnings wait behind the seat. A seat whose atRisk
  is used up has to stand and sit again. The contract is right to work this way; the table has to respect it.
- `stand` frees a seat at the first settle that names it, so a later entry can't name it. The judge merges all pending entries naming a standing seat into one.

## The judge's speed and upkeep (2026-11-03)

- `logs/judge-timings.jsonl` has one row per transaction: time waiting for sync, building and proving, send to landed, DUST catch-up, block time.
- `JUDGE_POLL_SECS` defaults to 4. It reads the cage only when a claim, entry, door, float or release needs it, or every 15 s otherwise.
- `JUDGE_PREWARM` (1) is how many tables wait ready with the float seated. Each is one deposit and one sit, then one settle of nothing every 20 minutes. `JUDGE_PREWARM=0` turns this off.
- The judge's DUST fell about 150 an hour from 19:21 to 21:15 UTC on 2026-11-03, and about 5 an hour after that. The cause is not known. Its NIGHT coin showed as registered for DUST throughout, so unregistered change isn't it. Watch the `status` lines in `logs/judge.log`; under `JUDGE_MIN_DUST` it writes `.judge/STOP-dust-low` and stops settling.
