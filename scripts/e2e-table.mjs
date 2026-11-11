// End to end on preprod against a running Worker and judge service, using agent wallets a and b.
// deposit → sit → claim → rounds settled on chain → stand → withdraw. Every chain step reads state back. Stops on any mismatch.
//   node scripts/e2e-table.mjs <workerUrl> [--bots n] [--single]
// --bots n: wallet a alone against n house bots. Otherwise a and b play each other.
import './mask-stdio.mjs';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';

const [BASE, ...rest] = process.argv.slice(2);
if (!BASE) throw new Error('usage: e2e-table.mjs <workerUrl> [--bots n]');
const botsAt = rest.indexOf('--bots');
const BOTS = botsAt >= 0 ? Number(rest[botsAt + 1]) : 0;
const STAKE = Number(process.env.E2E_STAKE ?? 50); // tNIGHT per wallet in the cage; the brief's ceiling is 10
const CAGE_FILE = process.env.CAGE_FILE ?? 'deployment.cage4.json';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('logs', { recursive: true });
const LOG = `logs/e2e-${stamp}.log`;
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

// One move for a seat, by the rules since claim-raise: a truthful claim as the passing stops, or a truthful claim in the lap;
// otherwise pass, check, match what it must, and fold what it can't. Round 3 puts a raise on the table.
const raised = new Set();
async function move(id, token, v) {
  const me = (await api('GET', `/tables/${id}/me`, { token })).body;
  const can = (name) => me.legal?.find((x) => x.action === name);
  const pick = (list) => list?.[0]?.claim ?? null;
  let action = null;
  if (can('back')) action = { action: 'back' };
  else if (can('pass')?.raise && v.round === 3 && v.passNo === 1 && me.seat === v.starter && !raised.has(v.round)) { action = { action: 'pass', card: me.hand[0], raise: 1 }; raised.add(v.round); }
  else if (v.phase === 'pass' && can('match')) action = { action: 'match' };
  else if (can('stop') && pick(can('stop').truthful)) action = { action: 'stop', claim: pick(can('stop').truthful) };
  else if (can('pass')) action = { action: 'pass', card: me.hand[0], ...(can('pass').match ? { match: true } : {}) };
  else if (v.phase === 'answer' && can('match')) action = { action: 'match' };
  else if (can('claim') && pick(can('claim').truthful)) action = { action: 'claim', claim: pick(can('claim').truthful), ...(can('claim').match ? { match: true } : {}) };
  else if (can('check')) action = { action: 'check', ...(can('check').match ? { match: true } : {}) };
  else if (can('fold')) action = { action: 'fold' }; // a raise this seat can't match
  if (!action) return false;
  return (await api('POST', `/tables/${id}/act`, { token, body: action })).status === 200;
}

// The agents keep their seats alive for the whole run. The turn clock is 15 s and a settle takes longer than that,
// so nothing here may sit idle waiting for the chain. A new round deals itself after the table's 30 s gap, unless asked for.
function startAgents(id, seats) {
  const state = { stop: false, active: [...seats], lastRound: 0 };
  state.done = (async () => {
    while (!state.stop) {
      try {
        const v = await view(id);
        if (v.phase === 'over') return;
        if (v.round !== state.lastRound) { state.lastRound = v.round; log(`round ${v.round} dealt`); }
        if (v.phase === 'settled' && BOTS) await api('POST', `/tables/${id}/act`, { token: state.active[0], body: { action: 'next' } }); // alone with bots, the table has no clock
        for (const token of state.active) await move(id, token, await view(id));
      } catch (e) { log(`agent loop: ${e.message}`); }
      await sleep(800);
    }
  })();
  return state;
}
const settled = (v, round) => v.cage.receipts.some((r) => r.rounds.includes(round));
const chainNone = async (w) => { try { await expectWith({ retrying: true }, `${w}.seat=none`); return true; } catch { return false; } };

async function main() {
  const wallets = BOTS ? ['a'] : ['a', 'b'];
  log(`e2e · worker ${new URL(BASE).host} · wallets ${wallets.join(', ')} · bots ${BOTS} · stake ${STAKE}`);
  const made = await api('POST', '/tables', { body: { tnight: true, lobbySeconds: 2, ...(BOTS ? { bots: BOTS } : {}) } });
  if (made.status !== 201) throw new Error(`could not create the table: ${JSON.stringify(made.body)}`);
  const { id } = made.body;
  const T = made.body.state.cage.table;
  log(`table ${id} · cage table ${T}`);

  log('--- deposit');
  await Promise.all(wallets.map((w) => chain(w, 'deposit', String(STAKE))));
  await expect(...wallets.map((w) => `${w}.balance=${STAKE}`));
  log('--- sit');
  for (const w of wallets) await chain(w, 'sit', String(T), String(STAKE));
  await expect(...wallets.flatMap((w) => [`${w}.seat=${T}`, `${w}.atRisk=${STAKE}`]));

  log('--- a seat with no proof, and a stolen id, are refused');
  const thief = await api('POST', `/tables/${id}/cage-seat`, { body: { name: 'thief', kind: 'agent', ...JSON.parse((await run('node', ['scripts/cage.mjs', 'b', 'seat-proof', id])).trim().split('\n').at(-1)), cageId: JSON.parse((await run('node', ['scripts/cage.mjs', 'a', 'seat-proof', id])).trim().split('\n').at(-1)).cageId } });
  log(`  b's key claiming a's seat: ${thief.status}`);
  const refused = await until("the judge's answer to the stolen id", async () => { const s = (await api('GET', `/tables/${id}/cage-seat`, { token: thief.body.token })).body; return s.status === 'pending' ? null : s; });
  log(`  answer: ${refused.status}: ${refused.reason}`);
  if (refused.status !== 'refused') throw new Error('a stolen cage id was seated');

  log('--- claim seats');
  const tokens = {};
  for (const w of wallets) {
    const proof = JSON.parse((await run('node', ['scripts/cage.mjs', w, 'seat-proof', id])).trim().split('\n').at(-1));
    const r = await api('POST', `/tables/${id}/cage-seat`, { body: { name: `agent-${w}`, kind: 'agent', ...proof } });
    if (r.status !== 202) throw new Error(`claim for ${w}: ${JSON.stringify(r.body)}`);
    tokens[w] = r.body.token;
    log(`  ${w} claimed; ${(await view(id)).seats.length} seats dealt in so far`);
  }
  for (const w of wallets) {
    const seat = await until(`${w} confirmed by the judge`, async () => {
      const s = (await api('GET', `/tables/${id}/cage-seat`, { token: tokens[w] })).body;
      if (s.status === 'refused') throw new Error(`${w} refused: ${s.reason}`);
      return s.status === 'seated' ? s : null;
    });
    log(`  ${w} seated at ${seat.seat} with ${seat.stack} chips`);
  }
  await until('the first deal', async () => (await view(id)).round > 0 || (await view(id)).phase !== 'lobby');

  log('--- rounds');
  const agents = startAgents(id, wallets.map((w) => tokens[w]));
  await until('rounds 1, 2 and 3 on chain, or the table played out', async () => { const x = await view(id); return (settled(x, 1) && settled(x, 2) && settled(x, 3)) || (BOTS && x.phase === 'over' && x.cage.unsettled.length === 0); }, 900000);
  const so = await view(id);
  log(`on chain so far: ${JSON.stringify(so.cage.receipts.map((r) => [r.rounds, r.hash.slice(0, 12), r.block, String(r.chainRound)]))}`);

  log('--- stand');
  if (so.phase !== 'over') await chain('a', 'stand', String(T));
  else log('  the table has already played out; the judge frees the seat');
  if (wallets.length === 2) {
    log('  a called stand on chain with the table still playing');
    await until('the Worker to have a out', async () => (await view(id)).seats.find((s) => s.name === 'agent-a').left, 300000);
    agents.active = [tokens.b];
    const out = await view(id);
    log(`a is out after round ${out.round}: left with ${out.seats.find((s) => s.name === 'agent-a').leftWith}; ${out.cage.unsettled.length} rounds unsettled`);
    await until('every round on chain', async () => (await view(id)).cage.unsettled.length === 0, 600000);
    await until('a freed on chain', () => chainNone('a'), 300000, 15000);
    agents.stop = true;
    await agents.done;
    // b leaves through the Worker only: the judge frees the seat with release.
    const left = await api('POST', `/tables/${id}/leave`, { token: tokens.b, body: {} });
    log(`b left through the Worker: ${JSON.stringify({ status: left.status, amount: left.body.amount, queued: left.body.queued })}`);
    await until('every round on chain', async () => (await view(id)).cage.unsettled.length === 0, 600000);
    await until('b freed on chain by the judge', () => chainNone('b'), 300000, 15000);
  } else {
    await until('the Worker to have a out', async () => (await view(id)).seats.find((s) => s.name === 'agent-a').left || (await view(id)).phase === 'over', 300000);
    agents.stop = true;
    await agents.done;
    await until('every round on chain', async () => (await view(id)).cage.unsettled.length === 0, 600000);
    await until('a freed on chain', () => chainNone('a'), 300000, 15000);
  }

  log('--- withdraw');
  const end = await view(id);
  for (const w of wallets) {
    const seatNo = end.seats.findIndex((q) => q.name === `agent-${w}`);
    const bal = end.cage.seats.find((s) => s.seat === seatNo).balance;
    log(`  ${w}: Worker says cage balance ${bal}`);
    await expect(`${w}.balance=${bal}`);
    if (bal > 0) await chain(w, 'withdraw', String(bal)); // the contract refuses a withdraw of nothing
    await expect(`${w}.balance=0`, `${w}.seat=none`);
  }

  log('--- result');
  const final = await view(id);
  log(`table phase ${final.phase} (${final.overReason}). Receipts: ${JSON.stringify(final.cage.receipts.map((r) => ({ rounds: r.rounds, hash: r.hash, block: r.block, chainRound: r.chainRound, status: r.status, lines: r.lines.map((l) => [l.id.slice(0, 8), l.delta]) })))}`);
  log(`player receipts: ${JSON.stringify(receipts)}`);
  log(`log lines: ${JSON.stringify(final.log.filter((l) => l.receipt).map((l) => l.text))}`);
  console.log(`\nDONE. table ${id}. log ${LOG}`);
}
main().then(() => process.exit(0), (e) => { log(`FAILED: ${e.message}`); log(`player receipts so far: ${JSON.stringify(receipts)}`); process.exit(1); });
