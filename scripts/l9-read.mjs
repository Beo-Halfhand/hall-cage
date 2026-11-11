// Read-only: the cage's public state at the tip or at a block height, on Ledger 9 (11-09). For check-receipt.mjs.
// Same two-era decode as l9-cage.mjs readCage (kept separate: the judge imports l9-cage.mjs and this file must not change it).
import { ContractState } from '@midnight-ntwrk/compact-runtime'; // 0.21.0, the ledger 9 runtime
import * as rt8 from 'cage-l8/runtime'; // 0.16.0, the copy the cage build imports
import { publicData, ledger } from './l9-cage.mjs';

/** The cage's ledger at a block height (omit for the tip). null if the contract did not exist yet. */
export async function cageAt(address, blockHeight) {
  const read = await publicData().queryContractState(address, blockHeight === undefined ? undefined : { type: 'blockHeight', blockHeight });
  if (!read) return null;
  const stateValue = read.contractState.deserialize({
    v8: { deserialize: (bytes) => rt8.ContractState.deserialize(bytes).data.state },
    v9: { deserialize: (bytes) => rt8.StateValue.decode(ContractState.deserialize(bytes).data.state.encode()) },
  });
  return ledger(stateValue);
}
