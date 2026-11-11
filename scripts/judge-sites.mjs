// One judge for staging and live (11-10). One process, one wallet, the Workers taken in turn, live first. No network here:
// judge.mjs supplies each Worker's judge (judge-cycle.mjs) and its peek, and tests run this against two stand-in Workers.
//
//   - The allowlist is in this file: exactly the staging Worker and live (halfhand.app, or sealedhand.halfhand.dev: the same Worker,
//     so never both). Any other host stops the judge at start.
//   - Each Worker owns a range of table numbers, from its CAGE_TABLE_BASE: staging 101..1000, live 1001 and up. A table outside its
//     Worker's range is refused and logged, never settled.
//   - Live comes first: its cycle runs first in every turn, and between staging's transactions (after staging's settles) a live player
//     waiting stops staging's cycle there. One wallet means one transaction at a time either way.
//   - A Worker that doesn't answer is backed off and logged; the other keeps being served. A heartbeat line per Worker every minute.

/** The Workers this judge may serve. `above`/`upTo`: the table numbers each owns (CAGE_TABLE_BASE + 1 and up). */
export const SITES = Object.freeze([
  { site: 'live', hosts: ['halfhand.app', 'sealedhand.halfhand.dev'], above: 1000, upTo: Infinity, priority: 0, tokenFile: '.wallets/judge.live-token' },
  { site: 'staging', hosts: ['sealed-hand-staging.halfhand.workers.dev'], above: 100, upTo: 1000, priority: 1, tokenFile: '.wallets/judge.staging-token', legacy: true },
]);

/** A throwaway preview may stand in for live in a test (JUDGE_TEST_LIVE=<its host>): never in the LaunchAgent. */
const STANDIN_HOST = /^[a-z0-9-]{1,63}\.halfhand\.workers\.dev$/;

/**
 * JUDGE_WORKER_URL (comma-separated) → the sites to serve, live first. Throws on anything not on the allowlist, a Worker named twice,
 * live named by both its hosts, or a token-file list that doesn't match. env: JUDGE_WORKER_URL, JUDGE_TOKEN_FILE, JUDGE_TEST_LIVE.
 */
export function parseWorkers(env = {}) {
  const raw = String(env.JUDGE_WORKER_URL ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!raw.length) throw new Error('JUDGE_WORKER_URL is not set');
  const standin = env.JUDGE_TEST_LIVE ? String(env.JUDGE_TEST_LIVE).trim().toLowerCase() : null;
  if (standin && (!STANDIN_HOST.test(standin) || SITES.some((s) => s.hosts.includes(standin)))) throw new Error('JUDGE_TEST_LIVE must be a throwaway preview host on halfhand.workers.dev');
  const out = raw.map((u) => {
    let url;
    try { url = new URL(u); } catch { throw new Error(`JUDGE_WORKER_URL: "${u.slice(0, 80)}" is not a URL`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error(`JUDGE_WORKER_URL: ${url.host} must be a plain https origin`);
    const host = url.hostname.toLowerCase();
    const known = SITES.find((s) => s.hosts.includes(host));
    if (known) return { ...known, host, origin: `https://${host}` };
    if (standin && host === standin) {
      const live = SITES.find((s) => s.site === 'live');
      const label = host.split('.')[0];
      return { ...live, hosts: [host], site: `test-${label}`, host, origin: `https://${host}`, tokenFile: `.wallets/judge.${label}-token`, standin: true };
    }
    throw new Error(`JUDGE_WORKER_URL: refusing ${host}; this judge serves only ${SITES.flatMap((s) => s.hosts).join(', ')}`);
  });
  if (new Set(out.map((s) => s.host)).size !== out.length) throw new Error('JUDGE_WORKER_URL names a Worker twice');
  if (new Set(out.map((s) => s.site)).size !== out.length) throw new Error('JUDGE_WORKER_URL names live twice (halfhand.app and sealedhand.halfhand.dev are one Worker)');
  for (const a of out) for (const b of out) if (a !== b && a.above < b.upTo && b.above < a.upTo) throw new Error(`${a.host} and ${b.host} would share table numbers`);
  if (env.JUDGE_TOKEN_FILE) {
    const files = String(env.JUDGE_TOKEN_FILE).split(',').map((x) => x.trim()).filter(Boolean);
    if (files.length !== out.length) throw new Error(`JUDGE_TOKEN_FILE names ${files.length} file(s) for ${out.length} Worker(s): one each, in the same order, or leave it unset`);
    files.forEach((f, i) => { out[i].tokenFile = f; });
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/** One wallet, one transaction at a time, whichever Worker asked: a second build would race the first for the same DUST. */
export function oneAtATime() {
  let queue = Promise.resolve();
  return (fn) => { const run = queue.then(() => fn()); queue = run.catch(() => {}); return run; };
}

export const ownsTable = (site, n) => Number.isInteger(n) && n > site.above && n <= site.upTo;

/** Whether a Worker's table list has a person waiting on the judge: a round to settle, someone leaving, a seat or move, a door. */
export function playerWork(body, owns = () => true) {
  if (!body) return false;
  if ((body.doors ?? []).some((d) => d.status === 'pending')) return true;
  for (const r of body.tables ?? []) {
    if (r.status !== 'open' || !owns(Number(r.cageTable))) continue;
    if (r.entries?.length || r.leaving?.length || r.claims?.length) return true;
    if ((r.releases ?? []).some((x) => x.kind !== 'house')) return true;
  }
  return false;
}

/** How a failed table-list read reads in the log and the heartbeat. */
export function stateOf(status) {
  if (status === 404) return 'waiting'; // the judge routes are off there: TNIGHT_TABLES off or no JUDGE_TOKEN secret yet
  if (status === 401 || status === 403) return 'refused'; // the token doesn't match the Worker's JUDGE_TOKEN
  return 'down';
}

export const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000];
export const PEEK_EVERY_MS = 3_000;
export const MAX_YIELDS = 3; // a lower Worker stops for a higher one this many cycles running, then runs one through, so a stuck live table can't freeze staging

/**
 * sites: [{ site, host, priority, judge: { cycle() }, peek: async () => body | null, owns(n) }]. One turn serves each Worker once, live first;
 * a cycle stopped for live starts the turn again from live. Heartbeats: `heartbeat site=… host=… state=… lastOkSecs=…`, one per Worker per minute.
 */
export function makeRunner({ sites, log, clock = Date.now, heartbeatMs = 60_000, setTimer = setInterval, clearTimer = clearInterval }) {
  const S = [...sites].sort((a, b) => a.priority - b.priority).map((s) => ({ ...s, state: 'starting', lastOkAt: null, retryAt: 0, failures: 0, cycles: 0, tables: null, inCycleSince: null, lastNote: 0, yields: 0, peeked: null, peekedAt: 0, lastError: null }));
  const say = (s, m) => log(`[${s.site}] ${m}`);
  async function peekWork(s) {
    if (s.state !== 'ok' || clock() < s.retryAt) return false;
    if (clock() - s.peekedAt >= PEEK_EVERY_MS) { s.peekedAt = clock(); s.peeked = await s.peek().catch(() => null); }
    return playerWork(s.peeked, s.owns);
  }
  const preemptFor = (i) => async () => {
    const s = S[i];
    if (s.yields >= MAX_YIELDS) return false;
    for (const higher of S.slice(0, i)) {
      if (await peekWork(higher)) { s.yields += 1; say(s, `stopping this cycle here: ${higher.site} has a player waiting`); return true; }
    }
    return false;
  };
  function failed(s, state, why) {
    s.failures += 1;
    s.retryAt = clock() + BACKOFF_MS[Math.min(s.failures, BACKOFF_MS.length) - 1];
    const changed = s.state !== state;
    s.state = state; s.lastError = why;
    if (changed || clock() - s.lastNote >= 10 * 60_000) { s.lastNote = clock(); say(s, `${state}: ${why}; the other Worker(s) keep going; trying ${s.host} again in ${Math.round((s.retryAt - clock()) / 1000)} s`); }
  }
  async function serve(i) {
    const s = S[i];
    s.inCycleSince = clock();
    try {
      const r = (await s.judge.cycle()) ?? { ok: true };
      s.cycles += 1;
      if (r.ok) {
        if (s.state !== 'ok') say(s, `served (${s.host})${s.failures ? ` after ${s.failures} failed read(s)` : ''}`);
        Object.assign(s, { state: 'ok', lastOkAt: clock(), failures: 0, retryAt: 0, lastError: null, tables: r.tables ?? s.tables });
        if (!r.preempted) s.yields = 0;
        return r;
      }
      const st = stateOf(r.status);
      failed(s, st, st === 'waiting' ? `${s.host} has no judge routes yet (HTTP 404: tNIGHT off there, or no JUDGE_TOKEN)` : st === 'refused' ? `${s.host} refused the judge's token (HTTP ${r.status})` : `${s.host} answered HTTP ${r.status}`);
      return r;
    } catch (e) {
      if (e?.dustLow || e?.stuck) throw e; // the wallet's, not a Worker's: both stop
      if (e?.workerDown) { failed(s, e.noToken ? 'waiting' : 'down', String(e.message ?? e).slice(0, 200)); return { ok: false }; }
      s.lastError = String(e?.message ?? e).slice(0, 200);
      say(s, `cycle error: ${String(e?.message ?? e).slice(0, 500)}`);
      return { ok: false, error: true };
    } finally { s.inCycleSince = null; }
  }
  /** One turn: every Worker once, live first. A cycle stopped for a higher Worker sends the turn back to the top (a few times at most). */
  async function turn() {
    let restarts = 0;
    for (let i = 0; i < S.length; i++) {
      if (clock() < S[i].retryAt) continue;
      S[i].judge.setPreempt?.(i ? preemptFor(i) : null);
      const r = await serve(i);
      if (r?.preempted && restarts < S.length * MAX_YIELDS) { restarts += 1; i = -1; }
    }
  }
  function heartbeat() {
    for (const s of S) {
      const ago = s.lastOkAt === null ? 'never' : String(Math.round((clock() - s.lastOkAt) / 1000));
      log(`heartbeat site=${s.site} host=${s.host} state=${s.state} lastOkSecs=${ago} tables=${s.tables ?? '?'} cycles=${s.cycles} failures=${s.failures}${s.inCycleSince ? ` inCycleSecs=${Math.round((clock() - s.inCycleSince) / 1000)}` : ''}`);
    }
  }
  let timer = null;
  return {
    sites: S,
    turn,
    heartbeat,
    start() { log(`serving ${S.map((s) => `${s.site}=${s.host} (tables ${s.above + 1}..${s.upTo === Infinity ? '' : s.upTo})`).join(', ')}, in that order: one wallet, one transaction at a time`); heartbeat(); timer = setTimer(heartbeat, heartbeatMs); timer?.unref?.(); },
    stop() { if (timer) clearTimer(timer); },
  };
}
