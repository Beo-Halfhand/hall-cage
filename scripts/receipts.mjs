// Reads each transaction back from the indexer by hash, independently of what the scripts recorded when they ran.
//   node scripts/receipts.mjs file    lines of: step|wallet|hash    Prints the same with the block and result the indexer gives.
import './mask-stdio.mjs';
import { readFileSync } from 'node:fs';
import { loadEndpoints } from './endpoints.mjs';
const EP = loadEndpoints();
if (EP.missing.length) throw new Error(`endpoints missing: ${EP.missing.join(', ')}`);
const rows = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => l.split('|'));
let bad = 0;
for (const [step, wallet, hash] of rows) {
  const query = `{ transactions(offset:{hash:"${hash}"}) { hash block { height } ... on RegularTransaction { transactionResult { status } } } }`;
  const res = await fetch(EP.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(20000) });
  const t = (await res.json())?.data?.transactions?.[0];
  if (!t) bad++;
  console.log(`| ${step} | ${wallet} | \`${hash}\` | ${t?.block?.height ?? 'NOT FOUND'} | ${t?.transactionResult?.status ?? '?'} |`);
  await new Promise((r) => setTimeout(r, 120));
}
console.error(`${rows.length} rows, ${bad} not found`);
