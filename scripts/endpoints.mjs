/**
 * Midnight endpoints for escrow-self.mjs and pot-runner.mjs — Vision 2026-11-01.
 * Order per endpoint: MIDNIGHT_* in the shell, then NIGHTGATE_* in the shell, then NIGHTGATE_* in ENDPOINTS_ENV
 * (default ../halfhand-notary/.env, the file escrow-ng and the notary already use for the Blockfrost node + indexer).
 * Only these three names are read from that file: NIGHTGATE_NODE_URL, NIGHTGATE_INDEXER_HTTP_URL, NIGHTGATE_INDEXER_WS_URL.
 * No seed, token or other value is read. Values are never printed: describe() gives the variable name and the host only.
 * There is no fallback to the public rpc.preprod.midnight.network node (the 10-28 node) or the public indexer (gone since 10-09).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FILE = process.env.ENDPOINTS_ENV ?? join(homedir(), "workspace", "halfhand-notary", ".env");
const FROM_FILE = ["NIGHTGATE_NODE_URL", "NIGHTGATE_INDEXER_HTTP_URL", "NIGHTGATE_INDEXER_WS_URL"];
const short = (f) => f.replace(homedir(), "~");

function fileValues() {
  const out = {};
  if (!existsSync(FILE)) return out;
  for (const line of readFileSync(FILE, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && FROM_FILE.includes(m[1])) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** ws(s):// → http(s)://, query string (project_id) kept — same as nightgate-tx nodeHttpUrlFor. */
export function httpFor(wsUrl) {
  const u = new URL(wsUrl);
  if (u.protocol === "wss:") u.protocol = "https:"; else if (u.protocol === "ws:") u.protocol = "http:";
  return u.toString().replace(/\/$/, "");
}

export function loadEndpoints() {
  const f = fileValues();
  const pick = (...names) => {
    for (const n of names) {
      if (process.env[n]) return { value: process.env[n], src: `${n} (shell)` };
      if (f[n]) return { value: f[n], src: `${n} (${short(FILE)})` };
    }
    return { value: null, src: `none of ${names.join(" / ")} set (shell or ${short(FILE)})` };
  };
  const node = pick("MIDNIGHT_NODE_WS", "NIGHTGATE_NODE_URL");
  const indexer = pick("MIDNIGHT_INDEXER", "NIGHTGATE_INDEXER_HTTP_URL");
  const indexerWS = pick("MIDNIGHT_INDEXER_WS", "NIGHTGATE_INDEXER_WS_URL");
  const missing = [["node", node], ["indexer", indexer], ["indexerWS", indexerWS]].filter(([, x]) => !x.value).map(([k]) => k);
  if (node.value && !/^wss?:/.test(node.value)) missing.push("node (must be ws:// or wss://)");
  const host = (x) => { try { return new URL(x.value).host; } catch { return "?"; } };
  return {
    node: node.value, nodeHttp: node.value && /^wss?:/.test(node.value) ? httpFor(node.value) : null,
    indexer: indexer.value, indexerWS: indexerWS.value, missing,
    publicNode: !!node.value && /rpc\.[a-z]+\.midnight\.network/.test(node.value),
    describe: () => [
      `node      ${node.src} · host ${node.value ? host(node) : "—"}`,
      `indexer   ${indexer.src} · host ${indexer.value ? host(indexer) : "—"}`,
      `indexerWS ${indexerWS.src} · host ${indexerWS.value ? host(indexerWS) : "—"}`,
    ],
  };
}
