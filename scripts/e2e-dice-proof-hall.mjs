// A proof table, end to end, through the Hall package's own pages on staging and on preprod (11-07): the successor of e2e-dice-proof.mjs,
// which sat through cage #3's circuits by hand. The cage is v4b now: wallet b goes in by the door (the cage page, one deposit and one
// signature), the table page seats it from the cage with nothing to approve, and the judge frees the seat at the end. The dice are the
// chain's: the page makes its seed, seals its cup from the wallet, proves its count or shows its dice, and dice-house (wallet a) does the
// house's side. The judge settles the money as at any table. dice-house must be running.
//   node scripts/e2e-dice-proof-hall.mjs <workerUrl> <sealed-hand worktree> <shots dir>
// Env: E2E_ROUNDS (default 2: cups shut and shown by turns), E2E_STAKE (default 60), E2E_CHROME_ARGS.
// Everything the page sends to the Worker is scanned for this round's seed: the seed must never be in it. Nothing secret is printed.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractModule, DEPLOY_FILE, env, hex, ledgerV, log, NodeZkConfigProvider, openWallet, probeTx, readLedger, receipt, sleep, stop, unhex, WALLET_DIR, ZK } from './dice-chain.mjs';
import * as J from './dice-fair.mjs';
import { bringAtTheCage, chooseTnight, leaveForTheHall, secs, sitFromTheCage, textOf, withdrawAll } from '../sealed-cage-hall-package/scripts/e2e-hall.mjs';

const { httpClientProvingProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
const [BASE, WORKTREE, SHOTS] = process.argv.slice(2);
if (!SHOTS) throw new Error('usage: e2e-dice-proof-hall.mjs <workerUrl> <sealed-hand worktree> <shots dir>');
if (!/^https:\/\/sealed-hand-staging\.[a-z0-9-]+\.workers\.dev$/.test(BASE)) throw new Error('STOP: staging only');
const { chromium } = createRequire(`${WORKTREE}/`)('playwright-core');
const ROUNDS = Number(process.env.E2E_ROUNDS ?? 2);
const STAKE = process.env.E2E_STAKE ?? '60';
mkdirSync(SHOTS, { recursive: true });
const DICE = JSON.parse(readFileSync(DEPLOY_FILE, 'utf8')).address;
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => {});
const checks = [];
const expect = (ok, what) => { checks.push({ ok, what }); log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) process.exitCode = 1; };

async function api(method, path, { body, token } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    } catch (e) {
      if (attempt >= 5) throw e;
      await sleep(3000 * attempt);
    }
  }
}

const W = await openWallet('b');
const address = W.ks.getBech32Address().asString();
const cageKey = readFileSync(`${WALLET_DIR}/b.cage-key`, 'utf8').trim(); // wallet b's usual cage key: the door and the seat go under it

// ---------- the page, with wallet b behind the connector ----------
// Two contracts prove through this one connector: the cage (v4b, the Hall's build) at the door and the withdraw, dice-proof for the cups.
const CAGE_ZK = process.env.CAGE_ZK_DIR ?? '../sealed-cage-hall-package/contracts/managed/sealed-cage';
const DICE_CIRCUITS = new Set(['commitCup', 'proveCount', 'showCup']);
const provers = { dice: httpClientProvingProvider(env.proofServer, new NodeZkConfigProvider(ZK)), cage: httpClientProvingProvider(env.proofServer, new NodeZkConfigProvider(CAGE_ZK)) };
const proverFor = (loc) => (DICE_CIRCUITS.has(loc) ? provers.dice : provers.cage);
const proved = [];
const sent = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: (process.env.E2E_CHROME_ARGS ?? '').split(' ').filter(Boolean) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await context.newPage();
const problems = [];
const toWorker = [];
page.on('pageerror', (e) => { problems.push(e.message); log(`page error: ${e.message.slice(0, 300)}`); });
page.on('console', (m) => { if (m.type() === 'error') log(`console: ${m.text().slice(0, 220)}`); });
page.on('request', (r) => { if (r.url().startsWith(BASE)) toWorker.push(`${r.url()} ${r.postData() ?? ''}`); });
await page.exposeFunction('__state', async () => { const s = await W.wallet.waitForSyncedState(); return { night: String(s.unshielded.balances[ledgerV.unshieldedToken().raw] ?? 0n), dust: String(s.dust.balance(new Date())) }; });
await page.exposeFunction('__keys', async () => ({ coin: String(W.wp.getCoinPublicKey()), enc: String(W.wp.getEncryptionPublicKey()) }));
await page.exposeFunction('__check', async (pre, loc) => (await proverFor(loc).check(unhex(pre), loc)).map((v) => (v === undefined ? null : v.toString())));
await page.exposeFunction('__prove', async (pre, loc, over) => { const t = Date.now(); const out = await proverFor(loc).prove(unhex(pre), loc, over == null ? undefined : BigInt(over)); proved.push({ loc, ms: Date.now() - t, bytes: out.length }); return hex(out); });
await page.exposeFunction('__balance', async (txHex) => { await W.wallet.waitForSyncedState(); const tx = ledgerV.Transaction.deserialize('signature', 'proof', 'pre-binding', unhex(txHex)); return hex((await W.wp.balanceTx(tx)).serialize()); });
await page.exposeFunction('__submit', async (txHex) => {
  const tx = ledgerV.Transaction.deserialize('signature', 'proof', 'binding', unhex(txHex));
  const id = await W.wp.submitTx(tx);
  sent.push(id);
  log(`  sent ${String(id).slice(0, 18)}… (${proved.at(-1)?.loc ?? 'cage'})`);
  (async () => { for (let i = 0; i < 40; i++) { const seen = await probeTx(id); if (seen) { receipt({ label: `page: ${proved.at(-1)?.loc ?? 'cage'}`, circuit: proved.at(-1)?.loc ?? 'cage', wallet: 'b', hash: seen.hash, id, block: seen.block, status: seen.status }); log(`  TX ${seen.hash} block ${seen.block} ${seen.status}`); await W.save(); return; } await sleep(6000); } })();
});
let signs = 0;
await page.exposeFunction('__sign', async (data) => {
  signs += 1;
  const bytes = new TextEncoder().encode(data);
  const signed = new Uint8Array([...new TextEncoder().encode(`midnight_signed_message:${bytes.length}:`), ...bytes]); // what Lace signs
  return { data, signature: W.ks.signData(signed), verifyingKey: W.ks.getPublicKey() };
});
await context.addInitScript(({ addr, http, ws, key }) => {
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
}, { addr: address, http: env.indexer, ws: env.indexerWS, key: cageKey });

// ---------- in by the door, as a person does ----------
const H = { page, base: BASE, log, shot: (name) => shot(page, name) };
await chooseTnight(H);
await bringAtTheCage({ ...H, stake: STAKE, name: 'agent-b' });
const deposits = sent.length;

// A proof table is opened by its link only: the Hall lists none. Two house bots, three seats.
const made = await api('POST', '/dice-tables', { body: { tnight: true, proof: true, bots: 2, seats: 3, lobbySeconds: 0 } });
if (made.status !== 201) throw new Error(`could not open a proof table: ${made.status} ${JSON.stringify(made.body).slice(0, 200)}. Is DICE_PROOF on?`);
const TABLE = made.body.id;
const tableNo = BigInt(made.body.state.cage.table);
log(`proof table ${tableNo} · contract ${DICE.slice(0, 16)}…`);
const view = async () => (await api('GET', `/dice-tables/${TABLE}`)).body;
await page.goto(`${BASE}/dice?id=${TABLE}`);
const token = await sitFromTheCage({ ...H, tableId: TABLE });
log(`seated by the judge · page transactions at the sit: ${sent.length - deposits}, signatures: ${signs}`);
// The sit window stays up to be read, and Tally's first-sit guide follows it: Close and Got it, as a person would, so neither sits over the choices.
await page.click('#waiting-hide').catch(() => {});
await page.waitForTimeout(800);
if (await page.$('#guide-ok')) { log(`Tally's guide: "${await textOf(page, '#guide-title')}"`); await shot(page, 'tally-guide'); await page.click('#guide-ok').catch(() => {}); }
expect(sent.length - deposits === 0, 'the sit sent nothing from the page: the judge seats from the cage');

// ---------- the rounds ----------
const seenStage = new Set();
const stamp = (v) => { const k = `${v.proof?.round}.${v.proof?.stage}`; if (!seenStage.has(k)) { seenStage.add(k); log(`round ${v.proof?.round}: ${v.phase}, ${v.proof?.stage}. ${(v.proof?.alert ?? '')}`); } };
const seedOnPage = (p, seat) => page.evaluate((k) => localStorage.getItem(k), `dice.seed.${p.address}.${p.table}.${p.round}.${seat}`);
let played = 0;
const stopAt = Date.now() + 75 * 60 * 1000;
const done = new Set();
const timings = [];
let roundFrom = Date.now();
while (played < ROUNDS && Date.now() < stopAt) {
  const v = await view();
  stamp(v);
  if (v.phase === 'over') { log(`the table closed: ${v.overReason}`); break; }
  const me = (await api('GET', `/dice-tables/${TABLE}/me`, { token })).body;
  const p = v.proof;
  if (!p) { await sleep(1500); continue; }
  if (v.phase === 'bid' || v.phase === 'duel') {
    if (!done.has(`dice.${p.round}`)) {
      done.add(`dice.${p.round}`);
      expect(me.dice.length === 0, `round ${p.round}: the server has no dice for this seat`);
      const seed = await seedOnPage(p, me.seat);
      expect(!!seed, `round ${p.round}: the seed is on the page`);
      await page.waitForFunction(() => document.querySelectorAll('#my-dice .die').length === 5, null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const onScreen = await page.$$eval('#my-dice .die', (els) => els.length).catch(() => 0);
      expect(onScreen === 5, `round ${p.round}: the page shows five dice the server never had`);
      if (played === 0) { await page.click('#guide-ok').catch(() => {}); }
      await shot(page, `round-${p.round}-bidding`);
    }
  }
  if (v.phase === 'bid') {
    const can = (n) => me.legal?.find((x) => x.action === n);
    let action = null;
    if (can('liar') && (v.bid?.count ?? 0) >= 2) action = { action: 'liar' };
    else if (can('bid')) action = { action: 'bid', ...can('bid').lowest };
    else if (can('liar')) action = { action: 'liar' };
    if (action) await api('POST', `/dice-tables/${TABLE}/act`, { token, body: action });
  } else if (v.phase === 'duel') {
    const reveal = me.legal?.find((x) => x.action === 'reveal');
    if (reveal?.ready && !reveal.folded && !done.has(`answer.${p.round}`)) {
      done.add(`answer.${p.round}`);
      const title = await textOf(page, '#choose-prove .choice-title');
      expect(title === 'Let the chain prove it', `round ${p.round}: the choice promises the chain while it is checking ("${title}")`);
      await shot(page, `round-${p.round}-the-call`);
      const mode = played % 2 === 0 ? 'prove' : 'show';
      log(`round ${p.round}: clicking "${mode}" on the page`);
      await page.waitForSelector(`#choose-${mode}:not([disabled])`, { timeout: 60000 });
      await page.click(`#choose-${mode}`);
    }
  } else if (v.phase === 'settled') {
    const last = v.lastDuel ?? {};
    const r = BigInt(p.round);
    if (!done.has(`checked.${p.round}`)) {
      done.add(`checked.${p.round}`);
      await page.waitForTimeout(1500);
      await shot(page, `round-${p.round}-counted`);
      const L = await readLedger(DICE);
      const id = { table: tableNo, round: r };
      if (L.results.member(id)) {
        const res = L.results.lookup(id);
        log(`round ${p.round}: Worker says total ${last.total}, ${last.held === null ? 'void' : last.held ? 'holds' : 'falls'}. Chain says total ${res.total}, verdict ${res.verdict}, why ${res.why}`);
        expect(Number(res.total) === last.total, `round ${p.round}: the Worker's total is the chain's`);
        expect(last.held === (res.verdict === contractModule.Verdict.holds), `round ${p.round}: the Worker's verdict is the chain's`);
        const seed = await seedOnPage(p, me.seat);
        const salt = L.rounds.lookup(id).salt;
        const mine = J.diceOf(J.rollOf(salt, unhex(seed), me.seat));
        const cup = { ...id, seat: BigInt(me.seat) };
        if (L.answers.member(cup)) {
          const a = L.answers.lookup(cup);
          expect(Number(a.count) === J.countOf(mine, last.bid.face), `round ${p.round}: the count on chain is what this seat's dice make, 1s wild`);
          if (a.shown) expect(a.dice.map(Number).join() === mine.join(), `round ${p.round}: the dice shown on chain are the page's`);
          else expect(a.dice.every((d) => d === 0n), `round ${p.round}: a shut cup: no dice on chain`);
        } else log(`round ${p.round}: settled before this seat had to answer`);
        const sentText = toWorker.join('\n');
        expect(!sentText.includes(seed), `round ${p.round}: of ${toWorker.length} requests to the Worker, none holds the seed`);
        const rec = (await api('GET', `/receipt/${p.table}-${p.round}.json`)).body;
        expect(rec.attested?.length === 0 && !!rec.dice?.tx?.finish, `round ${p.round}: the receipt names the finish transaction, and no count is on the house's word`);
        // every cup that answered is on the receipt as chain-checked; the house's answers carry their transaction hash (dice-house sent them), a
        // player's own answer is the chain's record of the cup (the Worker never sees that transaction: the page sends it from the wallet)
        const proven = rec.proven ?? [];
        expect(proven.length === (rec.reveals ?? []).filter((c) => c.mode !== 'silent').length, `round ${p.round}: every cup that answered is on the receipt as chain-checked (${proven.length})`);
        expect(proven.filter((x) => x.seat !== me.seat).every((x) => !!x.hash), `round ${p.round}: the house's answers carry their proof transaction hashes`);
        const callText = await textOf(page, '#call .call-fair');
        expect(/The chain checked each answer/.test(callText), `round ${p.round}: the page says the chain checked each answer only when it did ("${callText.slice(0, 60)}…")`);
      } else { log(`round ${p.round}: no result on chain yet`); expect(false, `round ${p.round}: the chain has a result for the round`); }
      played += 1;
      timings.push({ round: p.round, ms: Date.now() - roundFrom });
      log(`played ${played} of ${ROUNDS} · ${secs(roundFrom, Date.now())} from the last count`);
      for (let i = 0; i < 100; i++) { const x = await view(); if (x.cage.unsettled.length === 0 && x.cage.receipts.some((e) => e.rounds.includes(x.round))) { const e = x.cage.receipts.find((e) => e.rounds.includes(x.round)); log(`the judge settled round ${x.round}: block ${e.block} · ${e.hash}`); break; } if (i === 99) log('the judge has not settled this round yet'); await sleep(3000); }
      roundFrom = Date.now();
      if (played < ROUNDS) await api('POST', `/dice-tables/${TABLE}/act`, { token, body: { action: 'next' } });
    }
  }
  await sleep(1500);
}
const proofsByCircuit = Object.groupBy(proved, (x) => x.loc);
for (const [c, xs] of Object.entries(proofsByCircuit)) log(`page's proofs, ${c}: ${xs.map((x) => `${(x.ms / 1000).toFixed(1)} s`).join(', ')} · ${xs[0].bytes} bytes`);
expect(problems.length === 0, `no page errors (${problems.length})`);
expect(played === ROUNDS, `${ROUNDS} rounds played and checked (${played})`);

// ---------- leave, and take the money home ----------
let v = await view();
for (let i = 0; i < 200 && v.phase !== 'settled' && v.phase !== 'over'; i++) { await sleep(1500); v = await view(); }
const leave = await leaveForTheHall(H);
const wd = await withdrawAll(H);
log(`CASHOUT Leave → seat freed ${(leave.freedMs / 1000).toFixed(1)} s · Withdraw clicked → landed ${(wd.landedMs / 1000).toFixed(1)} s · cage after: ${wd.left}`);
v = await view();
log(`final: table ${v.phase} (${v.overReason ?? ''}). Receipts ${JSON.stringify(v.cage.receipts.map((r) => ({ rounds: r.rounds, hash: r.hash, block: r.block, status: r.status })))}`);
log(`page transactions sent: ${sent.length} (${deposits} at the door, ${sent.length - deposits} proofs and the withdraw) · signatures: ${signs}`);
await browser.close();
await stop(W);
const failed = checks.filter((c) => !c.ok);
log(`${checks.length - failed.length} of ${checks.length} checks held${failed.length ? `. FAILED: ${failed.map((c) => c.what).join(' | ')}` : ''}`);
console.log(`\nDONE table ${tableNo}`);
process.exit();
