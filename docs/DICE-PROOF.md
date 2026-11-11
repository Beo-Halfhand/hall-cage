# dice-proof

Cup & Claim's dice, checked on chain. A Compact contract next to the cage, compiled with 0.31.1, the same compiler cage v4 uses. It holds no money and never touches the cage.

**Status:** preprod only, not audited. Wired into Cup & Claim on staging behind a flag that is off.

## How it proves it

Say this out loud:

> Before anyone sees a die, the house and every player each lock in a secret. Yours is made on your own device, and the house only ever gets a fingerprint of it. All of those fingerprints go on the chain together, with the house's own secret and its bots' cups, so nobody can change theirs after seeing anyone else's. Then each player posts their seal from their own wallet. Only when that's done does the house open its secret, and it has to be the one it locked. Your dice come from a hash of your secret and everything that was locked, so the house can't pick them or even see them, and you can't pick them either, because you locked in before you saw the house's. When someone calls Liar, your wallet makes a zero-knowledge proof that says: these dice came from what I locked in, and they hold this many of that face, with 1s wild. The chain checks that proof against your seal. It learns that one number and not your dice, unless you choose to lift your cup. A wrong number or a swapped die can't make a proof that passes. Then the chain adds up the numbers and says whether the bid holds, and nobody gets to tell it the answer. Go quiet and the clock runs out: a bidder or caller who doesn't answer loses the call, and so does the house if one of its bots goes quiet.

## A round, in the order the chain enforces

| Step | Who | What the chain checks |
|---|---|---|
| `openRound` | the house key | The house's seed is sealed, and so is each house-run seat. Each player seat is named by a key hash and the hash of the seal it will post, which that player's page sent first. A round number can only be opened once. |
| `commitCup` | that seat's key | Each player posts their seal. It has to be the one named at the open. It can't be posted twice, by anyone else, or after the window. |
| `openHouse` | whoever knows the seed | It must be the sealed seed, and every player must have sealed or the window must be over. The chain hashes the seed with all six seals and its own address into the round's salt. |
| `callLiar` | the house key | Posts the called bid: face 2 to 6, between 1 die and all of them, two seats that hold cups. It has to land within the time for a call. Starts the answer windows. |
| `proveCount` | the cup's owner | The proof shows the seed matches the seal, the dice come from that seed and the salt, and the claimed count is what they make with 1s wild. Only the count goes on chain. House-run seats must answer first. |
| `showCup` | the cup's owner | The same proof, with the dice on chain. |
| `finish` | anyone | Adds up what was proven and says whether the bid holds. |
| `voidRound` | anyone | If the house missed its window to open, which counts against it on chain. Or if the time for a call has passed. |

```
seal   = SHA-256(tag ‖ seed ‖ table ‖ round ‖ seat ‖ contract address)
named  = SHA-256(tag ‖ seal ‖ table ‖ round ‖ seat)          what the page sends first, and the round opens with
salt   = SHA-256(tag ‖ houseSeed ‖ table ‖ round ‖ seal0 ‖ … ‖ seal5 ‖ contract address)
roll   = SHA-256(tag ‖ salt ‖ seed ‖ seat)
die k  = bytes 2k and 2k+1 of roll, as a word, in one of six ranges of 10,922 or 10,923 words
count  = dice equal to the bid's face, or equal to 1
```

That is `persistentHash`, which turned out to be plain SHA-256 of the fields in order, with a `Uint<N>` little-endian. So the server and the page work these out with no Midnight code at all, and `test/dice-vectors.json` holds them to the contract to the bit.

## Silence

The windows are fixed at deployment, inside limits written in the contract, and the house can't shorten the players' windows for a round. The time it declares, inside the clock slack, can lengthen the seal window by up to the slack, or start its own answer window sooner. That leaves the house less time, and the players the same.

| Who goes quiet | What happens |
|---|---|
| A player's page never sends its seal's hash | They aren't dealt in. The table doesn't wait past a minute, and the ante goes back. No wallet is involved in this step. |
| A player never seals | They aren't dealt in. Their ante goes back. If no player seals, there is no round. |
| The house never opens its seed | Anyone voids the round. No bid was made and no player's die was known. `houseFaults` goes up, for anyone to see. |
| The house never posts a call | Past the time for a call, no call can land, and anyone can close the round. A round everyone folded out of looks the same, so this doesn't count as a fault. |
| The house's seat doesn't answer | It can't answer once its window closes, and the players aren't held up. |
| The bidder or the caller doesn't answer | They lose the call. Unless what's proven already settles it, in which case that stands. |
| Both of them | Void. |
| A bot is what's missing, and the house is on one side of the call | The house's side loses, so a quiet bot can't dodge a lost call. |
| Any other third seat, and its cup could change the result | Void. On the table, its stake is shared among the seats that answered. |
| Any cup, and what's proven already settles it | Nobody waits. Anyone can `finish`. |

House-run seats answer first, in their own window, so the house can't read a player's count and then decide whether to answer.

## Still house-trusted

What the chain does prove: every sealed cup is fixed before anyone can read one, and every count and every shown die it accepts is what that sealed cup holds. What follows is everything around that.

- **The money.** The cage doesn't read this contract. The judge settles what the Worker reports, and the Worker carries out the chain's answer, but nothing on chain forces a settle to match a verdict. Anyone can compare the two; nothing stops them differing. This is the biggest gap, and closing it means a new cage.
- **Whether a call gets asked.** Bids and turns live on the server, and only the house can post a call. So the house can sit on a call it would lose, and the round voids with no chips moved. It shows on chain as a round with no call, but from outside that looks the same as a round everyone folded out of. Stopping this needs bids on chain, or a caller who can post a bid signed by its bidder.
- **What was called.** The chain only sees the bid as posted by the house. A house could post a different bid from the one the table saw. The player's page compares the two and says so, but the chain wouldn't refuse it.
- **The page.** The player's seed is made by a page the house serves. A house that changed that page could read the seed. A wallet or open-source client would close this.
- **The proof server.** The seed goes to the wallet's prover in the clear. Someone using a hosted proof server is trusting whoever runs it.
- **Which seats are really the house's.** A seat is house-run because the house says so. A seat it holds and labels a player's isn't made to answer first, and doesn't lose the house's side of a call by going quiet. It can void a call it would lose by keeping quiet, or keeping a bot quiet, at the cost of that seat's stake. The page checks that every seat it shows as a bot is house-run on chain, but it can't tell whether another "player" is a person. A human with a second wallet has the same lever.
- **One last look.** Once the seals are on chain, the house can work out its bots' dice before it opens its seed, and it can refuse to open if it doesn't like them. It costs no chips and shows as a fault on chain. A house-held "player" seat can do the same by keeping its seal back: each one it holds doubles what it can choose from, and each leaves a no-show on chain. That's a choice to keep or re-deal, not a choice of dice: one held seat moves a bot's best-face count from 2.83 to 3.25 on average, and four move it to 4.24. A cost for it needs the cage.
- **The time for a call.** A call has to land inside its window, but inside that window the house picks the moment. A player who has walked away from a round still in play can lose by silence to a call posted after they left.
- **Locking a player out.** The house names the hash of each player's seal. If it names a wrong one, that player can't seal, and on chain it looks like a no-show. The page says so. It's decided before anyone sees a die, so it gains little, and the ante goes back.
- **The house's own seats.** The house knows its bots' dice, so bots can play each other's cups as one hand. The code doesn't, but nothing proves that. The chain proves the dice, not how anyone bids.
- **`houseFaults` is not an honesty score.** It only counts a house that never opened, and only if someone paid to void the round.

A shut cup's count is public by design: each cup has its own owner, so no single prover holds all the dice, and the chain has to add up per-seat counts. A yes/no with no counts would mean one prover holding every seed, which is what this exists to avoid.

Three rounds of independent adversarial review shaped this. The first is `2026-11-05-0746-dice-proof-security-review.md` in Vision's reports. It found the seat that could grind the bots' dice, the quiet bot, the delayed call and the window limits, and those are fixed here. The second attacked the fixes, and found a decoy-deployment trick, a call deadline anyone could set, a zero seal and window floors too low for real proving, which are fixed too. The third, `2026-11-05-1046-dice-proof-four-rules.md`, attacked those last fixes and found that they held, including against a real proof carried from one deployment to another, which the chain refused. What it did find is below. No review found a way to land a false count or false dice.

## Limits of this deployment

The contract on preprod is locked, so these stay as they are until a new deployment. They are about clocks and seats, not counts.

- **Bots against the house's window.** The house answers from one wallet, one transaction at a time, and each takes about 30 seconds to land. In this deployment's 240-second window it can start four answers at best and three when the chain is slow, so a fourth or fifth bot would go quiet and lose the house its side of the call. Proof tables take at most three bots, and `dice-house` answers bots, nearest deadline first, before it posts another call. A busy house still needs a longer window, which means a new deployment.
- **Windows that don't fit each other.** The constructor bounds each window but not one against another. An hour for the house and two minutes for the players would be a legal deployment, and would let a house wait a player out. This one is 240 seconds each. Next time: the house's window no more than twice the players', and a cap on the total.
- **The wait for a call is longer than the call window.** The deadline for a call counts from the round's open, through the seal and open windows and the slack, so dice can wait up to 25 minutes for a call, not 15.
- **The declared time.** Inside the clock slack, the house picks the time it declares. It can give players up to three more minutes to seal, or start the answer clock up to three minutes sooner, which only shortens its own window. Players always get their full 240 seconds.
- **A seal is checked against this contract only when its cup answers.** A seal made for another deployment is accepted when posted, then can never answer, so that seat loses by silence. The page never does this. Next time: check the seal against the seed in `commitCup`.
- **The house's own seal has no address in it.** A house that reused a seed and round number on two deployments would give its seed away early. `dice-house` draws a new seed every round. Next time: bind it like the others.
- **Only the literal zero is refused.** A house seed of all zeros, a house key of zero, or a seat named by the hash of a zero key all get through. None helps anyone against an honest page. Read the phase, not a zero seed, to tell whether the house has opened.
- **Floors the client can't meet.** A clock slack under about 100 seconds, or an open window under about 75, would make the house miss its own deadlines. This deployment is well clear of both.

The next version is designed, not built: [DICE-PROOF-V2.md](DICE-PROOF-V2.md). It binds the pot to the verdict, has the caller post the call, and takes each of the fixes above.

## Running it

```bash
npm ci && npm run compile && npm run compile:dice
node scripts/dice-vectors.mjs   # only if the hashes change: then copy test/dice-vectors.json to sealed-hand
npm test
node scripts/dice-mutants.mjs   # the sweep

# Preprod, on test wallets a and b only. judge and anything else are refused.
node scripts/dice-rounds.mjs balance
node scripts/dice-rounds.mjs deploy                 # locked: no key can ever change a verifier key. Windows: seal, open, call, house, players, slack
node scripts/dice-rounds.mjs verify                 # that lock, and every verifier key against this source
node scripts/dice-rounds.mjs honest <table>
node scripts/dice-rounds.mjs attacks <table>
node scripts/dice-rounds.mjs timeouts <table>
node scripts/dice-rounds.mjs finish <table> <round…>  # close called rounds whose answer window has passed. No key and no dice: anyone can
node scripts/dice-rounds.mjs check <table> <round>  # from the chain alone: no wallet, no key, nothing from the Worker
```

Wallet state lives in `.dice-state/` (600, gitignored), as copies, so nothing here writes to `.wallets/`. Keys and seeds are never printed.

### On staging, behind the flag

The Worker's flag is `DICE_PROOF`, off in `wrangler.staging.toml`. With it off, there is no route, no table and no text: the code is inert, and `POST /dice-tables { proof: true }` is refused. With it on, a table is only a proof table if it was opened with `{ tnight: true, proof: true }`, and it isn't listed in the Hall.

```bash
# In sealed-hand, branch dice-proof
cd wallet-app && DICE_PROOF_DIR=../sealed-cage-dice-proof npm run build && cd ..
DICE_PROOF_DIR=../sealed-cage-dice-proof node scripts/preview-build.mjs
tr -d '\n' < ../sealed-cage-dice-proof/.dice-state/house.token | npx wrangler secret put DICE_HOUSE_TOKEN --config wrangler.staging.toml
npx wrangler deploy --config wrangler.staging.toml --var DICE_PROOF:on --var DICE_PROOF_ADDRESS:<address>

# In sealed-cage, branch dice-proof
DICE_HOUSE_URL=https://sealed-hand-staging.halfhand.workers.dev node scripts/dice-house.mjs
node scripts/e2e-dice-proof.mjs https://sealed-hand-staging.halfhand.workers.dev ../sealed-hand-dice-proof <shots dir>

# And off again
npx wrangler deploy --config wrangler.staging.toml
```

`dice-house` is the house's side on chain: a long-running wallet on test wallet `a`, separate from the judge. It has its own token, which opens only `/judge/dice-proof`. It can't settle, seat or release, and the judge's token doesn't open its routes.
