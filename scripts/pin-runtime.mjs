/**
 * One copy of @midnight-ntwrk/onchain-runtime-v3 per process — Vision 2026-11-01.
 *
 * Why: this repo's install has TWO copies.
 *   - 3.1.2 at the top level, used by compact-runtime 0.16.0 (which asks for "^3.0.0")
 *   - 3.0.0 nested under midnight-js-protocol 4.1.1 (pinned to "3.0.0")
 * midnight-js-contracts wraps contract state in protocol's ChargedState (3.0.0), but the contract's StateValue comes
 * from compact-runtime's copy (3.1.2). So every circuit call fails with "expected instance of StateValue"
 * (seen 10:21 PT 11-01 on enter). A deploy doesn't hit it. halfhand-notary has a single 3.0.0, which is why escrow-ng works.
 *
 * Fix without touching node_modules: a resolve hook sends every import of onchain-runtime-v3 to the copy that
 * midnight-js-protocol resolves (3.0.0). That is the notary's layout, and compact-runtime 0.16.0's own range allows it.
 * Import this BEFORE any Midnight module is loaded, and load those dynamically afterwards: static imports are resolved
 * before any code runs. If the nested copy is gone (e.g. after `npm dedupe`), this does nothing.
 * NO_RUNTIME_PIN=1 turns it off, to reproduce the bug.
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const PROTO = new URL("../node_modules/@midnight-ntwrk/midnight-js-protocol/package.json", import.meta.url).href;
const NESTED = new URL("../node_modules/@midnight-ntwrk/midnight-js-protocol/node_modules/@midnight-ntwrk/onchain-runtime-v3/package.json", import.meta.url);
const version = existsSync(NESTED) ? JSON.parse(readFileSync(NESTED, "utf8")).version : null;
export const runtimePin = version && process.env.NO_RUNTIME_PIN !== "1" ? `onchain-runtime-v3 pinned to ${version} (midnight-js-protocol's copy)` : `onchain-runtime-v3 not pinned${version ? " (NO_RUNTIME_PIN=1)" : " (single copy installed)"}`;
if (version && process.env.NO_RUNTIME_PIN !== "1") {
  registerHooks({
    resolve(spec, ctx, next) {
      if (spec === "@midnight-ntwrk/onchain-runtime-v3" || spec.startsWith("@midnight-ntwrk/onchain-runtime-v3/")) return next(spec, { ...ctx, parentURL: PROTO });
      return next(spec, ctx);
    },
  });
}
