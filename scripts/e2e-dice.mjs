// Cup & Claim on tNIGHT, end to end, on preprod. Variant of e2e-topup.mjs: door → the dice sign in the Hall → sit → rounds → receipts → leave → withdraw.
// Env: E2E_STAKE (deposit if the cage is short, default 60), E2E_ROUNDS (default 2: the first keeps the cup shut, later ones show it), E2E_WALLET (a).
// End to end through the real pages, on preprod. The only stand-in is the wallet: wallet a sits behind the same connector API
// Lace offers, so the page's own contract code runs, proves through the proof server, and the transactions it builds are
// balanced by wallet a and sent to the real chain. Its signature uses Lace's own envelope (midnight_signed_message:<n>:).
// Hall → Bring tNIGHT to the Hall → wallet → deposit → sign once → Hall → Play for tNIGHT → sit (one approval) → first deal on a
// warm table → rounds settled → Leave → withdraw. Prints how long each step took.
//   node scripts/e2e-dice.mjs <workerUrl> <dice worktree> <shots dir>
// Nothing secret leaves this process except the player key, into this run's throwaway browser profile.
import './mask-stdio.mjs';
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import pino from 'pino';
import { runtimePin } from './pin-runtime.mjs';
import { loadEndpoints } from './endpoints.mjs';
void runtimePin;
const [BASE, WORKTREE, SHOTS] = process.argv.slice(2);
if (!SHOTS) throw new Error('usage: e2e-dice.mjs <workerUrl> <dice worktree> <shots dir>');
let TABLE = null;
const ROUNDS = Number(process.env.E2E_ROUNDS ?? 2);
const { HDWallet, Roles, WalletFacade, ShieldedWallet, DustWallet, UnshieldedWallet, createKeystore, PublicKey, NoOpTransactionHistoryStorage, DustAddress } = await import('@midnightntwrk/wallet-sdk');
const ledgerV = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
const { unshieldedToken } = ledgerV;
const { setNetworkId, getNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
const { httpClientProvingProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
const { MidnightWalletProvider } = await import('@midnight-ntwrk/testkit-js');
const { chromium } = createRequire(`${WORKTREE}/`)('playwright-core');

setNetworkId('preprod');
const WHO = process.env.E2E_WALLET ?? 'a';
const STAKE = process.env.E2E_STAKE ?? '60';
const WDIR = '.wallets';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('logs', { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const LOG = `logs/e2e-dice-${stamp}.log`;
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(LOG, `${line}\n`); };
const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (s) => Buffer.from(s, 'hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EP = loadEndpoints();
if (EP.missing.length) throw new Error(`endpoints missing: ${EP.missing.join(', ')}`);
for (const u of [EP.node, EP.indexer, EP.indexerWS]) if (!/preprod/i.test(new URL(u).host)) throw new Error('STOP: an endpoint is not preprod');
const env = { walletNetworkId: 'preprod', networkId: 'preprod', indexer: EP.indexer, indexerWS: EP.indexerWS, node: EP.nodeHttp, nodeWS: EP.node, proofServer: 'http://127.0.0.1:6300', faucet: undefined };
const receipts = [];
let thePage = null;
let signs = 0;

// ---------- wallet a, behind the connector ----------
async function openWallet() {
  const hd = HDWallet.fromSeed(unhex(readFileSync(`${WDIR}/${WHO}.seed`, 'utf8').trim()));
  const keys = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0).keys;
  hd.hdWallet.clear();
  const zswap = ledgerV.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSk = ledgerV.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const ks = createKeystore(keys[Roles.NightExternal], getNetworkId());
  const saved = JSON.parse(readFileSync(`${WDIR}/${WHO}.state.json`, 'utf8'));
  const configuration = { networkId: getNetworkId(), indexerClientConnection: { indexerHttpUrl: env.indexer, indexerWsUrl: env.indexerWS }, provingServerUrl: new URL(env.proofServer), relayURL: new URL(env.nodeWS), txHistoryStorage: new NoOpTransactionHistoryStorage(), costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 } };
  const wallet = await WalletFacade.init({ configuration, shielded: (c) => ShieldedWallet(c).restore(saved.shielded), unshielded: (c) => UnshieldedWallet(c).restore(saved.unshielded), dust: (c) => DustWallet(c).restore(saved.dust) });
  await wallet.start(zswap, dustSk);
  await wallet.waitForSyncedState();
  const wp = await MidnightWalletProvider.withWallet(pino({ level: 'warn' }), env, wallet, zswap, dustSk, ks);
  return { wallet, wp, ks };
}
async function save(w) {
  const file = `${WDIR}/${WHO}.state.json`;
  writeFileSync(`${file}.tmp`, JSON.stringify({ savedAt: new Date().toISOString(), shielded: await w.wallet.shielded.serializeState(), unshielded: await w.wallet.unshielded.serializeState(), dust: await w.wallet.dust.serializeState() }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
async function encodeExtrinsic(tx) {
  const { ApiPromise, HttpProvider } = await import('@polkadot/api');
  const api = await ApiPromise.create({ provider: new HttpProvider(env.node), noInitWarn: true });
  try { return api.tx.midnight.sendMnTransaction(`0x${hex(tx.serialize())}`).toHex(); } finally { try { await api.disconnect(); } catch { /* best effort */ } }
}
function submitExtrinsic(xt) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(env.nodeWS); let done = false;
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch { /* gone */ } fn(v); };
    const timer = setTimeout(() => end(reject, new Error('no reply in 30 s')), 30000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'author_submitExtrinsic', params: [xt] }));
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m?.id !== 1) return; if (m.error) end(reject, new Error(`node rejected: ${m.error.code} ${m.error.message} ${JSON.stringify(m.error.data ?? '')}`)); else end(resolve, m.result); };
    ws.onerror = (ev) => end(reject, new Error(`socket: ${ev?.message ?? 'failed'}`));
  });
}
async function probe(id) {
  const query = `{ transactions(offset:{identifier:"${id}"}) { hash block { height } ... on RegularTransaction { transactionResult { status } } } }`;
  try { const t = (await (await fetch(env.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15000) })).json())?.data?.transactions?.[0]; return t?.block?.height == null ? null : { hash: t.hash, block: t.block.height, status: t.transactionResult?.status }; } catch { return null; }
}

// ---------- the run ----------
async function api(method, path, { body, token } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
      return { status: res.status, body: await res.json() };
    } catch (e) {
      if (attempt >= 5) throw e;
      log(`network hiccup (${e.message}); trying again`);
      await sleep(3000 * attempt);
    }
  }
}
const view = async () => (await api('GET', `/dice-tables/${TABLE}`)).body;
async function move(token, v, showCup) {
  const me = (await api('GET', `/dice-tables/${TABLE}/me`, { token })).body;
  const can = (name) => me.legal?.find((x) => x.action === name);
  let action = null;
  if (can('back')) action = { action: 'back' };
  else if (can('reveal')) action = { action: 'reveal', mode: showCup ? 'show' : 'prove' };
  else if (can('liar') && (v.bid?.count ?? 0) >= 2) action = { action: 'liar' };
  else if (can('bid')) action = { action: 'bid', ...can('bid').lowest };
  else if (can('liar')) action = { action: 'liar' };
  else if (can('fold')) action = { action: 'fold' };
  if (!action) return false;
  return (await api('POST', `/dice-tables/${TABLE}/act`, { token, body: action })).status === 200;
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => {});
const secs = (from, to) => (from && to ? `${((to - from) / 1000).toFixed(1)} s` : '?');
function report(v) {
  const c = v.cage.timings ?? {};
  log('TIMING sit: approved → seat claimed ' + secs(c.approvedAt, c.claimedAt) + ' · claimed → judge seated ' + secs(c.claimedAt, c.seatedAt) + ' · seated → dealt ' + secs(c.seatedAt, c.dealtAt) + ' · APPROVED → FIRST DEAL ' + secs(c.approvedAt, c.dealtAt));
  for (const r of v.cage.receipts) log(`TIMING settle: rounds ${r.rounds} · round end → block ${secs(r.endedAt, r.blockAt)} · round end → receipt at the table ${secs(r.endedAt, r.at)} · block ${r.block} · ${r.hash}`);
}
const statusOf = (page) => page.textContent('#bring-status').catch(() => '');
async function stepNow(page, step, ms) {
  log(`waiting for the page's step: ${step}`);
  try { await page.waitForSelector(`[data-step="${step}"].now`, { timeout: ms }); }
  catch (e) { log(`stuck. Status: ${await statusOf(page)}. Log: ${(await page.textContent('#log').catch(() => '')).slice(0, 400)}. Checks: ${(await page.textContent('#checks').catch(() => '')).slice(0, 400)}`); throw e; }
}

async function main() {
  log(`e2e through the page · ${new URL(BASE).host} · table ${TABLE} · wallet ${WHO}, stake ${STAKE}`);
  const w = await openWallet();
  log('wallet open');
  const address = w.ks.getBech32Address().asString();
  const zk = new NodeZkConfigProvider(new URL('../contracts/managed/sealed-cage', import.meta.url).pathname);
  const prover = httpClientProvingProvider('http://127.0.0.1:6300', zk);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: (process.env.E2E_CHROME_ARGS ?? '').split(' ').filter(Boolean) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const page = await context.newPage();
  thePage = page;
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') log(`console: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => { problems.push(e.message); log(`page error: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) { problems.push(m.text()); log(`CSP: ${m.text().slice(0, 200)}`); } });

  await page.exposeFunction('__state', async () => { const s = await w.wallet.waitForSyncedState(); return { night: String(s.unshielded.balances[unshieldedToken().raw] ?? 0n), dust: String(s.dust.balance(new Date())) }; });
  await page.exposeFunction('__keys', async () => ({ coin: String(w.wp.getCoinPublicKey()), enc: String(w.wp.getEncryptionPublicKey()) }));
  await page.exposeFunction('__check', async (pre, loc) => (await prover.check(unhex(pre), loc)).map((v) => (v === undefined ? null : v.toString())));
  await page.exposeFunction('__prove', async (pre, loc, over) => hex(await prover.prove(unhex(pre), loc, over == null ? undefined : BigInt(over))));
  await page.exposeFunction('__balance', async (txHex) => {
    await w.wallet.waitForSyncedState();
    const tx = ledgerV.Transaction.deserialize('signature', 'proof', 'pre-binding', unhex(txHex));
    return hex((await w.wp.balanceTx(tx)).serialize());
  });
  await page.exposeFunction('__submit', async (txHex) => {
    const tx = ledgerV.Transaction.deserialize('signature', 'proof', 'binding', unhex(txHex));
    const id = String(tx.identifiers().at(-1));
    await submitExtrinsic(await encodeExtrinsic(tx));
    log(`  sent ${id.slice(0, 18)}…`);
    (async () => { for (let i = 0; i < 40; i++) { const seen = await probe(id); if (seen) { receipts.push(seen); log(`  TX hash ${seen.hash} block ${seen.block} ${seen.status}`); await save(w); return; } await sleep(6000); } })();
  });
  await page.exposeFunction('__sign', async (data) => {
    signs += 1;
    const bytes = new TextEncoder().encode(data);
    const signed = new Uint8Array([...new TextEncoder().encode(`midnight_signed_message:${bytes.length}:`), ...bytes]); // what Lace signs
    return { data, signature: w.ks.signData(signed), verifyingKey: w.ks.getPublicKey() };
  });
  await context.addInitScript(({ address: addr, http, ws, key }) => {
    localStorage.setItem(`cage.key.${addr}`, key);
    const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
    const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
    const connected = {
      getConnectionStatus: async () => ({ status: 'connected', networkId: 'preprod' }),
      getUnshieldedAddress: async () => ({ unshieldedAddress: addr }),
      getDustAddress: async () => ({ dustAddress: 'mn_dust_preprod1shim' }),
      getShieldedAddresses: async () => { const k = await window.__keys(); return { shieldedAddress: 'shim', shieldedCoinPublicKey: k.coin, shieldedEncryptionPublicKey: k.enc }; },
      getUnshieldedBalances: async () => ({ ['0'.repeat(64)]: BigInt((await window.__state()).night) }),
      getDustBalance: async () => { const s = await window.__state(); return { balance: BigInt(s.dust), cap: BigInt(s.dust) }; },
      getConfiguration: async () => ({ networkId: 'preprod', indexerUri: http, indexerWsUri: ws, proverServerUri: 'http://localhost:6300', substrateNodeUri: 'https://node.test' }),
      getProvingProvider: async (km) => ({
        check: async (pre, loc) => { await km.getZKIR(loc); return (await window.__check(toHex(pre), loc)).map((v) => (v === null ? undefined : BigInt(v))); },
        prove: async (pre, loc, over) => fromHex(await window.__prove(toHex(pre), loc, over === undefined ? null : over.toString())),
      }),
      balanceUnsealedTransaction: async (tx) => ({ tx: await window.__balance(tx) }),
      submitTransaction: async (tx) => { await window.__submit(tx); },
      signData: async (data) => window.__sign(data),
    };
    window.midnight = { [crypto.randomUUID()]: { name: 'lace', rdns: 'io.lace.wallet', apiVersion: '4.0.1', connect: async () => connected } };
  }, { address, http: EP.indexer, ws: EP.indexerWS, key: readFileSync(`${WDIR}/${WHO}.cage-key`, 'utf8').trim() });

  // The Hall's door: bring tNIGHT once, sign once.
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#menu .menu-item[data-id="cage"]:not([disabled])', { timeout: 30000 });
  log(`Hall says: "${(await page.textContent('#menu .menu-item[data-id="cage"]')).trim()}"`);
  await shot(page, '1-hall');
  await page.click('#menu .menu-item[data-id="cage"]');
  await page.waitForURL(`${BASE}/wallet?door=1`);
  await stepNow(page, 'wallet', 20000);
  await page.click('[data-wallet="io.lace.wallet"]');
  log('wallet chosen');
  await page.waitForSelector('[data-step="deposit"].now, [data-step="door"].now, [data-step="done"].now', { timeout: 120000 });
  await shot(page, '2-at-the-door');
  if (await page.$('[data-step="deposit"].now')) {
    await page.fill('#bring-deposit-amount', STAKE);
    await page.click('#bring-deposit-go');
    log('deposit clicked: the page runs the circuit, proves, balances and sends');
    const t = Date.now();
    await page.waitForSelector('[data-step="door"].now', { timeout: 420000 }).catch(async (e) => { log(`deposit stuck. ${(await page.textContent('#log')).slice(0, 500)}`); throw e; });
    log(`TIMING deposit, from the click: ${secs(t, Date.now())}. ${(await page.textContent('#log li')).slice(0, 160)}`);
  }
  await shot(page, '3-sign-at-the-door');
  await page.fill('#bring-name', `agent-${WHO}`);
  const signAt = Date.now();
  await page.click('#bring-sign-go');
  log("signed at the door, with Lace's envelope; waiting for the judge");
  await page.waitForSelector('[data-step="done"].now', { timeout: 120000 }).catch(async (e) => { log(`door stuck: ${await statusOf(page)}`); throw e; });
  log(`TIMING door, signature → verified: ${secs(signAt, Date.now())}. ${await statusOf(page)}`);
  await shot(page, '4-in-at-the-door');
  await page.click('#bring-to-hall');
  await page.waitForURL(`${BASE}/`);

  // Back in the Hall, the dice sign: a warm tNIGHT table waiting, and one approval.
  // A warm table if the judge keeps one (E2E_WAIT_WARM=1); otherwise a table of our own, where the float comes once a player shows up.
  log(process.env.E2E_WAIT_WARM ? 'waiting for a warm dice table' : 'opening a tNIGHT dice table with two house bots');
  let pick = null;
  for (let i = 0; i < 80 && !pick; i++) {
    const { games } = (await api('GET', '/games')).body;
    pick = games.find((g) => g.id === 'cup-and-claim').tables.find((x) => x.tnight && x.joinable && (x.warm || !process.env.E2E_WAIT_WARM)) ?? null;
    if (!pick && !process.env.E2E_WAIT_WARM) {
      const made = await api('POST', '/dice-tables', { body: { tnight: true, bots: 2, lobbySeconds: 0 } });
      if (made.status !== 201) throw new Error(`could not open a dice table: ${made.status} ${JSON.stringify(made.body).slice(0, 200)}`);
      log(`opened table ${made.body.state.cage.table}`);
      await sleep(1500);
    } else if (!pick) await sleep(5000);
  }
  if (!pick) throw new Error('no dice table on staging');
  TABLE = pick.id;
  await page.goto(`${BASE}/`);
  await page.waitForSelector('[data-game="cup-and-claim"]', { timeout: 30000 });
  await page.waitForSelector('#menu .menu-item[data-id="cage"]:not([disabled])', { timeout: 30000 }); // the greeting has landed: a click before it would be written over
  await page.click('[data-game="cup-and-claim"]');
  await page.waitForSelector('#menu .menu-item[data-id="bring"]:not([disabled])', { timeout: 30000 });
  log(`the dice sign says: "${(await page.textContent('#menu .menu-item[data-id="bring"]')).trim()}"`);
  await shot(page, '5-dice-sign');
  await page.click('#menu .menu-item[data-id="bring"]');
  await page.waitForURL(/\/wallet\?table=[0-9a-f]{64}&game=cup-and-claim/, { timeout: 30000 });
  TABLE = new URL(page.url()).searchParams.get('table');
  const before = await view();
  log(`table ${before.cage.table}, warm: ${before.cage.warm}, seats: ${before.seats.map((x) => `${x.name} ${x.chips}`).join(', ')}`);
  await stepNow(page, 'sit', 120000); // the wallet was approved at the door, so this page reconnects by itself
  await shot(page, '6-sit');
  log(`sit card: ${(await page.textContent('#bring-risk-max')).trim()} | ${(await page.textContent('#bring-add-note')).trim()} | risk box ${await page.inputValue('#bring-risk')}`);
  const sitAt = Date.now();
  const txs1 = receipts.length;
  await page.click('#bring-sit-go');
  log('sit clicked: one approval, no signature');
  await page.waitForURL(`${BASE}/dice?id=${TABLE}*`, { timeout: 420000 }).catch(async (e) => { log(`sit stuck: ${await statusOf(page)} ${(await page.textContent('#log')).slice(0, 500)}`); throw e; });
  log(`TIMING sit: click → at the dice table: ${secs(sitAt, Date.now())}. Page transactions: ${receipts.length - txs1} so far`);
  const token = await page.evaluate((k) => localStorage.getItem(k), `hall.seat.${TABLE}`);
  if (!token) throw new Error('no seat token after the redirect');
  await page.waitForFunction(() => /on the table/.test(document.getElementById('purse-bar')?.textContent ?? ''), null, { timeout: 60000 });
  log(`top bar: ${await page.textContent('#purse-bar')}`);

  for (let i = 0; i < 360; i++) { const x = await view(); if (x.round > 0) break; if (i === 359) throw new Error('no deal'); await sleep(1000); } // a table that isn't warm waits for the float: two transactions
  let v = await view();
  report(v);
  log(`dealt. Receipt ${v.receipt?.number}, fingerprint ${v.receipt?.fingerprint}. Seats: ${v.seats.map((x) => `${x.name} ${x.chips}`).join(', ')}`);
  const posted = (await api('GET', `${v.receipt.url}.json`)).body;
  log(`receipt while the round is in play: status ${posted.status}, opened: ${!!posted.opened}`);
  await page.waitForTimeout(1500);
  await shot(page, '7-at-the-table');
  const numbers = [];
  const stopAt = Date.now() + 1500000;
  let shot8 = false;
  while (Date.now() < stopAt) {
    v = await view();
    if (v.receipt && !numbers.includes(v.receipt.number)) numbers.push(v.receipt.number);
    if (v.phase === 'over') break;
    if (v.phase === 'duel' && !shot8) { const me = (await api('GET', `/dice-tables/${TABLE}/me`, { token })).body; if (me.legal?.some((a) => a.action === 'reveal')) { shot8 = true; await page.waitForTimeout(1600); await shot(page, '8-keep-shut-or-show'); } }
    if (v.phase === 'settled') {
      const roundDone = v.cage.unsettled.length === 0 && v.cage.receipts.some((r) => r.rounds.includes(v.round));
      if (roundDone && v.cage.receipts.length >= ROUNDS) break;
      if (v.cage.unsettled.length === 0) { await api('POST', `/dice-tables/${TABLE}/act`, { token, body: { action: 'next' } }); }
      await sleep(1500);
      continue;
    }
    await move(token, v, v.cage.receipts.length > 0);
    await sleep(900);
  }
  report(v);
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.getElementById('round-receipt')?.scrollIntoView());
  await page.waitForTimeout(400);
  await shot(page, '9-round-panel');
  log(`round panel: ${(await page.textContent('#round-receipt').catch(() => '?')).replace(/\s+/g, ' ').slice(0, 300)}`);

  // Each receipt, as a stranger sees it: the page, its own check, and the JSON.
  const receiptPage = await context.newPage();
  for (const number of numbers) {
    await receiptPage.goto(`${BASE}/receipt/${number}`);
    await receiptPage.waitForSelector('#check-now', { timeout: 30000 });
    await receiptPage.click('#check-now');
    await receiptPage.waitForSelector('#rc-checks li', { timeout: 10000 });
    const lines = await receiptPage.$$eval('#rc-checks li', (x) => x.map((li) => `${li.className}: ${li.textContent}`));
    log(`RECEIPT ${number}: ${(await receiptPage.textContent('#status')).trim()}`);
    for (const l of lines) log(`  ${l}`);
    await receiptPage.screenshot({ path: join(SHOTS, `receipt-${number}.png`), fullPage: true }).catch(() => {});
    log(`RECEIPT-JSON ${number}: ${JSON.stringify((await api('GET', `/receipt/${number}.json`)).body)}`);
  }
  await receiptPage.close();

  // Leave with the page's own button, then withdraw on the page it lands on.
  if (v.phase !== 'over') {
    for (let i = 0; i < 200; i++) { v = await view(); if (v.phase === 'settled') break; await move(token, v, true); await sleep(900); }
    await page.waitForSelector('#leave:not([hidden])', { timeout: 20000 });
    await page.click('#leave');
    log('Leave clicked');
    await page.waitForURL(`${BASE}/wallet`, { timeout: 120000 });
  } else {
    await page.goto(`${BASE}/wallet`);
  }
  log('on the wallet page; waiting for the reconnect and for the judge to free the seat');
  await page.waitForFunction(() => !document.getElementById('withdraw').disabled, null, { timeout: 420000 }).catch(async (e) => { log(`withdraw stayed off. Seat: ${await page.textContent('#cage-seat')}. Balance: ${await page.textContent('#cage-balance')}`); throw e; });
  const balance = await page.textContent('#cage-balance');
  log(`balance in the cage: ${balance}`);
  await shot(page, '10-free-to-withdraw');
  await page.click('#withdraw');
  log('withdraw clicked');
  await page.waitForFunction(() => /Withdraw .*landed/.test(document.getElementById('log').textContent), null, { timeout: 420000 }).catch(async (e) => { log(`withdraw stuck. ${(await page.textContent('#log')).slice(0, 500)}`); throw e; });
  log(`withdraw done: ${(await page.textContent('#log li')).slice(0, 180)}`);
  await sleep(4000);
  await shot(page, '11-withdrawn');
  v = await view();
  report(v);
  log(`final: table ${v.phase} (${v.overReason}). Receipts ${JSON.stringify(v.cage.receipts.map((r) => ({ rounds: r.rounds, hash: r.hash, block: r.block, chainRound: String(r.chainRound), status: r.status })))}`);
  log(`page's own transactions: ${JSON.stringify(receipts)}`);
  log(`problems on the pages: ${problems.length}`);
  await save(w);
  await browser.close();
  await w.wallet.stop();
  console.log(`\nDONE ${LOG}`);
}
main().then(() => process.exit(0), async (e) => {
  log(`FAILED: ${e.message}`);
  if (thePage) {
    for (const id of ['bring-status', 'connect-status', 'checks', 'cage-balance', 'cage-seat', 'progress', 'log', 'stop']) log(`  ${id}: ${(await thePage.textContent(`#${id}`).catch(() => '?')).slice(0, 500)}`);
    await thePage.screenshot({ path: join(SHOTS, 'failed.png') }).catch(() => {});
  } log(`page's own transactions so far: ${JSON.stringify(receipts)}`); process.exit(1); });
