// Read-only check of the dice-house port on ledger 9 (11-09). Sends nothing.
//   node scripts/dice-l9-check.mjs          (from this folder; wallet a syncs on its own state, .wallets/a-dice.l9-state.json)
// Checks: dice-proof reads on ledger 9 through its 0.31.1 build; every circuit's on-chain verifier key equals the local key (so proofs
// from this build will be accepted); the house key on chain is this folder's .dice-state/house.key; cage4 reads; wallet a syncs on
// protocol 2001100 with DUST registered and enough DUST for a round. Prints "DICE-L9 CHECK: n/n" last; exit 1 on any failure.
import { existsSync, readFileSync } from 'node:fs';
import { DEPLOY_FILE, ZK, hex, log, openWallet, rawState, readLedger, secretFile, stop } from './dice-chain.mjs';
import { readCage } from './l9-cage.mjs';
import { nightCoins, registeredCount, dustOf } from './l9-wallet.mjs';
import * as J from './dice-fair.mjs';

const { ContractState } = await import('@midnight-ntwrk/compact-runtime');
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); log(`${ok ? 'ok ' : 'NOT'} ${name}${detail ? ` · ${detail}` : ''}`); };
let W = null;
try {
  const dice = JSON.parse(readFileSync(DEPLOY_FILE, 'utf8'));
  const read = await rawState(dice.address);
  check('dice-proof found on preprod', !!read, `${dice.address.slice(0, 12)}… · served as era ${read?.contractState?.era} · protocol ${read?.protocolVersion}`);
  const L = await readLedger(dice.address);
  check('dice-proof state reads through the 0.31.1 build (runtime 0.16) on ledger 9', !!L && typeof L.rounds?.size === 'function', `rounds ${L.rounds.size()} · commits ${L.commits.size()} · answers ${L.answers.size()} · results ${L.results.size()}`);

  // every circuit's verifier key, on chain vs local
  const cs = read.contractState.deserialize({ v8: { deserialize: () => { throw new Error('served as v8'); } }, v9: { deserialize: (b) => ContractState.deserialize(b) } });
  const info = JSON.parse(readFileSync(`${ZK}/compiler/contract-info.json`, 'utf8'));
  const impure = info.circuits.filter((c) => !c.pure).map((c) => c.name);
  const bad = [];
  for (const c of impure) {
    const onChain = cs.operation(c)?.verifierKey;
    const f = `${ZK}/keys/${c}.verifier`;
    const local = existsSync(f) ? readFileSync(f) : null;
    if (!onChain || !local || Buffer.compare(Buffer.from(onChain), local) !== 0) bad.push(c);
  }
  check(`all ${impure.length} circuits: on-chain verifier key = local key`, bad.length === 0, bad.length ? `differ: ${bad.join(', ')}` : impure.join(', '));

  const houseKey = secretFile('house.key');
  check('the house key on chain is .dice-state/house.key (dice-house\'s start check)', hex(L.house) === hex(J.keyId(houseKey)), `house ${hex(L.house).slice(0, 12)}…`);
  check('house.token present for the staging Worker (600)', existsSync(new URL('../.dice-state/house.token', import.meta.url)));

  const cageAddr = JSON.parse(readFileSync(new URL('../deployment.cage4.json', import.meta.url), 'utf8')).address;
  const { L: C, era } = await readCage(cageAddr);
  let sum = 0n; for (const [, v] of C.balance) sum += v;
  check('cage4 reads on ledger 9 (its 0.31.1 build)', C.balance.size() > 0, `${cageAddr.slice(0, 12)}… · era ${era} · ${C.balance.size()} balances, total ${Number(sum) / 1e6} tNIGHT · tables ${C.tables.size()} · seats ${C.seat.size()}`);

  W = await openWallet('a');
  const s = await W.wallet.waitForSyncedState();
  check('wallet a synced on ledger 9 (its own state file)', String(s.activeProtocolVersion) === '2001100', `${W.balances(s)} · state ${W.stateFile.split('/').slice(-2).join('/')}`);
  check('wallet a: NIGHT registered for DUST and at least 1 DUST', registeredCount(s) > 0 && registeredCount(s) === nightCoins(s).length && dustOf(s) >= 1_000_000_000_000_000n);
} catch (e) { check('check ran', false, String(e?.message ?? e).slice(0, 400)); }
if (W) await stop(W);
log(`DICE-L9 CHECK: ${results.filter(Boolean).length}/${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
