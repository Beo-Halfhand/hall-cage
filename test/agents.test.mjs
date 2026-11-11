// Agents on tNIGHT (phase 2, 11-08): the owner's setting, checked with real ledger signatures; the rule it makes; the door for an
// agent's own key; the buy-in max and the daily cap on a seat the agent made itself; a day's loss from the journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUY_IN_MAX_STAR, Journal, agentMessage, agentRule, checkAgentSetting, checkClaim, checkDoor, pacificDayStart, signedForms } from '../scripts/judge-plan.mjs';
import { addressFromKey, sampleSigningKey, signData, signatureVerifyingKey, verifySignature } from './sig-v9.mjs';

const M = 1_000_000n;
const NOW = 2_000_000_000n;
const CAGE = 'e'.repeat(64);
const A = 'a'.repeat(64);
const enc = (s) => new TextEncoder().encode(s);
const opts = { address: CAGE, addressFromKey, verify: (vk, m, sig) => signedForms(m).some((d) => verifySignature(vk, d, sig)) };
const addr = (k) => addressFromKey(signatureVerifyingKey(k));
const chainOf = ({ payTo = {}, seats = {} } = {}) => ({
  table: { epoch: 1n, lastRound: 0n, heartbeat: NOW - 10n, seated: 2n }, seats: new Map(Object.entries(seats)), balance: () => 900n * M,
  payTo: (id) => payTo[id] ?? null, nowSecs: NOW, escapeSecs: 1800n,
});
function signed(key, agent, limit, signedAt = Math.floor(Date.now() / 1000) - 5, lace = true) {
  const message = agentMessage(CAGE, A, agent, limit, signedAt);
  const bytes = enc(lace ? `midnight_signed_message:${message.length}:${message}` : message);
  return { cageId: A, agent, limit, signedAt, message, verifyingKey: signatureVerifyingKey(key), signature: signData(key, bytes) };
}

test('an owner\'s setting: good only from the wallet the cage id pays out to, for exactly this message', () => {
  const owner = sampleSigningKey(), agent = sampleSigningKey(), thief = sampleSigningKey();
  const c = chainOf({ payTo: { [A]: addr(owner) } });
  assert.deepEqual(checkAgentSetting(signed(owner, addr(agent), '1000'), c, opts), { ok: true });
  assert.deepEqual(checkAgentSetting(signed(owner, addr(agent), 'none', undefined, false), c, opts), { ok: true }, 'a script signs the bare message');
  assert.match(checkAgentSetting(signed(thief, addr(agent), 'none'), c, opts).reason, /Only the wallet this cage id pays out to/);
  assert.match(checkAgentSetting(signed(agent, addr(agent), 'none'), c, opts).reason, /Only the wallet/, 'the agent can\'t lift its own cap');
  const raised = signed(owner, addr(agent), '1000');
  raised.limit = '9999';
  assert.match(checkAgentSetting(raised, c, opts).reason, /not the one for this setting/, 'changing the limit breaks it');
  raised.message = agentMessage(CAGE, A, raised.agent, '9999', raised.signedAt);
  assert.match(checkAgentSetting(raised, c, opts).reason, /signature does not match/);
  assert.match(checkAgentSetting(signed(owner, addr(agent), '0'), c, opts).reason, /whole number/);
  assert.match(checkAgentSetting(signed(owner, addr(agent), '1000', Math.floor(Date.now() / 1000) + 3600), c, opts).reason, /signedAt/);
  assert.match(checkAgentSetting(signed(owner, addr(agent), '1000'), chainOf(), opts).reason, /deposits first/);
});

test('the rule a setting makes: the default 1,000 less the day\'s loss, none, stop; nothing without a setting', () => {
  assert.equal(agentRule(null), null);
  assert.deepEqual(agentRule({ limit: '1000' }, 0n), { stopped: false, leftStar: 1000n * M, capStar: 1000n * M });
  assert.deepEqual(agentRule({ limit: '1000' }, 400n * M), { stopped: false, leftStar: 600n * M, capStar: 1000n * M });
  assert.deepEqual(agentRule({ limit: '1000' }, -300n * M), { stopped: false, leftStar: 1000n * M, capStar: 1000n * M }, 'a winning day doesn\'t raise the cap');
  assert.deepEqual(agentRule({ limit: '1000' }, 1200n * M).leftStar, 0n);
  assert.deepEqual(agentRule({ limit: 'none' }, 5000n * M), { stopped: false, leftStar: null, capStar: null });
  assert.equal(agentRule({ limit: 'stop' }).stopped, true);
});

test('the door: an agent\'s own key gets in only under its owner\'s setting, and not after Stop', () => {
  const owner = sampleSigningKey(), agent = sampleSigningKey(), other = sampleSigningKey();
  const c = chainOf({ payTo: { [A]: addr(owner) } });
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const message = `sealed-hand:door:v1|${CAGE}|${A}|${addr(owner)}|${expires}`;
  const door = (key) => ({ cageId: A, payout: addr(owner), expires, message, verifyingKey: signatureVerifyingKey(key), signature: signData(key, enc(message)) });
  const under = (limit, who = agent) => ({ ...opts, settingFor: (id) => (id === A ? { agent: addr(who), limit } : null) });
  assert.match(checkDoor(door(agent), c, opts).reason, /not the payout address/, 'no setting: refused, as before');
  assert.deepEqual(checkDoor(door(agent), c, under('1000')), { ok: true, agent: true });
  assert.match(checkDoor(door(agent), c, under('1000', other)).reason, /not the payout address/, 'a setting for another agent key');
  assert.match(checkDoor(door(agent), c, under('stop')).reason, /owner has stopped it/);
  assert.match(checkDoor({ ...door(agent), signature: door(other).signature }, c, under('1000')).reason, /signature does not match/);
  assert.deepEqual(checkDoor(door(owner), c, under('stop')), { ok: true }, 'the owner\'s own door is the owner\'s');
});

test('a seat the agent made on chain itself: the buy-in max, Stop and the daily cap still hold', () => {
  const owner = sampleSigningKey();
  const seat = (tnight) => ({ table: 1n, epoch: 1n, atRisk: tnight * M, standing: false, standAt: 0n });
  const c = (tnight) => chainOf({ payTo: { [A]: addr(owner) }, seats: { [A]: seat(tnight) } });
  const claim = { cageId: A, door: true, at: Date.now() };
  assert.equal(checkClaim(claim, 1, c(250n), opts).ok, true);
  assert.equal(BUY_IN_MAX_STAR, 250n * M);
  assert.deepEqual([checkClaim(claim, 1, c(251n), opts).ok, checkClaim(claim, 1, c(251n), opts).code], [false, 'buy_in_max']);
  assert.equal(checkClaim(claim, 1, c(50n), { ...opts, ruleFor: () => ({ stopped: true }) }).code, 'agent_stopped');
  const left = (n) => ({ ...opts, ruleFor: () => ({ stopped: false, leftStar: n * M, capStar: 1000n * M }) });
  assert.equal(checkClaim(claim, 1, c(200n), left(150n)).code, 'daily_cap');
  assert.match(checkClaim(claim, 1, c(200n), left(150n)).reason, /more than the 150 this agent has left/);
  assert.equal(checkClaim(claim, 1, c(100n), left(150n)).ok, true);
});

test('a day\'s loss from the journal: since midnight Pacific, debits less credits, a failed settle never counts', () => {
  const j = new Journal();
  const line = (batch, at, debit, credit, type = 'landed') => {
    j.apply({ type: 'intent', batch, entries: [{ table: 'T', cageTable: 1, roundNo: '1', seqs: [1], rounds: [1], lines: [{ id: A, debit: String(debit * M), credit: String(credit * M) }, { id: 'b'.repeat(64), debit: '0', credit: String(debit * M) }] }], at });
    j.apply({ type, batch, id: 'x', hash: 'h', block: 1, status: 'SucceedEntirely', reason: 'r', at });
  };
  const day = pacificDayStart(Date.parse('2026-11-08T23:48:00Z'));
  assert.equal(new Date(day).toISOString(), '2026-11-08T08:00:00.000Z', 'PST: midnight in Los Angeles is 08:00 UTC');
  assert.equal(new Date(pacificDayStart(Date.parse('2026-07-01T12:00:00Z'))).toISOString(), '2026-07-01T07:00:00.000Z', 'PDT: 07:00 UTC');
  line('y', '2026-11-08T07:59:00Z', 500n, 0n); // yesterday, Pacific
  line('a', '2026-11-08T09:00:00Z', 40n, 0n);
  line('b', '2026-11-08T10:00:00Z', 0n, 15n);
  line('c', '2026-11-08T11:00:00Z', 70n, 0n, 'failed');
  j.apply({ type: 'intent', batch: 'd', entries: [{ table: 'T', cageTable: 1, roundNo: '2', seqs: [2], rounds: [2], lines: [{ id: A, debit: String(5n * M), credit: '0' }] }], at: '2026-11-08T12:00:00Z' }); // out there, not seen land yet
  assert.equal(j.lossSince(A, day), 30n * M, '40 lost, 15 won back, 5 out there; yesterday and the failed one don\'t count');
});
