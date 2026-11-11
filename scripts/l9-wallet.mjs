// Ledger 9 wallet (wallet SDK 2.0.0, facade 5.0.0) for cage.mjs and judge.mjs: branch ledger9, 11-09.
// Preprod forked to ledger 9 in place at block 3,348,434 (2026-11-09 04:04 PT). Wallet SDK 1.x can't read the new events.
//
// Same seeds, same derivation (account 0, Zswap / NightExternal / Dust at index 0), so the same addresses as before.
// Its own state files, <name>.l9-state.json: the SDK 1 snapshots (<name>.state.json) stay where they are, for the old build.
// Nothing here prints a seed, a key or an endpoint's query string; mask-stdio.mjs hides mn_ addresses and project ids.
//
//   node scripts/l9-wallet.mjs <wallet> sync      sync (the first time from genesis), save, print tNIGHT, DUST and registration
// Env: MIDNIGHT_PROOF_SERVER_L9 (default http://127.0.0.1:6302, proof server 9.0.1), endpoints as endpoints.mjs.
import './mask-stdio.mjs';
import { WebSocket } from 'ws';
globalThis.WebSocket ??= WebSocket;
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { inspect } from 'node:util';
import * as Rx from 'rxjs';
import { loadEndpoints } from './endpoints.mjs';

const W = await import('@midnightntwrk/wallet-sdk');
const { WalletFacade, WalletSeeds, ShieldedWallet, UnshieldedWallet, DustWallet, PublicKey, createKeystore, InMemoryTransactionHistoryStorage, WalletEntrySchema, mergeWalletEntries, DefaultForkSchedule } = W;

export const NETWORK = 'preprod';
export const WDIR = '.wallets';
export const DUST_UNIT = 1_000_000_000_000_000n; // SPECK per DUST
export const NIGHT_RAW = '0'.repeat(64); // the unshielded NIGHT token type
export const PROOF_SERVER = process.env.MIDNIGHT_PROOF_SERVER_L9 ?? 'http://127.0.0.1:6302';
export const EP = loadEndpoints();

export function endpointsEnv() {
  if (EP.missing.length) throw new Error(`endpoints missing: ${EP.missing.join(', ')}\n  ${EP.describe().join('\n  ')}`);
  for (const u of [EP.node, EP.indexer, EP.indexerWS]) if (!/preprod/i.test(new URL(u).host)) throw new Error(`endpoint host ${new URL(u).host} is not preprod. Stopping.`);
  return { indexer: EP.indexer, indexerWS: EP.indexerWS, node: EP.nodeHttp, nodeWS: EP.node, proofServer: PROOF_SERVER };
}

const seedOf = (who) => {
  const f = `${WDIR}/${who}.seed`;
  if (!existsSync(f)) throw new Error(`no ${f}`);
  return Uint8Array.from(Buffer.from(readFileSync(f, 'utf8').trim(), 'hex'));
};

export const fmtNight = (star) => (Number(star) / 1e6).toFixed(6).replace(/\.?0+$/, '');
export const fmtDust = (speck) => (Number(speck / (DUST_UNIT / 1000n)) / 1000).toFixed(3);
export const nightOf = (s) => s.unshielded.balances?.[NIGHT_RAW] ?? 0n;
export const dustOf = (s) => s.dust.balance(new Date());
export const nightCoins = (s) => s.unshielded.availableCoins ?? [];
export const registeredCount = (s) => nightCoins(s).filter((c) => c.meta?.registeredForDustGeneration === true).length;
export const balancesLine = (s) => `tNIGHT ${fmtNight(nightOf(s))} · DUST ${fmtDust(dustOf(s))} · NIGHT coins ${nightCoins(s).length} (registered for DUST ${registeredCount(s)}) · protocol ${s.activeProtocolVersion}`;

/**
 * Opens (restores or starts) the wallet <who> and waits until it is synced. Returns { wallet, seeds, ks, save, synced, stateFile }.
 * `log` gets progress lines every 30 s.
 */
export async function openWallet(who, log = console.log, { wait = true } = {}) {
  const env = endpointsEnv();
  mkdirSync(WDIR, { recursive: true, mode: 0o700 });
  // L9_STATE_TAG keeps a trial's state apart; L9_RESTORE_FROM starts from a pre-fork wallet SDK 1 snapshot instead of genesis
  // (wallet SDK 2 reads the snapshot on the ledger that wrote it and carries it across the fork).
  const STATE = `${WDIR}/${who}${process.env.L9_STATE_TAG ?? ''}.l9-state.json`;
  const seeds = WalletSeeds.fromMasterSeed(seedOf(who));
  const ks = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, NETWORK);
  const from = existsSync(STATE) ? STATE : process.env.L9_RESTORE_FROM && existsSync(process.env.L9_RESTORE_FROM) ? process.env.L9_RESTORE_FROM : null;
  const saved = from ? JSON.parse(readFileSync(from, 'utf8')) : null;
  const configuration = {
    networkId: NETWORK,
    forks: DefaultForkSchedule,
    indexerClientConnection: { indexerHttpUrl: env.indexer, indexerWsUrl: env.indexerWS },
    provers: { v9: { kind: 'server', url: new URL(env.proofServer) } },
    relayURL: new URL(env.nodeWS),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };
  const wallet = await WalletFacade.init({
    configuration,
    shielded: (c) => (saved ? ShieldedWallet(c).restore(saved.shielded) : ShieldedWallet(c).startWithSeed(seeds.shielded)),
    unshielded: (c) => (saved ? UnshieldedWallet(c).restore(saved.unshielded) : UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(ks))),
    dust: (c) => (saved ? DustWallet(c).restore(saved.dust) : DustWallet(c).startWithSeed(seeds.dust)),
  });
  await wallet.start(seeds);
  for (const line of EP.describe()) log(line);
  log(`proof server (ledger 9) ${new URL(env.proofServer).host}`);
  log(saved ? `wallet ${who} restored from ${from === STATE ? 'its ledger 9 state' : 'a pre-fork snapshot'} (${saved.savedAt ?? '?'}), catching up…` : `wallet ${who}: no ledger 9 state yet, full sync from genesis (about an hour)…`);
  const save = async () => {
    const tmp = `${STATE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), shielded: await wallet.shielded.serializeState(), unshielded: await wallet.unshielded.serializeState(), dust: await wallet.dust.serializeState() }), { mode: 0o600 });
    renameSync(tmp, STATE);
  };
  if (!wait) return { wallet, seeds, ks, save, synced: null, stateFile: STATE };
  const prog = (p) => { if (!p) return '?'; const a = p.appliedIndex ?? p.appliedId, t = p.highestRelevantWalletIndex ?? p.highestTransactionId ?? p.highestIndex; const done = typeof p.isStrictlyComplete === 'function' ? p.isStrictlyComplete() : false; return `${a ?? '?'}/${t ?? '?'}${done ? ' ✓' : ''}`; };
  let last = null;
  const sub = wallet.state().subscribe({ next: (x) => { last = x; }, error: (e) => log(`state stream error: ${inspect(e, { depth: 4 }).slice(0, 800)}`) });
  const tick = setInterval(() => {
    if (!last) return log('… connecting (no wallet state yet)');
    try { log(`… sync shielded ${prog(last.shielded?.progress)} · unshielded ${prog(last.unshielded?.progress)} · dust ${prog(last.dust?.progress)} · protocol ${last.activeProtocolVersion} · isSynced ${last.isSynced}`); } catch (e) { log(`… (progress unreadable: ${e?.message})`); }
  }, 30000);
  let synced;
  try { synced = await wallet.waitForSyncedState(); } finally { clearInterval(tick); sub.unsubscribe(); }
  await save();
  log(`synced · ${balancesLine(synced)} · state saved (${STATE}, 600)`);
  return { wallet, seeds, ks, save, synced, stateFile: STATE };
}

export const latestState = (wallet) => Rx.firstValueFrom(wallet.state());

if (import.meta.url === `file://${process.argv[1]}`) {
  const [who, mode = 'sync'] = process.argv.slice(2);
  if (!/^[a-z0-9_-]{1,16}$/i.test(who ?? '')) throw new Error('usage: l9-wallet.mjs <wallet> sync');
  const t0 = Date.now();
  const log = (m) => console.log(`${new Date().toISOString()} [${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  try {
    if (mode !== 'sync') throw new Error(`unknown mode ${mode}`);
    const w = await openWallet(who, log);
    await w.wallet.stop();
  } catch (e) { log(`FAILED: ${e?.message ?? e}\n${inspect(e?.cause ?? e, { depth: 5 }).slice(0, 2000)}`); process.exitCode = 1; }
  process.exit();
}
