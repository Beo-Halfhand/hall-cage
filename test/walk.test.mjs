// A random walk over every player circuit and the judge's, checking after each step what must always hold. Failed moves are just refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createConstructorContext, createCircuitContext, sampleContractAddress } from 'cage-l8/runtime';
import { batchWidth } from './batch-width.mjs';
const { Contract, ledger, pureCircuits } = await import(new URL(`${process.env.MANAGED ?? '../contracts/managed/sealed-cage'}/contract/index.js`, import.meta.url).href);
const WIDTH = batchWidth(new URL(`${process.env.MANAGED ?? '../contracts/managed/sealed-cage'}/contract/index.js`, import.meta.url));
// v4b: a move is seatByJudge with a from-table, a revoke is a deposit of 0 with the empty permit, and a single settle is a batch of one.
const NO_FROM = { is_some: false, value: 0n }, fromT = (t) => ({ is_some: true, value: BigInt(t) });
const REVOKE = [{ bytes: new Uint8Array(32) }, 0n, new Uint8Array(32), 0n, 0n];
const one = (e) => [{ is_some: true, value: e }, ...Array(WIDTH - 1).fill({ is_some: false, value: e })];

const b32 = () => new Uint8Array(randomBytes(32));
const id = (p) => pureCircuits.playerId(p.sk);
const COIN = '00'.repeat(32), T0 = 1_900_000_000n, NIGHT = 1_000_000n, E = 1800n, TABLES = 3, MAXGRANT = 2_592_000n;
const NONE = { is_some: false, value: { id: new Uint8Array(32), debit: 0n, credit: 0n } };
const STEPS = Number(process.env.WALK_STEPS ?? 300);

// mulberry32, so a failure can be run again from its seed
const rngFrom = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

function walk(seed) {
  const r = rngFrom(seed), pick = (xs) => xs[Math.floor(r() * xs.length)], amount = (n) => 1n + BigInt(Math.floor(r() * Number(n)));
  const contract = new Contract({ secretKey: ({ privateState }) => [privateState, privateState.sk] });
  const judge = { sk: b32() };
  const players = Array.from({ length: 8 }, () => ({ sk: b32(), addr: { bytes: b32() } }));
  const init = contract.initialState(createConstructorContext(judge, COIN), id(judge), id(judge), 0n, 1000n * NIGHT, E, 6n, 300n, 2100n, MAXGRANT);
  let ctx = createCircuitContext(sampleContractAddress(), COIN, init.currentContractState.data, judge, undefined, undefined, Number(T0));
  let now = T0, paidIn = 0n, paidOut = 0n, landed = 0, moves = 0, overRefused = 0, onBound = 0;
  const rounds = new Map();
  const grantedAt = new Map(); // player id (hex) → block time of the grant that wrote their permit
  const hexOf = (u) => Buffer.from(u).toString('hex');
  let refusal = ''; // what the last refused call said
  const call = (who, name, ...args) => { const cc = { ...ctx, currentPrivateState: who }; cc.currentQueryContext.block = { ...cc.currentQueryContext.block, secondsSinceEpoch: now }; try { const out = contract.impureCircuits[name](cc, ...args); ctx = out.context; landed += 1; return true; } catch (e) { if (!/failed assert/.test(String(e?.message))) throw e; refusal = String(e.message); return false; } };
  const L = () => ledger(ctx.currentQueryContext.state);
  const alive = (t, l) => l.seats.member(t) && l.seats.lookup(t).read() > 0n && now < l.tables.lookup(t).heartbeat + E;
  const bound = (p, l) => { const k = id(p); if (!l.seat.member(k)) return false; const s = l.seat.lookup(k); if (s.standing && now >= s.standAt + E) return false; return l.epochs.lookup(s.table) === s.epoch && alive(s.table, l); };
  const balOf = (p, l = L()) => (l.balance.member(id(p)) ? l.balance.lookup(id(p)) : 0n);

  for (let step = 0; step < STEPS; step++) {
    if (r() < 0.25) now += BigInt(Math.floor(r() * 400));
    if (r() < 0.003) now += MAXGRANT / 2n; // now and then fifteen days pass, so grants on the bound run out and F5 lets go
    const p = pick(players), t = BigInt(1 + Math.floor(r() * TABLES)), l = L();
    const before = balOf(p, l), wasBound = bound(p, l);
    const m = r();
    if (m < 0.18) {
      // L1: mostly a few hours, sometimes on the bound, one to three seconds over it, in milliseconds, 2^64 - 1, or under maxGrant itself
      const n = amount(50n * NIGHT); const cap = r() < 0.5 ? amount(40n * NIGHT) : 0n; const e = r();
      const until = e < 0.80 ? now + BigInt(Math.floor(r() * 9000)) : e < 0.86 ? now + MAXGRANT : e < 0.91 ? now + MAXGRANT + 1n + BigInt(Math.floor(r() * 3))
        : e < 0.95 ? (now + BigInt(Math.floor(r() * 9000))) * 1000n : e < 0.97 ? 2n ** 64n - 1n : BigInt(Math.floor(r() * Number(MAXGRANT)));
      const over = cap > 0n && until > now + MAXGRANT;
      if (call(p, 'deposit', p.addr, n, id(judge), cap, until)) {
        paidIn += n; assert.equal(wasBound, false, 'a bound seat deposited');
        assert.equal(over, false, `a grant over now + maxGrant landed (seed ${seed}, step ${step})`);
        if (cap > 0n) { grantedAt.set(hexOf(id(p)), now); if (until === now + MAXGRANT) onBound += 1; }
      } else if (over && !wasBound) {
        // the checks before the bound all pass for an unbound player here (amount above 0, the same payout address), so it must be the bound that refused
        assert.match(refusal, /a permit runs at most maxGrant/, `a grant over the bound was refused for another reason (seed ${seed}, step ${step})`);
        overRefused += 1;
      } else assert.doesNotMatch(refusal, /a permit runs at most maxGrant/, `a grant within the bound was refused as over it (seed ${seed}, step ${step})`);
    }
    else if (m < 0.28) call(p, 'sit', t, amount(40n * NIGHT), now);
    else if (m < 0.40) {
      // the judge seats or moves p under a permit: whatever it asks, the seat it gets is within the permit, and a stand is never touched
      const permit = l.permits.member(id(p)) ? l.permits.lookup(id(p)) : null;
      const had = l.seat.member(id(p)) ? l.seat.lookup(id(p)) : null;
      const room = permit && before > permit.floor ? before - permit.floor : 0n;
      const risk = room > 0n && r() < 0.85 ? amount(room < permit.cap ? room : permit.cap) : amount(60n * NIGHT);
      const landedNow = had && r() < 0.6 ? call(judge, 'seatByJudge', id(p), fromT(had.table), t, risk, now) : call(judge, 'seatByJudge', id(p), NO_FROM, t, risk, now);
      if (landedNow) {
        assert.ok(permit && risk <= permit.cap, `seated over the cap or with no permit (seed ${seed}, step ${step})`);
        assert.ok(now <= permit.until, `seated after the permit ran out (seed ${seed}, step ${step})`);
        assert.ok(!had?.standing, `a standing seat was seated over or moved (seed ${seed}, step ${step})`);
        assert.ok(before - risk >= permit.floor, `the judge placed below the floor (seed ${seed}, step ${step})`);
        moves += 1;
      }
    } else if (m < 0.42) { if (call(p, 'deposit', ...REVOKE)) assert.equal(L().permits.member(id(p)), false, 'revoke left a permit behind'); }
    else if (m < 0.52) { if (call(p, 'stand', l.seat.member(id(p)) ? l.seat.lookup(id(p)).table : t, now)) assert.equal(L().permits.member(id(p)), false, 'a stand left the permit behind'); }
    else if (m < 0.60) { const n = before > 0n ? amount(before) : 1n; if (call(p, 'withdraw', n)) { paidOut += n; assert.equal(wasBound, false, 'a bound seat withdrew'); } }
    else if (m < 0.66) { const who = pick(players); const had = balOf(who, l), was = bound(who, l), live = l.permits.member(id(who)) && now <= l.permits.lookup(id(who)).until; if (call(p, 'rescue', id(who))) { paidOut += had; assert.equal(was, false, 'a bound seat was rescued'); assert.equal(live, false, `F5: a balance with a live permit was rescued (seed ${seed}, step ${step})`); } }
    else if (m < 0.70) { const who = pick(players); if (l.seat.member(id(who))) call(judge, 'release', l.seat.lookup(id(who)).table, id(who)); }
    else {
      // the judge settles a round at a table, naming some of its seats
      const here = players.filter((q) => l.seat.member(id(q)) && l.seat.lookup(id(q)).table === t).slice(0, 6);
      const loser = here[0], winner = here[1];
      const lim = loser && l.risks.member(id(loser)) ? l.risks.lookup(id(loser)) : 0n;
      const d = loser && winner && lim > 0n && r() < 0.6 ? amount(lim) : 0n;
      const lines = here.map((q, i) => ({ is_some: true, value: { id: id(q), debit: i === 0 ? d : 0n, credit: i === 1 ? d : 0n } }));
      const riskBefore = loser && l.risks.member(id(loser)) ? l.risks.lookup(id(loser)) : 0n;
      const n = l.tables.member(t) ? l.tables.lookup(t).lastRound + 1n : 1n;
      if (call(judge, 'settleBatch', one({ table: t, roundNo: n, houseCut: 0n, lines: [...lines, ...Array(6 - lines.length).fill(NONE)] }), now) && d > 0n) assert.ok(d <= riskBefore, 'debited over atRisk');
      rounds.set(t, n);
    }
    // what must always hold
    const after = L();
    const total = [...after.balance].reduce((s, [, v]) => s + v, 0n);
    assert.equal(total, paidIn - paidOut, `balances must add up to what came in and went out (seed ${seed}, step ${step})`);
    for (const [t2] of after.tables) {
      const epoch = after.epochs.lookup(t2);
      const counted = [...after.seat].filter(([, s]) => s.table === t2 && s.epoch === epoch).length;
      const n = after.seats.member(t2) ? after.seats.lookup(t2).read() : 0n;
      assert.ok(n <= 6n, `a table over its seats (seed ${seed}, step ${step})`);
      // A void seat of this epoch can have left a dead table without coming off the count; a live table's count is exact.
      if (alive(t2, after)) assert.equal(n, BigInt(counted), `a live table's count is the seats on it (seed ${seed}, step ${step}, table ${t2})`);
    }
    for (const q of players) if (bound(q, after)) assert.ok(balOf(q, after) >= after.risks.lookup(id(q)), `a bound seat's balance covers its atRisk (seed ${seed}, step ${step})`);
    // L1: every permit there runs at most maxGrant past the grant that wrote it, so F5 can't hold anyone longer
    for (const [k, pm] of after.permits) assert.ok(grantedAt.has(hexOf(k)) && pm.until <= grantedAt.get(hexOf(k)) + MAXGRANT, `a permit runs past its grant + maxGrant (seed ${seed}, step ${step})`);
  }
  return { landed, moves, overRefused, onBound };
}

// Long walks run one seed a process (WALK_SEEDS=3 WALK_STEPS=3000): the simulator grows about 1 MB a step and traps at 4 GB.
for (const seed of (process.env.WALK_SEEDS ?? '1,2,3,4').split(',').map(Number)) {
  test(`random walk, seed ${seed}: money adds up, a live table's count is exact, a bound seat can't deposit or leave, debits stay within atRisk, judge seats stay within their permit and above its floor, and no permit runs past its grant + maxGrant`, () => {
    const { landed, moves, overRefused, onBound } = walk(seed);
    assert.ok(landed > STEPS / 5, `only ${landed} of ${STEPS} moves landed, so the walk isn't showing much`);
    assert.ok(moves > 0, 'no seat by the judge ever landed, so the walk says nothing about them');
    if (process.env.WALK_REPORT) console.log(`seed ${seed}: ${STEPS} steps, ${landed} landed, ${moves} judge seats, ${onBound} grants on the bound, ${overRefused} over it refused by L1`);
  });
}
