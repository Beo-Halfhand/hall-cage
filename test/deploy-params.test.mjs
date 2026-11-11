// The deploy command's maxGrant: the constructor's own range check runs only on the deployer's machine and takes 720 (30 days in hours)
// as 12 minutes, so cage.mjs deploys only the owner's 30 days, unless told otherwise on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_GRANT_SECS, maxGrantArg } from '../scripts/deploy-params.mjs';

test('deploy: maxGrant is 30 days in seconds unless CAGE_ALLOW_MAX_GRANT=1, so a unit mistake stops before anything is built', () => {
  assert.equal(MAX_GRANT_SECS, 2_592_000n);
  assert.equal(maxGrantArg(undefined, {}), 2_592_000n, 'the default');
  assert.equal(maxGrantArg('2592000', {}), 2_592_000n);
  for (const [wrong, what] of [['720', '30 days in hours'], ['43200', 'in minutes'], ['30', 'in days'], ['2592000000', 'in milliseconds'], ['21600000', '6 hours in milliseconds']]) {
    assert.throws(() => maxGrantArg(wrong, {}), /isn't 2592000s \(30 days, in seconds\)/, what);
  }
  for (const junk of ['30d', '2592000.5', '-1', '', '0x278d00']) assert.throws(() => maxGrantArg(junk, {}), /a whole number of seconds/, `"${junk}"`);
  assert.equal(maxGrantArg('3600', { CAGE_ALLOW_MAX_GRANT: '1' }), 3600n, 'another value on purpose, for a test cage');
});
