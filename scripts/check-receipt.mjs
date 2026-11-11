// Checks a Cup & Claim receipt against the chain, trusting neither the Hall's page nor the transaction hash the receipt names.
//   node scripts/check-receipt.mjs <receipt url | table-round> [workerUrl]
// 1. Reads the receipt's JSON from the Worker. It's a claim, nothing more.
// 2. Recomputes the fingerprint, the house seal, and every shown cup. Shut cups can't be recomputed, and it says so.
// 3. From the table and round number alone, finds the block where tables[table].lastRound first reached that round, by reading the
//    cage's public state over block height. That's the settle. It then compares what the receipt says with what's there:
//    transaction hash, block, entry point, and the change in each named seat's balance.
// Reads only: no wallet, no key, no transaction. Needs an indexer: as the judge's endpoints, or NIGHTGATE_INDEXER_HTTP_URL.
import './mask-stdio.mjs';
import { WebSocket as WS } from 'ws';
globalThis.WebSocket = WS;
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { loadEndpoints } from './endpoints.mjs';
import { cageAt } from './l9-read.mjs'; // Ledger 9 (11-09): cage4 through its own 0.31.1 build, either era's bytes

const [arg, workerArg] = process.argv.slice(2);
if (!arg) throw new Error('usage: check-receipt.mjs <receipt url | table-round> [workerUrl]');
const url = /^https?:/.test(arg) ? `${arg.replace(/\.json$/, '')}.json` : `${(workerArg ?? process.env.JUDGE_WORKER_URL ?? 'https://sealed-hand-staging.halfhand.workers.dev').replace(/\/$/, '')}/receipt/${arg}.json`;
const EP = loadEndpoints();
if (!EP.indexer) throw new Error('no indexer configured');
const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const utf8 = (s) => Buffer.from(s, 'utf8');
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s, 'hex');
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
let bad = 0;
const pass = (t) => console.log(`  PASS  ${t}`);
const fail = (t) => { bad += 1; console.log(`  FAIL  ${t}`); };
const word = (t) => console.log(`  WORD  ${t}`);
const check = (ok, t) => (ok ? pass(t) : fail(t));

const res = await fetch(url);
if (!res.ok) throw new Error(`receipt not found: ${res.status}`);
const r = await res.json();
console.log(`${r.label} (${r.status}) · cage ${r.cage.address}`);

console.log('The dice:');
const f = r.fingerprint;
const zero = Buffer.alloc(32);
const fp = hex(sha(utf8(f.domain), u32(r.table), u32(Math.floor(r.round / 2 ** 32)), u32(r.round), unhex(f.houseCommit), ...f.commits.map((c) => (c ? unhex(c) : zero))));
check(fp === f.hash, `fingerprint recomputes: ${fp}`);
if (r.opened) check(hex(sha(utf8('cup-and-claim/house/v1'), unhex(r.opened.houseSeed))) === f.houseCommit, 'opened house secret matches the seal');
let total = 0;
for (const c of r.reveals ?? []) {
  total += c.count;
  if (c.mode === 'show') {
    const bytes = sha(utf8('cup-and-claim/roll/v1'), unhex(r.opened.houseSeed), unhex(c.seed), u32(c.seat), u32(r.engineRound));
    const dice = [0, 1, 2, 3, 4].map((k) => (((bytes[2 * k] << 8) | bytes[2 * k + 1]) % 6) + 1);
    const count = dice.filter((d) => d === r.claim.face || d === 1).length;
    check(hex(sha(utf8('cup-and-claim/commit/v1'), unhex(c.seed))) === f.commits[c.seat] && dice.join() === c.dice.join() && count === c.count, `${c.name} shown cup ${dice.join(' ')}: seal, re-roll and count of ${count}`);
  } else word(`${c.name}: shut cup, count ${c.count} is the house's word. Not checkable.`);
}
if (r.result?.kind === 'call') check(total === r.result.total && (total >= r.claim.count) === r.result.held, `counts add to ${total}; the bid of ${r.claim.count} ${r.result.held ? 'holds' : 'falls'}`);
word('The fingerprint itself is not on chain. postedAt is the server\'s clock.');

console.log('The chain:');
const gql = async (query) => {
  const x = await fetch(EP.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000) });
  if (!x.ok) throw new Error(`indexer ${x.status}`);
  const j = await x.json();
  if (j.errors) throw new Error(`indexer: ${JSON.stringify(j.errors).slice(0, 200)}`);
  return j.data;
};
const stateAt = (height) => cageAt(r.cage.address, height);
const roundIn = (L) => (L && L.tables.member(BigInt(r.table)) ? L.tables.lookup(BigInt(r.table)).lastRound : 0n);
/** The cage's first action at or after a height, by the indexer's subscription: a plain query only answers for a block that has one. */
function firstActionFrom(height, waitMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(EP.indexerWS, 'graphql-transport-ws');
    const end = (fn, v) => { clearTimeout(timer); try { ws.close(); } catch { /* gone */ } fn(v); };
    const timer = setTimeout(() => end(reject, new Error(`no action from block ${height} within ${waitMs / 1000} s`)), waitMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onerror = (e) => end(reject, new Error(`indexer socket: ${e?.message ?? 'failed'}`));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'connection_ack') ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: `subscription { contractActions(address:"${r.cage.address}", offset:{height:${height}}) { __typename transaction { hash block { height } } } }` } }));
      else if (m.type === 'next' && m.payload.errors) end(reject, new Error(`indexer: ${JSON.stringify(m.payload.errors).slice(0, 200)}`));
      else if (m.type === 'next') end(resolve, { hash: m.payload.data.contractActions.transaction.hash, block: m.payload.data.contractActions.transaction.block.height });
      else if (m.type === 'error') end(reject, new Error(`indexer: ${JSON.stringify(m.payload).slice(0, 200)}`));
    };
  });
}
// NUMBER_ONLY=1 uses nothing from the receipt to find the settle but its table and round: no block, no hash, no chain round.
const NUMBER_ONLY = process.env.NUMBER_ONLY === '1';
const target = BigInt(NUMBER_ONLY ? r.round : r.settle?.chainRound ?? r.round);
const tip = (await gql('{ block { height } }')).block.height;
if (roundIn(await cageAt(r.cage.address)) < target) { word(`Table ${r.table} has not reached chain round ${target} yet.`); process.exit(bad ? 1 : 0); }
// Binary search over block height: before the settle the counter is short of the round, and from it onward it isn't.
// NUMBER_ONLY starts from the tip; otherwise the receipt's block only shortens the search, and the checks below prove it.
let lo = Number(process.env.CHECK_FROM ?? 3_260_000), hi = NUMBER_ONLY || !r.settle ? tip + 1 : Number(r.settle.block) + 1;
let found = null;
while (hi - lo > 1) {
  const mid = Math.floor((lo + hi) / 2);
  const first = await firstActionFrom(mid, 8000).catch(() => null); // none: everything happened before this height
  if (!first || roundIn(await stateAt(first.block)) >= target) { hi = mid; if (first) found = first; } else lo = first.block;
}
found ??= await firstActionFrom(hi);
pass(`table ${r.table} first reached chain round ${target} in block ${found.block}, found by reading the cage's state over block height${NUMBER_ONLY ? ', from the table and round number alone' : ''}`);
const block = found.block;
const blockData = await gql(`{ block(offset:{height:${block}}) { hash transactions { hash ... on RegularTransaction { transactionResult { status } } contractActions { __typename address ... on ContractCall { entryPoint } } } } }`);
const settles = blockData.block.transactions.filter((t) => t.contractActions.some((a) => a.address === r.cage.address && a.entryPoint === 'settleBatch'));
console.log(`  block ${block} has ${settles.length} settleBatch on this cage: ${settles.map((t) => t.hash).join(', ')}`);
check(!!r.settle && settles.some((t) => t.hash === r.settle.hash), `the receipt's transaction ${r.settle?.hash ?? '(none)'} is that settle`);
if (r.settle) {
  check(r.settle.block === block, `the receipt's block ${r.settle.block} is block ${block}`);
  check(settles.find((t) => t.hash === r.settle.hash)?.transactionResult?.status === 'SUCCESS', 'it landed as SUCCESS');
}
const before = await stateAt((await firstActionFrom(lo)).block); // the cage's last action before the settle
const after = await stateAt(block);
const bal = (L, id) => { const k = unhex(id); return L.balance.member(k) ? L.balance.lookup(k) : 0n; };
for (const l of r.chips ?? []) {
  const moved = bal(after, l.cageId) - bal(before, l.cageId);
  check(moved === BigInt(l.delta) * 1_000_000n, `${l.name} ${l.delta > 0 ? '+' : ''}${l.delta} tNIGHT: balance moved ${Number(moved) / 1e6} on chain`);
}
console.log(bad ? `\n${bad} check(s) FAILED.` : `\nAll checks passed. Shut cups stay the house's word.`);
process.exit(bad ? 1 : 0);
