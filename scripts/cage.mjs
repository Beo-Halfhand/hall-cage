// sealed-cage driver on LEDGER 9 (branch ledger9, 11-09): Midnight.js 5.0.0, wallet SDK 2.0.0, proof server 9.0.1.
// SELF-FUNDED (no NIGHTGATE): each wallet pays its own DUST and submits through our own preprod node, one-shot, never resent blind.
//
// Preprod forked to ledger 9 in place at block 3,348,434 (2026-11-09 04:04 PT). cage4 was deployed before it, so it stays a
// ledger 8 contract, called through its own 0.31.1 build (packages/cage-l8): no recompile and no redeploy. A ledger 8 deploy
// is refused after the fork, so `deploy` lives on in the old build only (sealed-cage-v4b-wire), for history.
//
// Wallets live in .wallets/<name>.seed (600) with .wallets/<name>.l9-state.json (wallet SDK 2) and a cage key .wallets/<name>.cage-key
// (600). All gitignored and never printed. The SDK 1 snapshots (<name>.state.json) belong to the old build and aren't read here.
//
// Usage (from this repo):
//   node scripts/cage.mjs <wallet> address                      print the faucet address (to .wallets/<name>.address) and the cage player id
//   node scripts/cage.mjs <wallet> sync | balance               sync (first time: from genesis); print tNIGHT, DUST, registration
//   node scripts/cage.mjs <wallet> dust                         register the wallet's NIGHT for DUST (one tx) if it isn't, wait for DUST
//   node scripts/cage.mjs <wallet> deposit <tNIGHT> [<capNight> <hours>]   as before (L1 permit); without a cap, an empty permit
//   node scripts/cage.mjs <wallet> revoke
//   node scripts/cage.mjs judge seat-by-judge <wallet> <tableId> <atRiskNight>
//   node scripts/cage.mjs judge move-by-judge <wallet> <fromTable> <toTable> <atRiskNight>
//   node scripts/cage.mjs <wallet> sit <tableId> <atRiskNight>
//   node scripts/cage.mjs <wallet> stand <tableId>
//   node scripts/cage.mjs <wallet> withdraw <tNIGHT>
//   node scripts/cage.mjs <wallet> rescue <otherWallet>
//   node scripts/cage.mjs judge release <tableId> <wallet>
//   node scripts/cage.mjs judge settle <tableId> <roundNo> [<wallet>:+<creditNight> | <wallet>:-<debitNight> ...]
//   node scripts/cage.mjs judge propose <wallet> | cancel ;  node scripts/cage.mjs <wallet> accept
//   node scripts/cage.mjs <wallet> seat-proof <workerTableId>   JSON for POST /tables/:id/cage-seat (no network)
//   node scripts/cage.mjs <wallet> door-proof <expiresUnixSecs>  JSON for POST /door: this cage, this player key, this wallet (no network)
//   node scripts/cage.mjs <wallet> state                        the cage's public ledger (no wallet)
// Env: CAGE_FILE (default deployment.cage4.json), MIDNIGHT_PROOF_SERVER_L9 (default http://127.0.0.1:6302), endpoints as endpoints.mjs.
// Amounts on the command line are tNIGHT with up to 6 decimals; the cage counts STAR (1 tNIGHT = 1,000,000 STAR).
import './mask-stdio.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { inspect } from 'node:util';
import * as Rx from 'rxjs';
import { openWallet, balancesLine, nightOf, dustOf, WDIR, NETWORK, EP } from './l9-wallet.mjs';
import { readCage, providersFor, callCage, pureCircuits, hex, submitOnce, waitLanded, closeChain } from './l9-cage.mjs';
const { ENTRIES_PER_BATCH } = await import('./judge-plan.mjs'); // the width of the cage's settleBatch
const { isLocked } = await import('./locked.mjs');
const W = await import('@midnightntwrk/wallet-sdk');

const [who = 'judge', mode = 'state', ...args] = process.argv.slice(2);
if (!/^[a-z0-9_-]{1,16}$/i.test(who)) throw new Error('wallet name: letters, digits, - and _ only');
const t0 = Date.now(); const log = (m) => console.log(`${new Date().toISOString()} [${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const KEY_FILE = `${WDIR}/${who}.cage-key`;
const CAGE_FILE = process.env.CAGE_FILE ?? 'deployment.cage4.json';
// The cage counts STAR. A command-line amount is read as a decimal string, so 0.1 is exactly 100000 STAR (no float rounding).
const toStar = (x) => {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(x));
  if (!m) throw new Error(`amount ${x}: tNIGHT with at most 6 decimals`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
};
const fmtN = (s) => { const b = BigInt(s); const w = b / 1_000_000n, f = (b % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, ''); return `${w}${f ? '.' + f : ''} tNIGHT`; };
const nowSec = () => BigInt(Math.floor(Date.now() / 1000) - 60); // declared time: a minute behind the wall clock, inside clockSlack
const grantOf = (L) => { try { return L.maxGrant; } catch { return null; } };
const notBeforeL1 = (L) => { if (grantOf(L) === null) throw new Error('this cage is from before L1: deposit or revoke on it from a checkout of its own build'); };
mkdirSync(WDIR, { recursive: true, mode: 0o700 });

// ---------- keys (never printed) ----------
const cageKey = () => { if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); return readFileSync(KEY_FILE, 'utf8').trim(); };
const idOf = (skHex) => pureCircuits.playerId(Buffer.from(skHex, 'hex'));
const idOfWallet = (name) => { const f = `${WDIR}/${name}.cage-key`; if (!existsSync(f)) throw new Error(`no cage key for wallet ${name}`); return idOf(readFileSync(f, 'utf8').trim()); };
const knownWallets = () => readdirSync(WDIR).filter((f) => f.endsWith('.cage-key')).map((f) => f.slice(0, -9));
const keystoreOnly = () => {
  const f = `${WDIR}/${who}.seed`; if (!existsSync(f)) throw new Error(`no ${f}`);
  const seeds = W.WalletSeeds.fromMasterSeed(Uint8Array.from(Buffer.from(readFileSync(f, 'utf8').trim(), 'hex')));
  return W.createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, NETWORK);
};

// ---------- cage ----------
const addrOf = () => { if (!existsSync(CAGE_FILE)) throw new Error(`no cage file ${CAGE_FILE} (set CAGE_FILE)`); return JSON.parse(readFileSync(CAGE_FILE, 'utf8')).address; };
async function showState(addr) {
  const { L, era, protocolVersion, authority } = await readCage(addr);
  const tbl = (t) => { const k = BigInt(t), x = L.tables.lookup(k); return `table ${t}: epoch ${L.epochs.lookup(k)} · lastRound ${x.lastRound} · heartbeat ${x.heartbeat} · seated ${L.seats.member(k) ? L.seats.lookup(k).read() : 0n}`; };
  const lines = [`cage ${addr} · state ${era} at protocol ${protocolVersion}`,
    `  judge ${hex(L.judge).slice(0, 16)}… · house ${hex(L.houseId).slice(0, 16)}… · maxRake ${fmtN(L.maxRake)} · roundCap ${fmtN(L.roundCap)} · escape ${L.escapeSecs}s · slack ${L.clockSlack}s · judgeDelay ${L.judgeDelay}s · seats ${L.maxSeats} · maxGrant ${grantOf(L) ?? 'none'}s`,
    `  maintenance authority: ${authority ? `${isLocked(authority) ? 'LOCKED' : 'NOT locked'} · committee ${authority.committee.length} · threshold ${authority.threshold} · counter ${authority.counter}` : 'unknown'}`,
    `  pending judge: ${L.hasPending ? `${hex(L.pendingJudge).slice(0, 16)}… since ${L.pendingAt}` : 'none'}`];
  const seen = new Set();
  for (const n of knownWallets()) {
    const id = idOfWallet(n); const b = L.balance.member(id) ? L.balance.lookup(id) : 0n;
    const s = L.seat.member(id) ? L.seat.lookup(id) : null;
    if (s) seen.add(String(s.table));
    lines.push(`  ${n.padEnd(8)} id ${hex(id).slice(0, 12)}… · balance ${fmtN(b)} · payTo ${L.payTo.member(id) ? 'bound' : 'none'}` + (s ? ` · seat table ${s.table} epoch ${s.epoch} atRisk ${fmtN(L.risks.member(id) ? L.risks.lookup(id) : 0n)} standing ${s.standing}${s.standing ? ` since ${s.standAt}` : ''}` : ' · no seat') + (L.permits.member(id) ? ` · permit cap ${fmtN(L.permits.lookup(id).cap)} floor ${fmtN(L.permits.lookup(id).floor)} until ${L.permits.lookup(id).until}` : '') + (hex(id) === hex(L.judge) ? ' · JUDGE' : ''));
  }
  for (const t of [...seen, ...(process.env.CAGE_TABLES ?? '').split(',').filter(Boolean)]) if (L.tables.member(BigInt(t))) lines.push('  ' + tbl(t));
  let total = 0n; for (const [, v] of L.balance) total += v;
  lines.push(`  all balances: ${fmtN(total)}`);
  log(lines.join('\n'));
  return L;
}
const txLine = (step, d, id) => log(`TX ${step} · hash ${d?.txHash ?? '?'} · id ${id ?? d?.txId ?? '?'} · block ${d?.blockHeight ?? '?'} · ${d?.status ?? '?'}`);

async function call(circuitId, skHex, argsFor) {
  const addr = addrOf(), w = await openWallet(who, log);
  const ctx = {}; const { p } = await providersFor(w, ctx, log);
  log(`${circuitId} as ${who}: proving (proof server 9) + submitting (one try)…`);
  const callArgs = typeof argsFor === 'function' ? await argsFor(w) : argsFor;
  try {
    const r = await callCage(p, addr, circuitId, skHex, callArgs);
    txLine(circuitId, r.public, ctx.lastId);
    log(`era: contract ${r.era} · recorded as ${r.public?.era ?? '?'}`);
  } catch (e) {
    const f = e?.finalizedTxData ?? e?.txData;
    if (f) { txLine(circuitId, f, ctx.lastId); await w.save(); await w.wallet.stop(); throw new Error(`${circuitId} landed but the call was NOT applied (${f.status}): fee spent, cage unchanged`); }
    throw e;
  }
  await w.save(); await w.wallet.stop(); await showState(addr);
}
const myAddress = (w) => ({ bytes: Buffer.from(String(w.ks.getAddress()), 'hex') });
const NONE_LINE = { is_some: false, value: { id: new Uint8Array(32), debit: 0n, credit: 0n } };
function parseLines(xs) {
  const lines = xs.map((x) => { const m = /^([a-z0-9_-]+):([+-])(\d+(?:\.\d+)?)$/i.exec(x); if (!m) throw new Error(`bad line ${x}: <wallet>:+<credit> or <wallet>:-<debit>`);
    return { is_some: true, value: { id: idOfWallet(m[1]), debit: m[2] === '-' ? toStar(m[3]) : 0n, credit: m[2] === '+' ? toStar(m[3]) : 0n } }; });
  if (lines.length > 6) throw new Error('at most 6 lines per entry');
  return [...lines, ...Array(6 - lines.length).fill(NONE_LINE)];
}
const entryOf = (table, roundNo, lines, houseCut = 0n) => ({ table: BigInt(table), roundNo: BigInt(roundNo), houseCut, lines: parseLines(lines) });
const batchOf = (entries) => { const NONE = { is_some: false, value: entryOf(0, 0, []) }; return [...entries.map((e) => ({ is_some: true, value: e })), ...Array(ENTRIES_PER_BATCH - entries.length).fill(NONE)]; };

try {
  if (mode === 'address') {
    const ks = keystoreOnly(); cageKey();
    writeFileSync(`${WDIR}/${who}.address`, `${ks.getBech32Address()}\n`, { mode: 0o644 });
    log(`wallet ${who}: faucet address (unshielded, tNIGHT) written to ${WDIR}/${who}.address`);
    log(`wallet ${who}: cage player id ${hex(idOf(cageKey()))}`);
  } else if (mode === 'seat-proof') {
    if (!args[0]) throw new Error('usage: seat-proof <worker table id>');
    const ks = keystoreOnly();
    const cageId = hex(idOf(cageKey()));
    const message = `sealed-hand:seat:v1|${addrOf()}|${args[0]}|${cageId}`;
    // Wallet SDK 2 tags keys and signatures ({ tag: 'schnorr', value }); the Worker and the judge read the plain hex values, as in 4.1.1.
    const vk = ks.getPublicKey(), sig = ks.signData(new TextEncoder().encode(message));
    console.log(JSON.stringify({ cageId, verifyingKey: vk?.value ?? vk, signature: sig?.value ?? sig }));
  } else if (mode === 'door-proof') {
    if (!/^\d+$/.test(args[0] ?? '')) throw new Error('usage: door-proof <expires, unix seconds>');
    const ks = keystoreOnly();
    const cageId = hex(idOf(cageKey()));
    const payout = String(ks.getAddress());
    const expires = Number(args[0]);
    const message = `sealed-hand:door:v1|${addrOf()}|${cageId}|${payout}|${expires}`; // as checkDoor in judge-plan.mjs reads it
    const vk = ks.getPublicKey(), sig = ks.signData(new TextEncoder().encode(message));
    console.log(JSON.stringify({ cageId, payout, expires, verifyingKey: vk?.value ?? vk, signature: sig?.value ?? sig }));
  } else if (mode === 'sync' || mode === 'balance') {
    const w = await openWallet(who, log); await w.wallet.stop();
  } else if (mode === 'dust') {
    const w = await openWallet(who, log); let s = w.synced;
    if (nightOf(s) === 0n) throw new Error('no tNIGHT yet: fund the faucet address first');
    const unregistered = s.unshielded.availableCoins.filter((c) => c.meta?.registeredForDustGeneration !== true);
    if (!unregistered.length) log('NIGHT already registered for DUST');
    else {
      const { fee } = await w.wallet.estimateRegistration(unregistered);
      log(`registering ${unregistered.length} NIGHT coin(s) for DUST · they pay the fee (${fee} SPECK) from the DUST they generate first…`);
      const register = () => w.wallet.registerNightUtxosForDustGeneration(unregistered, w.ks.getPublicKey(), (d) => w.ks.signDataAsync(d));
      const recipe = await register().catch(async (e) => {
        if (!W.isInsufficientDustForFeeError(e) || e.estimate?._tag !== 'Reachable') throw e;
        const ms = Number(e.estimate.seconds) * 1000 + 60_000;
        log(`not enough generated DUST for the fee yet: waiting up to ${Math.round(ms / 1000)}s`);
        await w.wallet.waitForGeneratedDust(unregistered, e.fee, { timeoutMs: ms });
        return register();
      });
      const tx = await w.wallet.finalizeRecipe(recipe);
      const bytes = tx.transaction?.serialize?.() ?? tx.serialize?.();
      if (!bytes) throw new Error('could not read the registration transaction bytes');
      const id = await submitOnce(bytes, { release: () => w.wallet.revert(tx), log });
      const landed = await waitLanded(id, 240000);
      log(`TX dust-register · hash ${landed?.hash ?? '?'} · id ${id} · block ${landed?.height ?? '?'} · ${landed?.status ?? 'not seen on the indexer in 4 min'}`);
    }
    log('waiting for spendable DUST…');
    await Rx.firstValueFrom(w.wallet.state().pipe(Rx.throttleTime(5000), Rx.filter((x) => x.isSynced && dustOf(x) > 0n)));
    s = await Rx.firstValueFrom(w.wallet.state()); log(`DUST READY · ${balancesLine(s)}`);
    await w.save(); await w.wallet.stop();
  } else if (mode === 'deploy' || mode === 'deploy-size') {
    throw new Error('a ledger 8 deploy is refused after the fork (EraMismatchError ledger8-deploy-on-ledger9-network). A new cage needs a 0.36.0 build: runbook PREPROD-RESET 2B');
  } else if (mode === 'deposit') {
    if (!args[0] || (args[1] && !args[2])) throw new Error('usage: deposit <tNIGHT> [<capNight> <hours>, or <seconds>s]');
    const { L } = await readCage(addrOf());
    notBeforeL1(L);
    const grants = !!args[1];
    const judgeId = grants ? L.judge : new Uint8Array(32);
    const secs = !grants ? 0n : /^\d+s$/.test(args[2]) ? BigInt(args[2].slice(0, -1)) : /^\d+(\.\d+)?$/.test(args[2]) ? BigInt(Math.round(Number(args[2]) * 3600)) : null;
    if (secs === null) throw new Error(`hours: a number, or seconds as <n>s (not ${args[2]})`);
    await call('deposit', cageKey(), async (w) => {
      if (!grants) return [myAddress(w), toStar(args[0]), judgeId, 0n, 0n];
      await new Promise((r) => setTimeout(r, 1005 - (Date.now() % 1000)));
      const until = BigInt(Math.floor(Date.now() / 1000)) + secs;
      log(`permit until ${until} (${new Date(Number(until) * 1000).toISOString()}), ${secs}s from the build · this cage's maxGrant ${grantOf(L)}s`);
      return [myAddress(w), toStar(args[0]), judgeId, toStar(args[1]), until];
    });
  } else if (mode === 'revoke') {
    notBeforeL1((await readCage(addrOf())).L);
    await call('deposit', cageKey(), [{ bytes: new Uint8Array(32) }, 0n, new Uint8Array(32), 0n, 0n]);
  } else if (mode === 'seat-by-judge') {
    if (!args[2]) throw new Error('usage: judge seat-by-judge <wallet> <tableId> <atRiskNight>');
    await call('seatByJudge', cageKey(), [idOfWallet(args[0]), { is_some: false, value: 0n }, BigInt(args[1]), toStar(args[2]), nowSec()]);
  } else if (mode === 'move-by-judge') {
    if (!args[3]) throw new Error('usage: judge move-by-judge <wallet> <fromTable> <toTable> <atRiskNight>');
    await call('seatByJudge', cageKey(), [idOfWallet(args[0]), { is_some: true, value: BigInt(args[1]) }, BigInt(args[2]), toStar(args[3]), nowSec()]);
  } else if (mode === 'sit') {
    if (!args[1]) throw new Error('usage: sit <tableId> <atRiskNight>');
    await call('sit', cageKey(), [BigInt(args[0]), toStar(args[1]), nowSec()]);
  } else if (mode === 'stand') {
    if (!args[0]) throw new Error('usage: stand <tableId>');
    await call('stand', cageKey(), [BigInt(args[0]), nowSec()]);
  } else if (mode === 'withdraw') {
    if (!args[0]) throw new Error('usage: withdraw <tNIGHT>');
    await call('withdraw', cageKey(), [toStar(args[0])]);
  } else if (mode === 'rescue') {
    if (!args[0]) throw new Error('usage: rescue <otherWallet>');
    await call('rescue', cageKey(), [idOfWallet(args[0])]);
  } else if (mode === 'release') {
    if (!args[1]) throw new Error('usage: judge release <tableId> <wallet>');
    await call('release', cageKey(), [BigInt(args[0]), idOfWallet(args[1])]);
  } else if (mode === 'settle') {
    const [table, roundNo, ...lines] = args; if (!roundNo) throw new Error('usage: judge settle <tableId> <roundNo> [<wallet>:+<credit>|<wallet>:-<debit> ...]');
    const e = entryOf(table, roundNo, lines);
    const debits = e.lines.reduce((s, l) => s + l.value.debit, 0n), credits = e.lines.reduce((s, l) => s + l.value.credit, 0n);
    log(`entry table ${table} round ${roundNo}: ${lines.join(' ') || '(empty)'} · debits ${fmtN(debits)} · credits ${fmtN(credits)}`);
    await call('settleBatch', cageKey(), [batchOf([e]), nowSec()]);
  } else if (mode === 'propose') {
    if (!args[0]) throw new Error('usage: judge propose <wallet>');
    await call('proposeJudge', cageKey(), [idOfWallet(args[0]), nowSec()]);
  } else if (mode === 'cancel') {
    await call('cancelJudge', cageKey(), []);
  } else if (mode === 'accept') {
    await call('acceptJudge', cageKey(), []);
  } else if (mode === 'state') {
    await showState(args[0] ?? addrOf());
  } else throw new Error(`unknown mode ${mode}`);
} catch (e) { log(`FAILED: ${e?.message ?? e}\n${inspect(e?.cause ?? e, { depth: 5 }).slice(0, 2500)}`); process.exitCode = 1; }
await closeChain();
process.exit();
