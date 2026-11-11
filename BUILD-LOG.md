# Build log

## 2026-11-02 2:58–4:08 PM PT — PREPROD SPIKE: two cages, 24 transactions, every state check held
Self-funded through our own preprod node and proof server (`scripts/cage.mjs`, derived from sworn-escrow's `escrow-self.mjs`). Three fresh wallets (`judge`, `a`, `b`), each funded once from the faucet, each registered for DUST. Stakes: 3 tNIGHT deposits, 2 tNIGHT at risk, 1 tNIGHT per settle. After every landed transaction the ledger was read back and checked (`scripts/expect.mjs`).

**Cage #1** `3e531a27e5ef2a7ec606188183befc4f3a92990ca72bf67f35891c70ba3acb5a` (escape 300 s). A sat at 3:06 PM; nothing settled within 300 s (each scripted step takes about two minutes), so the table was dead when B sat at 3:11 PM and B's sit opened epoch 2, voiding A's seat. That is the escape rule doing its job, and it gave the escape test for free: A withdrew with a seat from a dead epoch, B withdrew after his own table died. 3 tNIGHT back to each, no judge involved.

**Cage #2** `b38a8d356f156cda25cbad7c5edd991ec9763f68d2e428f83e17207f91831e44` (escape 900 s, judgeDelay 900 s). Deposits (same block for both players on cage #1, adjacent blocks here), sits, `settleBatch` round 1 (a −1, b +1: balances 2 and 4, a's atRisk 2 → 1), B stands, `settleBatch` round 2 (b −1, a +1; B released), B withdraws 3, B deposits 1, `proposeJudge b`, early `acceptJudge` by b refused at build with "timelock has not passed" (no transaction, no fee), `cancelJudge`, `rescue b` sent by A (1 tNIGHT to B's own address), then the 900 s escape fired and A withdrew 3. Final: both cage balances 0, every wallet back at 5,000 tNIGHT.

**Refusals, all correct:** deploy #2's first try was rejected by the node with `1010 … Custom error: 170` (InvalidDustSpendProof: the judge wallet's DUST view was one event behind); a resync and retry landed. NIGHTGATE sponsorship of an unbound `settleBatch` (built with a throwaway 64-byte seed derived from the judge seed, since `nightgate-tx` requires one) was accepted as a job and then refused: `contract b38a8d356f156cda is not in the allow-list`. Sponsorship needs the cage allow-listed on the grant.

### Receipts (preprod)
| # | Cage | Wallet | Step | Explorer tx hash | Ledger id | Block | Status |
|---|---|---|---|---|---|---|---|
| 1 | — | `judge` | DUST registration | `7a48c33b531924283a60dc31dbc702315e8a8cebe4a6d6302a3a9b30f2a4bf52` | `0057f4dff916cbc6bffce25ce584be9bdbd13de75c3a643af240aa2c97bf9e5902` | 3254208 | SUCCESS |
| 2 | — | `a` | DUST registration | `519c64bd4bc73782d6d61ac2c88a299f8e8b64597a9085163585722d1c744499` | `00d795ad6a6c45f7ebc9785118ee0c93245fa2f40603cbac65c469f32e9bae0256` | 3254209 | SUCCESS |
| 3 | — | `b` | DUST registration | `acf5163133866eb6b671e9668006aae4f1561a275ab99c702df9258a9df8c51c` | `0037485b0557f0af51dabef89031372cdde9dc9b57f682398aa2eb6d02fc5779d5` | 3254208 | SUCCESS |
| 4 | #1 | `judge` | deploy cage #1 (escape 300 s) | `35d00248aaf3395b5cdfed75f881231f34ccff8ad713e51e0380579ec4f7799d` | `00fe80bd4887170bae8e60af5d3c229bfde8186e33eea12a0de08d142c0f84f607` | 3254250 | SucceedEntirely |
| 5 | #1 | `a` | deposit 3 | `9b4fd5d3d36b60c88926bc6a9063d6e87eeee0a548ca3adce05b2d5bcdd28b68` | `009990b4bae2daf8f266335d1a82101493e229abfca7661990a455e8c9df5775e6` | 3254284 | SucceedEntirely |
| 6 | #1 | `b` | deposit 3 | `6bca6fa36b0bf02c6dcab6c1e677ae8b3ffee25cc925341d59f538e931baf676` | `004a19fd85dc798ceba1e4a8b47886285f942efdfc1c1d842c960f9f7c7b5730ab` | 3254284 | SucceedEntirely |
| 7 | #1 | `a` | sit table 1, atRisk 2 | `d626ecdc3b6a856c7666d91ae5f163c3508e0ce717c7d5c2e12a3b275bb30920` | `006ea60808146fae9a64bc99090c930eb33832f1d3de1aac43c38323d0a8c66f8d` | 3254320 | SucceedEntirely |
| 8 | #1 | `b` | sit table 1 (table had died: opened epoch 2) | `a2518f1eeff8d853633847b37d444dbd9507568806d584a51c2063ef7189ad5d` | `00cdc55d592bd7ff12dbe60fd7a7229aefee060579d822b5f0bfffbc1a9fae81a9` | 3254351 | SucceedEntirely |
| 9 | #1 | `a` | withdraw 3 (seat from a dead epoch) | `be5e5d4d6233a0c10ece50d09c975d2e0f685a7e47ae3acf5a84aa62c449a6b0` | `0040e23b2e158850c6e283fd4699cfe0d2a1045c8fafb3997a76830875bc871962` | 3254424 | SucceedEntirely |
| 10 | #1 | `b` | withdraw 3 (table dead, escape) | `18ca95811567e362a133ca1aacfe94c2b9e250f99dc8795ca8c9b5c70e33b3f7` | `000403a1f9ab5d1edf6e4ca28b2e34269f1e3e2c7d8e2fc2aae3b395639656c8be` | 3254442 | SucceedEntirely |
| 11 | #2 | `judge` | deploy cage #2 (escape 900 s, judgeDelay 900 s) | `e49d2849e64b5289b404bc937b8ebfb4f57de36af69ddc20dcc4dbbe2161c079` | `009ba73642fd7c2b89c953594feefddff9de76a3edf868ca6292e032389a1fcee0` | 3254558 | SucceedEntirely |
| 12 | #2 | `a` | deposit 3 | `e02f90f183b9e6d7e3e8552bff3d5916ad104ede6ad5586559655bfb3398f5e7` | `00a6b1d92fd73364427e27c42581ccbc009af1de2b24d71288fefde8fd38aeb1a1` | 3254646 | SucceedEntirely |
| 13 | #2 | `b` | deposit 3 | `0daa4f9a3617731cbb5bc86ad40e1d2b35322da3990e704626701fb5afccd6e0` | `006d2f655468cd093bc727607ba31942fe086a819a18058d62fdbce2372cf55f14` | 3254647 | SucceedEntirely |
| 14 | #2 | `a` | sit table 1, atRisk 2 | `f5285fc13ab037aa24e226df3c0f5fe8a3168d3f6ba3bc532c90a04fe1371a3f` | `001b9c867d30ca7c330b921303936a8d7a2e206ee6a80827c475d32e1c67c59de5` | 3254666 | SucceedEntirely |
| 15 | #2 | `b` | sit table 1, atRisk 2 | `ab02f4395b46b12c15ddf890cf7948609b4e83c26cf79c5d7087d5fdc630cd46` | `009b2cad331e21c3f3c1cd0f6659dbd31a6cebad59508c2b711f55c70759b74fcb` | 3254686 | SucceedEntirely |
| 16 | #2 | `judge` | settleBatch round 1: a −1, b +1 | `919e04eac9a5c7c6af29e33f279622f130c65800fd76d9dab1cf6c48db88c093` | `00bfc33a5b44f13da3e55725eb7854d1ada706b6102411af9b7a38cccde79ee500` | 3254705 | SucceedEntirely |
| 17 | #2 | `b` | stand | `b63d3d898aebbd85d483aba7755f8bcc281148c06dd327b9a259b8f57f996159` | `00fe080b28c9ecd2958ef752096828d6f3dd7e8d8c7c3b1fd73d2a8cf3e2f29706` | 3254726 | SucceedEntirely |
| 18 | #2 | `judge` | settleBatch round 2: b −1, a +1; releases b | `e25684e34460d65882268853e8d079366d1616be11e6a0a250056ea0d90c9ca0` | `00c66700e49476f45d3c8c2a51592d69cdb10a4341894991381dff6e61b63ccbbc` | 3254747 | SucceedEntirely |
| 19 | #2 | `b` | withdraw 3 | `996ebbb65d82b73a7e7d1a98aea67018b9758a7dc8264ecc962d265a569356bb` | `009fcf64ce50a26ebbdb7b2587a97b9a1aa0c003e07761f65ee5a394fa04189468` | 3254769 | SucceedEntirely |
| 20 | #2 | `b` | deposit 1 (for the rescue) | `325735d522eacc0ac2c25a076df0c06e54108c85b970b31411c4dda93126d680` | `003d9246c9a1887fc71aff67b8111dfb6a35a064b53a0e34821813498e4ee8af58` | 3254790 | SucceedEntirely |
| 21 | #2 | `judge` | proposeJudge b | `e7c953ca0650fce1f4d809cb0dea81965fd7a7c9196a2e5fa3fd9eaa0f6733bb` | `001e8bf66f08013f46e0d1bffb2ff47e47be41f641d53e26052667bf71687505d6` | 3254835 | SucceedEntirely |
| 22 | #2 | `judge` | cancelJudge | `f31fcac90e45a9d0c63711e00607d76393841d88ec5c7c75a4435d302ca780e7` | `000d62f69b760e29c7fa9b5d6dea9e12ea5fd2be209c6df34d19470793f95876a4` | 3254867 | SucceedEntirely |
| 23 | #2 | `a` | rescue b: 1 tNIGHT to b's own address | `5ad78125648aca84db41ae94f9df1550424903f00b9c155999056eed0d7e8813` | `00f173203ee4f6a175aab73d91588c7fd9dd9be5d9c67beb81d7e26dea2867c09d` | 3254834 | SucceedEntirely |
| 24 | #2 | `a` | withdraw 3 after the 900 s escape | `567a82cd16b27022f9d4e41ab8d30fa8c6bf1fd2a31a546399de8f1bd9b84947` | `0069c2fdd2ea71b1f29cec69fb709ddc968a303f55e6f0ab9ee335661755e3a629` | 3254890 | SucceedEntirely |

Times are the run logs' own; the first `dust-register` block (3254208) is 2:58 PM PT, the last `withdraw` (3254890) 4:07 PM PT.

— Beobrand Halfhand | 2026-11-02

## 2026-11-03: cage #3 and the judge service
Cage #3 `802bf6bb1759ced14f3ffd39dcb56bc6e4051ff09bea1194f9b16967fcfe5bf6` deployed at block 3263942 (roundCap 1000, escape 1800 s, judgeDelay 1800 s, maxRake 0). The judge service ran four tNIGHT tables against the preview Worker: 53 transactions on cage #3 including its deploy, all read back from the indexer. Full receipts: Vision's `tnight-table` report of this date.
What the chain taught:
- An entry with no lines is refused by the node before the pool: Custom error 168, FeeCalculation. Two lines of zero are accepted.
- A settle built before a player's `stand` lands fails as FailFallible when it lands: fee spent, cage unchanged. The next settle succeeds.
- `kill -9` right after "submitting" left a transaction that never reached the node. The journal held its round until the wait ran out, then settled it once. No round settled twice.
- The DUST view lag (170) did not occur: the long-running wallet waited for its DUST view after each tx. Its retry path has never run on chain.
- `Wallet.Sync: [object Object]` appears on stderr after quiet minutes. Each time so far the wallet carried on. The judge exits if a sync takes over 4 minutes.
