#!/usr/bin/env node
// sealed-cage settleBatch through NIGHTGATE sponsorship (spike step 10, 2026-11-02).
// Lives in THIS repo. It uses the notary clone (NOTARY_DIR, default ../halfhand-notary) only at runtime, by path:
//   - its scripts/lib/{mc,nightgate}.mjs and node_modules/@odatano/nightgate-tx (the sponsor client and tx builder)
//   - its .env, read by the notary's own loadDotEnv for the NIGHTGATE grant; nothing is copied or printed
// The transaction is built with the sealed-cage JUDGE wallet's own seed and signed by its cage key, not the notary's wallet.
// The compiled contract is staged under build/zk-ext/sealed-cage (gitignored) with build/node_modules linked to the notary's,
// so the contract and nightgate-tx share one compact-runtime instance (else "expected instance of ContractMaintenanceAuthority").
//   node scripts/cage-ng.mjs <tableId> <roundNo> [<wallet>:+<credit> | <wallet>:-<debit> ...]
//   DRY=1 …   build + prove only, nothing sent
import './mask-stdio.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const NOTARY = process.env.NOTARY_DIR ?? path.join(os.homedir(), 'workspace', 'halfhand-notary');
const HERE = path.resolve(new URL('..', import.meta.url).pathname);
const ZK = path.join(HERE, 'build', 'zk-ext', 'sealed-cage');
const DRY = process.env.DRY === '1';
const [table, roundNo, ...lineArgs] = process.argv.slice(2);
if (!roundNo) { console.error('usage: node scripts/cage-ng.mjs <tableId> <roundNo> [<wallet>:+<credit>|<wallet>:-<debit> ...]'); process.exit(2); }
const notaryFile = (p) => { const f = path.join(NOTARY, p); if (!fs.existsSync(f)) throw new Error(`notary file missing: ${p} (NOTARY_DIR=${NOTARY.replace(os.homedir(), '~')})`); return pathToFileURL(f).href; };

const { loadDotEnv, log: rawLog } = await import(notaryFile('scripts/lib/mc.mjs'));
const ng = await import(notaryFile('scripts/lib/nightgate.mjs'));
const R = (s) => String(s).replace(/project_id=[^&\s"']+/g, 'project_id=***').replace(/ngat_[A-Za-z0-9_-]+/g, 'ngat_***').replace(/oda_[A-Za-z0-9_-]+/g, 'oda_***');
const log = (...a) => rawLog(...a.map(R));
loadDotEnv(path.join(NOTARY, '.env'));                 // runtime read of the grant, by path
const cfg = ng.config();

const { Contract, pureCircuits } = await import(pathToFileURL(path.join(ZK, 'contract', 'index.js')).href);
const witnesses = { secretKey: ({ privateState }) => [privateState, Buffer.from(privateState.sk, 'hex')] };
const secret = (f) => fs.readFileSync(path.join(HERE, '.wallets', f), 'utf8').trim();
const idOfWallet = (n) => pureCircuits.playerId(Buffer.from(secret(`${n}.cage-key`), 'hex'));
const toStar = (x) => BigInt(Math.round(Number(x) * 1e6));
const NONE_LINE = { is_some: false, value: { id: new Uint8Array(32), debit: 0n, credit: 0n } };
const lines = lineArgs.map((x) => { const m = /^([a-z0-9_-]+):([+-])(\d+(?:\.\d+)?)$/i.exec(x); if (!m) throw new Error(`bad line ${x}`);
  return { is_some: true, value: { id: idOfWallet(m[1]), debit: m[2] === '-' ? toStar(m[3]) : 0n, credit: m[2] === '+' ? toStar(m[3]) : 0n } }; });
const entry = { table: BigInt(table), roundNo: BigInt(roundNo), houseCut: 0n, lines: [...lines, ...Array(6 - lines.length).fill(NONE_LINE)] };
const NONE = { is_some: false, value: { table: 0n, roundNo: 0n, houseCut: 0n, lines: Array(6).fill(NONE_LINE) } };
const { ENTRIES_PER_BATCH } = await import('./judge-plan.mjs'); // the width of the cage's settleBatch: 4 since v4b, 8 before
const batch = [{ is_some: true, value: entry }, ...Array(ENTRIES_PER_BATCH - 1).fill(NONE)];
const now = BigInt(Math.floor(Date.now() / 1000) - 60);
const address = JSON.parse(fs.readFileSync(path.join(HERE, process.env.CAGE_FILE ?? 'deployment.cage.json'), 'utf8')).address;

async function main() {
  if (!cfg.token) throw new Error('NIGHTGATE_TOKEN not configured in the notary env');
  const { createTxBuilder } = await import(notaryFile('node_modules/@odatano/nightgate-tx/src/txbuilder/index.mjs'));
  // nightgate-tx wants a 64-byte BIP39 seed; our wallets use 32-byte seeds. An unbound sponsored call needs no funded wallet
  // (the sponsor balances it; the judge's authority is the cage key), so derive a throwaway builder seed from the judge seed.
  const { createHash } = await import('node:crypto');
  const builderSeed = createHash('sha512').update('sealed-cage:ng-builder:' + secret('judge.seed')).digest('hex');
  const b = await createTxBuilder({ seedHex: builderSeed, networkId: cfg.network, indexerHttpUrl: cfg.indexerHttpUrl, indexerWsUrl: cfg.indexerWsUrl, nodeUrl: cfg.nodeUrl,
    zkConfigDir: ZK, contractClass: Contract, contractName: 'sealed-cage', privateStateId: 'sealed-cage', walletSync: false });
  const t0 = Date.now();
  log(`settleBatch table ${table} round ${roundNo}: ${lineArgs.join(' ') || '(empty)'} · building unbound (sponsor pays the DUST)…`);
  let built;
  try {
    built = await b.buildSponsorable({ contractAddress: address, call: { circuitId: 'settleBatch', args: [batch, now], witnesses }, initialPrivateState: { sk: secret('judge.cage-key') }, bind: false });
  } finally { await b.close?.(); }
  log(`built+proved in ${Math.round((Date.now() - t0) / 1000)}s (unbound, ${Math.round(built.serializedBytes / 1024)} KB)`);
  if (DRY) { log('DRY: not sponsoring'); return; }
  const sub = await ng.sponsorUnbound(built.unboundTxB64, `sealed-cage-settle-${table}-${roundNo}-${Date.now()}`, cfg);
  log('sponsor accepted the job (ids masked); waiting up to 5 min…');
  const job = await ng.waitForJob(sub.jobId, sub.sessionId, { cfg, timeoutMs: 300_000 });
  if (job.status !== 'succeeded') throw new Error(`job ended ${job.status}: ${job.errorMessage || job.errorCode || '?'}`);
  log(`LANDED · tx ${job.txHash}`);
}
main().catch((e) => { log(`FAILED: ${e?.message ?? e}`); process.exit(1); });
