// Measures a deploy against what preprod will take in one transaction, with nothing sent.
//
// Where the limit comes from (midnight-node, read 2026-11-05; the live numbers are read from the node and the indexer each run):
//   - The ledger prices a transaction as a SyntheticCost (readTime, computeTime, blockUsage, bytesWritten, bytesChurned) and divides each
//     by the block limit for it (ledger parameters, from the newest block on the indexer). bytesWritten's limit is 50,000.
//   - The node turns the largest of those shares into Substrate weight: share x max block weight (ledger/src/ledger_8/mod.rs,
//     get_transaction_cost and scale_normalized_cost), plus ConfigurableTransactionSizeWeight (pallets/midnight/src/lib.rs, get_tx_weight).
//   - frame_system refuses a normal transaction whose weight is over max_extrinsic for the normal class, with 1010 "Transaction would
//     exhaust the block limits" (check_weight.rs, check_extrinsic_weight). max_extrinsic is 75% of the block, less 10% for block
//     initialization, less the base extrinsic weight.
// So one transaction can use (max_extrinsic - size weight) / max block of any one block limit: 63.99% on preprod today, 31,997 bytes written.
//
// Usage: node scripts/measure-deploy.mjs [--tx <hash>]... [--build <managed dir>]...
//   --tx     prices a landed transaction by its hash, as landed (balanced and proven)
//   --build  builds that compiled contract's locked deploy, unproven and unbalanced, and prices it. Balancing adds a DUST spend; the landed
//            cage #3 deploy shows how much (185 bytes written over its unproven build)
// `node scripts/cage.mjs <wallet> deploy-size ...` prices the real thing: built, proven and balanced by that wallet, then released, not sent.
import { loadEndpoints } from './endpoints.mjs';
const L = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
const EP = loadEndpoints();
const q = async (query) => { const r = await (await fetch(EP.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })).json(); if (r.errors) throw new Error(r.errors[0].message); return r.data; };
const hexTo = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const DIMS = ['readTime', 'computeTime', 'blockUsage', 'bytesWritten', 'bytesChurned'];
const BLOCK = { readTime: 2_000_000_000_000, computeTime: 2_000_000_000_000, blockUsage: 1_000_000, bytesWritten: 50_000, bytesChurned: 50_000_000 };
/** What the landed cage #3 deploy (e56a58df…) wrote over its own unproven build: one DUST spend and its fee. */
export const BALANCING_BYTES_WRITTEN = 185;

/** The ledger parameters in force, from the newest block. */
export async function chainParams() {
  const { block } = await q('{ block { height ledgerParameters } }');
  return { height: block.height, params: L.LedgerParameters.deserialize(hexTo(block.ledgerParameters)) };
}

/** The node's side of the limit, from its runtime constants and pallet storage. */
export async function nodeLimit() {
  const { ApiPromise, HttpProvider } = await import('@polkadot/api');
  const api = await ApiPromise.create({ provider: new HttpProvider(EP.nodeHttp), noInitWarn: true });
  try {
    const bw = api.consts.system.blockWeights.toJSON();
    const sizeWeight = BigInt((await api.query.midnight.configurableTransactionSizeWeight()).toJSON().refTime);
    const maxBlock = BigInt(bw.maxBlock.refTime), maxExtrinsic = BigInt(bw.perClass.normal.maxExtrinsic.refTime);
    return { runtime: `${api.runtimeVersion.specName} ${api.runtimeVersion.specVersion}`, maxBlock, maxExtrinsic, sizeWeight, share: Number(maxExtrinsic - sizeWeight) / Number(maxBlock) };
  } finally { try { await api.disconnect(); } catch { /* best effort */ } }
}

/** A transaction's cost the way the node computes it, its weight, and the room left under the per-transaction limit. */
export function price(params, limit, tx) {
  const c = tx.cost(params, true);
  const out = { bytes: tx.serialize().length, cost: Object.fromEntries(DIMS.map((k) => [k, Number(c[k])])) };
  let n;
  try { n = params.normalizeFullness(c); } catch (e) { return { ...out, fits: false, verdict: `OVER A BLOCK LIMIT: ${e?.message ?? e}` }; }
  const worst = DIMS.reduce((a, k) => (n[k] > n[a] ? k : a), DIMS[0]);
  out.share = Object.fromEntries(DIMS.map((k) => [k, `${(n[k] * 100).toFixed(2)}%`]));
  if (limit) {
    const weight = BigInt(Math.floor(n[worst] * Number(limit.maxBlock))) + limit.sizeWeight;
    const allowed = Math.floor(limit.share * BLOCK[worst]);
    Object.assign(out, { dimension: worst, allowed, used: out.cost[worst], headroom: allowed - out.cost[worst], weight: String(weight), maxExtrinsic: String(limit.maxExtrinsic), fits: weight <= limit.maxExtrinsic });
  }
  return out;
}

export async function landed(hash) {
  const { transactions } = await q(`{ transactions(offset:{hash:"${hash}"}) { hash block { height } raw } }`);
  const t = transactions[0]; if (!t) throw new Error(`no tx ${hash}`);
  return { height: t.block.height, tx: L.Transaction.deserialize('signature', 'proof', 'binding', hexTo(t.raw)) };
}

/** The locked deploy this build would send, unproven, with throwaway wallet keys standing in (they only name who would pay). */
export async function buildDeploy(dir) {
  const { randomBytes } = await import('node:crypto');
  const { CompiledContract } = await import('@midnight-ntwrk/midnight-js-protocol/compact-js');
  const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
  const { buildLockedDeploy } = await import('./deploy-locked.mjs');
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId('preprod');
  const { Contract, pureCircuits } = await import(`${dir}/contract/index.js`);
  const compiled = CompiledContract.make('SealedCage', Contract).pipe(CompiledContract.withWitnesses({ secretKey: ({ privateState }) => [privateState, new Uint8Array(32)] }), CompiledContract.withCompiledFileAssets(dir));
  const z = L.ZswapSecretKeys.fromSeed(randomBytes(32));
  const providers = { zkConfigProvider: new NodeZkConfigProvider(dir), walletProvider: { getCoinPublicKey: () => z.coinPublicKey, getEncryptionPublicKey: () => z.encryptionPublicKey } };
  const id = pureCircuits.playerId(new Uint8Array(32));
  // A build with L1 takes maxGrant last (30 days, as the real deploy); older builds don't, and still measure as they did. The generated
  // constructor says how many arguments it takes, counting its context: 10 with L1, 9 before.
  const { MAX_GRANT_SECS } = await import('./deploy-params.mjs');
  const takes = Number(/Contract state constructor: expected (\d+) arguments/.exec((await import('node:fs')).readFileSync(`${dir}/contract/index.js`, 'utf8'))?.[1]) - 1;
  const all = [id, id, 0n, 1_000_000_000n, 1800n, 6n, 300n, 2700n, MAX_GRANT_SECS];
  if (!(takes === 8 || takes === 9)) throw new Error(`${dir}: a constructor of ${takes} parameters, not one this measures`);
  const { unprovenTx } = await buildLockedDeploy(providers, { compiledContract: compiled, initialPrivateState: { sk: '00'.repeat(32) }, args: all.slice(0, takes) });
  return unprovenTx;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { height, params } = await chainParams();
  const limit = await nodeLimit();
  const s = params.toString(); const i = s.indexOf('block_limits');
  console.log(`ledger parameters at block ${height}: ${s.slice(i, s.indexOf('}', i) + 1).replace(/\s+/g, ' ')}`);
  console.log(`node ${limit.runtime}: max block weight ${limit.maxBlock}, normal max_extrinsic ${limit.maxExtrinsic}, tx size weight ${limit.sizeWeight}: one transaction may use ${(limit.share * 100).toFixed(4)}% of any one block limit`);
  const argv = process.argv.slice(2);
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--tx') { const h = argv[++k]; const x = await landed(h); console.log(`landed tx ${h.slice(0, 16)}… (block ${x.height})`, JSON.stringify(price(params, limit, x.tx))); }
    if (argv[k] === '--build') { const d = argv[++k]; console.log(`build ${d.replace(/.*workspace\//, '../').replace(/.*scratchpad\//, 'scratchpad/')} (unproven, unbalanced; balancing adds about ${BALANCING_BYTES_WRITTEN} bytes written)`, JSON.stringify(price(params, limit, await buildDeploy(d)))); }
  }
}
