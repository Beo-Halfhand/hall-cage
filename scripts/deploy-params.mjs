// The maxGrant a deploy passes, and the check on it, in a module of its own so a test can run it without a wallet.
// The constructor's own check (1 second to 365 days) runs only on the deployer's machine: the chain stores whatever state the deploy carries.
// And it takes 720, which is 30 days in hours, as 12 minutes. So the deploy command holds the one value the owner chose, and checks it on chain after.

export const MAX_GRANT_SECS = 2_592_000n; // 30 days, in seconds: The owner's decision of 2026-11-06 (L1)

/** The maxGrant to deploy with, from a command-line argument in seconds. Anything but 30 days needs CAGE_ALLOW_MAX_GRANT=1. */
export function maxGrantArg(arg, env = process.env) {
  const s = arg ?? String(MAX_GRANT_SECS);
  if (!/^\d+$/.test(s)) throw new Error(`maxGrantSecs: a whole number of seconds (not ${s})`);
  const g = BigInt(s);
  if (g !== MAX_GRANT_SECS && env.CAGE_ALLOW_MAX_GRANT !== '1') {
    throw new Error(`maxGrant ${g}s isn't ${MAX_GRANT_SECS}s (30 days, in seconds). The cage is locked once deployed, so another value needs CAGE_ALLOW_MAX_GRANT=1`);
  }
  return g;
}
