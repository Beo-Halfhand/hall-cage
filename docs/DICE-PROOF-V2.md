# dice-proof v2: the verdict moves the money

**Design only.** Nothing here is built into the contract or deployed. It covers three decisions from the 11-05 report:
binding the pot to the verdict (2), calls on chain (3), and what the next deployment changes (4). The deployed v1 is
described in [DICE-PROOF.md](DICE-PROOF.md).

## In short

- **The verdict binds the pot.** A Cup & Claim round on a tNIGHT table can't settle until its dice round has closed on chain.
  The settle has to agree with the verdict: the side that lost the call pays, the side that won doesn't, and a void can't
  take chips from a seat that answered.
- **The caller posts the call.** Every bid is signed by its bidder. The caller's own wallet puts the call on chain, with the
  bid it's calling, so the house can't sit on a call it would lose.
- **The fixes.** Fix A (a seal is checked against its seed when it's posted), Fix B (the house's seal names the contract),
  window caps (the house's answer window at most twice the players', and at most four hours of waiting before a call),
  120-second floors for the clock slack and the open window, no zero keys, and one proof for all the house's bots.
- **The constraint that decides the shape.** Compact 0.31.1 can't call one contract from another. I compiled a minimal call
  and got "cross-contract calls are not yet supported". So for the cage to read the verdict, the dice and the money have to
  share one ledger, or wait for Compact 0.36, which needs ledger 9 on preprod.
- **Recommendation.** Don't hold cage v4b for this. Ship v4b as planned, and deploy dice-proof v2 on its own with the call
  and the fixes. Bind the money in the next cage, by a cross-contract read once ledger 9 is on preprod, or by folding the dice
  into the cage if a deploy-then-lock spike works first. Three things line up now so that step stays small (section 4).

## What I checked on 11-05

| Question | Answer | How |
|---|---|---|
| Can a 0.31.1 contract call another? | No. "cross-contract calls are not yet supported", exit 255 | Compiled a minimal caller against a compiled callee |
| Is the curve maths for a signature check there? | Yes. A Jubjub Schnorr check compiles to a 0.69 MB proving key and a 1.6 KB verifier key | Compiled, not run |
| Can verifier keys be added after a deploy, and the contract then locked? | The ledger has `VerifierKeyInsert` and `ReplaceAuthority` | Read `@midnight-ntwrk/ledger-v8`'s types. Not tried on preprod |
| How many circuits fit one locked deploy? | 11 landed (22,541 bytes of keys). 14 were refused: "Transaction would exhaust the block limits" | Cage v4's staging rehearsal, 11-05 |

A verifier key is about 2 KB whatever the circuit's size, so the limit is a count of circuits per deploy, about 11.

## 1. The verdict binds the pot

### What the cage checks

For an entry on a dice table, `settleOne` reads the dice round the entry names, and refuses the batch unless the lines fit:

| The dice round | What the settle may do |
|---|---|
| Not closed yet | Nothing: no line may move chips |
| Not the next one due at this table | Nothing. Dice rounds settle in order, each exactly once |
| A call, and the bid **holds** (counted, `callerSilent`, or `houseSeatSilent`) | The caller pays. The bidder isn't debited |
| A call, and the bid **falls** (counted, `bidderSilent`, or `houseSeatSilent`) | The bidder pays. The caller isn't debited |
| Void: the house never opened its seed (`houseSilent`) | No player is debited |
| Void: too few cups | No player is debited |
| Void: a silent seat (`thirdSilent`, `bothSilent`) | Only seats that didn't answer may be debited |
| No call (`noCall`) | Whatever the cage's own rules allow. This is the uncontested pot: who folded is off chain |

"Pays" means its line is a debit. "Isn't debited" means its line is a credit, or absent. The house's bots share one cage
line, so when a bot is the bidder or the caller, the rule binds the player on the other side, and the house's line only has
to balance.

Amounts stay within what the cage already enforces: each line within `roundCap` and the seat's risk, and debits equal to
credits plus the house cut. Binding exact amounts needs every seat's stake on chain, which is stage two.

### What the settle names

- **`Entry.dice: Maybe<Uint<32>>`**, the dice round at this table that the entry settles. It's a reference, not the cage's
  `roundNo`: `roundNo` also moves on settles of nothing, so the two can never be the same number.
- **Dice rounds are numbered in order per table.** `openRound` takes round `opened[table] + 1`. The cage keeps
  `diceNext[table]` and accepts only that one, so the judge can't skip a round it doesn't like or pay one twice.
- **A table is a dice table once a dice round has opened at it.** On a dice table, every entry that moves chips must name a
  dice round. A settle of nothing names none.

### Who is who

- **Player seats are named by the cage's own `playerId`**, the same key and the same hash. Then a settle line's `id` and a
  dice seat's holder are the same 32 bytes, and the rule can match them. Today the two hashes use different domain strings.
- **House-run seats map to the house's float seat** in the cage.

### Two routes

| | One contract: cage and dice | Two contracts: a cross-contract read |
|---|---|---|
| How the cage reads the verdict | From its own ledger | Calls `dice.resultOf(table, round)` from `settleOne` |
| Toolchain | 0.31.1, today | Compact 0.36 on ledger 9: not on preprod yet |
| Circuits | v4b's 11 plus dice's 10. Too many for one deploy, so deploy with a temporary authority, insert the rest of the keys, then replace the authority with an empty committee | Each contract stays under 11 |
| Risk | The staged deploy is untested. One much bigger contract to review | Waits on the network. Whether deployed contracts keep running after the ledger 9 fork is still unanswered |
| Effect on v4b | v4b waits for the dice work | v4b ships now. The next cage adds the check to `settleOne` |

## 2. Calls on chain

Today only the house posts `callLiar`, so it can let a call it would lose run out, and the round voids. The second review
measured what that's worth: posting only the calls it would win takes the house's bid of 4 from losing 55.9% of called rounds
to losing 17.3%, with 46.1% voided.

In v2:

1. **Every bid is signed by its bidder.** A player's page signs with a bid key derived from its own seat key, so there's no
   wallet prompt. The key goes on chain inside the player's own `commitCup` proof, so the house can't name a false one. The
   house signs its bots' bids. The message is the contract address, table, round, a sequence number, the bidder's seat, the
   count and the face. The signature is Schnorr on the Jubjub curve, which a 0.31.1 circuit can check.
2. **The caller posts `callLiar`**, from its own key, with the bid it's calling. The chain checks the signature against the
   bidder's key, the face and count rules, both seats, and the time for a call. The house can't stop it landing, so sitting on
   a call is no longer a free void.
3. **A later bid replaces a stale one.** For a short window after a call lands (90 seconds proposed), anyone may post
   `supersede`: a bid in the same round, with a higher sequence number, that beats the called bid and is signed by its bidder.
   The call then stands on that bid. That stops a caller calling an old bid instead of the standing one. No cup answers until
   the window closes, because a count is for one face.
4. **The house's window counts from the latest moment the call could have landed.** The caller now declares the time, so
   `houseBy = now + slack + houseSecs`, the same shape as the seal window. Otherwise a caller could back-date its call by up
   to the slack and squeeze the house's bots out of their window.

What it doesn't close:

- **A made-up later bot bid.** The house signs its bots' bids, so after a call it could sign a later bot bid and use
  `supersede` to move the call onto its bot. Every player at the table would see a bid that never happened, and the signed bid
  would be on chain, but the chain can't tell it was made late. Closing it needs each player to countersign the bid sequence.
  That's stage two.
- **Folds.** Who folded stays off chain, which is why a round with no call isn't bound.
- **Time and prompts.** The caller approves one more transaction (seal, call, answer), and a called round takes about 90
  seconds longer for the supersede window.

## 3. The fixes

| Fix | Change | Closes |
|---|---|---|
| A | `commitCup` proves the seal opens with the seat's seed on this contract: `commitOf(cupSeed(c), c, kernel.self().bytes) == seal` | A seal made for another deployment, or with no seed behind it (third review L3, and part of L5) |
| B | `houseCommitOf(seed, id, self)` takes the contract address, and `openHouse` passes `kernel.self().bytes` | A house seed reused across deployments giving itself away early (L4) |
| Window caps | `houseAnswer <= 2 × playerAnswer`, and `seal + slack + open + call <= 14400` | An hour-long house window against two-minute players (M2). Up to six hours of waiting for a call (L1) |
| Floors | `slack >= 120` and `open >= 120` | Floors the shipped client can't meet (L6) |
| Zero keys | Refuse `houseId == 0`, `houseId == keyId(0)`, and a holder equal to `keyId(0)`. The client's key witness throws when the key is missing | L5 |
| The house's bots | `answerHouse`: one proof answers every house-run seat | The three-bot cap. One transaction instead of one per bot, about 34 seconds each from the house's one wallet |

`answerHouse` replaces the cap, so the house's answer window doesn't have to grow. It proves each house seat's count from its
sealed seed, like several `proveCount`s in one circuit. House seats still answer first, and players after.

## 4. Lining up with cage v4b

These facts are from v4b's working tree at 16:09 PT on 11-05, while tab 4 was still changing it:

- 11 exported circuits
- one settle: `settleBatch(es: Vector<8, Maybe<Entry>>, now)`, judge only
- `Entry { table: Uint<32>, roundNo: Uint<64>, houseCut, lines: Vector<6, Maybe<Line>> }`
- a settle must name `lastRound + 1`, and settles of nothing take numbers too
- a declared `now`, checked within `clockSlack`
- locked at deploy

What lines up now, with no change to v4b:

- **Table numbers.** dice-proof already uses the cage's table number.
- **Identity.** dice v2 adopts v4b's `playerId`, so dice seats and settle lines match.
- **Time.** The same declared-`now` pattern and slack check.

What the cage that binds the money adds:

- `Entry.dice`, `diceNext`, and the rules in section 1, in `settleOne`.
- If that cage is v4b, these have to be in it before it's locked, because nothing can be added after.

## 5. Circuits

| Circuit | In v1 | Who posts it | Change in v2 |
|---|---|---|---|
| `openRound` | yes | the house | rounds in order per table; player seats named by the cage's `playerId` |
| `commitCup` | yes | the seat | Fix A; puts the seat's bid key on chain |
| `openHouse` | yes | anyone with the seed | Fix B |
| `callLiar` | yes | **the caller** | a signed bid; the slack added to the house's window |
| `supersede` | new | anyone | a later signed bid, in the window after a call |
| `proveCount` | yes | the seat | waits for the supersede window |
| `showCup` | yes | the seat | waits for the supersede window |
| `answerHouse` | new | the house | every house-run seat in one proof |
| `finish` | yes | anyone | none |
| `voidRound` | yes | anyone | none |

Ten circuits, under the 11 that fit one locked deploy.

## 6. Still house-trusted after v2, deployed on its own

- **The money**, until a cage binds it.
- **The amounts** inside a bound settle, because stakes are off chain.
- **Who folded.**
- **A made-up later bot bid** (section 2).
- **As in v1:** the page, the proof server, which seats are really the house's, one last look before `openHouse`, and the
  house's bots playing as one hand.

## 7. Before building

- **The deploy-then-lock spike**, for the one-contract route only: does preprod accept `VerifierKeyInsert` for a new
  operation, then `ReplaceAuthority` to an empty committee?
- **Run the Schnorr check**, not just compile it, against signatures made by the page's library.
- **Measure `answerHouse`** with three to five seats: proving time and key size.
- **A review of v2 whole.** v1's final version had a narrow review, not a full one.

## 8. Decisions for the owner

1. **The route for binding the money:** hold v4b and fold the dice in, or ship v4b and bind in the next cage (recommended).
2. **Signed bids with `supersede` now**, accepting the made-up-bot-bid hole until countersigned bid sequences, or wait and do
   countersigned sequences in one go.
3. **`answerHouse` instead of the three-bot cap.**
