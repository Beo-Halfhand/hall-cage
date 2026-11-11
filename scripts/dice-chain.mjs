// What the dice-proof service shares, on LEDGER 9 (branch dice-l9, 11-09): a wallet on PREPROD, the contract, and one call that proves,
// sends, waits and measures. Same exports dice-house.mjs used on ledger 8, so dice-house itself is unchanged in logic.
//
// Preprod forked in place to ledger 9 at block 3,348,434 (11-09 04:04 PT). dice-proof (c2459aac…) was deployed before the fork with
// compactc 0.31.1 (runtime 0.16.0), so it stays a ledger 8 contract: Midnight.js 5 calls it through its own build (packages/cage-l8,
// export ./dice-proof, never recompiled: its verifier keys are the ones on chain), passed as `new Contract(witnesses)`. Its state comes in
// the ledger 9 format and is decoded with runtime 0.21, then handed to the 0.16 build's ledger() as plain encoded data (as l9-cage.mjs).
// Wallet: wallet SDK 2 through l9-wallet.mjs, proofs on proof server 9 (MIDNIGHT_PROOF_SERVER_L9, default :6302). Submission is
// l9-cage.mjs's one-shot path: a lost socket is never resent, a refusal before the pool releases the DUST.
//
// Wallets: only `a` and `b`. Each keeps its OWN ledger 9 state, .wallets/<who>-dice.l9-state.json (600), so another script using the
// same wallet (cage.mjs, the e2e drivers) never shares a state file with this one. The first run restores from DICE_RESTORE_FROM (default
// ../sealed-cage-l9/.wallets/<who>.l9-state.json) if there is no state yet.
//
// Not ported (ledger 8 only, they build alternative contracts or use the 4.1.1 provider APIs): compiledFrom, CompiledContract, ledgerV,
// NodeZkConfigProvider, runtimePin. dice-rounds.mjs, dice-mutants.mjs and the e2e-dice-proof drivers still need them.
import './mask-stdio.mjs';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { inspect } from 'node:util';
import { openWallet as openL9Wallet, endpointsEnv, balancesLine, dustOf, PROOF_SERVER } from './l9-wallet.mjs';
import { providersFor as cageProviders, publicData, probeLanded, closeChain } from './l9-cage.mjs';

const { ContractState } = await import('@midnight-ntwrk/compact-runtime'); // 0.21.0, ledger 9
const rt8 = await import('cage-l8/runtime'); // 0.16.0, the copy the dice-proof build imports
export const contractModule = await import('cage-l8/dice-proof');
const { Contract, ledger } = contractModule;
const { submitCallTx } = await import('@midnight-ntwrk/midnight-js-contracts');
const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');

const HERE = (p) => new URL(p, import.meta.url).pathname;
export const ZK = HERE('../packages/cage-l8/dice-proof');
export const WALLET_DIR = HERE('../.wallets');
export const STATE_DIR = process.env.DICE_STATE_DIR ?? HERE('../.dice-state');
export const DEPLOY_FILE = process.env.DICE_FILE ?? HERE('../deployment.dice.json');
const ALLOWED = new Set(['a', 'b']);
const DUST_WAIT_MS = 30_000;
const MIN_DUST = 1_000_000_000_000_000n; // 1 DUST. Below this a wallet stops rather than run a round it can't finish.

export const hex = (u) => Buffer.from(u).toString('hex');
export const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
export const log = (m) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s] ${m}`);
export const nowSec = () => BigInt(Math.floor(Date.now() / 1000) - 60); // declared time: a minute behind the wall clock, inside clockSlack

const E = endpointsEnv(); // refuses anything that isn't preprod
export const env = { walletNetworkId: 'preprod', networkId: 'preprod', indexer: E.indexer, indexerWS: E.indexerWS, node: E.node, nodeWS: E.nodeWS, proofServer: PROOF_SERVER };

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

/** A secret of this run's own, made once and kept in a file of mode 600. Never printed. */
export function secretFile(name) {
  const f = `${STATE_DIR}/${name}`;
  if (!existsSync(f)) writeFileSync(f, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  return unhex(readFileSync(f, 'utf8').trim());
}

export const cupKey = (c) => `${c.table}/${c.round}/${c.seat}`;
const witnesses = {
  seatKey: ({ privateState }) => [privateState, privateState.sk ?? new Uint8Array(32)],
  cupSeed: ({ privateState }, cup) => {
    const seed = privateState.seeds?.[cupKey(cup)];
    if (!seed) throw new Error(`no seed held for table ${cup.table} round ${cup.round} seat ${cup.seat}`);
    return [privateState, seed];
  },
};
const contractInstance = () => new Contract(witnesses);

/** The raw read: { contractState (both eras), protocolVersion, ... } or null. */
export const rawState = (address) => publicData().queryContractState(address);
/** dice-proof's public state as the 0.16 build reads it, from either era's bytes. */
export async function readLedger(address) {
  const read = await rawState(address);
  if (!read) throw new Error(`no contract at ${address}`);
  return ledger(read.contractState.deserialize({
    v8: { deserialize: (bytes) => rt8.ContractState.deserialize(bytes).data.state },
    v9: { deserialize: (bytes) => rt8.StateValue.decode(ContractState.deserialize(bytes).data.state.encode()) },
  }));
}
export const probeTx = probeLanded;

const dustApplied = (s) => { const p = s.dust?.progress; return p?.appliedIndex ?? p?.appliedId ?? 0n; };
const isDustLag = (e) => /\b170\b|InvalidDustSpendProof/i.test(`${e?.message ?? ''} ${inspect(e?.cause ?? '', { depth: 4 })}`);
const dustNum = (d) => Number(d / 1_000_000_000_000n) / 1000;

export async function openWallet(who) {
  if (!ALLOWED.has(who)) throw new Error(`STOP: dice-proof only runs on the test wallets a and b, not "${who}"`);
  // l9-wallet reads .wallets/<who>.seed and keeps .wallets/<who><L9_STATE_TAG>.l9-state.json, relative to the working directory
  process.chdir(HERE('..'));
  process.env.L9_STATE_TAG = '-dice';
  const own = `${WALLET_DIR}/${who}-dice.l9-state.json`;
  const from = process.env.DICE_RESTORE_FROM ?? HERE(`../../sealed-cage-l9/.wallets/${who}.l9-state.json`);
  if (!existsSync(own) && existsSync(from)) process.env.L9_RESTORE_FROM = from; else delete process.env.L9_RESTORE_FROM;
  const w = await openL9Wallet(who, log);
  const W = { who, wallet: w.wallet, l9: w, stateFile: w.stateFile, proofs: [], queue: Promise.resolve(), lastId: null, sentAt: null, txBytes: null };
  W.save = w.save;
  W.balances = (s) => balancesLine(s);
  W.ctx = {};
  W.providers = await cageProviders(w, W.ctx, log); // the wallet provider with the one-shot submit; its zk/proof parts are replaced per call
  log(`wallet ${who}: synced · ${W.balances(w.synced)}`);
  return W;
}

/** Providers for a dice-proof call: the wallet's, with dice-proof's own keys and a proof provider that keeps each proof's time. */
export function providersFor(W, { dir = ZK } = {}) {
  const zk = new NodeZkConfigProvider(dir, { verify: 'require-if-present' }); // 0.31.1 writes contract-info.json and no manifest
  const inner = httpClientProofProvider(env.proofServer, zk);
  const proofProvider = {
    supportedEras: inner.supportedEras,
    proveTx: async (...a) => { const t = Date.now(); const out = await inner.proveTx(...a); W.proofs.push({ kind: 'prove', ms: Date.now() - t }); return out; },
  };
  return { ...W.providers.p, zkConfigProvider: zk, proofProvider };
}

async function dustCaughtUp(W, before) {
  const end = Date.now() + DUST_WAIT_MS;
  for (;;) {
    const s = await W.wallet.waitForSyncedState();
    if (dustApplied(s) > before || Date.now() > end) return s;
    await sleep(3000);
  }
}

const RECEIPTS = process.env.DICE_RECEIPTS ?? HERE('../logs/dice-rounds.jsonl');
mkdirSync(HERE('../logs'), { recursive: true });
export const receipt = (row) => { appendFileSync(RECEIPTS, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`); };

/**
 * Proves, sends and waits for one call, one at a time per wallet. Returns the receipt row. Retries only the DUST lag, where nothing was
 * spent. A refusal comes back as an error, and a transaction that landed but wasn't applied throws with `notApplied`.
 */
export function call(W, circuitId, privateState, args, label, { address, dir = ZK } = {}) {
  const run = async () => {
    const asked = Date.now();
    for (let attempt = 1; ; attempt++) {
      const s = await W.wallet.waitForSyncedState();
      const dustBefore = dustOf(s);
      if (dustBefore < MIN_DUST) throw new Error(`wallet ${W.who} has ${dustNum(dustBefore)} DUST: stopping`);
      const before = dustApplied(s);
      const p = providersFor(W, { dir });
      await p.privateStateProvider.forContract(address).set('me', privateState);
      W.proofs = [];
      W.ctx.lastId = null; W.ctx.sentAt = null;
      const started = Date.now();
      try {
        const r = await submitCallTx(p, { compiledContract: contractInstance(), contractAddress: address, circuitId, privateStateId: 'me', args });
        const landed = Date.now();
        await W.save();
        const after = await dustCaughtUp(W, before);
        await W.save();
        const prove = W.proofs.filter((x) => x.kind === 'prove');
        const row = { label, circuit: circuitId, wallet: W.who, hash: r.public.txHash, id: r.public.txId ?? W.ctx.lastId, block: Number(r.public.blockHeight), status: String(r.public.status), proveMs: prove.reduce((n, x) => n + x.ms, 0), proofs: prove.length, buildMs: (W.ctx.sentAt ?? landed) - started, landMs: landed - (W.ctx.sentAt ?? started), totalMs: landed - asked, tries: attempt, dustBefore: dustNum(dustBefore), dustAfter: dustNum(dustOf(after)), ledger: 9 };
        receipt(row);
        log(`TX ${label} · ${circuitId} · ${W.who} · hash ${row.hash} · id ${row.id} · block ${row.block} · ${row.status} · prove ${(row.proveMs / 1000).toFixed(1)}s · landed in ${(row.landMs / 1000).toFixed(1)}s`);
        return row;
      } catch (e) {
        const f = e?.record ?? e?.finalizedTxData; // Midnight.js 5: TxFailedError.record
        if (f) {
          await W.save();
          await dustCaughtUp(W, before);
          await W.save();
          receipt({ label, circuit: circuitId, wallet: W.who, hash: f.txHash, id: f.txId ?? W.ctx.lastId, block: Number(f.blockHeight), status: String(f.status), notApplied: true, ledger: 9 });
          log(`TX ${label} · ${circuitId} · ${W.who} · hash ${f.txHash} · block ${f.blockHeight} · ${f.status}: LANDED, NOT APPLIED. The fee is spent and the contract is unchanged.`);
          throw Object.assign(new Error(`${label}: landed but not applied (${f.status})`), { notApplied: true, row: { hash: f.txHash, status: String(f.status) } });
        }
        if (e?.unknown) throw e;
        if (isDustLag(e) && attempt < 6) {
          log(`${label}: DUST view lag (170), nothing spent. Waiting ${8 * attempt}s (try ${attempt}).`);
          await sleep(8000 * attempt);
          continue;
        }
        throw e;
      }
    }
  };
  const result = W.queue.then(run, run);
  W.queue = result.catch(() => {});
  return result;
}
export const stop = async (...wallets) => { for (const W of wallets) { await W.queue; await W.save(); await W.wallet.stop(); } await closeChain(); };
