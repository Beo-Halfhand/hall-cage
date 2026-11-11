// Lock at deploy, with nothing sent: the real constructor, the real verifier keys, and the transaction stopped at the door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ContractState as RuntimeState, createCircuitContext } from 'cage-l8/runtime';
const { ContractMaintenanceAuthority, sampleCoinPublicKey, sampleEncryptionPublicKey, sampleSigningKey, signatureVerifyingKey } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
const { CompiledContract } = await import('@midnight-ntwrk/midnight-js-protocol/compact-js');
const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
const { buildLockedDeploy, deployLocked, isLocked, lockedState } = await import('../scripts/deploy-locked.mjs');
const { Contract, ledger, pureCircuits } = await import('../contracts/managed/sealed-cage/contract/index.js');

const ZK = new URL('../contracts/managed/sealed-cage', import.meta.url).pathname;
const needKeys = existsSync(`${ZK}/keys/settleBatch.verifier`) ? false : 'needs the keys from npm run compile';
const CIRCUITS = 11;
const b32 = () => new Uint8Array(randomBytes(32));
const hex = (u) => Buffer.from(u).toString('hex');
const T0 = 1_900_000_000n;
setNetworkId('preprod');

const judge = { sk: b32() };
const args = [pureCircuits.playerId(judge.sk), pureCircuits.playerId(judge.sk), 0n, 1000n * 1_000_000n, 1800n, 6n, 300n, 2700n, 2_592_000n];
const witnesses = { secretKey: ({ privateState }) => [privateState, Buffer.from(privateState.sk, 'hex')] };
const compiled = () => CompiledContract.make('SealedCage', Contract).pipe(CompiledContract.withWitnesses(witnesses), CompiledContract.withCompiledFileAssets(ZK));
const providers = (onChain) => ({
  zkConfigProvider: new NodeZkConfigProvider(ZK),
  walletProvider: { getCoinPublicKey: () => sampleCoinPublicKey(), getEncryptionPublicKey: () => sampleEncryptionPublicKey() },
  publicDataProvider: { queryContractState: async (address) => onChain(address) },
});
const options = () => ({ compiledContract: compiled(), initialPrivateState: { sk: hex(b32()) }, args });
// The ledger package and the compact runtime each have their own ContractState class, in their own WASM. Bytes cross between them.
const asRuntime = (st) => RuntimeState.deserialize(st.serialize());
const authorityOf = (a) => ({ committee: a.committee.length, threshold: a.threshold, counter: a.counter });

test('what counts as locked: a threshold above the committee', () => {
  assert.equal(isLocked(new ContractMaintenanceAuthority([], 1, 0n)), true);
  const one = new ContractMaintenanceAuthority([signatureVerifyingKey(sampleSigningKey())], 1, 0n);
  assert.equal(isLocked(one), false, 'what cages #1-3 have');
});

test('the deploy carries the constructor state, every verifier key, and an authority nobody can use', { skip: needKeys }, async () => {
  const { deploy, unprovenTx } = await buildLockedDeploy(providers(), options());
  const st = deploy.initialState;
  assert.deepEqual(authorityOf(st.maintenanceAuthority), { committee: 0, threshold: 1, counter: 0n });
  assert.equal(st.operations().length, CIRCUITS, 'the circuit count: 11, as cage #3, so the locked deploy fits one transaction (scripts/measure-deploy.mjs)');
  for (const op of st.operations()) assert.ok(st.operation(op), `verifier key for ${op}`);
  const L = ledger(asRuntime(st).data);
  assert.equal(hex(L.judge), hex(args[0])); assert.equal(L.judgeDelay, 2700n); assert.equal(L.escapeSecs, 1800n); assert.equal(L.hasPending, false);
  const intents = [...unprovenTx.intents.values()];
  assert.equal(intents.length, 1);
  const actions = intents[0].actions;
  assert.equal(actions.length, 1, 'the deploy and nothing else');
  assert.equal(actions[0].address, deploy.address);
  assert.deepEqual(authorityOf(actions[0].initialState.maintenanceAuthority), { committee: 0, threshold: 1, counter: 0n });
});

test('deployLocked checks the public state after landing, and sends exactly once', { skip: needKeys }, async () => {
  const sent = [];
  const submit = async (_p, o) => { sent.push(o.unprovenTx); return { status: 'SucceedEntirely', txId: 'x', txHash: 'y' }; };
  let deployed = null;
  const seen = (address) => { deployed = address; return { maintenanceAuthority: new ContractMaintenanceAuthority([], 1, 0n) }; };
  const r = await deployLocked(providers(seen), options(), { submit });
  assert.equal(sent.length, 1); assert.equal(r.address, deployed);

  const notLocked = () => ({ maintenanceAuthority: new ContractMaintenanceAuthority([signatureVerifyingKey(sampleSigningKey())], 1, 0n) });
  await assert.rejects(deployLocked(providers(notLocked), options(), { submit }), /authority is not locked/);
  await assert.rejects(deployLocked(providers(() => null), options(), { submit }), /no contract at/);
  await assert.rejects(deployLocked(providers(seen), options(), { submit: async () => ({ status: 'FailFallible', txId: 'x' }) }), /not applied/);
});

test('judge rotation runs from the locked state: it reads the judge field and never the authority', { skip: needKeys }, async () => {
  const { deploy } = await buildLockedDeploy(providers(), options());
  const contract = new Contract({ secretKey: ({ privateState }) => [privateState, privateState.sk] });
  const next = { sk: b32() };
  const state = lockedState(deploy.initialState);
  assert.equal(isLocked(state.maintenanceAuthority), true);
  let ctx = createCircuitContext(deploy.address, '00'.repeat(32), asRuntime(state).data, judge, undefined, undefined, Number(T0));
  let now = T0;
  const call = (who, name, ...a) => { const cc = { ...ctx, currentPrivateState: who }; cc.currentQueryContext.block = { ...cc.currentQueryContext.block, secondsSinceEpoch: now }; ctx = contract.impureCircuits[name](cc, ...a).context; };
  call(judge, 'proposeJudge', pureCircuits.playerId(next.sk), now);
  assert.throws(() => call(next, 'acceptJudge'), /timelock/);
  now = T0 + 2700n; call(next, 'acceptJudge');
  assert.equal(hex(ledger(ctx.currentQueryContext.state).judge), hex(pureCircuits.playerId(next.sk)));
  assert.throws(() => call(judge, 'proposeJudge', pureCircuits.playerId(judge.sk), now), /judge only/);
  call(next, 'proposeJudge', pureCircuits.playerId(judge.sk), now); call(next, 'cancelJudge');
});
