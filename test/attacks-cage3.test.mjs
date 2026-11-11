// Runs test/attacks.test.mjs against cage #3's code (npm run compile:cage3 builds it). Every attack must get through there:
// a test in that file that passes on the old code wouldn't be showing anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const root = new URL('..', import.meta.url).pathname;
const build = `${root}contracts/managed/cage3`;
const names = [...readFileSync(`${root}test/attacks.test.mjs`, 'utf8').matchAll(/^test\('(.+)', \(\) => \{$/gm)].map((m) => m[1]);

test('every attack in attacks.test.mjs gets through on cage #3', { skip: existsSync(`${build}/contract/index.js`) ? false : 'run npm run compile:cage3 first' }, () => {
  assert.ok(names.length >= 8, `found ${names.length} attack tests`);
  const { NODE_TEST_CONTEXT: _child, ...env } = process.env; // left set, the child would report to this runner instead of printing
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/attacks.test.mjs'], { cwd: root, env: { ...env, MANAGED: build }, encoding: 'utf8', timeout: 120_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const notOk = new Set([...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]));
  const ok = [...out.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(ok.filter((n) => names.includes(n)), [], 'these pass on cage #3, so they prove nothing');
  for (const n of names) assert.ok(notOk.has(n), `no failure reported for: ${n}`);
});
