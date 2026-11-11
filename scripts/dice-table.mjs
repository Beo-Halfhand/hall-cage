// Turns logs/dice-rounds.jsonl into the tables for a report: every transaction, and the proof size and time per call.
//   node scripts/dice-table.mjs [receipts file]
import { readFileSync, statSync } from 'node:fs';
const file = process.argv[2] ?? new URL('../logs/dice-rounds.jsonl', import.meta.url).pathname;
const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const zk = new URL('../contracts/managed/dice-proof', import.meta.url).pathname;
const landed = rows.filter((r) => r.hash);
console.log('| Step | Call | Wallet | Tx hash | Block | Status | Prove | Proof | Tx | Sent to landed |\n|---|---|---|---|---:|---|---:|---:|---:|---:|');
for (const r of landed) console.log(`| ${r.label} | \`${r.circuit}\` | ${r.wallet} | \`${r.hash}\` | ${r.block} | ${r.status} | ${r.proveMs != null ? `${(r.proveMs / 1000).toFixed(1)} s` : ''} | ${r.proofBytes ?? ''} | ${r.txBytes ?? ''} | ${r.landMs != null ? `${(r.landMs / 1000).toFixed(1)} s` : ''} |`);
const by = new Map();
for (const r of landed) if (r.proveMs != null && r.circuit !== 'deploy') { if (!by.has(r.circuit)) by.set(r.circuit, []); by.get(r.circuit).push(r); }
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const range = (xs, f = (x) => x) => (Math.min(...xs) === Math.max(...xs) ? f(xs[0]) : `${f(Math.min(...xs))} to ${f(Math.max(...xs))}`);
const s1 = (ms) => (ms / 1000).toFixed(1);
console.log('\n| Call | Runs | Instructions | Proving key | Proof bytes | Proving, seconds | Transaction bytes | Sent to landed, seconds |\n|---|---:|---:|---:|---:|---:|---:|---:|');
for (const [c, xs] of [...by].sort()) {
  const z = JSON.parse(readFileSync(`${zk}/zkir/${c}.zkir`, 'utf8'));
  const key = statSync(`${zk}/keys/${c}.prover`).size;
  const land = xs.map((r) => r.landMs).filter((x) => x != null);
  console.log(`| \`${c}\` | ${xs.length} | ${z.instructions.length} | ${(key / 1e6).toFixed(2)} MB | ${range(xs.map((r) => r.proofBytes))} | ${range(xs.map((r) => r.proveMs), s1)} | ${range(xs.map((r) => r.txBytes))} | ${land.length ? `${s1(avg(land))} avg, ${range(land, s1)}` : ''} |`);
}
console.log(`\n${landed.length} transactions: ${landed.filter((r) => /Succeed|SUCCESS/.test(r.status)).length} succeeded${landed.some((r) => r.notApplied) ? `, ${landed.filter((r) => r.notApplied).length} landed but not applied` : ''}.`);
for (const r of rows.filter((x) => x.refused)) console.log(`REFUSED ${r.label}: ${r.refused.slice(0, 220)}`);
