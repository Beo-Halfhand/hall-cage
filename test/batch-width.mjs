// How many entries the compiled contract's settleBatch takes, read from that build, so one test file runs against any build:
// v4b's is 4 (an 8-wide batch's proof took too long to dismiss for a small settle on preprod), cage #3's is 8.
import { readFileSync } from 'node:fs';

/** `contractIndex`: a path or URL of the build's contract/index.js. */
export function batchWidth(contractIndex) {
  const m = /Vector<(\d+), struct Maybe<is_some: Boolean, value: struct Entry/.exec(readFileSync(contractIndex, 'utf8'));
  if (!m) throw new Error(`no settleBatch entry vector in ${contractIndex}`);
  return Number(m[1]);
}
