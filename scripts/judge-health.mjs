// Is each Worker still being served? Reads the judge's log (heartbeat lines, one per Worker a minute) and says, per Worker, ok or not.
// No network, no keys. Exit 0 when every Worker the judge last started with has a fresh "state=ok" heartbeat, 1 otherwise, 2 if the log has none.
//
//   node scripts/judge-health.mjs [--log logs/judge.launchd.log] [--max-secs 600] [--expect staging,live]
//
// --expect: the sites that must be ok. By default every site the judge's last start line names. A site in "waiting" (its Worker has no
// judge routes yet: live before L2) counts as not ok only when it is expected.
import { closeSync, openSync, readSync, statSync } from 'node:fs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const LOG = arg('log', 'logs/judge.launchd.log');
const MAX = Number(arg('max-secs', 600)); // a busy turn runs minutes between good cycles (11-10 test: up to 122 s); the watchdog stops a cycle at 20 min
const TAIL = 2 * 1024 * 1024; // the last 2 MB is many minutes of heartbeats

function tail(path) {
  const size = statSync(path).size, len = Math.min(size, TAIL), buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  return buf.toString('utf8').split('\n');
}

export function health(lines, { now = Date.now(), maxSecs = MAX, expect = null } = {}) {
  let start = null;
  const beats = new Map();
  for (const l of lines) {
    const at = Date.parse(l.slice(0, 24));
    const s = / serving (.+), in that order/.exec(l);
    if (s) { start = { at, sites: s[1].split(', ').map((x) => x.split('=')[0]) }; beats.clear(); continue; }
    const h = / heartbeat site=(\S+) host=(\S+) state=(\S+) lastOkSecs=(\S+)/.exec(l);
    if (h) beats.set(h[1], { at, host: h[2], state: h[3], lastOkSecs: h[4] === 'never' ? null : Number(h[4]) });
  }
  if (!start) return { code: 2, lines: ['no start line from the two-Worker judge in the log (an older judge, or the wrong log)'] };
  const want = expect ?? start.sites;
  const out = [`judge started ${new Date(start.at).toISOString()} serving ${start.sites.join(', ')}`];
  let bad = false;
  for (const site of want) {
    const b = beats.get(site);
    const age = b ? Math.round((now - b.at) / 1000) : null;
    // Served: the heartbeat is recent, and the last good cycle was recent when it was written.
    const ok = !!b && age <= maxSecs && b.state === 'ok' && b.lastOkSecs !== null && b.lastOkSecs + age <= maxSecs;
    if (!ok) bad = true;
    out.push(`${ok ? 'OK  ' : 'NOT '} ${site}${b ? ` (${b.host}) state=${b.state} · last good cycle ${b.lastOkSecs === null ? 'never' : `${b.lastOkSecs + age} s ago`} · heartbeat ${age} s ago` : ': no heartbeat since the start'}${start.sites.includes(site) ? '' : ' · NOT SERVED by this judge'}`);
  }
  return { code: bad ? 1 : 0, lines: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = health(tail(LOG), { expect: arg('expect', null)?.split(',').map((x) => x.trim()).filter(Boolean) ?? null });
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
