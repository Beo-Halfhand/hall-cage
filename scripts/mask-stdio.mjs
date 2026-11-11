/**
 * Masks secrets in everything this process writes to stdout/stderr — Vision 2026-11-01 (from halfhand-notary/references/mask-stdio.mjs, 10-30).
 * Library log lines bypass a script's own logging: polkadot's RPC-CORE / API-WS loggers print
 * "disconnected from wss://…?project_id=…" straight to console.error from the wallet SDK's WsProvider.
 * Import it FIRST (before anything that can log). Masks the Blockfrost project id (query param or bare night<network><32>),
 * NIGHTGATE grants (ngat_), ODATANO keys (oda_), Midnight bech32 addresses (mn_…1…) and UUIDs (NIGHTGATE job/session ids).
 */
const PATTERNS = [
  [/project_id(=|%3D)[^&\s"'<>:,;)]+/gi, "project_id$1***"],
  [/night(preprod|preview|mainnet)[A-Za-z0-9]{32}/g, "night$1****"],
  [/ngat_[A-Za-z0-9_-]+/g, "ngat_***"],
  [/oda_[A-Za-z0-9_-]+/g, "oda_***"],
  [/\bmn_[a-z_-]+1[02-9ac-hj-np-z]{20,}/g, "mn_***"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "uuid-***"],
];
export const redact = (s) => PATTERNS.reduce((t, [re, to]) => t.replace(re, to), String(s));

for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => write(typeof chunk === "string" || Buffer.isBuffer(chunk) ? redact(chunk.toString()) : chunk, ...rest);
}
