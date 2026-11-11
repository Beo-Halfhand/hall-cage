// Cup & Claim on tNIGHT, end to end on preprod (Ledger 9, 11-09), against a running Worker and judge, using agent wallets a and b.
// Sibling of e2e-table.mjs (same chain steps), at /dice-tables: deposit → sit → claim → rounds (cups shown) settled on chain → both leave through
// the Worker as the page's Leave button does → judge frees the seats → withdraw → every receipt checked against the chain with check-receipt.mjs.
//   node scripts/e2e-dice-table.mjs <workerUrl>      env: E2E_STAKE (10), E2E_ROUNDS (2), CAGE_FILE
import './mask-stdio.mjs';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';

const [BASE, ...rest] = process.argv.slice(2);
if (!BASE) throw new Error('usage: e2e-dice-table.mjs <workerUrl>');
const ROUNDS = Number(process.env.E2E_ROUNDS ?? 2);
const STAKE = Number(process.env.E2E_STAKE ?? 50); // tNIGHT per wallet in the cage; the brief's ceiling is 10
const CAGE_FILE = process.env.CAGE_FILE ?? 'deployment.cage4.json';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('logs', { recursive: true });
const LOG = `logs/e2e-dice-table-${stamp}.log`;
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const receipts = [];

function run(file, args, timeoutMs = 600000, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...process.env, CAGE_FILE, ...extraEnv }, timeout: timeoutMs, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`${args.slice(0, 3).join(' ')} failed: ${String(stdout).split('\n').filter((l) => /FAILED|Error/.test(l)).slice(0, 3).join(' | ') || err.message}`), { stdout }));
      else resolve(String(stdout));
    });
  });
}
async function chain(wallet, step, ...args) {
  log(`${wallet} ${step} ${args.join(' ')}`);
  const out = await run('node', ['scripts/cage.mjs', wallet, step, ...args]);
  for (const line of out.split('\n')) {
    const m = /TX (\S+) · hash (\S+) · id (\S+) · block (\S+) · (\S+)/.exec(line);
    if (m) { receipts.push({ wallet, step: `${step} ${args.join(' ')}`.trim(), hash: m[2], block: m[4], result: m[5] }); log(`  TX ${step} hash ${m[2]} block ${m[4]} ${m[5]}`); }
  }
  return out;
}
async function expect(...facts) { return expectWith({}, ...facts); }
async function expectWith({ retrying = false }, ...facts) {
  const out = await run('node', ['scripts/expect.mjs', ...facts], 120000, retrying ? { EXPECT_RETRYING: '1' } : {}).catch((e) => { log(String(e.stdout)); throw new Error(`chain state mismatch: ${facts.join(' ')}`); });
  log(`  checked ${facts.join(' ')}: ${out.includes('all expectations hold') ? 'ok' : 'NOT OK'}`);
}
async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  return { status: res.status, body: await res.json() };
}
const view = async (id) => (await api('GET', `/tables/${id}`)).body;
async function until(what, fn, ms = 600000, every = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`STOP. timed out waiting: ${what}`);
    await sleep(every);
  }
}

const T0 = Date.now();
const mark = () => `+${Math.round((Date.now() - T0) / 1000)}s`;
// One move for a seat: a bid when it can, calling liar once the bid is 2 or more, a cup shown at the count (checkable on the receipt).
async function move(id, token, v) {
  const me = (await api('GET', `/dice-tables/${id}/me`, { token })).body;
  const can = (name) => me.legal?.find((x) => x.action === name);
  let action = null;
  if (can('back')) action = { action: 'back' };
  else if (can('reveal')) action = { action: 'reveal', mode: 'show' };
  else if (can('liar') && (v.bid?.count ?? 0) >= 2) action = { action: 'liar' };
  else if (can('bid')) action = { action: 'bid', ...can('bid').lowest };
  else if (can('liar')) action = { action: 'liar' };
  else if (can('fold')) action = { action: 'fold' };
  if (!action) return false;
  return (await api('POST', `/dice-tables/${id}/act`, { token, body: action })).status === 200;
}
const settledRound = (v, round) => v.cage.receipts.some((r) => r.rounds.includes(round));
const chainNone = async (w) => { try { await expectWith({ retrying: true }, `${w}.seat=none`); return true; } catch { return false; } };
const numbers = [];

async function main() {
  const wallets = ['a', 'b'];
  log(`e2e-dice · worker ${new URL(BASE).host} · wallets ${wallets.join(', ')} · stake ${STAKE} · rounds ${ROUNDS}`);
  const made = await api('POST', '/dice-tables', { body: { tnight: true, lobbySeconds: 2 } });
  if (made.status !== 201) throw new Error(`could not create the table: ${JSON.stringify(made.body)}`);
  const { id } = made.body;
  const T = made.body.state.cage.table;
  const view = async () => (await api('GET', `/dice-tables/${id}`)).body;
  log(`dice table ${id} · cage table ${T}`);

  log('--- deposit');
  await Promise.all(wallets.map((w) => chain(w, 'deposit', String(STAKE))));
  await expect(...wallets.map((w) => `${w}.balance=${STAKE}`));
  log('--- sit');
  for (const w of wallets) await chain(w, 'sit', String(T), String(STAKE));
  await expect(...wallets.flatMap((w) => [`${w}.seat=${T}`, `${w}.atRisk=${STAKE}`]));

  log('--- claim seats');
  const tokens = {};
  const claimedAt = Date.now();
  for (const w of wallets) {
    const proof = JSON.parse((await run('node', ['scripts/cage.mjs', w, 'seat-proof', id])).trim().split('\n').at(-1));
    const r = await api('POST', `/dice-tables/${id}/cage-seat`, { body: { name: `agent-${w}`, kind: 'agent', ...proof } });
    if (r.status !== 202) throw new Error(`claim for ${w}: ${JSON.stringify(r.body)}`);
    tokens[w] = r.body.token;
    log(`  ${w} claimed`);
  }
  for (const w of wallets) {
    const seat = await until(`${w} confirmed by the judge`, async () => {
      const s = (await api('GET', `/dice-tables/${id}/cage-seat`, { token: tokens[w] })).body;
      if (s.status === 'refused') throw new Error(`${w} refused: ${s.reason}`);
      return s.status === 'seated' ? s : null;
    });
    log(`  ${w} seated at ${seat.seat} with ${seat.stack} chips (${Math.round((Date.now() - claimedAt) / 1000)} s after the claim)`);
  }
  await until('the first deal', async () => (await view()).round > 0);
  log(`first deal ${mark()} after the start`);

  log('--- rounds');
  let lastRound = 0;
  const stopAt = Date.now() + 1800000;
  for (;;) {
    if (Date.now() > stopAt) throw new Error('STOP. timed out in the rounds');
    const v = await view();
    if (v.receipt && !numbers.some((n) => n.number === v.receipt.number)) { numbers.push({ number: v.receipt.number, url: v.receipt.url, round: v.round }); log(`  receipt ${v.receipt.number} for round ${v.round} (${v.receipt.url})`); }
    if (v.round !== lastRound) { lastRound = v.round; log(`round ${v.round} dealt (${v.phase})`); }
    // The table deals the next round itself and a settle takes about as long as a round, so "enough rounds" is read from the chain receipts alone.
    if (v.cage.receipts.length >= ROUNDS) break; // the next round is already being played while this one settles, so nothing waits for a quiet table
    if (v.phase === 'over') throw new Error(`the table closed before ${ROUNDS} rounds settled: ${v.overReason}`);
    if (v.phase === 'settled') { await sleep(1500); continue; }
    for (const w of wallets) await move(id, tokens[w], await view());
    await sleep(900);
  }
  const so = await view();
  log(`on chain: ${JSON.stringify(so.cage.receipts.map((r) => ({ rounds: r.rounds, hash: r.hash, block: r.block, chainRound: String(r.chainRound), status: r.status })))}`);
  for (const r of so.cage.receipts) log(`TIMING settle: rounds ${r.rounds} · round end → block ${r.blockAt && r.endedAt ? ((r.blockAt - r.endedAt) / 1000).toFixed(1) + ' s' : '?'} · round end → receipt at the table ${r.at && r.endedAt ? ((r.at - r.endedAt) / 1000).toFixed(1) + ' s' : '?'}`);

  log('--- leave (through the Worker, as the page does)');
  for (const w of wallets) {
    const left = await api('POST', `/dice-tables/${id}/leave`, { token: tokens[w], body: {} });
    log(`  ${w} left: ${JSON.stringify({ status: left.status, amount: left.body.amount, queued: left.body.queued })}`);
  }
  await until('every round on chain', async () => (await view()).cage.unsettled.length === 0, 600000);
  for (const w of wallets) await until(`${w} freed on chain by the judge`, () => chainNone(w), 600000, 15000);
  log(`seats freed ${mark()}`);

  log('--- withdraw');
  const end = await view();
  for (const w of wallets) {
    const seatNo = end.seats.findIndex((q) => q.name === `agent-${w}`);
    const bal = end.cage.seats.find((s) => s.seat === seatNo).balance;
    log(`  ${w}: Worker says cage balance ${bal}`);
    await expect(`${w}.balance=${bal}`);
    if (bal > 0) await chain(w, 'withdraw', String(bal));
    await expect(`${w}.balance=0`, `${w}.seat=none`);
  }

  log('--- receipts against the chain');
  const final = await view();
  const urls = [...new Set([...numbers.map((n) => n.url), ...(final.receipt ? [final.receipt.url] : [])])];
  let failed = 0;
  for (const url of urls) {
    log(`check-receipt ${url}`);
    const out = await run('node', ['scripts/check-receipt.mjs', `${BASE}${url}`], 600000).catch((e) => { failed += 1; return String(e.stdout ?? e.message); });
    for (const line of out.split('\n')) if (line.trim()) log(`  ${line}`);
    if (/FAIL/.test(out)) failed += 1;
  }
  log(`player receipts: ${JSON.stringify(receipts)}`);
  log(`table phase ${final.phase}; receipts checked: ${urls.length}; checks failed: ${failed}`);
  console.log(`\n${failed ? 'RECEIPT CHECK FAILED' : 'DONE'}. table ${id}. log ${LOG}`);
  if (failed) process.exit(1);
}
main().then(() => process.exit(0), (e) => { log(`FAILED: ${e.message}`); log(`player receipts so far: ${JSON.stringify(receipts)}`); process.exit(1); });
