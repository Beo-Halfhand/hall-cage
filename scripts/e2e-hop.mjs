// End to end on preprod, the judge-paid path: one wallet at one Worker, against house bots. Run two at once (one per Worker) to test
// one judge serving two Workers (11-10).
//   deposit with a permit → the door → the judge seats it (seatByJudge) → rounds settled on chain → a hop: ask at a second table, leave the
//   first, and the judge moves the seat (seatByJudge with a from-table) → a round there → leave → the judge releases it → withdraw → revoke.
// Every chain step is read back. Stops on any mismatch.
//   node scripts/e2e-hop.mjs <workerUrl> <wallet> [stake tNIGHT, default 20]
import './mask-stdio.mjs';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';

const [BASE, WHO, STAKE_ARG] = process.argv.slice(2);
if (!BASE || !WHO) throw new Error('usage: e2e-hop.mjs <workerUrl> <wallet> [stake]');
const STAKE = Number(STAKE_ARG ?? 20);
const AT_RISK = 10; // tNIGHT a seat
const CAGE_FILE = process.env.CAGE_FILE ?? 'deployment.cage4.json';
const host = new URL(BASE).host;
mkdirSync('logs', { recursive: true });
const LOG = `logs/e2e-hop-${host.split('.')[0]}-${WHO}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
const log = (m) => { const line = `${new Date().toISOString()} [${host.split('.')[0]} ${WHO}] ${m}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const mark = (what, t0) => { const s = Math.round((Date.now() - t0) / 1000); steps.push([what, s]); log(`  ✓ ${what} (${s} s)`); };

function run(args, timeoutMs = 600000, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile('node', args, { env: { ...process.env, CAGE_FILE, ...extraEnv }, timeout: timeoutMs, maxBuffer: 1 << 24 }, (err, stdout) => {
      if (err) reject(Object.assign(new Error(`${args.slice(0, 3).join(' ')} failed: ${String(stdout).split('\n').filter((l) => /FAILED|Error|refus/i.test(l)).slice(0, 3).join(' | ') || err.message}`), { stdout }));
      else resolve(String(stdout));
    });
  });
}
const chainTx = async (step, ...args) => {
  log(`${WHO} ${step} ${args.join(' ')}`);
  const out = await run(['scripts/cage.mjs', WHO, step, ...args]);
  for (const line of out.split('\n')) { const m = /TX (\S+) · hash (\S+) · id \S+ · block (\S+) · (\S+)/.exec(line); if (m) log(`  TX ${step} hash ${m[2]} block ${m[3]} ${m[4]}`); }
  return out;
};
const expect = async (...facts) => {
  await run(['scripts/expect.mjs', ...facts], 180000, { EXPECT_RETRYING: '1' }).catch((e) => { log(String(e.stdout).slice(-800)); throw new Error(`chain state mismatch: ${facts.join(' ')}`); });
  log(`  chain: ${facts.join(' ')} ok`);
};
async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const view = async (id) => (await api('GET', `/tables/${id}`)).body;
async function until(what, fn, ms = 900000, every = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch((e) => { log(`  (${what}: ${e.message})`); return null; });
    if (v) return v;
    if (Date.now() > end) throw new Error(`STOP. timed out waiting: ${what}`);
    await sleep(every);
  }
}

// Plays this seat: the simplest legal move each turn (as e2e-table.mjs), and deals the next round when alone with bots.
async function move(id, token) {
  const me = (await api('GET', `/tables/${id}/me`, { token })).body;
  const can = (name) => me?.legal?.find((x) => x.action === name);
  const pick = (list) => list?.[0]?.claim ?? null;
  const v = await view(id);
  let action = null;
  if (can('back')) action = { action: 'back' };
  else if (v.phase === 'pass' && can('match')) action = { action: 'match' };
  else if (can('stop') && pick(can('stop').truthful)) action = { action: 'stop', claim: pick(can('stop').truthful) };
  else if (can('pass')) action = { action: 'pass', card: me.hand[0], ...(can('pass').match ? { match: true } : {}) };
  else if (v.phase === 'answer' && can('match')) action = { action: 'match' };
  else if (can('claim') && pick(can('claim').truthful)) action = { action: 'claim', claim: pick(can('claim').truthful), ...(can('claim').match ? { match: true } : {}) };
  else if (can('check')) action = { action: 'check', ...(can('check').match ? { match: true } : {}) };
  else if (can('fold')) action = { action: 'fold' };
  if (action) await api('POST', `/tables/${id}/act`, { token, body: action });
}
function play(id, token, { deal = () => true } = {}) {
  const st = { stop: false };
  st.done = (async () => {
    while (!st.stop) {
      try {
        const v = await view(id);
        if (v.phase === 'over') return;
        if (v.phase === 'settled' && deal()) await api('POST', `/tables/${id}/act`, { token, body: { action: 'next' } });
        await move(id, token);
      } catch (e) { log(`  play: ${e.message}`); }
      await sleep(900);
    }
  })();
  return st;
}
const settled = (v, round) => v.cage?.receipts?.some((r) => r.rounds.includes(round));

async function openTable() {
  const made = await api('POST', '/tables', { body: { tnight: true, lobbySeconds: 2, bots: 2 } });
  if (made.status !== 201) throw new Error(`could not open a table: ${made.status} ${JSON.stringify(made.body)}`);
  return { id: made.body.id, T: made.body.state.cage.table };
}
async function ask(id, door) {
  const r = await api('POST', `/tables/${id}/cage-seat`, { body: { doorToken: door, atRiskStar: String(AT_RISK * 1_000_000), name: `hop-${WHO}`, kind: 'agent' } });
  if (r.status !== 202) throw new Error(`ask at ${id.slice(0, 8)}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}
const seated = (id, token, what) => until(what, async () => {
  const s = (await api('GET', `/tables/${id}/cage-seat`, { token })).body;
  if (s?.status === 'refused') throw Object.assign(new Error(`refused: ${s.reason}`), { fatal: true });
  return s?.status === 'seated' ? s : null;
}, 900000, 3000);

async function main() {
  const t0 = Date.now();
  log(`e2e-hop · worker ${host} · wallet ${WHO} · stake ${STAKE} · at risk ${AT_RISK} a seat`);
  const door0 = await api('GET', '/door');
  if (door0.status !== 200) throw new Error(`GET /door: ${door0.status} (tNIGHT off here?)`);
  const cage = JSON.parse(await run(['-e', `console.log(require('fs').readFileSync('${CAGE_FILE}','utf8'))`])).address;
  if (door0.body.address !== cage) throw new Error(`the Worker's cage ${door0.body.address?.slice(0, 12)} is not ${cage.slice(0, 12)}`);

  log('--- deposit, with a permit for the judge');
  await chainTx('deposit', String(STAKE), String(STAKE), '2');
  await expect(`${WHO}.balance=${STAKE}`, `${WHO}.seat=none`);
  mark('deposit with permit', t0);

  log('--- the door');
  const proof = JSON.parse((await run(['scripts/cage.mjs', WHO, 'door-proof', String(Math.floor(Date.now() / 1000) + 3 * 3600)])).trim().split('\n').at(-1));
  const d = await api('POST', '/door', { body: { ...proof, name: `hop-${WHO}`, kind: 'agent' } });
  if (d.status !== 202) throw new Error(`door: ${d.status} ${JSON.stringify(d.body)}`);
  const door = d.body.token;
  const me = await until('the judge to check the door', async () => { const r = (await api('GET', '/door/me', { token: door })).body; if (r?.status === 'refused') throw Object.assign(new Error(`door refused: ${r.reason}`), { fatal: true }); return r?.status === 'verified' ? r : null; });
  log(`  door verified · balance ${Number(me.balanceStar) / 1e6} · permit ok ${me.permit?.ok}`);
  mark('door verified by the judge', t0);

  log('--- table 1: the judge seats us');
  const t1 = await openTable();
  log(`  table 1 ${t1.id.slice(0, 8)}… cage table ${t1.T}`);
  const tok1 = await ask(t1.id, door);
  await seated(t1.id, tok1, 'the judge to seat us at table 1');
  await expect(`${WHO}.seat=${t1.T}`, `${WHO}.atRisk=${AT_RISK}`);
  mark(`seated by the judge at ${t1.T}`, t0);

  log('--- rounds at table 1');
  const p1 = play(t1.id, tok1);
  await until('round 1 settled on chain at table 1', async () => settled(await view(t1.id), 1), 900000);
  mark('round 1 settled at table 1', t0);

  log('--- the hop: ask at table 2, then leave table 1');
  const t2 = await openTable();
  log(`  table 2 ${t2.id.slice(0, 8)}… cage table ${t2.T}`);
  const tok2 = await ask(t2.id, door);
  p1.stop = true; await p1.done;
  const left = await api('POST', `/tables/${t1.id}/leave`, { token: tok1, body: {} });
  log(`  left table 1: ${left.status} ${JSON.stringify({ amount: left.body?.amount, queued: left.body?.queued })}`);
  const hop = await seated(t2.id, tok2, 'the judge to move us to table 2');
  log(`  moved: ${JSON.stringify({ seat: hop.seat, stack: hop.stack })}`);
  await expect(`${WHO}.seat=${t2.T}`);
  mark(`hopped ${t1.T} → ${t2.T}`, t0);
  await until('every round at table 1 on chain', async () => (await view(t1.id)).cage.unsettled.length === 0, 600000);

  log('--- a round at table 2, then leave');
  const p2 = play(t2.id, tok2);
  await until('round 1 settled on chain at table 2', async () => settled(await view(t2.id), 1), 900000);
  p2.stop = true; await p2.done;
  const out = await api('POST', `/tables/${t2.id}/leave`, { token: tok2, body: {} });
  log(`  left table 2: ${out.status} ${JSON.stringify({ amount: out.body?.amount, queued: out.body?.queued })}`);
  await until('every round at table 2 on chain', async () => (await view(t2.id)).cage.unsettled.length === 0, 600000);
  await until('the judge to release us', async () => { try { await run(['scripts/expect.mjs', `${WHO}.seat=none`], 120000, { EXPECT_RETRYING: '1' }); return true; } catch { return false; } }, 600000, 10000);
  mark('released by the judge', t0);

  log('--- cash out');
  const st = await run(['scripts/cage.mjs', WHO, 'state']);
  const line = st.split('\n').find((l) => new RegExp(`^\\s+${WHO}\\s+id`).test(l));
  const bal = Number(/balance ([\d.]+) tNIGHT/.exec(line ?? '')?.[1] ?? NaN);
  if (!Number.isFinite(bal)) throw new Error('could not read the cage balance');
  log(`  cage balance ${bal}`);
  if (bal > 0) await chainTx('withdraw', String(bal));
  await chainTx('deposit', '0').catch((e) => log(`  revoke skipped: ${e.message}`)); // a deposit of 0 with the empty permit takes the permit away
  await expect(`${WHO}.balance=0`, `${WHO}.seat=none`);
  mark('cashed out', t0);

  const r1 = (await view(t1.id)).cage.receipts, r2 = (await view(t2.id)).cage.receipts;
  log(`receipts table ${t1.T}: ${JSON.stringify(r1.map((r) => [r.rounds, r.hash?.slice(0, 16), r.block]))}`);
  log(`receipts table ${t2.T}: ${JSON.stringify(r2.map((r) => [r.rounds, r.hash?.slice(0, 16), r.block]))}`);
  log(`DONE in ${Math.round((Date.now() - t0) / 1000)} s · ${JSON.stringify(steps)} · log ${LOG}`);
}
main().then(() => process.exit(0), (e) => { log(`FAILED: ${e.message}`); process.exit(1); });
