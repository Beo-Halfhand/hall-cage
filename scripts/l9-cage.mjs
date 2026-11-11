// Ledger 9 contract layer for cage.mjs and judge.mjs (Midnight.js 5.0.0): branch ledger9, 11-09.
//
// cage4 was deployed before the fork with compactc 0.31.1 (runtime 0.16.0), so it stays a ledger 8 contract: Midnight.js 5
// calls it through its own build, passed as `new Contract(witnesses)` (not CompiledContract.make), with the verifier keys
// that are on chain. That build lives in packages/cage-l8 with its own compact-runtime 0.16.0 and the one shared
// onchain-runtime-v3 (3.1.2). Never recompile it: 0.36.0 changes every verifier key and the cage would refuse the proofs.
//
// After the fork the chain serves the cage's state in the ledger 9 format (contract-state[v8] header). It is decoded with
// compact-runtime 0.21.0 and handed to the 0.16 build's ledger() as plain encoded data (the migration guide's recipe).
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import pino from 'pino';
import { endpointsEnv, NETWORK } from './l9-wallet.mjs';

const { WebSocket } = await import('ws');
const { ContractState } = await import('@midnight-ntwrk/compact-runtime'); // 0.21.0, the ledger 9 runtime
const rt8 = await import('cage-l8/runtime'); // 0.16.0, the copy the cage build imports
const cage = await import('cage-l8');
const { Transaction } = await import('@midnight-ntwrk/midnight-js-protocol/v9');
const { submitCallTx } = await import('@midnight-ntwrk/midnight-js-contracts');
const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
const { MidnightWalletProvider, inMemoryPrivateStateProvider } = await import('@midnight-ntwrk/testkit-js');

export const { Contract, ledger, pureCircuits } = cage;
export const ZK = new URL('../packages/cage-l8/sealed-cage', import.meta.url).pathname;
export const hex = (u8) => Buffer.from(u8).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const witnesses = { secretKey: ({ privateState }) => [privateState, Buffer.from(privateState.sk, 'hex')] };
export const contractInstance = () => new Contract(witnesses);

let pubProvider = null;
export function publicData() {
  if (pubProvider) return pubProvider;
  const env = endpointsEnv();
  pubProvider = indexerPublicDataProvider({ queryURL: env.indexer, subscriptionURL: env.indexerWS, webSocket: WebSocket });
  return pubProvider;
}

/** The cage's public state as the 0.16 build reads it, from either era's bytes. Also returns the raw read (era, maintenance authority). */
export async function readCage(address) {
  const read = await publicData().queryContractState(address);
  if (!read) throw new Error(`no contract at ${address}`);
  let authority = null;
  const stateValue = read.contractState.deserialize({
    v8: { deserialize: (bytes) => { const cs = rt8.ContractState.deserialize(bytes); authority = cs.maintenanceAuthority; return cs.data.state; } },
    v9: { deserialize: (bytes) => { const cs = ContractState.deserialize(bytes); authority = cs.maintenanceAuthority; return rt8.StateValue.decode(cs.data.state.encode()); } },
  });
  return { L: ledger(stateValue), era: read.contractState.era, protocolVersion: read.protocolVersion, authority };
}

// ---------- submit: one shot, never resent blind (as escrow-self.mjs and the 4.1.1 judge) ----------
export async function probeLanded(identifier) {
  const env = endpointsEnv();
  const query = `{ transactions(offset:{identifier:"${identifier}"}) { hash block { height timestamp } ... on RegularTransaction { identifiers transactionResult { status } } } }`;
  try {
    const r = await fetch(env.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const t = (await r.json())?.data?.transactions?.[0];
    if (t?.block?.height == null || t?.transactionResult?.status == null) return null;
    return { hash: t.hash, height: t.block.height, block: t.block.height, status: t.transactionResult.status, blockAt: t.block.timestamp ?? null };
  } catch { return null; }
}
export async function waitLanded(identifier, ms) { const end = Date.now() + ms; for (;;) { const f = await probeLanded(identifier); if (f || Date.now() > end) return f; await sleep(6000); } }

// The node's metadata costs a few seconds to fetch, so it's kept between transactions and refreshed every 30 minutes.
let polkadot = null;
async function encodeExtrinsic(bytes) {
  const env = endpointsEnv();
  if (!polkadot || Date.now() - polkadot.at > 30 * 60_000) {
    const { ApiPromise, HttpProvider } = await import('@polkadot/api');
    if (polkadot) await polkadot.api.disconnect().catch(() => {});
    polkadot = { api: await ApiPromise.create({ provider: new HttpProvider(env.node), noInitWarn: true }), at: Date.now() };
  }
  try { return polkadot.api.tx.midnight.sendMnTransaction('0x' + hex(bytes)).toHex(); }
  catch (e) { polkadot = null; throw e; }
}
export async function closeChain() { if (polkadot) { await polkadot.api.disconnect().catch(() => {}); polkadot = null; } }
function submitExtrinsic(extrinsicHex, timeoutMs = 30000) {
  const env = endpointsEnv();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(env.nodeWS); let done = false;
    const settle = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch { /* gone */ } fn(v); };
    const lost = (m) => { const e = new Error(m); e.transport = true; settle(reject, e); };
    const timer = setTimeout(() => lost(`no reply in ${timeoutMs / 1000}s`), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'author_submitExtrinsic', params: [extrinsicHex] }));
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m?.id !== 1) return;
      if (m.error) settle(reject, Object.assign(new Error(`node rejected: ${m.error.code} ${m.error.message}${m.error.data !== undefined ? ' | ' + JSON.stringify(m.error.data) : ''}`), { code: m.error.code }));
      else settle(resolve, String(m.result)); };
    ws.onerror = (ev) => lost(`websocket error during submit: ${ev?.message ?? 'connection failed'}`);
    ws.onclose = (ev) => lost(`socket closed before the reply (${ev?.code ?? '?'})`);
  });
}
/** The id the indexer knows a finalized ledger 9 transaction by (its last identifier, as in 4.1.1). */
export const idOfBytes = (bytes) => String(Transaction.deserialize('signature', 'proof', 'binding', bytes).identifiers().at(-1));

/**
 * Sends a finalized transaction once. `bytes` is the transaction's serialization; `release` gives its DUST back when the
 * node refuses it before the pool. Hooks: onSend(id) runs just before it leaves (the judge's journal), log(m) for lines.
 * Returns the id. Throws with .transport/.unknown when the outcome can't be known, .refused when the node said no.
 */
export async function submitOnce(bytes, { release, onSend, log = () => {} } = {}) {
  const id = idOfBytes(bytes);
  let xt;
  try { xt = await encodeExtrinsic(bytes); }
  catch (e) { try { await release?.(); } catch { /* run stops, state not saved */ } throw Object.assign(new Error(`could not encode the extrinsic (nothing sent): ${e?.message ?? e}`), { notSent: true, id }); }
  onSend?.(id);
  log(`submitting ${id.slice(0, 18)}… (one-shot author_submitExtrinsic)`);
  try { await submitExtrinsic(xt); return id; }
  catch (e) {
    const m = String(e?.message ?? e);
    if (/\b1013\b|already imported/i.test(m)) { log('node: already in the pool (1013), so the first send worked'); return id; }
    if (e?.transport) {
      log(`lost the socket before the reply: ${m}. NOT resending; asking the indexer for ${id.slice(0, 18)}… for 90 s`);
      if (await waitLanded(id, 90000)) { log('it landed'); return id; }
      throw Object.assign(new Error(`submit outcome unknown for ${id}: it may still land. Read the state before any retry; do not resend.`), { unknown: true, id });
    }
    try { await release?.(); log('refused before the pool: DUST released (wallet.revert); nothing spent'); } catch { log('refused before the pool; DUST release failed (state is not saved this run)'); }
    throw Object.assign(e, { refused: true, id });
  }
}

/**
 * Midnight.js 5 providers for one opened wallet (l9-wallet.mjs openWallet). The wallet provider balances through the
 * wallet SDK (testkit's MidnightWalletProvider, both eras); submission is the one-shot path above.
 * ctx gets .lastId / .sentAt / .onSend set as a transaction goes out.
 */
export async function providersFor(w, ctx = {}, log = () => {}) {
  const env = endpointsEnv();
  const wp = await MidnightWalletProvider.withWallet(pino({ level: 'warn' }), { walletNetworkId: NETWORK, ...env }, w.wallet, w.seeds, w.ks);
  wp.submitTx = async (tx) => {
    const bytes = tx.serialize();
    const release = async () => { await w.wallet.revert(w.wallet.adoptTransaction(bytes, 'Finalized')); };
    const id = await submitOnce(bytes, { release, onSend: (i) => { ctx.lastId = i; ctx.sentAt = Date.now(); ctx.onSend?.(i); }, log });
    ctx.lastId = id;
    return id;
  };
  const pub = publicData();
  const watch = pub.watchForTxData.bind(pub);
  const patched = Object.create(pub);
  patched.watchForTxData = (id) => Promise.race([watch(id), sleep(360000).then(() => { throw Object.assign(new Error(`${id} not on the indexer after 6 min: it may still land. Read the state before any retry.`), { unknown: true, id }); })]);
  const zk = new NodeZkConfigProvider(ZK, { verify: 'require-if-present' }); // 0.31.1 writes contract-info.json and no manifest
  return {
    wp,
    p: {
      privateStateProvider: inMemoryPrivateStateProvider(),
      publicDataProvider: patched,
      zkConfigProvider: zk,
      proofProvider: httpClientProofProvider(env.proofServer, zk),
      walletProvider: wp,
      midnightProvider: wp,
      config: { networkId: NETWORK, ttlSeconds: 3600 },
    },
  };
}

/** A private-state id per cage key, never the key itself. */
export const psIdOf = (skHex) => `k${createHash('sha256').update(skHex).digest('hex').slice(0, 12)}`;

/** Calls one cage circuit as the holder of skHex. Returns the Midnight.js result (r.public: txHash, txId, blockHeight, status). */
export async function callCage(p, address, circuitId, skHex, args) {
  const psId = psIdOf(skHex);
  await p.privateStateProvider.forContract(address).set(psId, { sk: skHex });
  return submitCallTx(p, { compiledContract: contractInstance(), contractAddress: address, circuitId, privateStateId: psId, args });
}
