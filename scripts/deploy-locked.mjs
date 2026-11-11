// Deploys with a maintenance authority nobody can use: an empty committee with threshold 1. No key could ever sign a change
// to this contract's verifier keys, and anyone can check that on the public state. The idea and shape come from Nightcast
// (deploy/src/steps.ts, MIT, Copyright (c) 2026 LearnMidnight).
//
// This doesn't touch judge rotation. The judge is a ledger field written by a proven circuit, and rotation never reads the authority.
// It only works for a constructor that creates no coins, because the transaction is rebuilt as the deploy and nothing else. Ours creates none.
const { ContractDeploy, ContractMaintenanceAuthority, ContractState, Intent, Transaction, sampleSigningKey } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
const { getNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
const { ttlOneHour } = await import('@midnight-ntwrk/midnight-js-utils');
const { createUnprovenDeployTx, submitTx } = await import('@midnight-ntwrk/midnight-js-contracts');

/** An authority can't sign anything when its threshold is above its committee size. */
export const isLocked = (authority) => authority.threshold > authority.committee.length;

/** The state the constructor produced, with the authority swapped for one nobody can use. The input isn't changed. */
export function lockedState(initialContractState) {
  const state = ContractState.deserialize(initialContractState.serialize());
  state.maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 0n);
  if (!isLocked(state.maintenanceAuthority)) throw new Error('internal: the locked authority is not locked');
  return state;
}

/** Builds the unproven, locked deploy transaction. Nothing is sent. */
export async function buildLockedDeploy(providers, options) {
  // The signing key is never used: the authority it would belong to is replaced before anything is sent, and it's not kept.
  const built = await createUnprovenDeployTx(providers, { ...options, signingKey: sampleSigningKey() });
  const deploy = new ContractDeploy(lockedState(built.public.initialContractState));
  const unprovenTx = Transaction.fromParts(getNetworkId(), undefined, undefined, Intent.new(ttlOneHour()).addDeploy(deploy));
  return { deploy, unprovenTx };
}

/** Sends it, then checks the public state: an address with the wrong authority on chain is an error, not a success. */
export async function deployLocked(providers, options, { submit = submitTx } = {}) {
  const { deploy, unprovenTx } = await buildLockedDeploy(providers, options);
  const finalized = await submit(providers, { unprovenTx });
  if (String(finalized?.status) !== 'SucceedEntirely') throw new Error(`deploy landed as ${finalized?.status}: not applied`);
  const onChain = await providers.publicDataProvider.queryContractState(deploy.address);
  if (!onChain) throw new Error(`deploy ${finalized.txId} was accepted but no contract at ${deploy.address}`);
  if (!isLocked(onChain.maintenanceAuthority)) throw new Error(`contract ${deploy.address} was deployed but its authority is not locked`);
  return { address: deploy.address, finalized };
}
