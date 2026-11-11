// A proof table, end to end, on the staging Worker and on preprod. The only stand-in is the wallet: wallet b sits behind the same connector
// API Lace offers, so the page's own contract code runs, proves through the proof server, and what it builds is balanced by wallet b and sent
// to the real chain. The judge settles the money as at any table. dice-house must be running.
//   node scripts/e2e-dice-proof.mjs <workerUrl> <sealed-hand worktree> <shots dir>
// Env: E2E_ROUNDS (default 2: the first keeps the cup shut, the next shows it), E2E_STAKE (default 60).
//
// Its player key is its own (.dice-state/b.player-key), so it doesn't touch what wallet b holds in the cage under its usual key. Everything
// the page sends to the Worker is scanned for this round's seed: the seed must never be in it.
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, CompiledContract, contractModule, env, hex, ledgerV, log, nowSec, NodeZkConfigProvider, openWallet, probeTx, readLedger, receipt, secretFile, sleep, stop, unhex, ZK, DEPLOY_FILE } from './dice-chain.mjs';
import * as J from './dice-fair.mjs';

const { httpClientProvingProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
const [BASE, WORKTREE, SHOTS] = process.argv.slice(2);
if (!SHOTS) throw new Error('usage: e2e-dice-proof.mjs <workerUrl> <sealed-hand worktree> <shots dir>');
// E2E_LOCAL=1: a local wrangler dev of the staging config, with this driver standing in for the judge and no money at all. The dice, the page,
// the wallet and dice-house are all real, on preprod. It's a rehearsal, so the page can be debugged without turning the flag on at staging.
const LOCAL = process.env.E2E_LOCAL === '1';
if (LOCAL ? !/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE) : !/^https:\/\/sealed-hand-staging\.[a-z0-9-]+\.workers\.dev$/.test(BASE)) throw new Error('STOP: staging only');
const { chromium } = createRequire(`${WORKTREE}/`)('playwright-core');
const ROUNDS = Number(process.env.E2E_ROUNDS ?? 2);
const STAKE = BigInt(process.env.E2E_STAKE ?? 60);
const NIGHT = 1_000_000n;
mkdirSync(SHOTS, { recursive: true });
const DICE = JSON.parse(readFileSync(DEPLOY_FILE, 'utf8')).address;
const CAGE = JSON.parse(readFileSync(new URL('../../sealed-cage/deployment.cage3.json', import.meta.url), 'utf8')).address;
const cageDir = new URL('../contracts/managed/sealed-cage', import.meta.url).pathname;
const cageModule = await import('../contracts/managed/sealed-cage/contract/index.js');
const cageCompiled = CompiledContract.make('SealedCage', cageModule.Contract).pipe(CompiledContract.withWitnesses({ secretKey: ({ privateState }) => [privateState, privateState.sk] }), CompiledContract.withCompiledFileAssets(cageDir));
const cageCall = (W, circuit, state, args, label) => call(W, circuit, state, args, label, { address: CAGE, compiledContract: cageCompiled, dir: cageDir });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => {});
const checks = [];
const expect = (ok, what) => { checks.push({ ok, what }); log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) process.exitCode = 1; };

async function api(method, path, { body, token } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
      return { status: res.status, body: await res.json() };
    } catch (e) {
      if (attempt >= 5) throw e;
      await sleep(3000 * attempt);
    }
  }
}

const W = await openWallet('b');
const sk = secretFile('b.player-key');
const cageId = cageModule.pureCircuits.playerId(sk);
const address = W.ks.getBech32Address().asString();
const payout = { bytes: Buffer.from(String(W.ks.getAddress()), 'hex') };

const made = await api('POST', '/dice-tables', { body: { tnight: true, proof: true, bots: 2, seats: 3, lobbySeconds: 0 } });
if (made.status !== 201) throw new Error(`could not open a proof table: ${made.status} ${JSON.stringify(made.body).slice(0, 200)}. Is DICE_PROOF on?`);
const TABLE = made.body.id;
const tableNo = BigInt(made.body.state.cage.table);
log(`proof table ${tableNo} · contract ${DICE.slice(0, 16)}…`);
const view = async () => (await api('GET', `/dice-tables/${TABLE}`)).body;

// The money side is the same as at any table, and the judge's own: deposit, sit, and the judge confirms the seat.
const L0 = await (async () => { const cs = await (await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider')).indexerPublicDataProvider(env.indexer, env.indexerWS).queryContractState(CAGE); return cageModule.ledger(cs.data); })();
const inCage = L0.balance.member(cageId) ? L0.balance.lookup(cageId) : 0n;
if (!LOCAL) {
  if (inCage < STAKE * NIGHT) await cageCall(W, 'deposit', { sk }, [payout, STAKE * NIGHT - inCage], `cage: deposit ${STAKE}`);
  await cageCall(W, 'sit', { sk }, [tableNo, (STAKE - 10n) * NIGHT, nowSec()], `cage: sit at table ${tableNo}`);
}
const message = `sealed-hand:seat:v1|${CAGE}|${TABLE}|${hex(cageId)}`;
const claim = await api('POST', `/dice-tables/${TABLE}/cage-seat`, { body: { name: 'agent-b', kind: 'agent', cageId: hex(cageId), verifyingKey: W.ks.getPublicKey(), signature: W.ks.signData(new TextEncoder().encode(message)) } });
if (claim.status !== 202) throw new Error(`the seat claim was refused: ${claim.status} ${JSON.stringify(claim.body).slice(0, 200)}`);
const token = claim.body.token;
if (LOCAL) { // the judge's part, by hand, on a local Worker with its own made-up token
  const judge = (op, body) => api('POST', `/judge/tables/${TABLE}/${op}`, { token: process.env.E2E_JUDGE_TOKEN, body });
  const star = (n) => String(n * 1_000_000);
  const a = await judge('verified', { cageId: hex(cageId), ok: true, atRiskStar: star(50), balanceStar: star(60), epoch: 1, lastRound: process.env.E2E_LAST_ROUND ?? '0' });
  const b = await judge('house', { cageId: 'e'.repeat(64), atRiskStar: star(60), balanceStar: star(60), epoch: 1 });
  if (a.status !== 200 || b.status !== 200) throw new Error(`local seat: ${a.status} ${b.status}`);
}
for (let i = 0; ; i++) {
  const c = await api('GET', `/dice-tables/${TABLE}/cage-seat`, { token });
  if (c.body.status === 'seated') { log(`the judge seated us at seat ${c.body.seat}, stack ${c.body.stack}`); break; }
  if (c.body.status === 'refused') throw new Error(`the judge refused the seat: ${c.body.reason}`);
  if (i > 120) throw new Error('the judge never answered the seat claim');
  await sleep(3000);
}

// ---------- the page, with wallet b behind the connector ----------
const zk = new NodeZkConfigProvider(ZK);
const prover = httpClientProvingProvider(env.proofServer, zk);
const proved = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await context.newPage();
const problems = [];
const toWorker = [];
page.on('pageerror', (e) => { problems.push(e.message); log(`page error: ${e.message.slice(0, 300)}`); });
page.on('console', (m) => { if (m.type() === 'error') log(`console: ${m.text().slice(0, 220)}`); });
page.on('request', (r) => { if (r.url().startsWith(BASE)) toWorker.push(`${r.url()} ${r.postData() ?? ''}`); });
await page.exposeFunction('__state', async () => { const s = await W.wallet.waitForSyncedState(); return { night: String(s.unshielded.balances[ledgerV.unshieldedToken().raw] ?? 0n), dust: String(s.dust.balance(new Date())) }; });
await page.exposeFunction('__keys', async () => ({ coin: String(W.wp.getCoinPublicKey()), enc: String(W.wp.getEncryptionPublicKey()) }));
await page.exposeFunction('__check', async (pre, loc) => (await prover.check(unhex(pre), loc)).map((v) => (v === undefined ? null : v.toString())));
await page.exposeFunction('__prove', async (pre, loc, over) => { const t = Date.now(); const out = await prover.prove(unhex(pre), loc, over == null ? undefined : BigInt(over)); proved.push({ loc, ms: Date.now() - t, bytes: out.length }); log(`page's proof: ${loc}, ${((Date.now() - t) / 1000).toFixed(1)} s, ${out.length} bytes`); return hex(out); });
await page.exposeFunction('__balance', async (txHex) => { await W.wallet.waitForSyncedState(); const tx = ledgerV.Transaction.deserialize('signature', 'proof', 'pre-binding', unhex(txHex)); return hex((await W.wp.balanceTx(tx)).serialize()); });
await page.exposeFunction('__submit', async (txHex) => {
  const tx = ledgerV.Transaction.deserialize('signature', 'proof', 'binding', unhex(txHex));
  const id = await W.wp.submitTx(tx);
  (async () => { for (let i = 0; i < 40; i++) { const seen = await probeTx(id); if (seen) { receipt({ label: `page: ${proved.at(-1)?.loc}`, circuit: proved.at(-1)?.loc, wallet: 'b', hash: seen.hash, id, block: seen.height, status: seen.status, proveMs: proved.at(-1)?.ms, proofBytes: proved.at(-1)?.bytes, txBytes: tx.serialize().length }); log(`TX from the page · ${proved.at(-1)?.loc} · b · hash ${seen.hash} · block ${seen.height} · ${seen.status}`); await W.save(); return; } await sleep(6000); } })();
});
await context.addInitScript(({ addr, http, ws, key, tableId, seatToken }) => {
  localStorage.setItem(`cage.key.${addr}`, key);
  localStorage.setItem(`hall.seat.${tableId}`, seatToken);
  localStorage.setItem('cage.wallet', 'io.lace.wallet');
  localStorage.setItem('cage.wallet.auto', '1');
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
    signData: async () => { throw new Error('this test signs nothing'); },
  };
  window.midnight = { lace: { name: 'lace', rdns: 'io.lace.wallet', apiVersion: '4.0.1', connect: async () => connected } };
}, { addr: address, http: env.indexer, ws: env.indexerWS, key: hex(sk), tableId: TABLE, seatToken: token });

await page.goto(`${BASE}/dice?id=${TABLE}`);
log('at the table');

const seenStage = new Set();
const stamp = (v) => { const k = `${v.proof?.round}.${v.proof?.stage}`; if (!seenStage.has(k)) { seenStage.add(k); log(`round ${v.proof?.round}: ${v.phase}, ${v.proof?.stage}. ${(v.proof?.alert ?? '')}`); } };
const seedOnPage = (p, seat) => page.evaluate((k) => localStorage.getItem(k), `dice.seed.${p.address}.${p.table}.${p.round}.${seat}`);
let played = 0;
const stopAt = Date.now() + 40 * 60 * 1000;
const done = new Set();
while (played < ROUNDS && Date.now() < stopAt) {
  const v = await view();
  stamp(v);
  if (v.phase === 'over') { log(`the table closed: ${v.overReason}`); break; }
  const me = (await api('GET', `/dice-tables/${TABLE}/me`, { token })).body;
  const p = v.proof;
  if (v.phase === 'bid' || v.phase === 'duel') {
    if (!done.has(`dice.${p.round}`)) {
      done.add(`dice.${p.round}`);
      expect(me.dice.length === 0, `round ${p.round}: the server has no dice for this seat`);
      const seed = await seedOnPage(p, me.seat);
      expect(!!seed, `round ${p.round}: the seed is on the page`);
      const dice = J.diceOf(J.rollOf(unhex(p.salt), unhex(seed), me.seat));
      await page.waitForFunction(() => (document.querySelectorAll('#my-dice .die').length || document.querySelectorAll('#my-dice > *').length) === 5, null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const onScreen = await page.$$eval('#my-dice > *', (els) => els.map((e) => e.getAttribute('aria-label') || e.getAttribute('data-face') || e.className)).catch(() => []);
      log(`round ${p.round}: the page works out its own cup. On screen: ${onScreen.length} dice`);
      expect(onScreen.length === 5, `round ${p.round}: the page shows five dice the server never had`);
      void dice;
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
      await shot(page, `round-${p.round}-the-call`);
      const mode = played === 0 ? 'prove' : 'show';
      log(`round ${p.round}: clicking "${mode}" on the page`);
      await page.waitForSelector(`#choose-${mode}:not([disabled])`, { timeout: 60000 });
      await page.click(`#choose-${mode}`);
    }
  } else if (v.phase === 'settled' || (v.phase === 'seal' && played > 0 && !done.has(`checked.${played}`) && v.lastDuel)) {
    const last = v.lastDuel ?? {};
    const r = BigInt(p.round);
    if (!done.has(`checked.${p.round}`) && v.phase === 'settled') {
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
        const sent = toWorker.join('\n');
        expect(!sent.includes(seed), `round ${p.round}: of ${toWorker.length} requests to the Worker, none holds the seed`);
        const rec = (await api('GET', `/receipt/${p.table}-${p.round}.json`)).body;
        expect(rec.attested?.length === 0 && !!rec.dice?.tx?.finish, `round ${p.round}: the receipt names the finish transaction, and no count is on the house's word`);
      } else log(`round ${p.round}: no result on chain yet`);
      played += 1;
      log(`played ${played} of ${ROUNDS}`);
      for (let i = 0; i < 80 && !LOCAL; i++) { const x = await view(); if (x.cage.unsettled.length === 0 && x.cage.receipts.some((e) => e.rounds.includes(x.round))) { log(`the judge settled round ${x.round}: ${x.cage.receipts.find((e) => e.rounds.includes(x.round)).hash}`); break; } await sleep(4000); }
      if (played < ROUNDS) await api('POST', `/dice-tables/${TABLE}/act`, { token, body: { action: 'next' } });
    }
  }
  await sleep(1500);
}
const proofsByCircuit = Object.groupBy(proved, (x) => x.loc);
for (const [c, xs] of Object.entries(proofsByCircuit)) log(`page's proofs, ${c}: ${xs.map((x) => `${(x.ms / 1000).toFixed(1)} s`).join(', ')} · ${xs[0].bytes} bytes`);
expect(problems.length === 0, `no page errors (${problems.length})`);

// ---------- leave, and take the money home ----------
const left = await api('POST', `/dice-tables/${TABLE}/leave`, { token, body: {} });
log(`left the table: ${left.status}`);
for (let i = 0; i < 120 && !LOCAL; i++) {
  const cs = await (await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider')).indexerPublicDataProvider(env.indexer, env.indexerWS).queryContractState(CAGE);
  const L = cageModule.ledger(cs.data);
  if (!L.seat.member(cageId)) { const bal = L.balance.lookup(cageId); log(`the seat is free. Balance ${Number(bal) / 1e6}`); if (bal > 0n) await cageCall(W, 'withdraw', { sk }, [bal], `cage: withdraw ${Number(bal) / 1e6}`); break; }
  if (i === 119) log('the seat was not freed in time: the money stays in the cage under the run\'s player key');
  await sleep(5000);
}
await browser.close();
await stop(W);
const failed = checks.filter((c) => !c.ok);
log(`${checks.length - failed.length} of ${checks.length} checks held${failed.length ? `. FAILED: ${failed.map((c) => c.what).join(' | ')}` : ''}`);
process.exit();
