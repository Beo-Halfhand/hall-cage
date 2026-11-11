// The judge's seat authority, wired: the real cycle in judge-cycle.mjs, the real circuits in the simulator, and a small stand-in for the Worker. No network, no proofs.
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ENTRIES_PER_BATCH, Journal, HOP_GAP_MS, HOP_PATIENCE_MS, SEAT_MARGIN_SECS, planAsk, planTable } from '../scripts/judge-plan.mjs';
import { batchWidth } from './batch-width.mjs';
import { byNeed, chainFor, checkBatchWidth, fillBatch, makeJudge, permitSummary, SEAT_TRIES, TAIL_SENDS, UNKNOWN_AFTER_MS } from '../scripts/judge-cycle.mjs';
import { checkClaim } from '../scripts/judge-plan.mjs';
import { NIGHT, b32, hex, idOf, simChain, simWallet, unhex } from './sim-chain.mjs';

const T0 = 1_900_000_000n, HOURS12 = 43_200n;
// v4b: a move is seatByJudge with a from-table, and a single settle is a batch of one. MOVE is how sentCircuits() names a move.
const NO_FROM = { is_some: false, value: 0n }, MOVE = 'seatByJudge (move)';
const WIDTH = batchWidth(new URL(`${process.env.MANAGED ?? '../contracts/managed/sealed-cage'}/contract/index.js`, import.meta.url));
const one = (e) => [{ is_some: true, value: e }, ...Array(WIDTH - 1).fill({ is_some: false, value: e })];
const row = (n, over = {}) => ({ id: `T${n}`, cageTable: n, game: 'sealed-hand', status: 'open', phase: 'lobby', live: false, over: false, wantHouse: false, warm: false, claims: [], holders: [], entries: [], releases: [], house: null, wantBots: 0, ante: 5, lastChainRound: 0, alert: null, done: false, ...over });
const holder = (cageId, over = {}) => ({ cageId, kind: 'player', left: false, epoch: 1, released: false, ...over });
const ask = (cageId, tnight, at = 0) => ({ cageId, at, door: true, ask: { atRiskStar: String(BigInt(tnight) * NIGHT) } });

function rig({ tables = [], doors = [], agents = [], dust = 10n ** 18n, minDust = 0n, cap } = {}) {
  let now = T0;
  const chain = simChain({ clock: () => now, ...(cap ? { cap } : {}) });
  const wallet = simWallet(chain);
  const posts = [];
  const lines = [];
  const journal = new Journal();
  const worker = async (method, path, body) => {
    if (method === 'GET') return { ok: true, status: 200, body: { address: chain.address, tables: structuredClone(j.tables), doors: j.doors, agents: structuredClone(j.agents), games: [] } }; // a copy, as the real Worker's answer is: what's posted back doesn't change this cycle's snapshot
    posts.push({ path, body });
    j.onPost?.(path, body);
    const m = /^\/judge\/tables\/([^/]+)\/(\w+)$/.exec(path);
    const r = m && j.tables.find((x) => x.id === m[1]);
    if (r && m[2] === 'verified') {
      r.claims = r.claims.filter((c) => c.cageId !== body.cageId);
      if (body.ok) r.holders.push(holder(body.cageId, { epoch: body.epoch }));
    }
    if (r && m[2] === 'released') {
      r.releases = r.releases.filter((x) => x.cageId !== body.cageId);
      const h = r.holders.find((x) => x.cageId === body.cageId);
      if (h) h.released = true;
    }
    if (r && m[2] === 'settled') r.entries = r.entries.filter((e) => !body.seqs.includes(e.seq));
    if (r && m[2] === 'seated') r.seatedBy = body;
    return { ok: true, status: 200, body: {} };
  };
  const j = {
    tables, doors, agents, chain, wallet, posts, journal, lines,
    now: () => now,
    at: (t) => { now = BigInt(t); },
    dust,
    judge: null,
  };
  j.judge = makeJudge({
    address: chain.address, worker, readChain: async () => chain.state(), callCircuit: (...a) => wallet.callCircuit(...a), probeTx: async (id) => j.seen?.[id] ?? null,
    dustNow: async () => j.dust, journal, record: (r) => { const line = { ...r, at: new Date(Number(now) * 1000).toISOString() }; lines.push(line); journal.apply(line); },
    log: () => {}, judgeKey: hex(chain.judge.sk), idOf: (k) => hex(idOf(unhex(k))), houseKeyFor: () => hex(b32()), payoutOf: () => ({ bytes: b32() }),
    declaredNow: () => now - 60n, checkOpts: () => ({ address: chain.address, addressFromKey: (k) => k, verify: () => true }), prewarm: 0, minDust,
    clock: () => Number(now) * 1000,
  });
  j.judgeId = hex(idOf(chain.judge.sk));
  j.player = (tnight = 100n, { cap = tnight, until = T0 + HOURS12, judge = idOf(chain.judge.sk) } = {}) => {
    const sk = b32(); const addr = { bytes: b32() };
    chain.call(sk, 'deposit', addr, tnight * NIGHT, judge, cap * NIGHT, until);
    return { sk, id: hex(idOf(sk)), payout: hex(addr.bytes) };
  };
  j.liveTable = (n) => { const sk = b32(); chain.call(sk, 'deposit', { bytes: b32() }, 100n * NIGHT, new Uint8Array(32), 0n, 0n); chain.call(sk, 'sit', BigInt(n), 100n * NIGHT, now - 60n); return { sk, id: hex(idOf(sk)) }; };
  j.seat = (p) => { const L = chain.state(); const k = idOf(p.sk); return L.seat.member(k) ? { ...L.seat.lookup(k), atRisk: L.risks.lookup(k) } : null; };
  j.sentCircuits = () => wallet.sent.map((x) => (x.kind === 'move' ? MOVE : x.circuit)); // a move and a seat are one circuit since v4b: tell them apart by the from-table
  j.post = (suffix) => posts.filter((p) => p.path.endsWith(suffix));
  return j;
}

test('fair batches: the nearest deadline first, then one item from each table in turn, each table\'s own entries in order, and a stand about to run out before all', () => {
  const it = (t, k) => ({ table: t, k });
  const names = (b) => b.map((x) => x.table + x.k);
  const busy = ['A', 'B', 'C', 'D'].map((t) => ({ items: [it(t, 1), it(t, 2), it(t, 3)], urgent: false, deadline: 5000n }));
  const late = { items: [it('E', 1)], urgent: false, deadline: 1000n };
  assert.deepEqual(names(fillBatch([], [...busy, late], 4)), ['E1', 'A1', 'B1', 'C1'], 'listed last, nearest its deadline: it goes first');
  assert.deepEqual(names(fillBatch([], busy.slice(0, 2), 4)), ['A1', 'B1', 'A2', 'B2'], 'round by round, so no table waits behind another\'s backlog');
  assert.deepEqual(names(fillBatch([], [...busy, late, { items: [it('U', 1)], urgent: true, deadline: 9000n }], 4)), ['U1', 'E1', 'A1', 'B1'], 'a stand about to run out first of all');
  assert.deepEqual(names(fillBatch([], [{ items: [it('N', 1)], urgent: false, deadline: null }, busy[0]], 4)), ['A1', 'N1', 'A2', 'A3'], 'no deadline goes after the ones that have one');
  assert.deepEqual(names(fillBatch([], [busy[0]], 4)), ['A1', 'A2', 'A3'], 'fewer than a batch: all of it');
});

test('fair batches in a cycle: four busy tables listed first can\'t keep a fifth, nearer its deadline, out of the batch (review of v4b, H-1)', async () => {
  const busy = [1, 2, 3, 4].map((n) => row(n, { phase: 'settled' }));
  const late = row(5, { phase: 'settled' });
  const j = rig({ tables: [...busy, late] });
  const x = j.liveTable(5), y = j.liveTable(5); // sat first, so its table's deadline is the nearest
  j.at(T0 + 300n);
  for (const r of busy) {
    const a = j.liveTable(r.cageTable), b = j.liveTable(r.cageTable);
    r.holders = [holder(a.id), holder(b.id)];
    r.entries = [1, 2].map((k) => ({ seq: k, rounds: [k], lines: [{ id: a.id, delta: -1 }, { id: b.id, delta: 1 }], at: k }));
  }
  late.holders = [holder(x.id), holder(y.id)];
  late.entries = [{ seq: 1, rounds: [1], lines: [{ id: x.id, delta: -10 }, { id: y.id, delta: 10 }], at: 1 }];
  await j.judge.cycle();
  const round = (n) => j.chain.state().tables.lookup(BigInt(n)).lastRound;
  const batches = j.wallet.sent.filter((x) => x.circuit === 'settleBatch').map((x) => x.label.split(' ')[1]);
  assert.equal(batches[0], 't5r1+t1r1+t2r1+t3r1', 'the first batch: listed last and nearest its deadline first, then one from each busy table in the Worker\'s order, not two from the first two');
  assert.equal(batches[1], 't4r1+t1r2+t2r2+t3r2', 'the second (M-1): the table the first left out goes first, then the next round of each');
  assert.equal(round(5), 1n);
  assert.deepEqual([1, 2, 3, 4].map(round), [2n, 2n, 2n, 1n]);
  for (let i = 0; i < 3; i++) await j.judge.cycle();
  assert.deepEqual([1, 2, 3, 4, 5].map(round), [2n, 2n, 2n, 2n, 1n], 'every round once, each table in order');
});

test('fair batches: with equal deadlines the round that has waited longest goes first', () => {
  const names = (b) => b.map((x) => x.table);
  const at = (t, when) => ({ items: [{ table: t, at: when }], urgent: false, deadline: 100n });
  assert.deepEqual(names(fillBatch([], [at('A', 50), at('B', 10), at('C', 30)], 2)), ['B', 'C']);
  assert.deepEqual(names(fillBatch([], [at('A', 50), { items: [{ table: 'K', keepAlive: true }], urgent: false, deadline: 100n }], 1)), ['K'], 'a keep-alive has no round: it counts as oldest');
  assert.deepEqual(names(fillBatch([], [{ ...at('A', 10), served: 1 }, { ...at('B', 10), served: 0 }], 1)), ['B'], 'still equal: the table settled less this cycle goes first (M-1)');
});

test('a table whose settle the cage keeps refusing is settled on its own, so the tables beside it keep landing (review of the fair batch, H-2)', async () => {
  const tables = [1, 2, 3].map((n) => row(n, { phase: 'settled' }));
  const j = rig({ tables });
  const seated = tables.map((r) => { const a = j.liveTable(r.cageTable), b = j.liveTable(r.cageTable); r.holders = [holder(a.id), holder(b.id)]; return { a, b }; });
  const real = j.wallet.callCircuit.bind(j.wallet);
  j.wallet.callCircuit = async (circuit, sk, args, ...rest) => { // the cage refuses any batch with table 1 in it
    if (circuit === 'settleBatch' && args[0].some((e) => e.is_some && e.value.table === 1n)) throw new Error('refused before the pool');
    return real(circuit, sk, args, ...rest);
  };
  for (let c = 0; c < 6; c++) {
    for (const [i, r] of tables.entries()) r.entries.push({ seq: c + 1, rounds: [c + 1], lines: [{ id: seated[i].a.id, delta: -1 }, { id: seated[i].b.id, delta: 1 }], at: c });
    await j.judge.cycle();
    j.at(j.now() + 30n);
  }
  const round = (n) => j.chain.state().tables.lookup(BigInt(n)).lastRound;
  assert.deepEqual([round(2), round(3)], [6n, 6n], 'every round at the other tables landed');
  assert.equal(round(1), 0n, 'the refused table settles nothing, and only it waits');
});

test('roundCap: the judge never seats more than it, refuses a seat over it, and blocks a line over it instead of sending it again and again (review of v4b, H-3)', async () => {
  const cap = 10n * NIGHT;
  { const j = rig({ tables: [row(1)], cap }); const p = j.player(100n, { cap: 100n });
    j.tables[0].claims = [ask(p.id, 50n, Number(T0) * 1000)];
    await j.judge.cycle();
    assert.equal(j.seat(p).atRisk, cap, 'asked for 50, seated with roundCap'); }
  { const j = rig({ tables: [row(1)], cap }); const self = j.liveTable(1); // sat for itself, with 100 at risk
    const r = checkClaim({ cageId: self.id, door: true, at: Number(T0) * 1000 }, 1, chainFor(j.chain.state(), 1, j.now()), { address: j.chain.address, addressFromKey: (k) => k, verify: () => true, now: Number(T0) * 1000 });
    assert.equal(r.ok, false); assert.match(r.reason, /over the cage's limit/); }
  { const t = row(1, { phase: 'settled' }); const j = rig({ tables: [t], cap });
    const a = j.liveTable(1), b = j.liveTable(1); t.holders = [holder(a.id), holder(b.id)];
    t.entries = [{ seq: 1, rounds: [1], lines: [{ id: a.id, delta: -11 }, { id: b.id, delta: 11 }], at: 1 }];
    await j.judge.cycle();
    assert.ok(!j.sentCircuits().includes('settleBatch'), 'not sent: the cage would refuse it every time');
    assert.ok(j.post('/alert').some((x) => /over the cage's roundCap/.test(x.body.message)), 'a person is told'); }
});

test('a player who left a busy table is released in the same cycle its round settles, not only once the table stops (review of the fair batch, M-2)', async () => {
  const t = row(1, { phase: 'settled' });
  const j = rig({ tables: [t] });
  const a = j.liveTable(1), b = j.liveTable(1), z = j.liveTable(1);
  t.holders = [holder(a.id), holder(b.id), holder(z.id, { left: true })];
  t.releases = [{ cageId: z.id, kind: 'player' }];
  t.entries = [{ seq: 1, rounds: [1], lines: [{ id: a.id, delta: -1 }, { id: b.id, delta: 1 }], at: 1 }];
  await j.judge.cycle();
  assert.equal(j.chain.state().tables.lookup(1n).lastRound, 1n, 'the round settled');
  assert.equal(j.seat(z), null, 'and the player who left was released in the same cycle');
});

test('the judge stops at start if the compiled cage\'s batch is not its own (review of v4b, L-1)', () => {
  assert.equal(checkBatchWidth(readFileSync(new URL(`${process.env.MANAGED ?? '../contracts/managed/sealed-cage'}/contract/index.js`, import.meta.url), 'utf8')), ENTRIES_PER_BATCH);
  const cage3 = new URL('../contracts/managed/cage3/contract/index.js', import.meta.url);
  if (existsSync(cage3)) assert.throws(() => checkBatchWidth(readFileSync(cage3, 'utf8')), /takes 8 entries, and this judge sends 4/);
  assert.throws(() => checkBatchWidth('nothing here'), /no settleBatch/);
});

test('more tables waiting than a batch holds: one full batch, then a second in the same cycle while rounds wait, never a third, and every round lands once (review of the fair batch, M-1)', async () => {
  const n = 2 * ENTRIES_PER_BATCH + 2;
  const tables = Array.from({ length: n }, (_, i) => row(i + 1, { phase: 'settled' }));
  const j = rig({ tables });
  for (const [i, r] of tables.entries()) {
    const a = j.liveTable(i + 1), b = j.liveTable(i + 1);
    r.holders = [holder(a.id), holder(b.id)];
    r.entries = [{ seq: 1, rounds: [1], lines: [{ id: a.id, delta: -3 }, { id: b.id, delta: 3 }], at: 1 }];
  }
  const settledNow = () => tables.filter((r) => j.chain.state().tables.lookup(BigInt(r.cageTable)).lastRound === 1n).length;
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), ['settleBatch', 'settleBatch'], 'two settles, and no more, with rounds still waiting');
  assert.equal(settledNow(), 2 * ENTRIES_PER_BATCH, 'two full batches');
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), ['settleBatch', 'settleBatch', 'settleBatch'], 'the last two in one settle: nothing waits after it, so no second');
  assert.equal(settledNow(), n, 'the rest in the next cycle');
  for (const r of tables) assert.equal(j.chain.state().tables.lookup(BigInt(r.cageTable)).lastRound, 1n, 'each round once');
  await j.judge.cycle();
  assert.equal(j.sentCircuits().length, 3, 'nothing left, nothing sent');
});

/** Busy tables with a round each waiting, more than one batch holds. */
function busyRig(n = ENTRIES_PER_BATCH + 2, opts = {}) {
  const tables = Array.from({ length: n }, (_, i) => row(i + 1, { phase: 'settled' }));
  const j = rig({ tables, ...opts });
  for (const [i, r] of tables.entries()) {
    const a = j.liveTable(i + 1), b = j.liveTable(i + 1);
    r.holders = [holder(a.id), holder(b.id)];
    r.entries = [{ seq: 1, rounds: [1], lines: [{ id: a.id, delta: -3 }, { id: b.id, delta: 3 }], at: 1 }];
  }
  j.settles = () => j.wallet.sent.filter((x) => x.circuit === 'settleBatch');
  return j;
}

test('the second settle respects DUST: under twice the floor (where seats already stop) the backlog waits for the next cycle, and the first settle still goes (M-1)', async () => {
  const j = busyRig(ENTRIES_PER_BATCH + 2, { minDust: 10n });
  j.dust = 19n;
  await j.judge.cycle();
  assert.equal(j.settles().length, 1, 'only the first');
  j.dust = 20n;
  await j.judge.cycle();
  assert.equal(j.settles().length, 2, 'at the reserve, the backlog settles');
  const k = busyRig(ENTRIES_PER_BATCH + 2, { minDust: 10n });
  k.dust = 20n;
  await k.judge.cycle();
  assert.equal(k.settles().length, 2, 'at the reserve, both in one cycle');
});

test('no second settle after the first failed or went unknown: its rounds may still land, and the round numbers after them would be refused (M-1)', async () => {
  const j = busyRig();
  j.wallet.next = ['refused'];
  await j.judge.cycle();
  assert.equal(j.settles().length, 1, 'refused: no second');
  const k = busyRig();
  k.wallet.next = ['unknown'];
  await k.judge.cycle();
  assert.equal(k.settles().length, 1, 'unknown: no second');
  await k.judge.cycle();
  const out = new Set(k.settles()[0].label.split(' ')[1].split('+').map((x) => x.split('r')[0]));
  assert.ok(k.settles().slice(1).every((s) => s.label.split(' ')[1].split('+').every((x) => !out.has(x.split('r')[0]))), 'the tables in the unknown batch wait; the others settle');
});

test('a suspect table\'s settle alone counts toward the two: never a third settle in a cycle (M-1 with H-2)', async () => {
  const j = busyRig(2 * ENTRIES_PER_BATCH + 1);
  const real = j.wallet.callCircuit.bind(j.wallet);
  let refuse = true;
  const tries = []; // every settle the judge built, refused or not
  j.wallet.callCircuit = async (circuit, sk, args, label, ...rest) => {
    if (circuit === 'settleBatch') tries.push(label);
    if (refuse && circuit === 'settleBatch' && args[0].some((e) => e.is_some && e.value.table === 1n)) throw new Error('refused before the pool');
    return real(circuit, sk, args, label, ...rest);
  };
  await j.judge.cycle(); // table 1 is in the first batch and fails it
  assert.equal(tries.length, 1, 'refused: no second');
  refuse = false;
  await j.judge.cycle(); // now: the clean tables' batch, then table 1 alone, and no backlog settle on top
  assert.equal(tries.length, 3, 'two this cycle, the cap, with rounds still waiting');
  assert.match(tries[2], /^settleBatch t1r1 /, 'the second was the suspect, alone');
  // A refused batch makes every table in it a suspect (H-2), and suspects settle one a cycle, alone. However they drain: two settles a cycle at most.
  for (let c = 0; c < 6; c++) { const before = tries.length; await j.judge.cycle(); assert.ok(tries.length - before <= 2, `cycle ${c + 3}: ${tries.length - before} settles`); }
  const round = (n) => j.chain.state().tables.lookup(BigInt(n)).lastRound;
  assert.deepEqual(Array.from({ length: 2 * ENTRIES_PER_BATCH + 1 }, (_, i) => round(i + 1)), Array(2 * ENTRIES_PER_BATCH + 1).fill(1n), 'every round lands, each once');
});

test('keep-alives alone are no backlog: no second settle for them (M-1)', async () => {
  const n = ENTRIES_PER_BATCH + 1;
  const tables = Array.from({ length: n }, (_, i) => row(i + 1, { phase: 'settled', live: true }));
  const j = rig({ tables });
  for (const [i, r] of tables.entries()) { const a = j.liveTable(i + 1); r.holders = [holder(a.id)]; }
  j.at(T0 + 1800n - 500n); // every table quiet long enough for its settle of nothing
  await j.judge.cycle();
  const settles = j.wallet.sent.filter((x) => x.circuit === 'settleBatch');
  assert.equal(settles.length, 1, 'one settle of keep-alives; the one left over goes next cycle');
  assert.equal(settles[0].label.split(' ')[1].split('+').length, ENTRIES_PER_BATCH);
});

test('L1: the judge seats a player whose grant runs exactly maxGrant (30 days), and one a second longer never gets on chain', async () => {
  const MAXGRANT = 2_592_000n;
  const j = rig({ tables: [row(1)] });
  assert.throws(() => j.player(100n, { until: j.now() + MAXGRANT + 1n }), /a permit runs at most maxGrant/, 'the cage refuses it when it is built');
  const p = j.player(100n, { until: j.now() + MAXGRANT });
  j.tables[0].claims = [ask(p.id, 40n, Number(T0) * 1000)];
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), ['seatByJudge']);
  assert.equal(j.seat(p).table, 1n);
  assert.equal(j.post('/seated')[0].body.until, String(j.now() + MAXGRANT), 'the Worker hears the permit\'s end, in seconds');
});

test('first seat: the judge seats the player under their permit, spending nothing of theirs, and the claim reads it back on the next cycle', async () => {
  const j = rig({ tables: [row(1)] });
  const p = j.player(100n);
  j.tables[0].claims = [ask(p.id, 40n, Number(T0) * 1000)];
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), ['seatByJudge']);
  assert.equal(j.seat(p).table, 1n);
  assert.equal(j.seat(p).atRisk, 40n * NIGHT, 'what was asked, under the cap');
  assert.equal(j.post('/verified').length, 0, 'not yet: the claim is the read-back, on the next cycle');
  const seated = j.post('/seated')[0].body;
  assert.deepEqual([seated.cageId, seated.kind, seated.tx.hash, seated.until], [p.id, 'seat', 'hash-tx1', String(T0 + HOURS12)]);
  await j.judge.cycle();
  const v = j.post('/verified')[0].body;
  assert.deepEqual([v.ok, v.atRiskStar, v.balanceStar], [true, String(40n * NIGHT), String(100n * NIGHT)]);
  assert.deepEqual(j.sentCircuits(), ['seatByJudge'], 'and nothing else was sent');
});

test('the judge places no more than the cap and the floor allow, whatever was asked', async () => {
  const j = rig({ tables: [row(1)] });
  const p = j.player(100n, { cap: 30n });
  j.tables[0].claims = [ask(p.id, 90n)];
  await j.judge.cycle();
  assert.equal(j.seat(p).atRisk, 30n * NIGHT);
  // The cap and the floor agree at the grant. They part after a win, and after a loss.
  const chain = (balance, cap, floor) => ({ table: null, seats: new Map(), tableAt: () => null, balance: () => balance * NIGHT, permit: () => ({ judge: 'J', cap: cap * NIGHT, until: T0 + HOURS12, floor: floor * NIGHT }), judgeId: 'J', maxSeats: 6n, nowSecs: T0, escapeSecs: 1800n });
  const place = (balance, cap, floor, want = 500n) => planAsk(ask(p.id, want), row(9), chain(balance, cap, floor), { nowMs: Number(T0) * 1000 }).atRisk;
  assert.equal(place(150n, 30n, 70n), 30n * NIGHT, 'a win sits above the floor, and the cap still limits a seat');
  assert.equal(place(80n, 30n, 70n), 10n * NIGHT, 'a loss: only what is above the floor');
  assert.equal(place(100n, 30n, 70n, 20n), 20n * NIGHT, 'what they asked, when that is less');
});

for (const [name, make, why] of [
  ['no permit', (j) => j.player(100n, { cap: 0n }), /No permit/],
  ['a permit naming another key: a rotation', (j) => j.player(100n, { judge: b32() }), /key has changed/],
  ['a permit within a landing of running out', (j) => j.player(100n, { until: T0 + SEAT_MARGIN_SECS }), /run out/],
  ['too little left to place at this table', (j) => j.player(100n, { cap: 4n }), /too little left/],
]) {
  test(`refused, with a new grant asked for and nothing spent: ${name}`, async () => {
    const j = rig({ tables: [row(1)] });
    const p = make(j);
    j.tables[0].claims = [ask(p.id, 40n)];
    await j.judge.cycle();
    assert.deepEqual(j.sentCircuits(), []);
    const v = j.post('/verified')[0].body;
    assert.equal(v.ok, false);
    assert.equal(v.code, 'need_grant');
    assert.match(v.reason, why);
  });
}

test('a standing seat and a table the Worker has dealt are refused before a proof is spent', async () => {
  const j = rig({ tables: [row(1, { phase: 'pass' })] });
  const p = j.player(100n);
  j.tables[0].claims = [ask(p.id, 40n)];
  await j.judge.cycle();
  assert.equal(j.post('/verified')[0].body.code, 'table_started');
  assert.deepEqual(j.sentCircuits(), []);

  const k = rig({ tables: [row(1), row(2)] });
  const q = k.player(100n);
  k.tables[0].claims = [ask(q.id, 40n)];
  await k.judge.cycle();
  k.chain.call(q.sk, 'stand', 1n, k.now() - 60n);
  k.tables[1].claims = [ask(q.id, 40n)];
  k.posts.length = 0;
  await k.judge.cycle();
  const refused = k.posts.find((x) => x.path.includes('/T2/verified'));
  assert.equal(refused.body.code, 'standing');
});

test('a hop: settle first, then one move in one transaction, with no release and no gap for a stranger\'s rescue', async () => {
  const j = rig({ tables: [row(1, { phase: 'settled' }), row(2)] });
  const keeper = j.liveTable(1);
  const p = j.player(100n);
  const seatedAt = (n) => j.chain.state().seats.lookup(BigInt(n)).read();
  j.chain.call(j.chain.judge.sk, 'seatByJudge', unhex(p.id), NO_FROM, 1n, 50n * NIGHT, j.now() - 60n);
  j.tables[0].holders = [holder(keeper.id), holder(p.id, { left: true })];
  j.tables[0].entries = [{ seq: 1, rounds: [1], lines: [{ id: p.id, delta: -10 }, { id: keeper.id, delta: 10 }], at: 1 }];
  j.tables[1].claims = [ask(p.id, 50n, Number(T0) * 1000)];
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), ['settleBatch'], 'the settle goes first, and the move waits: its entry is still open in what the Worker sent');
  assert.equal(j.seat(p).table, 1n);
  assert.equal(j.seat(p).atRisk, 40n * NIGHT);
  j.tables[0].releases = [{ cageId: p.id, kind: 'player' }];
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), ['settleBatch', MOVE]);
  assert.equal(j.seat(p).table, 2n);
  assert.equal(j.seat(p).atRisk, 50n * NIGHT, 'the new atRisk: a loss comes off the balance, and the floor here is 0');
  assert.equal(seatedAt(1), 1n);
  assert.equal(seatedAt(2), 1n);
  assert.equal(j.post('/T1/released')[0].body.cageId, p.id, 'the old table hears it is done with them');
  assert.equal(j.post('/T2/seated')[0].body.kind, 'move');
  assert.ok(!j.sentCircuits().includes('release'));
});

test('N-1, kept shut: a player can\'t hop away from a loss. No move while their round is on, while a line is still to come, or while an entry names them', async () => {
  const setup = () => {
    const j = rig({ tables: [row(1, { phase: 'pass', live: true }), row(2)] });
    const keeper = j.liveTable(1);
    const p = j.player(100n);
    j.chain.call(j.chain.judge.sk, 'seatByJudge', unhex(p.id), NO_FROM, 1n, 50n * NIGHT, j.now() - 60n);
    j.tables[0].holders = [holder(keeper.id), holder(p.id)];
    j.tables[1].claims = [ask(p.id, 50n, Number(T0) * 1000)];
    return { j, keeper, p };
  };
  const stayed = async ({ j, p }, label) => {
    for (let i = 0; i < 3; i += 1) await j.judge.cycle();
    assert.ok(!j.sentCircuits().includes(MOVE), label);
    assert.ok(!j.sentCircuits().includes('release'), label);
    assert.equal(j.seat(p).table, 1n, label);
    assert.equal(j.post('/verified').length, 0, `${label}: the ask waits, it isn't refused`);
  };
  await stayed(setup(), 'still playing');
  const left = setup(); left.j.tables[0].holders[1].left = true;
  await stayed(left, 'left, but the Worker doesn\'t list them as free: a line is still to come');
  const held = setup(); held.j.tables[0].entries = [{ seq: 1, rounds: [1], lines: [{ id: held.p.id, delta: -5 }, { id: held.keeper.id, delta: 5 }] }];
  held.j.tables[0].holders[1].left = true; held.j.tables[0].releases = [{ cageId: held.p.id, kind: 'player' }];
  held.j.wallet.next = ['refused', 'refused', 'refused'];
  await held.j.judge.cycle();
  assert.ok(!held.j.sentCircuits().includes(MOVE), 'an entry naming them is open, even with a release listed');
});

test('both tables in a move count as busy: nothing moves while a transaction is out at either', async () => {
  for (const busy of ['T1', 'T2']) {
    const j = rig({ tables: [row(1, { phase: 'settled' }), row(2)] });
    const keeper = j.liveTable(1);
    const p = j.player(100n);
    j.chain.call(j.chain.judge.sk, 'seatByJudge', unhex(p.id), NO_FROM, 1n, 50n * NIGHT, j.now() - 60n);
    j.tables[0].holders = [holder(keeper.id), holder(p.id, { left: true })];
    j.tables[0].releases = [{ cageId: p.id, kind: 'player' }];
    j.tables[1].claims = [ask(p.id, 50n, Number(T0) * 1000)];
    j.journal.apply({ type: 'intent', batch: 'b1', entries: [{ table: busy, cageTable: Number(busy.slice(1)), roundNo: '1', seqs: [1], rounds: [1], lines: [] }] });
    j.journal.apply({ type: 'sent', batch: 'b1', id: 'tx-out', at: new Date(Number(T0) * 1000).toISOString() });
    await j.judge.cycle();
    assert.ok(!j.sentCircuits().includes(MOVE), busy);
    assert.equal(j.seat(p).table, 1n, busy);
  }
});

test('on Leave: released, unless the next table is known. Then the move takes the seat off, and no release is sent', async () => {
  const j = rig({ tables: [row(1, { phase: 'settled' })] });
  const keeper = j.liveTable(1);
  const p = j.player(100n);
  j.chain.call(j.chain.judge.sk, 'seatByJudge', unhex(p.id), NO_FROM, 1n, 50n * NIGHT, j.now() - 60n);
  j.tables[0].holders = [holder(keeper.id), holder(p.id, { left: true })];
  j.tables[0].releases = [{ cageId: p.id, kind: 'player' }];
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), ['release'], 'nowhere to go: a plain release');
  const chain = chainFor(j.chain.state(), 1, j.now());
  const plan = planTable({ ...j.tables[0], releases: [{ cageId: p.id, kind: 'player' }] }, chain, { askedElsewhere: () => true });
  assert.deepEqual(plan.heldForMove, [p.id]);
  assert.deepEqual(plan.releases, []);
});

test('players first (11-06): a player who left is released before a seat is placed, and before a warm table\'s float, so a leaver waits for their own settle and nothing else', async () => {
  const j = rig({ tables: [row(1, { phase: 'settled' }), row(2), row(3, { wantHouse: true, warm: true, phase: 'lobby', ante: 5, wantBots: 2 })] });
  const a = j.liveTable(1), b = j.liveTable(1), z = j.liveTable(1);
  const p = j.player(100n);
  j.tables[0].holders = [holder(a.id), holder(b.id), holder(z.id, { left: true })];
  j.tables[0].releases = [{ cageId: z.id, kind: 'player' }];
  j.tables[0].leaving = [z.id];
  j.tables[0].entries = [{ seq: 1, rounds: [1], lines: [{ id: a.id, delta: -1 }, { id: b.id, delta: 1 }], at: 1 }];
  j.tables[1].claims = [ask(p.id, 10n, 1000)];
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits().slice(0, 2), ['settleBatch', 'release'], `the round settles, then the leaver is released, before the seat and the float: ${j.sentCircuits()}`);
  assert.equal(j.seat(z), null, 'freed');
  assert.equal(j.seat(p).table, 2n, 'the seat still placed this cycle');
  assert.equal(j.post('/released').filter((x) => x.body.cageId === z.id).length, 1, 'released once, not again in the tail');
});

test('a spare warm table\'s float never goes ahead of a player waiting to sit or move (11-09: a hop waited 30 s behind one, right after its own settle)', async () => {
  const j = rig({ tables: [row(1, { phase: 'settled' }), row(2), row(3, { wantHouse: true, warm: true, phase: 'lobby', ante: 5, wantBots: 2 })] });
  const a = j.liveTable(1), b = j.liveTable(1);
  const p = j.player(100n);
  j.tables[0].holders = [holder(a.id), holder(b.id)];
  j.tables[0].entries = [{ seq: 1, rounds: [1], lines: [{ id: a.id, delta: -1 }, { id: b.id, delta: 1 }], at: 1 }];
  j.tables[1].claims = [ask(p.id, 10n, 1000)];
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), ['settleBatch', 'seatByJudge'], `the settle, then the player's seat, and no float for a table nobody is at: ${j.sentCircuits()}`);
  assert.equal(j.seat(p).table, 2n);
  j.tables[1].claims = []; // seated: the Worker has them now
  j.tables[1].holders = [holder(p.id)];
  j.tables[0].entries = [{ seq: 2, rounds: [2], lines: [{ id: a.id, delta: 1 }, { id: b.id, delta: -1 }], at: 2 }];
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits().slice(2), ['settleBatch', 'deposit'], `with no seat waiting, the spare table's float goes right after the next settle, as before: ${j.sentCircuits()}`);
});

test('byNeed: a table with a player on their way out settles before one with none, after a stand about to run out', () => {
  const w = [{ items: [{ at: 1 }], urgent: false, deadline: 10n }, { items: [{ at: 2 }], urgent: false, deadline: 20n, leaving: true }, { items: [{ at: 0 }], urgent: true, deadline: 30n }];
  assert.deepEqual(byNeed(w).map((x) => x.i), [2, 1, 0]);
});

test('order on one wallet: settles, then one seat or move a cycle, the oldest ask first, so a queue of hops can\'t hold up a round', async () => {
  const j = rig({ tables: [row(1, { phase: 'settled' }), row(2), row(3)] });
  const a = j.liveTable(1), b = j.liveTable(1);
  const p = j.player(100n), q = j.player(100n), r = j.player(100n);
  j.tables[0].holders = [holder(a.id), holder(b.id)];
  j.tables[0].entries = [{ seq: 1, rounds: [1], lines: [{ id: a.id, delta: -1 }, { id: b.id, delta: 1 }], at: 1 }];
  j.tables[1].claims = [ask(q.id, 10n, 2000), ask(p.id, 10n, 1000)];
  j.tables[2].claims = [ask(r.id, 10n, 3000)];
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), ['settleBatch', 'seatByJudge']);
  assert.equal(j.seat(p).table, 2n, 'the oldest');
  assert.equal(j.seat(q), null);
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), ['settleBatch', 'seatByJudge', 'seatByJudge']);
  assert.equal(j.seat(q).table, 2n);
  await j.judge.cycle();
  assert.equal(j.seat(r).table, 3n);
});

test('a seat that fails is not a settle that failed: it backs off per player, never feeds the table\'s pause, and is refused after three tries', async () => {
  const j = rig({ tables: [row(1)] });
  const p = j.player(100n);
  j.tables[0].claims = [ask(p.id, 40n, Number(T0) * 1000)];
  j.wallet.next = ['refused', 'refused', 'refused'];
  await j.judge.cycle();
  assert.equal(j.wallet.sent.length, 1);
  await j.judge.cycle();
  assert.equal(j.wallet.sent.length, 1, 'backing off: not sent again at once');
  j.at(T0 + 31n);
  await j.judge.cycle();
  assert.equal(j.wallet.sent.length, 2);
  j.at(T0 + 62n);
  await j.judge.cycle();
  assert.equal(j.wallet.sent.length, 2, 'past the rate limit, and still backing off: longer each time');
  j.at(T0 + 72n);
  await j.judge.cycle();
  assert.equal(j.wallet.sent.length, 3);
  assert.equal(SEAT_TRIES, 3);
  const v = j.post('/verified').at(-1).body;
  assert.deepEqual([v.ok, v.code], [false, 'seat_failed']);
  assert.equal(j.post('/alert').length, 0, 'nothing here pauses a table');
});

test('a griefer\'s failed seats don\'t hold up the table\'s settles', async () => {
  const j = rig({ tables: [row(1, { phase: 'settled' }), row(2)] });
  const a = j.liveTable(1), b = j.liveTable(1);
  const p = j.player(100n);
  j.tables[0].holders = [holder(a.id), holder(b.id)];
  j.tables[1].claims = [ask(p.id, 40n, Number(T0) * 1000)];
  j.wallet.next = ['refused'];
  await j.judge.cycle();
  j.tables[0].entries = [{ seq: 1, rounds: [1], lines: [{ id: a.id, delta: -1 }, { id: b.id, delta: 1 }] }];
  await j.judge.cycle();
  assert.ok(j.wallet.sent.some((x) => x.circuit === 'settleBatch' && x.how === 'landed'));
});

test('a lost socket is never resent. The seat is read back from the chain: there, it is done. Not there after the wait, it can go again', async () => {
  const j = rig({ tables: [row(1)] });
  const p = j.player(100n);
  j.tables[0].claims = [ask(p.id, 40n, Number(T0) * 1000)];
  j.wallet.next = ['unknown-landed'];
  await j.judge.cycle();
  assert.equal(j.wallet.sent.length, 1);
  await j.judge.cycle();
  assert.equal(j.wallet.sent.length, 1, 'not resent');
  assert.equal(j.post('/verified')[0].body.ok, true, 'at the target table means done');

  const k = rig({ tables: [row(1)] });
  const q = k.player(100n);
  k.tables[0].claims = [ask(q.id, 40n, Number(T0) * 1000)];
  k.wallet.next = ['unknown'];
  await k.judge.cycle();
  k.at(T0 + 100n); // past the rate limit, and still inside the wait for the indexer
  await k.judge.cycle();
  assert.equal(k.wallet.sent.length, 1, 'still out there, so the ask waits');
  assert.equal(k.post('/verified').length, 0);
  k.at(T0 + BigInt(UNKNOWN_AFTER_MS / 1000) + 1n);
  await k.judge.cycle();
  assert.equal(k.wallet.sent.length, 2, 'the indexer never saw it, and the wait is over');
  assert.equal(k.seat(q).table, 1n);
});

test('a restart picks up from the journal: a seat out there stays out there, and a landed one still gets its receipt', async () => {
  const j = rig({ tables: [row(1)] });
  const p = j.player(100n);
  j.tables[0].claims = [ask(p.id, 40n, Number(T0) * 1000)];
  j.wallet.next = ['unknown'];
  await j.judge.cycle();
  const replay = new Journal(j.lines);
  assert.equal(replay.seatOpOut(p.id), true);
  assert.deepEqual(replay.seatOpsOut().map((o) => [o.kind, o.cageId, o.tx]), [['seat', p.id, 'tx1']]);
  replay.apply({ type: 'seat-landed', op: replay.seatOpsOut()[0].op, tx: 'tx1', hash: 'h', block: 9, status: 'SucceedEntirely' });
  assert.equal(replay.seatOpOut(p.id), false);
  assert.equal(replay.seatOpsUnwritten().length, 1);
  assert.equal(replay.madeSeat(p.id, 1), true);
  assert.equal(replay.madeSeat(p.id, 2), false);
});

test('the DUST floor: below it the judge stops paying for seats and says so, so the page can fall back to the player\'s own sit. Settles keep a reserve', async () => {
  const j = rig({ tables: [row(1)], minDust: 10n });
  const p = j.player(100n);
  j.tables[0].claims = [ask(p.id, 40n, Number(T0) * 1000)];
  j.dust = 19n;
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), []);
  assert.equal(j.post('/verified')[0].body.code, 'judge_no_dust');
  const k = rig({ tables: [row(1)], minDust: 10n });
  const q = k.player(100n);
  k.tables[0].claims = [ask(q.id, 40n, Number(T0) * 1000)];
  k.dust = 20n;
  await k.judge.cycle();
  assert.deepEqual(k.sentCircuits(), ['seatByJudge']);
});

test('the rate limit: one judge-paid seat or move per player in the gap, and a cap an hour', () => {
  const j = rig({ tables: [row(1)] });
  const p = j.player(100n);
  const chain = chainFor(j.chain.state(), 1, j.now());
  const nowMs = Number(T0) * 1000;
  const claim = ask(p.id, 40n, nowMs);
  assert.equal(planAsk(claim, j.tables[0], chain, { nowMs }).kind, 'seat');
  assert.equal(planAsk(claim, j.tables[0], chain, { nowMs, opsFor: () => [nowMs - HOP_GAP_MS + 1] }).kind, 'wait');
  assert.equal(planAsk(claim, j.tables[0], chain, { nowMs, opsFor: () => [nowMs - HOP_GAP_MS] }).kind, 'seat');
  const many = Array.from({ length: 30 }, (_, i) => nowMs - 60_000 * (i + 1));
  assert.equal(planAsk(claim, j.tables[0], chain, { nowMs, opsFor: () => many }).code, 'too_many_hops');
});

test('an ask that waits too long for the old table is refused, and the seat where it is stays', async () => {
  const j = rig({ tables: [row(1, { phase: 'pass', live: true }), row(2)] });
  const keeper = j.liveTable(1);
  const p = j.player(100n);
  j.chain.call(j.chain.judge.sk, 'seatByJudge', unhex(p.id), NO_FROM, 1n, 50n * NIGHT, j.now() - 60n);
  j.tables[0].holders = [holder(keeper.id), holder(p.id)];
  j.tables[1].claims = [ask(p.id, 50n, Number(T0) * 1000)];
  await j.judge.cycle();
  assert.equal(j.post('/verified').length, 0);
  j.at(T0 + 1000n); // the old table stays alive: someone else's round settles there
  j.tables[0].lastChainRound = 1;
  j.chain.call(j.chain.judge.sk, 'settleBatch', one({ table: 1n, roundNo: 1n, houseCut: 0n, lines: Array(6).fill({ is_some: false, value: { id: new Uint8Array(32), debit: 0n, credit: 0n } }).map((x, i) => (i === 0 ? { is_some: true, value: { id: unhex(keeper.id), debit: 0n, credit: 0n } } : x)) }), j.now() - 60n);
  j.at(T0 + BigInt(HOP_PATIENCE_MS / 1000) + 1n);
  await j.judge.cycle();
  assert.equal(j.post('/verified')[0].body.code, 'seat_timeout');
  assert.ok(!j.sentCircuits().includes(MOVE));
});

test('strays: a seat the judge made, with no holder and no live claim, is released. A player\'s own sit is left alone', async () => {
  const j = rig({ tables: [row(1, { house: null })] });
  const keeper = j.liveTable(1);
  const p = j.player(100n);
  j.tables[0].holders = [holder(keeper.id)];
  j.tables[0].claims = [ask(p.id, 40n, Number(T0) * 1000)];
  await j.judge.cycle();
  assert.equal(j.seat(p).table, 1n);
  j.tables[0].claims = []; // refused or timed out
  j.at(T0 + 16n); // the next read of the chain
  await j.judge.cycle();
  assert.deepEqual(j.sentCircuits(), ['seatByJudge', 'release']);
  assert.equal(j.seat(p), null);

  const k = rig({ tables: [row(1)] });
  const own = k.liveTable(1);
  k.at(T0 + 16n);
  await k.judge.cycle();
  assert.deepEqual(k.sentCircuits(), [], `their own sit: ${own.id.slice(0, 6)} stays`);
  assert.equal(k.seat(own).table, 1n);
});

test('the door hears what is left to place, and says when the permit names another key', () => {
  const j = rig();
  const p = j.player(100n, { cap: 30n }), q = j.player(10n, { judge: b32() });
  const chain = chainFor(j.chain.state(), 0, j.now());
  assert.deepEqual(permitSummary(chain, p.id), { cap: String(30n * NIGHT), until: String(T0 + HOURS12), floor: String(70n * NIGHT), ok: true });
  assert.equal(permitSummary(chain, q.id).ok, false);
  assert.equal(permitSummary(chain, 'ab'.repeat(32)), null);
});

test('the Worker hears the table\'s deadline when it moves, and only then', async () => {
  const j = rig({ tables: [row(1)] });
  const keeper = j.liveTable(1);
  j.tables[0].holders = [holder(keeper.id)];
  await j.judge.cycle();
  assert.equal(j.post('/clock')[0].body.tableUntil, String(j.now() - 60n + 1800n));
  j.tables[0].tableUntil = j.post('/clock')[0].body.tableUntil;
  j.at(T0 + 16n);
  await j.judge.cycle();
  assert.equal(j.post('/clock').length, 1);
});

test('the drain switch: no warm table opens, and the judge goes on settling', async () => {
  const opened = [];
  let chain;
  const journal = new Journal();
  chain = simChain();
  const judge = makeJudge({ address: chain.address, worker: async (m, path) => { if (m === 'GET') return { ok: true, status: 200, body: { address: chain.address, tables: [], doors: [], games: ['sealed-hand'], draining: true } }; opened.push(path); return { ok: true, status: 201, body: {} }; }, readChain: async () => chain.state(), journal, record: (r) => journal.apply(r), log: () => {}, prewarm: 1, dustNow: async () => 0n });
  await judge.cycle();
  assert.deepEqual(opened, []);
});

test('plan: a line naming someone a settle freed is dropped even if they sat back down here, so a re-sit can\'t collect. That is N-2', () => {
  const j = rig({ tables: [row(1)] });
  const k = j.liveTable(1), w = j.liveTable(1), walker = j.liveTable(1);
  const work = row(1, { phase: 'settled', holders: [holder(k.id), holder(w.id), holder(walker.id, { left: true, freed: true })], entries: [{ seq: 1, rounds: [2], lines: [{ id: walker.id, delta: 50 }, { id: k.id, delta: -30 }, { id: w.id, delta: -20 }] }] });
  const plan = planTable(work, chainFor(j.chain.state(), 1, j.now()));
  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.dropped.map((d) => d.id), [walker.id]);
  assert.ok(plan.entries[0].lines.every((l) => l.id !== walker.id));
});

test('plan: a round dealt too late to finish gets its settle at its start, once. A held deal gets one too. Past a round\'s longest age, no more: N-7', () => {
  const j = rig({ tables: [row(1)] });
  const k = j.liveTable(1);
  const base = { phase: 'pass', live: true, holders: [holder(k.id)] };
  const chainAt = (dt) => chainFor(j.chain.state(), 1, j.now() + dt);
  const nowMs = (dt) => Number(j.now() + dt) * 1000;
  assert.equal(planTable(row(1, { ...base, dealtAt: nowMs(100n) }), chainAt(100n)).keepAlive, null, 'fresh: it fits');
  assert.ok(planTable(row(1, { ...base, dealtAt: nowMs(500n) }), chainAt(500n)).keepAlive, 'dealt 500 s after the last settle: it may not fit');
  assert.equal(planTable(row(1, { phase: 'lobby', live: false, holders: [holder(k.id)], dealWaiting: false }), chainAt(500n)).keepAlive, null, 'a seated player with no round going gets none');
  assert.ok(planTable(row(1, { phase: 'settled', live: false, holders: [holder(k.id)], dealWaiting: true }), chainAt(500n)).keepAlive);
  assert.equal(planTable(row(1, { ...base, dealtAt: nowMs(-2000n) }), chainAt(1400n)).keepAlive, null, 'stuck: older than any round can be');
  assert.ok(planTable(row(1, { ...base }), chainAt(1300n)).keepAlive, 'the old backstop still holds with no deal time');
});

test('what the result card says stays private does: the player key is in no ledger field and no public transcript', () => {
  const chain = simChain();
  const sk = b32();
  const skHex = hex(sk);
  const show = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? hex(v) : v));
  const r = chain.call(sk, 'deposit', { bytes: b32() }, 50n * NIGHT, idOf(chain.judge.sk), 50n * NIGHT, BigInt(Math.floor(Date.now() / 1000)) + 3600n);
  assert.ok(!show(r.proofData.publicTranscript).includes(skHex), 'not in what the chain runs');
  assert.ok(!show(r.proofData.publicTranscriptOutputs ?? null).includes(skHex));
  const L = chain.state();
  assert.ok(!show([...L.balance].concat([...L.payTo], [...L.permits])).includes(skHex), 'not in the ledger');
  assert.equal(L.balance.lookup(idOf(sk)), 50n * NIGHT, 'and the amount and the id are public, as it says');
  assert.equal(L.permits.lookup(idOf(sk)).cap, 50n * NIGHT, 'the cap too');
});

test('leaving first and standing after still counts as standing: the Worker hears the deadline once, so a line still to come lands, and a re-sit can\'t collect', async () => {
  const j = rig({ tables: [row(1, { phase: 'pass', live: true })] });
  const keeper = j.liveTable(1), a = j.liveTable(1);
  j.chain.call(a.sk, 'stand', 1n, j.now() - 60n);
  j.tables[0].holders = [holder(keeper.id), holder(a.id, { left: true })];
  j.at(T0 + 16n);
  await j.judge.cycle();
  const told = j.post('/standing');
  assert.equal(told[0].body.cageId, a.id);
  assert.equal(told[0].body.standUntil, String(T0 - 60n + 1800n));
  j.tables[0].holders[1].standUntil = Number(told[0].body.standUntil);
  j.at(T0 + 32n);
  await j.judge.cycle();
  assert.equal(j.post('/standing').length, 1, 'once');
});

test('a stand about to run out with a line to land: nothing but settles on this wallet, not a friend\'s hop or a release', async () => {
  const j = rig({ tables: [row(1, { phase: 'pass', live: true }), row(2, { phase: 'settled' }), row(3)] });
  const a = j.liveTable(1), b = j.liveTable(1), k = j.liveTable(2), gone = j.liveTable(2);
  const p = j.player(100n);
  j.chain.call(a.sk, 'stand', 1n, j.now() - 60n);
  j.tables[0].holders = [holder(a.id), holder(b.id)];
  j.tables[1].holders = [holder(k.id), holder(gone.id, { left: true })];
  j.tables[1].releases = [{ cageId: gone.id, kind: 'player' }];
  j.tables[2].claims = [ask(p.id, 40n, Number(T0 + 1300n) * 1000)];
  j.at(T0 + 1300n);
  j.chain.call(j.chain.judge.sk, 'settleBatch', one({ table: 2n, roundNo: 1n, houseCut: 0n, lines: Array(6).fill({ is_some: false, value: { id: new Uint8Array(32), debit: 0n, credit: 0n } }).map((x, i) => (i === 0 ? { is_some: true, value: { id: unhex(k.id), debit: 0n, credit: 0n } } : x)) }), j.now() - 60n);
  j.tables[1].lastChainRound = 1;
  const before = j.wallet.sent.length;
  await j.judge.cycle();
  const sent = j.wallet.sent.slice(before).map((x) => x.circuit);
  assert.ok(!sent.includes('seatByJudge'), sent.join());
  assert.ok(!sent.includes('release'), sent.join());
});

test('a cycle sends a few releases, then looks again: a long queue can\'t run a settle out of time', async () => {
  const j = rig({ tables: [row(1, { phase: 'settled' })] });
  const keep = j.liveTable(1);
  const out = [j.liveTable(1), j.liveTable(1), j.liveTable(1), j.liveTable(1), j.liveTable(1)];
  j.tables[0].holders = [holder(keep.id), ...out.map((x) => holder(x.id, { left: true }))];
  j.tables[0].releases = out.map((x) => ({ cageId: x.id, kind: 'player' }));
  await j.judge.cycle();
  assert.equal(j.sentCircuits().filter((c) => c === 'release').length, TAIL_SENDS);
  await j.judge.cycle();
  assert.equal(j.sentCircuits().filter((c) => c === 'release').length, 5, 'the rest next time');
});

test('a stand in the way of a new seat: still running it is refused, run out it is cleared first, and only with a good permit', () => {
  const j = rig({ tables: [row(1), row(2)] });
  const p = j.player(100n);
  const stood = { table: 1n, epoch: 1n, atRisk: 5n * NIGHT, standing: true, standAt: T0 - 100n };
  const table = { epoch: 1n, lastRound: 0n, heartbeat: T0 - 10n, seated: 2n };
  const chain = (seat, permit = true) => ({ table: null, seats: new Map([[p.id, seat]]), tableAt: () => table, balance: () => 100n * NIGHT, permit: () => (permit ? { judge: 'J', cap: 50n * NIGHT, until: T0 + 9000n, floor: 0n } : null), judgeId: 'J', maxSeats: 6n, nowSecs: T0, escapeSecs: 1800n });
  const nowMs = Number(T0) * 1000;
  const claim = ask(p.id, 40n, nowMs);
  assert.equal(planAsk(claim, row(2), chain(stood), { nowMs }).code, 'standing');
  const runOut = { ...stood, standAt: T0 - 1800n };
  assert.deepEqual(planAsk(claim, row(2), chain(runOut), { nowMs }), { kind: 'clear', cageId: p.id, table: 1n });
  assert.equal(planAsk(claim, row(2), chain(runOut, false), { nowMs }).code, 'need_grant', 'nothing spent for someone with no permit');
});

test('someone told no in this cycle isn\'t seated by it, even if the chain changes before the seat step', async () => {
  const j = rig({ tables: [row(1, { phase: 'settled' }), row(2)] });
  const a = j.liveTable(1), b = j.liveTable(1);
  j.tables[0].holders = [holder(a.id), holder(b.id)];
  j.tables[0].entries = [{ seq: 1, rounds: [1], lines: [{ id: a.id, delta: -1 }, { id: b.id, delta: 1 }], at: 1 }];
  const p = j.player(100n, { cap: 0n });
  j.tables[1].claims = [ask(p.id, 40n, Number(T0) * 1000)];
  // They grant a permit just after being refused, and the settle makes the judge read the chain again.
  const payTo = j.chain.state().payTo.lookup(idOf(p.sk));
  j.onPost = (path, body) => { if (path.endsWith('/T2/verified') && body.code === 'need_grant') j.chain.call(p.sk, 'deposit', payTo, NIGHT, idOf(j.chain.judge.sk), 50n * NIGHT, T0 + HOURS12); };
  await j.judge.cycle();
  assert.equal(j.post('/verified')[0].body.code, 'need_grant');
  assert.ok(j.chain.state().permits.member(idOf(p.sk)), 'the permit is there now');
  assert.ok(j.sentCircuits().includes('settleBatch'));
  assert.ok(!j.sentCircuits().includes('seatByJudge'), 'told no, so no seat, until they ask again');
});

test('a table posted dead this cycle seats nobody', async () => {
  const j = rig({ tables: [row(1)] });
  const keeper = j.liveTable(1);
  const p = j.player(100n);
  j.tables[0].holders = [holder(keeper.id)];
  j.at(T0 + 1801n);
  j.tables[0].claims = [ask(p.id, 40n, Number(T0 + 1801n) * 1000)];
  await j.judge.cycle();
  assert.equal(j.post('/dead').length, 1);
  assert.ok(!j.sentCircuits().includes('seatByJudge'));
});

test('a settle\'s new deadline reaches the Worker in the same cycle, so a round isn\'t ended on a stale clock', async () => {
  const j = rig({ tables: [row(1, { phase: 'settled' })] });
  const a = j.liveTable(1), b = j.liveTable(1);
  j.tables[0].holders = [holder(a.id), holder(b.id)];
  j.tables[0].tableUntil = String(T0 - 60n + 1800n);
  j.at(T0 + 500n);
  j.tables[0].entries = [{ seq: 1, rounds: [1], lines: [{ id: a.id, delta: -1 }, { id: b.id, delta: 1 }], at: 1 }];
  await j.judge.cycle();
  assert.equal(j.post('/clock').at(-1).body.tableUntil, String(T0 + 500n - 60n + 1800n));
});

test('a warm table with a hop on its way is kept alive: the hop can wait a long round at its old table', () => {
  const j = rig({ tables: [row(1)] });
  const h = j.liveTable(1);
  const work = (claims) => row(1, { warm: true, house: h.id, holders: [holder(h.id, { kind: 'house' })], claims });
  const chain = chainFor(j.chain.state(), 1, j.now() + 1300n);
  assert.ok(planTable(work([ask('ab'.repeat(32), 40n, Number(j.now() + 1300n) * 1000)]), chain).keepAlive, 'an ask waiting');
  assert.equal(planTable(work([{ cageId: 'cd'.repeat(32), at: 1, door: true }]), chain).keepAlive, null, 'someone who has sat for themselves: their read-back settles it');
});

// ---------- agents on tNIGHT (phase 2, 11-08): the owner's setting, the daily cap, Stop, the buy-in max ----------
import { BUY_IN_MAX_STAR, agentMessage } from '../scripts/judge-plan.mjs';
const AGENT = 'a9'.repeat(32);
/** An owner's setting as the Worker lists it. In the rig a key's address is the key itself, so the owner signs with the payout. */
const setting = (j, p, limit, { signedAt = Number(j.now()) - 100, by = p.payout, status = 'verified' } = {}) => ({
  cageId: p.id, agent: AGENT, limit, signedAt, verifyingKey: by, signature: 'sig', message: agentMessage(j.chain.address, p.id, AGENT, limit, signedAt), status,
});
/** A settle the journal has landed today that cost this player `tnight`. */
function lostToday(j, p, tnight, batch = `b${Math.random().toString(36).slice(2)}`) {
  const at = new Date(Number(j.now()) * 1000).toISOString();
  j.journal.apply({ type: 'intent', batch, entries: [{ table: 'T99', cageTable: 99, roundNo: '1', seqs: [1], rounds: [1], lines: [{ id: p.id, debit: String(tnight * NIGHT), credit: '0' }] }], at });
  j.journal.apply({ type: 'landed', batch, id: 'tx', hash: 'h', block: 1, status: 'SucceedEntirely', at });
}

test('an owner\'s setting is verified only when the wallet the agent\'s cage id pays out to signed it', async () => {
  const j = rig({ tables: [row(1)] });
  const p = j.player(500n);
  j.agents.push(setting(j, p, '1000', { status: 'pending' }), { ...setting(j, p, 'none', { status: 'pending', by: hex(b32()), signedAt: Number(j.now()) - 50 }) });
  await j.judge.cycle();
  const said = j.post('/judge/agent').filter((x) => 'ok' in x.body).map((x) => [x.body.signedAt === j.agents[0].signedAt ? 'owner' : 'stranger', x.body.ok]);
  assert.deepEqual(said, [['owner', true], ['stranger', false]]);
  assert.match(j.post('/judge/agent').find((x) => x.body.ok === false).body.reason, /Only the wallet this cage id pays out to/);
});

test('the buy-in max: no tNIGHT seat places more than 250, whatever the permit allows (a person, no agent setting)', async () => {
  const j = rig({ tables: [row(1)] });
  const p = j.player(900n, { cap: 900n });
  j.tables[0].claims = [ask(p.id, 600n)];
  await j.judge.cycle();
  assert.equal(j.seat(p).atRisk, BUY_IN_MAX_STAR);
});

test('the daily cap: an agent places no more than its owner\'s cap leaves today, and past it the ask is refused with nothing spent, every time it asks', async () => {
  const j = rig({ tables: [row(1), row(2)] });
  const p = j.player(900n, { cap: 900n });
  j.agents.push(setting(j, p, '100'));
  lostToday(j, p, 60n);
  j.tables[0].claims = [ask(p.id, 90n)];
  await j.judge.cycle();
  assert.equal(j.seat(p).atRisk, 40n * NIGHT, '100 cap, 60 lost today: 40 left');
  const loss = j.post('/judge/agent').at(-1).body;
  assert.deepEqual([loss.lossTodayStar, loss.leftStar], [String(60n * NIGHT), String(40n * NIGHT)], 'the Worker is told the day so far');

  const q = j.player(900n, { cap: 900n });
  j.agents.push(setting(j, q, '100'));
  lostToday(j, q, 98n);
  const before = j.wallet.sent.length;
  for (let k = 0; k < 5; k++) {
    j.tables[1].claims = [ask(q.id, 50n)];
    j.at(j.now() + 60n);
    await j.judge.cycle();
    const v = j.post('/T2/verified').at(-1).body;
    assert.deepEqual([v.ok, v.code], [false, 'daily_cap'], `try ${k + 1}`);
    assert.match(v.reason, /daily cap of 100 tNIGHT/);
  }
  assert.equal(j.wallet.sent.length, before, 'nothing moves: no seat, no proof, no fee');
  assert.equal(j.seat(q), null);
});

test('raising or removing the cap: the newest signed setting wins', async () => {
  const j = rig({ tables: [row(1)] });
  const p = j.player(900n, { cap: 900n });
  lostToday(j, p, 100n);
  j.agents.push(setting(j, p, '100', { signedAt: Number(j.now()) - 200 }), setting(j, p, 'none', { signedAt: Number(j.now()) - 100 }));
  j.tables[0].claims = [ask(p.id, 200n)];
  await j.judge.cycle();
  assert.equal(j.seat(p).atRisk, 200n * NIGHT, 'no cap: what it asked, under the buy-in max');
});

test('Stop: a seated agent is told to leave after this round, once; its next ask is refused; its door is refused', async () => {
  const j = rig({ tables: [row(1, { phase: 'play', live: true }), row(2)] });
  const p = j.player(300n, { cap: 300n });
  j.tables[0].holders = [holder(p.id)];
  j.agents.push(setting(j, p, 'stop'));
  await j.judge.cycle();
  await j.judge.cycle();
  assert.deepEqual(j.post('/T1/stop').map((x) => x.body.cageId), [p.id], 'once, to the table it sits at');
  j.tables[1].claims = [ask(p.id, 50n)];
  await j.judge.cycle();
  const v = j.post('/T2/verified').at(-1).body;
  assert.deepEqual([v.ok, v.code], [false, 'agent_stopped']);
  assert.deepEqual(j.wallet.sent.filter((x) => x.label?.includes(p.id.slice(0, 8))), []);
});
