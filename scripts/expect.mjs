// Reads the cage's public ledger and checks expectations. Exit 1 on any mismatch (the spike stops there).
//   node scripts/expect.mjs a.balance=2 b.balance=4 a.atRisk=1 a.seat=1 b.seat=none a.permitCap=5 a.permitFloor=5 b.permitCap=none t1.lastRound=1 t1.seated=2 t1.epoch=1 judge=judge pending=none
// Amounts in tNIGHT. <w>.seat=<table>|none, <w>.standing=true|false, judge=<wallet>, pending=<wallet>|none.
import './mask-stdio.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { readCage, pureCircuits } from './l9-cage.mjs'; // Ledger 9 (11-09): cage4 is read through its own 0.31.1 build and the era-aware reader
const CAGE_FILE = process.env.CAGE_FILE ?? 'deployment.cage4.json';
const address = JSON.parse(readFileSync(CAGE_FILE, 'utf8')).address;
const hex = (u) => Buffer.from(u).toString('hex');
const idOf = (w) => { const f = `.wallets/${w}.cage-key`; if (!existsSync(f)) throw new Error(`no cage key for ${w}`); return pureCircuits.playerId(Buffer.from(readFileSync(f, 'utf8').trim(), 'hex')); };
const night = (s) => (Number(s) / 1e6).toString();
const { L } = await readCage(address);
const get = (key) => {
  let m;
  if ((m = /^t(\d+)\.(lastRound|seated|epoch|heartbeat)$/.exec(key))) { const t = BigInt(m[1]); if (!L.tables.member(t)) return 'none'; if (m[2] === 'epoch') return String(L.epochs.lookup(t)); if (m[2] === 'seated') return String(L.seats.member(t) ? L.seats.lookup(t).read() : 0n); return String(L.tables.lookup(t)[m[2]]); }
  if ((m = /^(\w+)\.(permitCap|permitFloor)$/.exec(key))) { const id = idOf(m[1]); return L.permits.member(id) ? night(L.permits.lookup(id)[m[2] === 'permitCap' ? 'cap' : 'floor']) : 'none'; }
  if ((m = /^(\w+)\.(balance|atRisk|seat|standing|epoch)$/.exec(key))) {
    const id = idOf(m[1]); const s = L.seat.member(id) ? L.seat.lookup(id) : null;
    if (m[2] === 'balance') return night(L.balance.member(id) ? L.balance.lookup(id) : 0n);
    if (!s) return 'none';
    return m[2] === 'atRisk' ? night(L.risks.member(id) ? L.risks.lookup(id) : 0n) : m[2] === 'seat' ? String(s.table) : m[2] === 'standing' ? String(s.standing) : String(s.epoch);
  }
  if (key === 'judge') { const j = hex(L.judge); for (const w of ['judge', 'a', 'b']) if (hex(idOf(w)) === j) return w; return j.slice(0, 12); }
  if (key === 'pending') { if (!L.hasPending) return 'none'; const j = hex(L.pendingJudge); for (const w of ['judge', 'a', 'b']) if (hex(idOf(w)) === j) return w; return j.slice(0, 12); }
  throw new Error(`unknown key ${key}`);
};
let bad = 0;
for (const arg of process.argv.slice(2)) {
  const [k, want] = arg.split('='); const got = get(k);
  const ok = got === want; if (!ok) bad++;
  console.log(`${ok ? '✓' : '✖'} ${k} = ${got}${ok ? '' : `  (expected ${want})`}`);
}
// EXPECT_RETRYING=1: the caller will ask again (the chain can lag a few seconds), so a miss is not a stop yet.
console.log(bad ? (process.env.EXPECT_RETRYING === '1' ? `NOT YET: ${bad} expectation(s) differ. Retrying; only a final failure stops the run.` : `MISMATCH: ${bad} expectation(s) failed. STOP.`) : 'all expectations hold');
process.exit(bad ? 1 : 0);
