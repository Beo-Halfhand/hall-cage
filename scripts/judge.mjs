// The judge service. One long-running wallet that turns finished Sealed Hand rounds into settleBatch transactions.
//
// Loop: read the tNIGHT tables from the Worker, read the cage, confirm seat claims, settle what's finished, free seats
// that are done, write each receipt back. Every step is safe to repeat, and a restart picks up from the journal.
// The loop is in judge-cycle.mjs, so tests can run it against the simulator. This file is the wallet, the journal file and the Worker's address.
//
// Never settles a round twice:
//   - .judge/journal.jsonl records a batch's rounds before it's built and its id before it leaves, and a round in a
//     batch that's live or landed is never planned again.
//   - If the journal were lost, the chain's lastRound would be ahead of what the Worker and the journal know, and the
//     table is blocked for a person to look at.
//   - One try per transaction: a lost socket is never resent; the indexer is asked instead.
//
// DUST view lag (Custom error 170, InvalidDustSpendProof): a build made before the wallet has applied its own last
// spend is refused before the pool, with nothing spent. So after each landed tx it waits for the wallet to catch up,
// and a 170 releases the note and waits, without counting against the rounds.
//
// Stops settling on low DUST: under MIN_DUST it writes .judge/STOP-dust-low and only keeps confirming seats.
//
// Two Workers, one judge (11-10): JUDGE_WORKER_URL is a comma-separated list, checked against the allowlist in judge-sites.mjs (the staging
// Worker and live, nothing else). Each Worker gets its own cycle (judge-cycle.mjs) on this one wallet, taken in turn, live first, and owns
// its own table numbers. One journal file: every line names its site, and lines from before 11-10 are staging's.
//
// Env: JUDGE_WORKER_URL (required, comma-separated), CAGE_FILE (default deployment.cage4.json), JUDGE_TOKEN_FILE (optional: one file per
//      Worker, comma-separated in the same order; by default each Worker's file in judge-sites.mjs), JUDGE_TEST_LIVE (tests only),
//      JUDGE_POLL_SECS (4), JUDGE_PREWARM (1: tables kept ready with the house seated), JUDGE_KEEP_ALIVE_SECS (600), JUDGE_MIN_DUST (10), HOUSE_FLOAT_TNIGHT (default six antes a bot, at most 100), MIDNIGHT_PROOF_SERVER, endpoints as endpoints.mjs.
import './mask-stdio.mjs';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { inspect } from 'node:util';
import * as Rx from 'rxjs';
import { Journal, KEEP_ALIVE_BEFORE, signedForms } from './judge-plan.mjs';
import { checkBatchWidth, houseKey, makeJudge } from './judge-cycle.mjs';
import { makeRunner, oneAtATime, ownsTable, parseWorkers } from './judge-sites.mjs';
import { openWallet, endpointsEnv, nightOf, dustOf as dustOfState, DUST_UNIT, EP, PROOF_SERVER } from './l9-wallet.mjs';
import { readCage, providersFor, callCage, probeLanded, pureCircuits, ZK } from './l9-cage.mjs';
const ledger9 = await import('@midnightntwrk/ledger-v9');

// Ledger 9 build (branch ledger9, 11-09): Midnight.js 5.0.0, wallet SDK 2.0.0, proof server 9.0.1 (MIDNIGHT_PROOF_SERVER_L9,
// default 127.0.0.1:6302). cage4 stays a ledger 8 contract, called through its own 0.31.1 build (packages/cage-l8): no recompile.
// The wallet keeps its own state, .wallets/judge.l9-state.json; the SDK 1 snapshot (judge.state.json) is the old build's.

// ---------- config ----------
const WHO = 'judge';
const WDIR = '.wallets', JDIR = '.judge';
const KEY_FILE = `${WDIR}/${WHO}.cage-key`;
const CAGE_FILE = process.env.CAGE_FILE ?? 'deployment.cage4.json';
const SITES = parseWorkers(process.env); // stops here, at start, on any Worker not on the allowlist
const POLL_MS = Number(process.env.JUDGE_POLL_SECS ?? 4) * 1000;
const PREWARM = Number(process.env.JUDGE_PREWARM ?? 1);
const KEEP_ALIVE = process.env.JUDGE_KEEP_ALIVE_SECS ? BigInt(process.env.JUDGE_KEEP_ALIVE_SECS) : KEEP_ALIVE_BEFORE;
const DUST_WAIT_MS = 20_000; // after a landed tx. A build that comes too soon is refused with nothing spent (170), and retried
const TIMINGS = 'logs/judge-timings.jsonl';
const MIN_DUST = BigInt(process.env.JUDGE_MIN_DUST ?? 10) * DUST_UNIT;
checkBatchWidth(readFileSync(`${ZK}/contract/index.js`, 'utf8')); // stops here, at start, if the build and the judge disagree on the batch
const t0 = Date.now(); const log = (m) => console.log(`${new Date().toISOString()} [${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => BigInt(Math.floor(Date.now() / 1000) - 60); // declared time: a minute behind the clock, inside clockSlack

const CAGE = JSON.parse(readFileSync(CAGE_FILE, 'utf8'));
if (CAGE.network !== 'preprod') throw new Error(`${CAGE_FILE} is not preprod`);
const ADDRESS = CAGE.address;
endpointsEnv(); // stops here if an endpoint is missing or not preprod
const judgeKey = readFileSync(KEY_FILE, 'utf8').trim();
const houseKeyFor = (cageTable) => houseKey(judgeKey, ADDRESS, cageTable);
const idOf = (skHex) => hex(pureCircuits.playerId(unhex(skHex)));

// ---------- journal ----------
mkdirSync(JDIR, { recursive: true, mode: 0o700 });
const LOCK = `${JDIR}/judge.lock`;
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, 'utf8').trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
  if (alive) throw new Error(`another judge is running (pid ${pid})`);
}
writeFileSync(LOCK, String(process.pid));
const JPATH = `${JDIR}/journal.jsonl`;
const STOPFILE = `${JDIR}/STOP-dust-low`;
const journal = new Journal(existsSync(JPATH) ? readFileSync(JPATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function record(r) {
  const line = { ...r, at: new Date().toISOString() };
  const fd = openSync(JPATH, 'a', 0o600);
  writeSync(fd, JSON.stringify(line) + '\n');
  fsyncSync(fd);
  closeSync(fd);
  journal.apply(line);
}

// ---------- workers ----------
// Each Worker's token is read when first needed and again while it's missing, so live's can be put in place without a restart. Never logged.
const tokens = new Map();
function tokenFor(site) {
  if (tokens.has(site.host)) return tokens.get(site.host);
  if (!existsSync(site.tokenFile)) throw Object.assign(new Error(`no token file for ${site.host} yet (${site.tokenFile})`), { workerDown: true, noToken: true });
  const t = readFileSync(site.tokenFile, 'utf8').trim();
  if (t.length < 24) throw Object.assign(new Error(`the token file for ${site.host} is too short`), { workerDown: true, noToken: true });
  tokens.set(site.host, t);
  return t;
}
const workerFor = (site) => async function worker(method, path, body, { timeoutMs = 20000 } = {}) {
  let res;
  try {
    res = await fetch(`${site.origin}${path}`, { method, headers: { authorization: `Bearer ${tokenFor(site)}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.noToken) throw e;
    throw Object.assign(new Error(`${site.host} did not answer (${String(e?.cause?.code ?? e?.name ?? e?.message ?? e).slice(0, 80)})`), { workerDown: true });
  }
  const text = await res.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not json */ }
  if (res.status === 401 || res.status === 403) tokens.delete(site.host); // read the file again next time: it may have been replaced
  return { status: res.status, ok: res.ok, body: parsed };
};

// ---------- chain ----------
async function readChain() { return (await readCage(ADDRESS)).L; }
const probeTx = (identifier) => probeLanded(identifier);

// ---------- wallet ----------
let W = null;
async function openJudgeWallet() {
  const w = await openWallet(WHO, log);
  W = { w, wallet: w.wallet, ks: w.ks, ctx: {} };
  log(`wallet restored · ${dustLine(w.synced)}`);
}
// The SDK can stop syncing without failing, with waitForSyncedState pending for ever (seen on preprod 2026-11-03 with SDK 1).
// A hung judge would let tables die quietly, so this exits instead. launchd restarts it, and the journal makes that safe.
const SYNC_LIMIT_MS = 4 * 60_000;
const CYCLE_LIMIT_MS = 20 * 60_000;
const walletSynced = () => Promise.race([W.wallet.waitForSyncedState(), sleep(SYNC_LIMIT_MS).then(() => { throw Object.assign(new Error('wallet did not sync in time'), { stuck: true }); })]);
// When the indexer flaps, waiting for "synced" can take minutes, and a player's settle shouldn't wait with it. After this long
// it goes on the state it has. A build from a stale view is refused before the pool with nothing spent (170), and retried.
const SYNC_PATIENCE_MS = 15_000;
async function walletNow() {
  const synced = walletSynced();
  const state = await Promise.race([synced, sleep(SYNC_PATIENCE_MS).then(() => null)]);
  if (state) return state;
  synced.catch(() => {});
  log(`wallet not synced after ${SYNC_PATIENCE_MS / 1000}s: going on with the state it has`);
  return Rx.firstValueFrom(W.wallet.state());
}
const dustOf = (s) => dustOfState(s);
const dustLine = (s) => `tNIGHT ${Number(nightOf(s)) / 1e6} · DUST ${Number(dustOf(s) / (DUST_UNIT / 1000n)) / 1000}`;
const saveWallet = () => W.w.save();
const dustApplied = (s) => { const p = s.dust?.progress; return p?.appliedIndex ?? p?.appliedId ?? 0n; };
/** Waits until the wallet's DUST view has moved past where it stood when the last tx left. Better late than a 170. */
async function dustCaughtUp(before, ms = DUST_WAIT_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await walletNow();
    if (before === null || dustApplied(s) > before) return s;
    if (Date.now() > end) { log('DUST view did not move within the wait; building anyway, a 170 would be retried'); return s; }
    await sleep(3000);
  }
}

function timing(row) {
  try { appendFileSync(TIMINGS, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`); } catch { /* the numbers are for looking at, not worth stopping for */ }
}

const isDustLag = (e) => /\b170\b|InvalidDustSpendProof/i.test(`${e?.message ?? ''} ${e?.cause?.message ?? ''} ${inspect(e?.cause ?? '', { depth: 4 })}`);

const walletTurn = oneAtATime(); // one wallet, one transaction at a time, whichever Worker asked: two builds would race for the same DUST
const callCircuit = (...a) => walletTurn(() => callCircuitNow(...a));

/** Calls a circuit and waits for it to land. Returns { hash, block, status, id }. Retries only the DUST lag, where nothing was spent. */
async function callCircuitNow(circuitId, skHex, args, label, onSend, meta = {}) {
  const asked = Date.now();
  for (let attempt = 1; ; attempt++) {
    const s = await walletNow();
    const ready = Date.now();
    if (dustOf(s) < MIN_DUST) throw Object.assign(new Error(`DUST ${dustOf(s)} is under the floor`), { dustLow: true });
    const before = dustApplied(s);
    const ctx = { onSend };
    const { p } = await providersFor(W.w, ctx, log);
    try {
      const started = Date.now();
      const r = await callCage(p, ADDRESS, circuitId, skHex, args);
      const pubTx = r.public;
      await saveWallet();
      const landed = Date.now();
      const dustBefore = dustOf(s);
      log(`TX ${label} · hash ${pubTx.txHash} · id ${ctx.lastId} · block ${pubTx.blockHeight} · ${pubTx.status} · ${Math.round((landed - started) / 1000)}s`);
      const blockAt = (await probeTx(ctx.lastId))?.blockAt ?? null;
      const id = ctx.lastId;
      const after = await dustCaughtUp(before);
      await saveWallet();
      log(`DUST ${label.split(' ').slice(0, 2).join(' ')} · ${Number(dustBefore / (DUST_UNIT / 1000n)) / 1000} → ${Number(dustOf(after) / (DUST_UNIT / 1000n)) / 1000}`);
      timing({ label, circuit: circuitId, ...meta, dustBefore: String(dustBefore), dustAfter: String(dustOf(after)), asked, syncMs: ready - asked, tries: attempt, buildMs: (ctx.sentAt ?? landed) - ready, landMs: landed - (ctx.sentAt ?? landed), totalMs: landed - asked, dustAfterMs: Date.now() - landed, blockAt });
      return { hash: pubTx.txHash, id, block: pubTx.blockHeight, status: String(pubTx.status), blockAt };
    } catch (e) {
      const f = e?.record?.public ?? e?.record ?? e?.finalizedTxData;
      if (f && (e?.name === 'TxFailedError' || e?.finalizedTxData)) {
        await saveWallet();
        log(`TX ${label} · hash ${f.txHash} · id ${ctx.lastId} · block ${f.blockHeight} · ${f.status} (fee spent, cage unchanged)`);
        await dustCaughtUp(before);
        throw Object.assign(new Error(`landed but not applied (${f.status})`), { notApplied: true });
      }
      if (e?.unknown || e?.cause?.unknown) throw Object.assign(e, { unknown: true, id: e?.id ?? e?.cause?.id ?? ctx.lastId });
      if (isDustLag(e) && attempt < 6) {
        log(`${label}: DUST view lag (170), nothing spent. Waiting ${8 * attempt}s (try ${attempt}).`);
        await sleep(8000 * attempt);
        continue;
      }
      throw e;
    }
  }
}

// ---------- signature check ----------
// Ledger 9 tags keys and signatures ({ tag, value: hex }). Claims carry plain hex, as the page sends what the wallet's signData gives.
// DApp Connector 4.1.0 adds ECDSA (secp256k1) next to Schnorr (BIP-340): a 33-byte key (66 hex) is ECDSA, a 32-byte key is Schnorr.
const kindOf = (vk) => (typeof vk === 'string' && vk.length === 66 ? 'ecdsa' : 'schnorr');
const tagged = (x, kind) => (typeof x === 'string' ? { tag: kind, value: x } : x);
function checkSignature(vk, message, signature) {
  const kind = typeof vk === 'string' ? kindOf(vk) : vk?.tag;
  for (const data of signedForms(message)) {
    try { if (ledger9.verifySignature(tagged(vk, kind), data, tagged(signature, kind))) return true; } catch { /* malformed: refused below */ }
  }
  return false;
}
const claimCheckOpts = () => ({ address: ADDRESS, addressFromKey: (k) => ledger9.addressFromKey(tagged(k, kindOf(k))), verify: checkSignature });

// ---------- the loop ----------
let stopping = false;
// One judge per Worker, on this one wallet and journal. Each sees only its own tables (owns) and its own part of the journal.
const runner = makeRunner({
  log,
  sites: SITES.map((site) => {
    const worker = workerFor(site);
    const owns = (n) => ownsTable(site, n);
    const siteLog = (m) => log(`[${site.site}] ${m}`);
    const judge = makeJudge({
      address: ADDRESS, worker, readChain, probeTx, judgeKey, idOf, houseKeyFor,
      callCircuit: (circuit, sk, args, label, onSend, meta = {}) => callCircuit(circuit, sk, args, `${label} [${site.site}]`, onSend, { ...meta, site: site.site }),
      journal: journal.forSite(site.site, { legacy: !!site.legacy }),
      record: (r) => record({ ...r, site: site.site }),
      log: siteLog,
      dustNow: async () => dustOf(await walletNow()),
      payoutOf: () => ({ bytes: unhex(String(W.ks.getAddress())) }),
      declaredNow: nowSec,
      checkOpts: claimCheckOpts,
      prewarm: PREWARM,
      keepAliveBefore: KEEP_ALIVE,
      minDust: MIN_DUST,
      houseFloat: process.env.HOUSE_FLOAT_TNIGHT ?? null,
      owns,
    });
    return { ...site, judge, owns, peek: async () => { const r = await worker('GET', '/judge/tables', undefined, { timeoutMs: 5000 }); return r.ok ? r.body : null; } };
  }),
});

async function main() {
  log(`judge (ledger 9 build) · cage ${ADDRESS.slice(0, 16)}… · workers ${SITES.map((s) => s.host).join(', ')} · node ${new URL(EP.node).host} · proof server ${new URL(PROOF_SERVER).host} · journal ${journal.batches.size} batches`);
  if (existsSync(STOPFILE)) rmSync(STOPFILE);
  await openJudgeWallet();
  runner.start(); // logs which Workers are served, in what order, with their table numbers
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; log(`${sig}: finishing this cycle`); });
  let lastBalance = 0;
  while (!stopping) {
    const started = Date.now();
    const watchdog = setTimeout(() => { log('a cycle ran over its limit: exiting so a fresh process can pick up from the journal'); process.exit(75); }, CYCLE_LIMIT_MS * SITES.length);
    try {
      await runner.turn(); // every Worker once, live first; one that doesn't answer is backed off, and the others keep going
    } catch (e) {
      if (e?.stuck) {
        log(`${e.message}: exiting so a fresh process can pick up from the journal`);
        process.exit(75);
      }
      if (e?.dustLow) {
        log(`STOP: ${e.message}`);
        writeFileSync(STOPFILE, `${new Date().toISOString()} ${e.message}\n`);
        await sleep(300000);
      } else {
        log(`cycle error: ${String(e?.message ?? e).slice(0, 500)}`);
      }
    }
    clearTimeout(watchdog);
    if (Date.now() - lastBalance > 600000) { lastBalance = Date.now(); const s = await walletSynced(); log(`status · ${dustLine(s)}`); }
    const left = POLL_MS - (Date.now() - started);
    if (left > 0 && !stopping) await sleep(left);
  }
  runner.stop();
  await saveWallet();
  await W.wallet.stop();
  rmSync(LOCK, { force: true });
  process.exit(0);
}
main().catch((e) => { log(`FATAL: ${e?.message ?? e}`); rmSync(LOCK, { force: true }); process.exit(1); });
