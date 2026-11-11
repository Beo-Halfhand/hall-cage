// Read-only: who still has money in a cage, and what still binds it. Public state through the indexer; sends nothing, opens no wallet.
//   node scripts/cage-balances.mjs <cage address>                                 for a v4 cage
//   CAGE_BUILD=contracts/managed/cage3 node scripts/cage-balances.mjs <address>   for cage #3 (npm run compile:cage3 first): the seat layout differs
import './mask-stdio.mjs';
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEndpoints } from './endpoints.mjs';
const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
const build = resolve(process.env.CAGE_BUILD ?? new URL('../contracts/managed/sealed-cage', import.meta.url).pathname);
const { ledger } = await import(pathToFileURL(`${build}/contract/index.js`).href);

const address = process.argv[2];
if (!/^[0-9a-f]{64}$/.test(address ?? '')) throw new Error('usage: cage-balances.mjs <64-hex cage address>');
setNetworkId('preprod');
const EP = loadEndpoints();
if (EP.missing.length) throw new Error(`endpoints missing: ${EP.missing.join(', ')}`);
const cs = await indexerPublicDataProvider(EP.indexer, EP.indexerWS).queryContractState(address);
if (!cs) throw new Error(`no contract at ${address}`);
const L = ledger(cs.data);
const hex = (u) => Buffer.from(u).toString('hex');
const now = BigInt(Math.floor(Date.now() / 1000));
// Cage #3 keeps epoch and seated in the table record. Later cages keep them in their own maps.
const split = !!L.epochs;
const tableAt = (k) => { if (!L.tables.member(k)) return null; const t = L.tables.lookup(k); return split ? { ...t, epoch: L.epochs.lookup(k), seated: L.seats.member(k) ? L.seats.lookup(k).read() : 0n } : t; };
const alive = (t) => t.seated > 0n && now < t.heartbeat + L.escapeSecs;
const a = cs.maintenanceAuthority;
console.log(`cage ${address}`);
console.log(`authority: committee ${a.committee.length} · threshold ${a.threshold} · ${a.threshold > a.committee.length ? 'LOCKED' : 'not locked'}`);
const held = [...L.balance].filter(([, v]) => v > 0n);
console.log(`ids with money: ${held.length} · ${Number(held.reduce((s, [, v]) => s + v, 0n)) / 1e6} tNIGHT`);
for (const [id, v] of held) {
  const s = L.seat.member(id) ? L.seat.lookup(id) : null;
  const t = s ? tableAt(s.table) : null;
  const expired = !!s && s.standing && s.standAt !== undefined && now >= s.standAt + L.escapeSecs;
  const binds = !!s && !expired && !!t && s.epoch === t.epoch && alive(t);
  const until = binds ? (s.standing && s.standAt !== undefined ? (s.standAt + L.escapeSecs < t.heartbeat + L.escapeSecs ? s.standAt + L.escapeSecs : t.heartbeat + L.escapeSecs) : t.heartbeat + L.escapeSecs) : null;
  const permit = L.permits?.member(id) ? L.permits.lookup(id) : null;
  const permitNote = !permit ? '' : now > permit.until ? ' · permit run out' : ` · judge may place up to ${Number(permit.cap) / 1e6}, not below ${Number(permit.floor) / 1e6}, until ${new Date(Number(permit.until) * 1000).toISOString()}${hex(permit.judge) === hex(L.judge) ? '' : ' (names another judge)'}`;
  console.log(`  ${hex(id)} ${(Number(v) / 1e6).toFixed(6)} ${binds ? `BOUND at table ${s.table}, at the latest until ${new Date(Number(until) * 1000).toISOString()} if nothing settles` : 'free: withdraw, or anyone can rescue'}${permitNote}`);
}
const live = [...L.tables].map(([k]) => [k, tableAt(k)]).filter(([, t]) => alive(t));
console.log(`tables alive: ${live.length}`);
for (const [k, t] of live) console.log(`  table ${k}: epoch ${t.epoch} · last round ${t.lastRound} · seated ${t.seated} · quiet ${now - t.heartbeat}s of ${L.escapeSecs}s`);
process.exit(0);
