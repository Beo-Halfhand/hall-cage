// dice-house: the house's side of a Cup & Claim proof table, on chain. A long-running wallet, like the judge, and separate from it: the judge
// settles money on the cage, and this posts the seals, the opened seed, the called bid and the bots' answers on dice-proof.
//
// Staging only. It refuses any other Worker. It runs on test wallet a, with a token of its own (.dice-state/house.token, 600) that the Worker
// knows as the secret DICE_HOUSE_TOKEN and that opens nothing but /judge/dice-proof.
//
//   DICE_HOUSE_URL=https://sealed-hand-staging.halfhand.workers.dev node scripts/dice-house.mjs
//
// What it reads from the Worker: each proof table's stage, the house's seed, and the bots' seeds. It never has a player's seed, because the
// Worker doesn't. What it reports back comes from the chain, so a player's answer counts when the chain has it, whatever the page says.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { call as chainCall, contractModule, cupKey, DEPLOY_FILE, hex, log, nowSec, openWallet, readLedger, secretFile, sleep, STATE_DIR, stop, unhex } from './dice-chain.mjs';
import * as J from './dice-fair.mjs';
import { MARGIN, order } from './dice-house-order.mjs';

const { Phase, Verdict, Why, SeatKind } = contractModule;
const BASE = process.env.DICE_HOUSE_URL;
if (!BASE || !/^(https:\/\/sealed-hand-staging\.[a-z0-9-]+\.workers\.dev|http:\/\/127\.0\.0\.1:\d+)$/.test(BASE)) throw new Error('STOP: dice-house runs against the staging Worker only (DICE_HOUSE_URL)');
const POLL_MS = Number(process.env.DICE_HOUSE_POLL_SECS ?? 3) * 1000;
const ONCE = process.env.DICE_HOUSE_ONCE === '1';
const LOCK = `${STATE_DIR}/house.lock`;
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
  if (alive) throw new Error(`dice-house is already running, pid ${pid}`);
}
writeFileSync(LOCK, String(process.pid), { mode: 0o600 });

const ADDRESS = JSON.parse(readFileSync(DEPLOY_FILE, 'utf8')).address;
// A local rehearsal uses a made-up token that means nothing anywhere else.
const TOKEN = /^http:/.test(BASE) ? process.env.DICE_HOUSE_LOCAL_TOKEN : hex(secretFile('house.token'));
const HOUSE_KEY = secretFile('house.key');
const ZERO = new Uint8Array(32);
const name = (e, v) => Object.keys(e).find((k) => e[k] === v);
const wall = () => Math.floor(Date.now() / 1000);
let sent = 0; // transactions tried: one per pass, so the nearest deadline is always the next one served
const call = (...a) => { sent += 1; return chainCall(...a); };

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`the Worker said ${res.status} ${out.error ?? ''} on ${path.split('/').slice(0, 3).join('/')}`);
  return out;
}
const report = (id, body) => api('POST', `/judge/dice-proof/${id}`, body);

function seatsInit(w) {
  return Array.from({ length: 6 }, (_, i) => {
    const s = w.seats[i];
    if (!s) return { kind: SeatKind.empty, holder: ZERO, seal: ZERO };
    if (s.bot) return { kind: SeatKind.house, holder: ZERO, seal: unhex(s.commit) };
    return { kind: SeatKind.player, holder: unhex(s.holder), seal: unhex(s.preseal) };
  });
}
const cupOf = (w, seat) => ({ table: BigInt(w.table), round: BigInt(w.round), seat: BigInt(seat) });
const chainCommits = (L, w) => {
  const out = {};
  for (const s of w.seats) { if (s && L.commits.member(cupOf(w, s.seat))) out[s.seat] = hex(L.commits.lookup(cupOf(w, s.seat))); }
  return out;
};
const lastSealed = new Map();
const firstProving = new Map();

async function step(W, id, w) {
  const rid = { table: BigInt(w.table), round: BigInt(w.round) };
  const tag = (s) => `${w.table}-${w.round} ${s}`;
  const opt = { address: ADDRESS };
  const L = await readLedger(ADDRESS);
  const R = L.rounds.member(rid) ? L.rounds.lookup(rid) : null;
  switch (w.stage) {
    case 'opening': {
      if (R && hex(R.houseCommit) !== w.houseCommit) throw new Error(`round ${w.table}-${w.round} is on chain already, with another seal`);
      const row = R ? null : await call(W, 'openRound', { sk: HOUSE_KEY }, [rid, unhex(w.houseCommit), seatsInit(w), nowSec()], tag('open'), opt);
      const r = (await readLedger(ADDRESS)).rounds.lookup(rid);
      await report(id, { event: 'opened', sealBy: Number(r.sealBy), openBy: Number(r.openBy), callBy: Number(r.callBy), hash: row?.hash ?? null });
      return;
    }
    case 'sealing':
    case 'revealing': {
      if (!R) throw new Error(`round ${w.table}-${w.round} isn't on chain`);
      const commits = chainCommits(L, w);
      const seen = JSON.stringify(commits);
      if (seen !== lastSealed.get(id)) { lastSealed.set(id, seen); await report(id, { event: 'sealed', commits }); }
      let hash = null;
      if (R.phase === Phase.sealing) {
        const everyone = w.seats.filter((s) => s && !s.bot).every((s) => commits[s.seat]);
        // The opened seed is public from the moment this leaves, even if it were refused. So it never leaves while a late seal could still land:
        // everyone has sealed, or block time is safely past the window.
        if (!everyone && wall() < Number(R.sealBy) + 30) return;
        await report(id, { event: 'revealing' });
        hash = (await call(W, 'openHouse', {}, [rid, unhex(w.houseSeed)], tag('open the seed'), opt)).hash;
      }
      const after = await readLedger(ADDRESS);
      const R2 = after.rounds.lookup(rid);
      if (R2.phase === Phase.voided) await report(id, { event: 'revealed', voided: 'too few cups were sealed.', hash });
      else await report(id, { event: 'revealed', salt: hex(R2.salt), houseSeed: hex(R2.houseSeed), commits: chainCommits(after, w), hash });
      return;
    }
    case 'calling': {
      const { bidder, caller, count, face } = w.duel;
      if (R.phase === Phase.dealt && wall() >= Number(R.callBy) - 45) { // the bidding ran past the contract's time for a call. No answers, no dice: every stake goes back.
        if (wall() < Number(R.callBy) + 30) return;
        const row = await call(W, 'voidRound', {}, [rid], tag('void: the call came too late'), opt);
        await report(id, { event: 'finished', verdict: 'voided', why: 'noCall', total: 0, hash: row.hash });
        return;
      }
      const row = R.phase === Phase.dealt ? await call(W, 'callLiar', { sk: HOUSE_KEY }, [rid, BigInt(bidder), BigInt(caller), BigInt(count), BigInt(face), nowSec()], tag(`call: seat ${caller} on seat ${bidder}'s ${count} of ${face}`), opt) : null;
      const r = (await readLedger(ADDRESS)).rounds.lookup(rid);
      await report(id, { event: 'called', houseBy: Number(r.houseBy), answerBy: Number(r.answerBy), hash: row?.hash ?? null });
      return;
    }
    case 'answering': {
      // What the chain has that the Worker hasn't heard.
      const answerOf = (ledger, seat) => { const a = ledger.answers.lookup(cupOf(w, seat)); return { event: 'answer', seat, count: Number(a.count), shown: a.shown, dice: a.shown ? a.dice.map(Number) : null }; };
      for (const s of w.seats) if (s && !s.answered && L.answers.member(cupOf(w, s.seat))) await report(id, { ...answerOf(L, s.seat), hash: null });
      if (R.phase === Phase.called) {
        // The bots first, one each time round, while the house's window is open.
        const bots = w.seats.filter((s) => s?.bot && !L.answers.member(cupOf(w, s.seat)));
        const openWindow = wall() < Number(R.houseBy) - MARGIN; // a proof and a block
        if (bots.length && openWindow) {
          const s = bots[0];
          const cup = cupOf(w, s.seat);
          const seed = unhex(s.seed);
          const dice = J.diceOf(J.rollOf(R.salt, seed, s.seat));
          const state = { seeds: { [cupKey(cup)]: seed } };
          const row = s.mode === 'show'
            ? await call(W, 'showCup', state, [cup, dice.map(BigInt)], tag(`seat ${s.seat} shows`), opt)
            : await call(W, 'proveCount', state, [cup, BigInt(J.countOf(dice, Number(R.bidFace)))], tag(`seat ${s.seat} proves, cup shut`), opt);
          await report(id, { ...answerOf(await readLedger(ADDRESS), s.seat), hash: row.hash });
          return;
        }
        if (bots.length && !openWindow) await report(id, { event: 'house-late' });
        const known = Number(L.totals.lookup(rid).read());
        const pending = Number(R.dealt) - Number(L.answered.lookup(rid).read());
        const settled = known >= Number(R.bidCount) || known + pending * 5 < Number(R.bidCount);
        if (!settled && wall() < Number(R.answerBy) + 5) return;
        // A player's proof that's on its way would make this finish stale, and that costs a fee for nothing. Give it a moment to land.
        const proving = w.seats.filter((x) => x && !x.bot && x.mode && !L.answers.member(cupOf(w, x.seat)));
        if (settled && proving.length && wall() < Number(R.answerBy)) {
          const key = `${id}.${w.round}`;
          if (!firstProving.has(key)) firstProving.set(key, wall());
          if (wall() - firstProving.get(key) < 90) return;
        }
      }
      const row = R.phase === Phase.called ? await call(W, 'finish', {}, [rid], tag('finish'), opt) : null; // a void here is the chain's verdict, like any other
      const after = await readLedger(ADDRESS);
      const res = after.results.lookup(rid);
      for (const s of w.seats) if (s && !s.answered && after.answers.member(cupOf(w, s.seat))) await report(id, { ...answerOf(after, s.seat), hash: null });
      await report(id, { event: 'finished', verdict: name(Verdict, res.verdict), why: name(Why, res.why), total: Number(res.total), hash: row?.hash ?? null });
      log(`${tag('the chain says')} ${name(Verdict, res.verdict)}, ${name(Why, res.why)}, total ${res.total}`);
      return;
    }
    default:
  }
}

let running = true;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { running = false; log(`${sig}: stopping after this step`); });
const W = await openWallet('a');
const L0 = await readLedger(ADDRESS);
if (hex(L0.house) !== hex(J.keyId(HOUSE_KEY))) throw new Error('STOP: this run\'s house key is not the one in the contract');
log(`dice-house · contract ${ADDRESS.slice(0, 16)}… · worker ${new URL(BASE).host} · wallet a`);
const alerted = new Map();
while (running) {
  try {
    const { address, tables } = await api('GET', '/judge/dice-proof');
    if (address !== ADDRESS) throw new Error('STOP: the Worker names another contract');
    for (const { id, work } of order(tables, wall())) {
      const before = sent;
      try {
        await step(W, id, work);
        if (alerted.get(id)) { alerted.delete(id); await report(id, { event: 'alert', message: null }); }
      } catch (e) {
        const m = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);
        log(`table ${work.table}, round ${work.round}, ${work.stage}: ${m}`);
        if (alerted.get(id) !== m) { alerted.set(id, m); await report(id, { event: 'alert', message: m }).catch(() => {}); }
        if (/^STOP/.test(m)) running = false;
      }
      if (sent > before || !running) break; // one transaction, then ask again: what's nearest may have changed
    }
  } catch (e) {
    log(`poll: ${String(e?.message ?? e).slice(0, 200)}`);
    if (/^STOP/.test(String(e?.message))) running = false;
  }
  if (ONCE) break;
  await sleep(POLL_MS);
}
await stop(W);
rmSync(LOCK, { force: true });
log('stopped');
process.exit();
