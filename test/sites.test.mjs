// One judge for staging and live (11-10): the allowlist, each Worker's table numbers, and two Workers served in turn from one wallet.
// The real cycle (judge-cycle.mjs) and the real circuits in the simulator, two stand-in Workers, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../scripts/judge-plan.mjs';
import { makeJudge } from '../scripts/judge-cycle.mjs';
import { BACKOFF_MS, MAX_YIELDS, SITES, makeRunner, oneAtATime, ownsTable, parseWorkers, playerWork, stateOf } from '../scripts/judge-sites.mjs';
import { NIGHT, b32, hex, idOf, simChain, simWallet, unhex } from './sim-chain.mjs';

const STAGING = 'https://sealed-hand-staging.halfhand.workers.dev';
const LIVE = 'https://halfhand.app';
const site = (name) => SITES.find((s) => s.site === name);
const T0 = 1_900_000_000n, HOURS12 = 43_200n;

// ---------- the list and the allowlist ----------
test('JUDGE_WORKER_URL: a comma-separated list, live first whatever the order, each with its own token file', () => {
  const s = parseWorkers({ JUDGE_WORKER_URL: ` ${STAGING}/ , ${LIVE} ` });
  assert.deepEqual(s.map((x) => [x.site, x.host, x.tokenFile]), [['live', 'halfhand.app', '.wallets/judge.live-token'], ['staging', 'sealed-hand-staging.halfhand.workers.dev', '.wallets/judge.staging-token']]);
  assert.deepEqual(parseWorkers({ JUDGE_WORKER_URL: STAGING }).map((x) => x.site), ['staging'], 'one Worker still works: today\'s LaunchAgent, unchanged');
  assert.deepEqual(parseWorkers({ JUDGE_WORKER_URL: 'https://sealedhand.halfhand.dev' }).map((x) => [x.site, x.origin]), [['live', 'https://sealedhand.halfhand.dev']], 'live\'s other host is live');
  const files = parseWorkers({ JUDGE_WORKER_URL: `${STAGING},${LIVE}`, JUDGE_TOKEN_FILE: 'a-file,b-file' });
  assert.deepEqual(files.map((x) => [x.site, x.tokenFile]), [['live', 'b-file'], ['staging', 'a-file']], 'JUDGE_TOKEN_FILE follows JUDGE_WORKER_URL\'s order');
  assert.equal(parseWorkers({ JUDGE_WORKER_URL: STAGING, JUDGE_TOKEN_FILE: '.wallets/judge.staging-token' })[0].tokenFile, '.wallets/judge.staging-token', 'today\'s plist: one URL, one token file');
});

test('the allowlist: any other host, scheme, port or path stops the judge at start; so do duplicates and live named twice', () => {
  const refuse = (env, re) => assert.throws(() => parseWorkers(env), re, JSON.stringify(env));
  refuse({}, /not set/);
  refuse({ JUDGE_WORKER_URL: ' , ' }, /not set/);
  refuse({ JUDGE_WORKER_URL: 'https://sealed-hand-preview.halfhand.workers.dev' }, /refusing sealed-hand-preview/);
  refuse({ JUDGE_WORKER_URL: 'https://evil.example' }, /refusing evil\.example/);
  refuse({ JUDGE_WORKER_URL: 'https://halfhand.app.evil.example' }, /refusing/);
  refuse({ JUDGE_WORKER_URL: 'https://x.halfhand.app' }, /refusing/);
  refuse({ JUDGE_WORKER_URL: 'http://halfhand.app' }, /plain https origin/);
  refuse({ JUDGE_WORKER_URL: 'https://halfhand.app:8443' }, /plain https origin/);
  refuse({ JUDGE_WORKER_URL: 'https://halfhand.app/judge' }, /plain https origin/);
  refuse({ JUDGE_WORKER_URL: 'https://user@halfhand.app' }, /plain https origin/);
  refuse({ JUDGE_WORKER_URL: 'http://127.0.0.1:8787' }, /plain https origin/);
  refuse({ JUDGE_WORKER_URL: 'not a url' }, /not a URL/);
  refuse({ JUDGE_WORKER_URL: `${STAGING},${STAGING}/` }, /twice/);
  refuse({ JUDGE_WORKER_URL: `${LIVE},https://sealedhand.halfhand.dev` }, /live twice/);
  refuse({ JUDGE_WORKER_URL: `${STAGING},${LIVE}`, JUDGE_TOKEN_FILE: 'one-file' }, /one each/);
});

test('a throwaway preview stands in for live only when JUDGE_TEST_LIVE names it, with live\'s numbers and place, and never beside live', () => {
  const host = 'judge2-test.halfhand.workers.dev';
  assert.throws(() => parseWorkers({ JUDGE_WORKER_URL: `${STAGING},https://${host}` }), /refusing judge2-test/);
  const s = parseWorkers({ JUDGE_WORKER_URL: `${STAGING},https://${host}`, JUDGE_TEST_LIVE: host });
  assert.deepEqual(s.map((x) => [x.site, x.above, x.upTo, x.tokenFile]), [['test-judge2-test', 1000, Infinity, '.wallets/judge.judge2-test-token'], ['staging', 100, 1000, '.wallets/judge.staging-token']]);
  assert.throws(() => parseWorkers({ JUDGE_WORKER_URL: `${LIVE},https://${host}`, JUDGE_TEST_LIVE: host }), /share table numbers/);
  assert.throws(() => parseWorkers({ JUDGE_WORKER_URL: STAGING, JUDGE_TEST_LIVE: 'evil.example' }), /throwaway preview/);
  assert.throws(() => parseWorkers({ JUDGE_WORKER_URL: STAGING, JUDGE_TEST_LIVE: 'sealed-hand-staging.halfhand.workers.dev' }), /throwaway preview/, 'staging can\'t be made live');
});

test('table numbers: staging owns 101..1000, live 1001 and up, and nothing is owned twice', () => {
  const st = site('staging'), lv = site('live');
  for (const [n, s, l] of [[100, false, false], [101, true, false], [196, true, false], [1000, true, false], [1001, false, true], [4_000_000_000, false, true], [0, false, false], [NaN, false, false], [101.5, false, false]]) {
    assert.equal(ownsTable(st, n), s, `staging ${n}`);
    assert.equal(ownsTable(lv, n), l, `live ${n}`);
  }
});

test('one wallet, one transaction at a time: calls from two Workers at once are run one after the other, and a failure doesn\'t stop the queue', async () => {
  const turn = oneAtATime();
  let running = 0, most = 0;
  const order = [];
  const job = (name, ms, fail) => turn(async () => { running += 1; most = Math.max(most, running); order.push(`${name}+`); await new Promise((r) => setTimeout(r, ms)); order.push(`${name}-`); running -= 1; if (fail) throw new Error(name); return name; });
  const results = await Promise.allSettled([job('live', 15), job('staging', 1, true), job('live2', 1)]);
  assert.equal(most, 1);
  assert.deepEqual(order, ['live+', 'live-', 'staging+', 'staging-', 'live2+', 'live2-']);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('what counts as a person waiting, for live first: a round, a leaver, an ask, a door. Not a house release, a quiet table or a table not its own', () => {
  const r = (o) => ({ cageTable: 1001, status: 'open', entries: [], leaving: [], claims: [], releases: [], ...o });
  assert.equal(playerWork(null), false);
  assert.equal(playerWork({ tables: [r({})] }), false);
  assert.equal(playerWork({ tables: [r({ entries: [{}] })] }), true);
  assert.equal(playerWork({ tables: [r({ leaving: ['x'] })] }), true);
  assert.equal(playerWork({ tables: [r({ claims: [{}] })] }), true);
  assert.equal(playerWork({ tables: [r({ releases: [{ kind: 'player' }] })] }), true);
  assert.equal(playerWork({ tables: [r({ releases: [{ kind: 'house' }] })] }), false);
  assert.equal(playerWork({ tables: [r({ entries: [{}], status: 'dead' })] }), false);
  assert.equal(playerWork({ tables: [r({ entries: [{}], cageTable: 105 })] }, (n) => n > 1000), false);
  assert.equal(playerWork({ tables: [], doors: [{ status: 'pending' }] }), true);
  assert.deepEqual([404, 401, 403, 500, 0].map(stateOf), ['waiting', 'refused', 'refused', 'down', 'down']);
});

// ---------- two Workers on one simulated chain and wallet ----------
const row = (id, n, over = {}) => ({ id, cageTable: n, game: 'sealed-hand', status: 'open', phase: 'lobby', live: false, over: false, wantHouse: false, warm: false, claims: [], holders: [], entries: [], releases: [], house: null, wantBots: 0, ante: 5, lastChainRound: 0, alert: null, done: false, ...over });
const holder = (cageId, over = {}) => ({ cageId, kind: 'player', left: false, epoch: 1, released: false, ...over });
const ask = (cageId, tnight, at = 0) => ({ cageId, at, door: true, ask: { atRiskStar: String(BigInt(tnight) * NIGHT) } });

/** Two stand-in Workers (live, staging) on one chain, one wallet, one journal, served by the real runner. */
function rig({ lines = [], prewarm = 0 } = {}) {
  let now = T0;
  const chain = simChain({ clock: () => now });
  const wallet = simWallet(chain);
  const journal = new Journal(lines);
  const allLines = [...lines];
  const logs = [];
  const log = (m) => logs.push(m);
  const walletTurn = oneAtATime();
  let running = 0, most = 0;
  const callCircuit = (...a) => walletTurn(async () => { running += 1; most = Math.max(most, running); try { const r = await wallet.callCircuit(...a); now += 20n; await hooks.afterCall?.(wallet.sent.at(-1)); return r; } finally { running -= 1; } }); // a transaction takes about 20 s
  const hooks = {};
  const W = {};
  const mkWorker = (name) => {
    const w = { name, tables: [], doors: [], posts: [], down: null, peeks: 0 };
    w.fetch = async (method, path, body) => {
      if (w.down === 'net') throw Object.assign(new Error(`${name} did not answer (ECONNREFUSED)`), { workerDown: true });
      if (typeof w.down === 'number') return { ok: false, status: w.down, body: null };
      if (method === 'GET') return { ok: true, status: 200, body: { address: chain.address, tables: structuredClone(w.tables), doors: w.doors, agents: [], games: ['sealed-hand'] } };
      w.posts.push({ path, body });
      const m = /^\/judge\/tables\/([^/]+)\/(\w+)$/.exec(path);
      const r = m && w.tables.find((x) => x.id === m[1]);
      if (r && m[2] === 'verified') { r.claims = r.claims.filter((c) => c.cageId !== body.cageId); if (body.ok) r.holders.push(holder(body.cageId)); }
      if (r && m[2] === 'released') { r.releases = r.releases.filter((x) => x.cageId !== body.cageId); r.leaving = (r.leaving ?? []).filter((x) => x !== body.cageId); const h = r.holders.find((x) => x.cageId === body.cageId); if (h) h.released = true; }
      if (r && m[2] === 'settled') r.entries = r.entries.filter((e) => !body.seqs.includes(e.seq));
      if (r && m[2] === 'seated') { r.claims = r.claims.filter((c) => c.cageId !== body.cageId); r.holders.push(holder(body.cageId)); }
      return { ok: true, status: 200, body: {} };
    };
    w.post = (suffix) => w.posts.filter((p) => p.path.endsWith(suffix));
    return w;
  };
  W.live = mkWorker('live');
  W.staging = mkWorker('staging');
  const judgeFor = (s) => makeJudge({
    address: chain.address, worker: (...a) => W[s.site].fetch(...a), readChain: async () => chain.state(),
    callCircuit: (c, sk, args, label, onSend, meta) => callCircuit(c, sk, args, `${label} [${s.site}]`, onSend, meta),
    probeTx: async () => null, dustNow: async () => 10n ** 18n,
    journal: journal.forSite(s.site, { legacy: !!s.legacy }),
    record: (r) => { const line = { ...r, site: s.site, at: new Date(Number(now) * 1000).toISOString() }; allLines.push(line); journal.apply(line); },
    log: (m) => log(`[${s.site}] ${m}`), judgeKey: hex(chain.judge.sk), idOf: (k) => hex(idOf(unhex(k))), houseKeyFor: (n) => hex(Buffer.from(String(n).padStart(64, '0').slice(-64), 'hex')),
    payoutOf: () => ({ bytes: b32() }), declaredNow: () => now - 60n,
    checkOpts: () => ({ address: chain.address, addressFromKey: (k) => k, verify: () => true }), prewarm, minDust: 0n,
    clock: () => Number(now) * 1000, owns: (n) => ownsTable(s, n),
  });
  const sites = [site('staging'), site('live')].map((s) => ({ ...s, host: s.hosts[0], judge: judgeFor(s), owns: (n) => ownsTable(s, n), peek: async () => { W[s.site].peeks += 1; const r = await W[s.site].fetch('GET', '/judge/tables'); return r.ok ? r.body : null; } }));
  const runner = makeRunner({ sites, log, clock: () => Number(now) * 1000, setTimer: () => null, clearTimer: () => {} });
  const j = {
    chain, wallet, journal, lines: allLines, logs, W, runner, hooks,
    most: () => most,
    now: () => now, at: (t) => { now = BigInt(t); }, step: (secs) => { now += BigInt(secs); },
    sent: () => wallet.sent.map((x) => `${x.circuit === 'seatByJudge' ? 'seat' : x.circuit}:${/\[(\w+)\]$/.exec(x.label)?.[1]}`),
    round: (n) => { const L = chain.state(); return L.tables.member(BigInt(n)) ? L.tables.lookup(BigInt(n)).lastRound : null; },
    /** Two players seated at cage table n, paying for themselves. */
    pair: (n) => [0, 1].map(() => { const sk = b32(); chain.call(sk, 'deposit', { bytes: b32() }, 100n * NIGHT, new Uint8Array(32), 0n, 0n); chain.call(sk, 'sit', BigInt(n), 100n * NIGHT, now - 60n); return { sk, id: hex(idOf(sk)) }; }),
    player: (tnight = 100n) => { const sk = b32(); chain.call(sk, 'deposit', { bytes: b32() }, tnight * NIGHT, idOf(chain.judge.sk), tnight * NIGHT, now + HOURS12); return { sk, id: hex(idOf(sk)) }; },
    seatOf: (p) => { const L = chain.state(); const k = idOf(p.sk); return L.seat.member(k) ? L.seat.lookup(k) : null; },
  };
  /** A table of two at cage table n with one finished round, on Worker w. */
  j.busy = (w, id, n, seq = 1, over = {}) => {
    const [a, b] = j.pair(n);
    const r = row(id, n, { phase: 'settled', holders: [holder(a.id), holder(b.id)], entries: [{ seq, rounds: [seq], lines: [{ id: a.id, delta: -1 }, { id: b.id, delta: 1 }], at: seq }], ...over });
    W[w].tables.push(r);
    return { r, a, b };
  };
  return j;
}

test('two Workers, one wallet: each Worker\'s rounds settle once, its receipts go back to it alone (even with the same table ids), and a restart settles nothing again', async () => {
  const j = rig();
  const L1 = j.busy('live', 'T1', 1001), S1 = j.busy('staging', 'T1', 101); // the same Worker-side id on purpose: the journal keeps them apart by site
  await j.runner.turn();
  assert.deepEqual(j.sent(), ['settleBatch:live', 'settleBatch:staging'], 'live first');
  assert.deepEqual([j.round(1001), j.round(101)], [1n, 1n]);
  assert.equal(j.W.live.post('/T1/settled').length, 1);
  assert.equal(j.W.staging.post('/T1/settled').length, 1);
  assert.deepEqual(j.W.live.post('/settled')[0].body.seqs, [1]);
  assert.ok(j.W.live.posts.every((p) => !String(p.path).includes('101')) && j.W.staging.posts.every((p) => !JSON.stringify(p.body ?? {}).includes('t1001')));
  assert.ok(j.lines.every((l) => l.site === 'live' || l.site === 'staging'), 'every journal line names its Worker');
  // More rounds on both, then a restart from the journal file: nothing is settled twice.
  L1.r.entries.push({ seq: 2, rounds: [2], lines: [{ id: L1.a.id, delta: 1 }, { id: L1.b.id, delta: -1 }], at: 2 });
  await j.runner.turn();
  assert.deepEqual([j.round(1001), j.round(101)], [2n, 1n]);
  for (let i = 0; i < 3; i++) await j.runner.turn();
  assert.equal(j.wallet.sent.filter((x) => x.circuit === 'settleBatch').length, 3, 'three rounds, three settles, however many turns');
  const again = new Journal(j.lines);
  for (const [name, legacy] of [['live', false], ['staging', true]]) {
    const v = again.forSite(name, { legacy });
    assert.equal(v.unwritten().length, 0);
    assert.equal(v.unresolved().length, 0);
  }
  assert.deepEqual([...again.forSite('live').taken()], ['T1:1', 'T1:2']);
  assert.deepEqual([...again.forSite('staging', { legacy: true }).taken()], ['T1:1']);
  assert.equal(j.most(), 1, 'never two transactions at once');
  assert.ok(S1);
});

test('a table number outside its Worker\'s range is refused and logged once, never settled, seated or released, and no warm table opens beside it', async () => {
  const j = rig({ prewarm: 1 });
  j.busy('staging', 'S1', 105);
  const stray = j.busy('staging', 'S2', 1003, 1, { releases: [] }); // staging numbering into live's range
  const wrong = j.busy('live', 'L9', 150); // and live into staging's
  await j.runner.turn();
  await j.runner.turn();
  assert.equal(j.round(105), 1n);
  assert.equal(j.round(1003), 0n, 'never settled');
  assert.equal(j.round(150), 0n, 'never settled');
  assert.deepEqual(j.sent(), ['settleBatch:staging']);
  assert.equal(j.logs.filter((m) => /\[staging\] table 1003: REFUSED/.test(m)).length, 1, 'logged once, not every cycle');
  assert.equal(j.logs.filter((m) => /\[live\] table 150: REFUSED/.test(m)).length, 1);
  assert.equal(j.W.staging.posts.filter((p) => p.path.includes('/S2/')).length, 0, 'nothing posted about it either');
  assert.equal(j.W.staging.post('/judge/warm').length, 0, 'staging has an open table outside its numbers: no warm table, or one would open every 30 s');
  assert.equal(j.W.live.post('/judge/warm').length, 0);
  // Once the stray is gone, warm tables open again.
  j.W.staging.tables = j.W.staging.tables.filter((r) => r.id !== 'S2');
  j.step(60);
  await j.runner.turn();
  assert.equal(j.W.staging.post('/judge/warm').length, 1);
  assert.ok(stray && wrong);
});

test('a player seated at a staging table who asks at a live one is refused there, and the staging seat is never touched by live', async () => {
  const j = rig();
  const p = j.player(100n);
  j.chain.call(j.chain.judge.sk, 'seatByJudge', unhex(p.id), { is_some: false, value: 0n }, 101n, 10n * NIGHT, j.now() - 60n);
  const [x] = j.pair(101);
  j.W.staging.tables.push(row('S1', 101, { holders: [holder(p.id), holder(x.id)] }));
  j.W.live.tables.push(row('L1', 1001, { claims: [ask(p.id, 10n, 1000)] }));
  await j.runner.turn();
  assert.deepEqual(j.sent(), [], 'no move: table 101 is not live\'s');
  const no = j.W.live.post('/L1/verified')[0].body;
  assert.equal(no.ok, false);
  assert.equal(no.code, 'seated_elsewhere');
  assert.equal(j.seatOf(p).table, 101n);
});

test('one Worker down: the other keeps being served, the down one is retried with backoff, and heartbeats say which is which', async () => {
  const j = rig();
  j.busy('staging', 'S1', 101);
  j.busy('live', 'L1', 1001);
  j.W.live.down = 'net';
  let t = Number(j.now()) * 1000; // live goes first, so it fails before staging's transaction moves the clock
  await j.runner.turn();
  assert.deepEqual(j.sent(), ['settleBatch:staging'], 'staging settled with live unreachable');
  const live = j.runner.sites.find((s) => s.site === 'live'), staging = j.runner.sites.find((s) => s.site === 'staging');
  assert.equal(live.state, 'down');
  assert.equal(live.retryAt - t, BACKOFF_MS[0]);
  assert.ok(j.logs.some((m) => /^\[live\] down: halfhand\.app|^\[live\] down: live did not answer/.test(m)), j.logs.join('\n'));
  j.runner.heartbeat();
  assert.ok(j.logs.some((m) => /^heartbeat site=live host=halfhand\.app state=down lastOkSecs=never/.test(m)));
  assert.ok(j.logs.some((m) => /^heartbeat site=staging host=sealed-hand-staging\.halfhand\.workers\.dev state=ok lastOkSecs=0 tables=1/.test(m)));
  // Within the backoff live isn't asked at all; staging goes on.
  j.busy('staging', 'S2', 102);
  j.at((live.retryAt - 1000) / 1000);
  await j.runner.turn();
  assert.deepEqual(j.sent(), ['settleBatch:staging', 'settleBatch:staging']);
  assert.equal(live.failures, 1, 'not asked inside its backoff');
  // Live's judge routes not on yet (before L2: tNIGHT off, no JUDGE_TOKEN): "waiting", not an error, backing off further.
  j.W.live.down = 404;
  j.at(live.retryAt / 1000);
  t = Number(j.now()) * 1000;
  await j.runner.turn();
  assert.equal(live.state, 'waiting');
  assert.equal(live.failures, 2);
  assert.equal(live.retryAt - t, BACKOFF_MS[1]);
  // Live back: served, its round settles, and the heartbeat says so.
  j.W.live.down = null;
  j.step(40);
  await j.runner.turn();
  assert.equal(live.state, 'ok');
  assert.equal(j.round(1001), 1n);
  assert.ok(j.logs.some((m) => /^\[live\] served \(halfhand\.app\) after 2 failed read/.test(m)));
  j.runner.heartbeat();
  assert.match(j.logs.filter((m) => m.startsWith('heartbeat site=live')).at(-1), /state=ok lastOkSecs=0/);
  // And the other way round: staging down, live goes on.
  j.W.staging.down = 'net';
  j.busy('live', 'L2', 1002);
  j.step(5);
  await j.runner.turn();
  assert.equal(j.round(1002), 1n);
  assert.equal(staging.state, 'down');
});

test('players first on both Workers, live before staging: live\'s leaver, then staging\'s leaver, then staging\'s seat, and the float last', async () => {
  const j = rig();
  const L = j.busy('live', 'L1', 1001);
  const lz = j.pair(1001)[0];
  L.r.holders.push(holder(lz.id, { left: true }));
  L.r.releases = [{ cageId: lz.id, kind: 'player' }];
  L.r.leaving = [lz.id];
  const S = j.busy('staging', 'S1', 101);
  const sz = j.pair(101)[0];
  S.r.holders.push(holder(sz.id, { left: true }));
  S.r.releases = [{ cageId: sz.id, kind: 'player' }];
  S.r.leaving = [sz.id];
  const p = j.player(100n);
  j.W.staging.tables.push(row('S2', 102, { claims: [ask(p.id, 10n, 1000)] }));
  j.W.staging.tables.push(row('S3', 103, { wantHouse: true, warm: true, ante: 5, wantBots: 2 }));
  await j.runner.turn();
  assert.deepEqual(j.sent(), ['settleBatch:live', 'release:live', 'settleBatch:staging', 'release:staging', 'seat:staging'], j.sent().join(' '));
  await j.runner.turn();
  assert.deepEqual(j.sent().slice(5), [], 'a spare warm table\'s float waits for a moment right after a settle, as before');
  S.r.entries.push({ seq: 2, rounds: [2], lines: [{ id: S.a.id, delta: 1 }, { id: S.b.id, delta: -1 }], at: 2 });
  await j.runner.turn();
  assert.deepEqual(j.sent().slice(5), ['settleBatch:staging', 'deposit:staging'], 'then the float, with no person waiting');
  assert.equal(j.seatOf(lz), null);
  assert.equal(j.seatOf(sz), null);
  assert.equal(j.seatOf(p).table, 102n);
});

test('live first: a live round that ends while staging works stops staging after its current transaction, and staging picks up after', async () => {
  const j = rig();
  // Staging: a round, then three leavers on three tables (tail work), all with nothing on live.
  const S = j.busy('staging', 'S1', 101);
  for (const [id, n] of [['S2', 102], ['S3', 103], ['S4', 104]]) {
    const [a, b] = j.pair(n);
    j.W.staging.tables.push(row(id, n, { holders: [holder(a.id, { left: true }), holder(b.id)], releases: [{ cageId: a.id, kind: 'player' }], leaving: [a.id] }));
  }
  const L = { a: null, b: null };
  [L.a, L.b] = j.pair(1001);
  j.W.live.tables.push(row('L1', 1001, { holders: [holder(L.a.id), holder(L.b.id)] }));
  // A live round ends just as staging's first release lands.
  j.hooks.afterCall = (tx) => {
    if (tx.circuit === 'release' && / \[staging\]$/.test(tx.label) && !j.W.live.tables[0].entries.length && j.round(1001) === 0n) {
      j.W.live.tables[0].entries = [{ seq: 1, rounds: [1], lines: [{ id: L.a.id, delta: -1 }, { id: L.b.id, delta: 1 }], at: 1 }];
    }
  };
  await j.runner.turn();
  const order = j.sent();
  assert.deepEqual(order.slice(0, 4), ['settleBatch:staging', 'release:staging', 'settleBatch:live', 'release:staging'], order.join(' '));
  assert.ok(j.logs.some((m) => /^\[staging\] stopping this cycle here: live has a player waiting/.test(m)));
  assert.equal(order.filter((x) => x === 'release:staging').length, 3, 'all three leavers still released in the same turn');
  assert.equal(j.round(1001), 1n);
  assert.ok(S);
});

test('a live table stuck with work can\'t freeze staging: after a few stops in a row staging runs one cycle through', async () => {
  const S = [];
  const calls = [];
  const stuckLive = { tables: [{ cageTable: 1001, status: 'open', entries: [{}], releases: [], claims: [], leaving: [] }] };
  const judge = (name, work) => {
    const me = { preempt: null };
    return { setPreempt: (fn) => { me.preempt = fn; }, cycle: async () => { calls.push(name); for (const step of work) { if (me.preempt && (await me.preempt())) { calls.push(`${name}:stopped`); return { ok: true, preempted: true }; } calls.push(`${name}:${step}`); } return { ok: true, tables: 1 }; } };
  };
  let t = 0;
  S.push({ site: 'live', host: 'halfhand.app', priority: 0, above: 1000, upTo: Infinity, judge: judge('live', []), owns: () => true, peek: async () => stuckLive });
  S.push({ site: 'staging', host: 'staging', priority: 1, above: 100, upTo: 1000, judge: judge('staging', ['release', 'float']), owns: () => true, peek: async () => null });
  const r = makeRunner({ sites: S, log: () => {}, clock: () => (t += 4000), setTimer: () => null, clearTimer: () => {} });
  await r.turn();
  assert.equal(calls.filter((c) => c === 'staging:stopped').length, MAX_YIELDS);
  assert.deepEqual(calls.slice(-3), ['staging', 'staging:release', 'staging:float'], calls.join(' '));
});

test('lines from before 11-10 carry no site and are staging\'s: a receipt owed from them goes to staging, never to live', async () => {
  const at = new Date(Number(T0) * 1000).toISOString();
  const lines = [
    { type: 'intent', batch: 'bold', entries: [{ table: 'T1', cageTable: 101, roundNo: '1', seqs: [1], rounds: [1], lines: [] }], at },
    { type: 'sent', batch: 'bold', id: 'tx0', at },
    { type: 'landed', batch: 'bold', id: 'tx0', hash: 'h0', block: 1, status: 'SucceedEntirely', at },
  ];
  const j = rig({ lines });
  j.W.live.tables.push(row('T1', 1001));
  j.W.staging.tables.push(row('T1', 101));
  await j.runner.turn();
  assert.equal(j.W.staging.post('/T1/settled').length, 1, 'staging gets its receipt');
  assert.equal(j.W.live.post('/settled').length, 0, 'live gets nothing of staging\'s');
  assert.deepEqual([...j.journal.forSite('live').taken()], [], 'and the old round holds nothing on live');
  assert.equal(j.journal.forSite('live').knownRound('T1'), 0n);
  assert.equal(j.journal.forSite('staging', { legacy: true }).knownRound('T1'), 1n);
});

test('shared across Workers, as the chain is: a seat out for a player holds their next one anywhere, and an agent\'s daily loss counts both', () => {
  const at = new Date(Number(T0) * 1000).toISOString();
  const J = new Journal([
    { type: 'seat-intent', op: 's1', kind: 'seat', cageId: 'p1', table: 'T1', to: '101', atRisk: '1', site: 'staging', at },
    { type: 'intent', batch: 'b1', entries: [{ table: 'L1', cageTable: 1001, roundNo: '1', seqs: [1], rounds: [1], lines: [{ id: 'ag', debit: '5', credit: '0' }] }], site: 'live', at },
    { type: 'sent', batch: 'b1', id: 'x', site: 'live', at },
    { type: 'intent', batch: 'b2', entries: [{ table: 'S1', cageTable: 101, roundNo: '1', seqs: [1], rounds: [1], lines: [{ id: 'ag', debit: '3', credit: '0' }] }], at },
    { type: 'sent', batch: 'b2', id: 'y', at },
  ]);
  const live = J.forSite('live'), staging = J.forSite('staging', { legacy: true });
  assert.equal(live.seatOpOut('p1'), true);
  assert.deepEqual(live.seatOpsOut(), [], 'but resolving it is staging\'s');
  assert.equal(staging.seatOpsOut().length, 1);
  assert.equal(live.lossSince('ag', 0), 8n);
  assert.deepEqual([...live.tablesInFlight()], ['L1']);
  assert.deepEqual([...staging.tablesInFlight()], ['S1']);
  assert.equal(live.batches.size, 2, 'the whole journal is still there underneath');
});

test('the health check: each Worker ok only with a fresh state=ok heartbeat; one site stopping is caught while the other runs', async () => {
  const { health } = await import('../scripts/judge-health.mjs');
  const at = (ms) => new Date(Date.UTC(2026, 10, 10, 16, 0, 0) + ms).toISOString();
  const lines = [];
  let ms = 0;
  const S = [
    { site: 'live', host: 'halfhand.app', priority: 0, above: 1000, upTo: Infinity, judge: { cycle: async () => (S[0].down ? { ok: false, status: 404 } : { ok: true, tables: 2 }) }, owns: () => true, peek: async () => null },
    { site: 'staging', host: 'sealed-hand-staging.halfhand.workers.dev', priority: 1, above: 100, upTo: 1000, judge: { cycle: async () => ({ ok: true, tables: 5 }) }, owns: () => true, peek: async () => null },
  ];
  const r = makeRunner({ sites: S, log: (m) => lines.push(`${at(ms)} [0s] ${m}`), clock: () => Date.UTC(2026, 10, 10, 16, 0, 0) + ms, setTimer: () => null, clearTimer: () => {} });
  r.start();
  await r.turn(); ms += 60_000; r.heartbeat();
  let h = health(lines, { now: Date.UTC(2026, 10, 10, 16, 0, 0) + ms + 5000 });
  assert.equal(h.code, 0, h.lines.join('\n'));
  assert.match(h.lines.join('\n'), /serving live, staging/);
  // Live stops being served (404 for ten minutes) while staging runs on.
  S[0].down = true;
  for (let i = 0; i < 10; i++) { ms += 60_000; await r.turn(); r.heartbeat(); }
  h = health(lines, { now: Date.UTC(2026, 10, 10, 16, 0, 0) + ms + 5000 });
  assert.equal(h.code, 1);
  assert.match(h.lines.find((l) => / live /.test(l)), /^NOT  live \(halfhand\.app\) state=waiting/);
  assert.match(h.lines.find((l) => / staging /.test(l)), /^OK   staging/);
  assert.equal(health(lines, { now: Date.UTC(2026, 10, 10, 16, 0, 0) + ms + 5000, expect: ['staging'] }).code, 0, 'before L2, staging alone can be expected');
  // A silent judge (no heartbeats for 15 min) is not ok for either.
  assert.equal(health(lines, { now: Date.UTC(2026, 10, 10, 16, 0, 0) + ms + 900_000, expect: ['staging'] }).code, 1);
  assert.equal(health(['2026-11-10T16:00:00.000Z [0s] judge (ledger 9 build) · worker x']).code, 2, 'an old judge\'s log');
});
