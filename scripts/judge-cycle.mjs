// One turn of the judge's loop, with its wallet and network passed in, so the same code runs on preprod and against the contract's simulator in tests.
// judge.mjs supplies the real wallet, the journal file and the Worker. The decisions are in judge-plan.mjs.
//
// The order in a cycle: settles first, then the releases of players on their way out (11-06: they used to wait behind a warm table's float
// and a seat, about three minutes on a busy cycle), then one float step, then one seat or move, then the rest of the releases. A seat at a table reads its heartbeat, so a settle landing
// first fails it, and a queue of hops must never hold up a round.
import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ENTRIES_PER_BATCH, KEEP_ALIVE_BEFORE, LINES_PER_ENTRY, agentRule, checkAgentSetting, checkClaim, checkDoor, pacificDayStart, planAsks, planTable } from './judge-plan.mjs';

const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const NIGHT = 1_000_000n;
const WARM_BOTS = 2;
const MAX_FLOAT = 100; // tNIGHT per table, whatever the stakes
const MAX_HOUSE_TABLES = 4; // tables anyone can open must not be able to drain the judge wallet into floats. Each game keeps one warm, and one in play
const MAX_TRIES = 3;
const PAUSE_MS = 3 * 60_000;
export const UNKNOWN_AFTER_MS = 4 * 60_000; // a transaction not seen this long after it left may be replanned with the same round number, so only one can ever land
export const SEAT_TRIES = 3; // failures for one player before their ask is refused
export const SEAT_BACKOFF_MS = 20_000;
export const TAIL_SENDS = 4; // releases and strays a cycle, before going back to see if a round needs settling
export const CHAIN_EVERY_MS = 15_000; // with nothing to do, how often the cage is read for standing seats and quiet tables
export const SETTLES_PER_CYCLE = 2; // a batch holds ENTRIES_PER_BATCH, so a cycle can land twice that while rounds are waiting (review of the fair batch, M-1)
export const SECOND_SETTLE_RESERVE = 2n; // the second settle needs DUST at this many times the floor, the reserve below which seats already stop

/** What a table and every seat look like to the plan. The contract keeps these apart so its transactions don't collide. The plan wants them together. */
export function chainFor(L, cageTable, nowSecs = BigInt(Math.floor(Date.now() / 1000))) {
  const tableAt = (n) => {
    const k = BigInt(n);
    return L.tables.member(k) ? { ...L.tables.lookup(k), epoch: L.epochs.member(k) ? L.epochs.lookup(k) : 0n, seated: L.seats.member(k) ? L.seats.lookup(k).read() : 0n } : null;
  };
  const seats = new Map();
  for (const [id, seat] of L.seat) seats.set(hex(id), { ...seat, atRisk: L.risks.member(id) ? L.risks.lookup(id) : 0n });
  return {
    table: tableAt(cageTable), seats, tableAt,
    balance: (id) => { const k = unhex(id); return L.balance.member(k) ? L.balance.lookup(k) : 0n; },
    payTo: (id) => { const k = unhex(id); return L.payTo.member(k) ? hex(L.payTo.lookup(k).bytes) : null; },
    permit: (id) => { const k = unhex(id); if (!L.permits.member(k)) return null; const p = L.permits.lookup(k); return { judge: hex(p.judge), cap: p.cap, until: p.until, floor: p.floor }; },
    judgeId: hex(L.judge),
    maxSeats: BigInt(L.maxSeats),
    nowSecs,
    escapeSecs: L.escapeSecs,
    roundCap: L.roundCap, // the most one line can debit: a standing seat is freed by its first line, so this is all it can ever pay
  };
}

/** What the Hall shows about a permit: what is left to place, and whether this judge can use it. */
export function permitSummary(chain, id) {
  const p = chain.permit(id);
  return p ? { cap: String(p.cap), until: String(p.until), floor: String(p.floor), ok: p.judge === chain.judgeId } : null;
}

const NONE_LINE = { is_some: false, value: { id: new Uint8Array(32), debit: 0n, credit: 0n } };
const NONE_ENTRY = { is_some: false, value: { table: 0n, roundNo: 0n, houseCut: 0n, lines: Array(LINES_PER_ENTRY).fill(NONE_LINE) } };
function toEntry(cageTable, e) {
  const lines = e.lines.map((l) => ({ is_some: true, value: { id: unhex(l.id), debit: BigInt(l.debit), credit: BigInt(l.credit) } }));
  return { is_some: true, value: { table: BigInt(cageTable), roundNo: BigInt(e.roundNo), houseCut: 0n, lines: [...lines, ...Array(LINES_PER_ENTRY - lines.length).fill(NONE_LINE)] } };
}

/** The earliest moment a table's rounds stop being settleable: its own deadline, or a standing seat's. Null if it has neither. */
export const earliestDeadline = (plan) => [plan.tableUntil, ...Object.values(plan.standUntil ?? {})].filter((x) => x != null).reduce((a, b) => (a === null || b < a ? b : a), null);

/** Tables in the order they need a settle: a stand about to run out, then the earliest deadline, then the oldest waiting round, then the fewest settled this cycle, then the Worker's order. */
export function byNeed(wanting) {
  // Tables settled in one batch share a heartbeat, so equal deadlines are common: the one whose round has waited longest goes first (a keep-alive has no round, so it counts as oldest).
  const oldest = (w) => w.items.reduce((m, x) => Math.min(m, x.at ?? -Infinity), Infinity);
  // Still equal: a table with fewer items already settled this cycle goes first (M-1's second settle), then the Worker's order.
  const tie = (a, b) => (oldest(a) !== oldest(b) ? oldest(a) - oldest(b) : (a.served ?? 0) !== (b.served ?? 0) ? (a.served ?? 0) - (b.served ?? 0) : a.i - b.i);
  // A table with a player on their way out (the Worker's `leaving`) settles before the rest, so their release isn't a cycle behind (11-06).
  return wanting.map((w, i) => ({ ...w, i })).sort((a, b) => (a.urgent !== b.urgent ? (a.urgent ? -1 : 1)
    : !!a.leaving !== !!b.leaving ? (a.leaving ? -1 : 1)
    : a.deadline === b.deadline ? tie(a, b) : a.deadline === null ? 1 : b.deadline === null ? -1 : a.deadline < b.deadline ? -1 : 1));
}

/**
 * Fills one settle batch from every table that wants one, fairly. Tables with a stand about to run out go first, then by the earliest deadline, then
 * by the oldest waiting round, then in the Worker's order (byNeed). The batch takes one item from each table in turn, so no table waits behind another's backlog, and a table's own entries
 * stay in order. First come first served let four busy tables listed earlier starve the next one past its deadline at 4 slots (review of v4b, H-1).
 * `wanting`: [{ items, urgent, deadline }], each table's items in order.
 */
export function fillBatch(batch, wanting, width = ENTRIES_PER_BATCH) {
  const order = byNeed(wanting);
  for (let k = 0; batch.length < width; k++) {
    let added = false;
    for (const w of order) {
      if (batch.length >= width) break;
      if (k < w.items.length) { batch.push(w.items[k]); added = true; }
    }
    if (!added) break;
  }
  return batch;
}

/** The judge's batch must be the contract's: with any other width every settle fails, and every table dies (review of v4b, L-1). */
export function checkBatchWidth(contractIndexSource, width = ENTRIES_PER_BATCH) {
  const m = /Vector<(\d+), struct Maybe<is_some: Boolean, value: struct Entry/.exec(contractIndexSource);
  if (!m) throw new Error('the compiled cage has no settleBatch entry vector. Stopping.');
  if (Number(m[1]) !== width) throw new Error(`the compiled cage's settleBatch takes ${m[1]} entries, and this judge sends ${width}. Stopping.`);
  return Number(m[1]);
}

/**
 * deps: { address, worker(method, path, body), readChain(), callCircuit(circuit, skHex, args, label, onSend, meta), probeTx(id), dustNow(), journal, record(line), log(text), judgeKey,
 * idOf(skHex), houseKeyFor(cageTable), payoutOf(), declaredNow(), checkOpts(), prewarm, keepAliveBefore, minDust, houseFloat,
 * owns(cageTable), preempt() }
 *
 * Two Workers, one judge (11-10): judge-sites.mjs makes one of these per Worker, all on one wallet, taken in turn.
 *   owns(n): whether table number n is this Worker's (by its CAGE_TABLE_BASE range). A table outside it is never planned, seated,
 *     settled or released here, and is logged once.
 *   preempt(): asked between this cycle's transactions after its settles. True means a Worker that comes first (live) has a player
 *     waiting, and this cycle stops there; everything it didn't do is planned again next time. Settles are never held back by it.
 * cycle() returns { ok, status?, tables?, preempted? }.
 */
export function makeJudge(deps) {
  const { address, worker, readChain, callCircuit, probeTx, dustNow, journal, record, log, judgeKey, idOf, houseKeyFor, payoutOf, declaredNow, checkOpts, prewarm = 1, keepAliveBefore = KEEP_ALIVE_BEFORE, minDust = 0n, houseFloat = null, clock = Date.now, owns = () => true, preempt = null } = deps;
  const notOurs = new Set(); // tables already logged as another Worker's
  let preemptFn = preempt;
  const chainAt = (L, cageTable) => chainFor(L, cageTable, BigInt(Math.floor(clock() / 1000)));
  const floatFor = (row) => Math.min(MAX_FLOAT, Number(houseFloat ?? row.ante * 6 * row.wantBots)); // six antes a bot: enough for a few rounds
  // A table whose settle keeps failing pauses, says so, and tries again: the escape is 30 minutes off, so giving up isn't safe either.
  const tries = new Map(); // table → { n, until }
  const paused = (table) => (tries.get(table)?.until ?? 0) > clock();

  // ---------- agents' owners (phase 2) ----------
  // The newest verified setting per agent cage id, from the Worker's list each cycle, and what was last told back.
  let settings = new Map();
  const stopsSent = new Set();
  const lossSent = new Map();
  const ruleFor = (id) => agentRule(settings.get(id) ?? null, journal.lossSince(id, pacificDayStart(clock())));
  const opts = () => ({ ...checkOpts(), settingFor: (id) => settings.get(id) ?? null, ruleFor });
  /** The verified settings, today's loss back to the Worker for each, and a Stop carried to the table where that agent sits. No chain needed. */
  async function syncAgents(body) {
    const next = new Map();
    for (const a of body.agents ?? []) if (a.status === 'verified' && !(next.get(a.cageId)?.signedAt > a.signedAt)) next.set(a.cageId, a);
    settings = next;
    for (const [id, a] of settings) {
      const loss = journal.lossSince(id, pacificDayStart(clock()));
      const rule = agentRule(a, loss);
      const said = `${a.signedAt}|${loss}`;
      if (lossSent.get(id) !== said) {
        await worker('POST', '/judge/agent', { cageId: id, signedAt: a.signedAt, lossTodayStar: String(loss), leftStar: rule.leftStar === null ? null : String(rule.leftStar), day: new Date(pacificDayStart(clock())).toISOString() });
        lossSent.set(id, said);
      }
      if (!rule.stopped) continue;
      for (const row of body.tables) {
        const h = row.holders.find((x) => x.cageId === id && !x.left && !x.released);
        const key = `${row.id}|${id}|${a.signedAt}`;
        if (!h || stopsSent.has(key)) continue;
        log(`table ${row.cageTable}: ${id.slice(0, 12)}'s owner pressed Stop: it leaves after this round`);
        await worker('POST', `/judge/tables/${row.id}/stop`, { cageId: id });
        stopsSent.add(key);
      }
    }
  }
  /** Settings waiting for the judge: only the wallet the cage id pays out to may sign them. */
  async function answerAgents(agents, L) {
    const chain = chainAt(L, 0);
    for (const a of agents) {
      if (a.status !== 'pending') continue;
      const r = checkAgentSetting(a, chain, { ...checkOpts(), now: clock() });
      log(`agent setting ${a.cageId.slice(0, 12)} (${a.limit}): ${r.ok ? 'verified' : `refused: ${r.reason}`}`);
      await worker('POST', '/judge/agent', { cageId: a.cageId, signedAt: a.signedAt, ...r });
      if (r.ok && !(settings.get(a.cageId)?.signedAt > a.signedAt)) settings.set(a.cageId, { ...a, status: 'verified' });
    }
  }
  const settleSucceeded = (batchEntries) => { for (const { table } of batchEntries) tries.delete(table); };
  // A seat or move that fails is not a settle that failed: a player's own deposit or withdraw, or a stranger's rescue, can do it. One griefer must not pause a table, so this backs off per player.
  const seatTries = new Map(); // player → { n, until }
  let lastWarmTry = 0;
  let lastRead = 0;

  // ---------- settle ----------
  async function settle(batchEntries, seenAt) {
    const batch = `b${clock().toString(36)}${randomBytes(3).toString('hex')}`;
    const stored = batchEntries.map(({ table, cageTable, e }) => ({ table, cageTable, roundNo: String(e.roundNo), seqs: e.seqs, rounds: e.rounds, lines: e.lines.map((l) => ({ id: l.id, debit: String(l.debit), credit: String(l.credit) })), ...(e.dropped ? { dropped: e.dropped } : {}) }));
    const ended = batchEntries.map((b) => b.at).filter(Boolean);
    record({ type: 'intent', batch, entries: stored });
    const args = [[...batchEntries.map(({ cageTable, e }) => toEntry(cageTable, e)), ...Array(ENTRIES_PER_BATCH - batchEntries.length).fill(NONE_ENTRY)], declaredNow()];
    const label = `settleBatch ${stored.map((x) => `t${x.cageTable}r${x.roundNo}`).join('+')} rounds ${stored.flatMap((x) => x.rounds).join(',')}`;
    try {
      const r = await callCircuit('settleBatch', judgeKey, args, label, (id) => record({ type: 'sent', batch, id }), { roundEndedAt: ended.length ? Math.min(...ended) : null, seenAt });
      record({ type: 'landed', batch, ...r });
      await deliverReceipts();
      settleSucceeded(batchEntries);
      return true;
    } catch (e) {
      if (e?.unknown) { log(`${label}: outcome unknown; holding these rounds until the indexer answers or ${UNKNOWN_AFTER_MS / 60000} min pass`); return false; }
      record({ type: 'failed', batch, reason: String(e?.message ?? e).slice(0, 500) });
      if (e?.dustLow) throw e;
      log(`${label} FAILED: ${String(e?.message ?? e).slice(0, 400)}`);
      for (const table of new Set(batchEntries.map((b) => b.table))) {
        const entry = tries.get(table) ?? { n: 0, until: 0 };
        entry.n += 1;
        if (entry.n >= MAX_TRIES) {
          entry.n = 0;
          entry.until = clock() + PAUSE_MS;
          log(`table ${batchEntries.find((b) => b.table === table).cageTable}: pausing its settles for ${PAUSE_MS / 60000} min after ${MAX_TRIES} failures`);
          await worker('POST', `/judge/tables/${table}/alert`, { message: `settle failed ${MAX_TRIES} times, retrying: ${String(e?.message ?? e).slice(0, 200)}` }).catch(() => {});
        }
        tries.set(table, entry);
      }
      return false;
    }
  }
  /** A transaction that left and hasn't been seen: the indexer decides. */
  async function resolveUnknown() {
    for (const b of journal.unresolved()) {
      if (b.state === 'intent') { record({ type: 'failed', batch: b.batch, reason: 'stopped before sending' }); continue; }
      const seen = await probeTx(b.id);
      if (seen && /succeed/i.test(seen.status)) { record({ type: 'landed', batch: b.batch, id: b.id, ...seen }); log(`batch ${b.batch} had landed: ${seen.hash}`); continue; }
      if (seen) { record({ type: 'failed', batch: b.batch, reason: `landed as ${seen.status}` }); continue; }
      if (clock() - Date.parse(b.sentAt) > UNKNOWN_AFTER_MS) record({ type: 'failed', batch: b.batch, reason: 'not seen on the indexer after the wait; replanning, and the round counter stops both landing' });
    }
    // The same for a seat or move, which never goes out twice: until it is settled either way, the plan waits or reads the seat back from the chain.
    for (const o of journal.seatOpsOut()) {
      if (o.state === 'intent') { record({ type: 'seat-failed', op: o.op, reason: 'stopped before sending' }); continue; }
      const seen = await probeTx(o.tx);
      if (seen && /succeed/i.test(seen.status)) { record({ type: 'seat-landed', op: o.op, tx: o.tx, ...seen }); log(`${o.kind} for ${o.cageId.slice(0, 12)} had landed: ${seen.hash}`); continue; }
      if (seen) { record({ type: 'seat-failed', op: o.op, reason: `landed as ${seen.status}` }); continue; }
      if (clock() - Date.parse(o.sentAt) > UNKNOWN_AFTER_MS) record({ type: 'seat-failed', op: o.op, reason: 'not seen on the indexer after the wait: reading the chain from here' });
    }
  }
  async function deliverReceipts() {
    for (const { batch, entry, tx } of journal.unwritten()) {
      const res = await worker('POST', `/judge/tables/${entry.table}/settled`, { seqs: entry.seqs, tx: { ...tx, at: clock() }, ...(entry.dropped ? { dropped: entry.dropped, lines: entry.lines } : {}) }).catch((e) => ({ ok: false, status: 0, error: e }));
      if (res.ok) { record({ type: 'written', batch, table: entry.table }); continue; }
      if (res.status === 409 || res.status === 404) { log(`receipt for batch ${batch} refused (${res.status}); a person should look`); record({ type: 'written', batch, table: entry.table, refused: res.status }); continue; }
      log(`receipt for batch ${batch} not delivered (${res.status}); will retry`);
    }
    for (const o of journal.seatOpsUnwritten()) {
      const tx = { hash: o.hash, id: o.tx, block: o.block, status: o.status, blockAt: o.blockAt ?? null, ms: o.ms ?? null, at: clock() };
      const seated = await worker('POST', `/judge/tables/${o.table}/seated`, { cageId: o.cageId, kind: o.kind, from: o.from ?? null, until: o.until ?? null, tx }).catch(() => ({ ok: false, status: 0 }));
      // The move took them off the old table in the same transaction, so that table is done with them.
      const left = !o.fromRow || !seated.ok ? seated : await worker('POST', `/judge/tables/${o.fromRow}/released`, { cageId: o.cageId }).catch(() => ({ ok: false, status: 0 }));
      if (left.ok || left.status === 404 || left.status === 409) record({ type: 'seat-written', op: o.op });
      else log(`seat receipt for ${o.cageId.slice(0, 12)} not delivered (${left.status}); will retry`);
    }
  }

  // ---------- house float ----------
  async function seatHouse(row, L) {
    const key = houseKeyFor(row.cageTable), id = idOf(key);
    const chain = chainAt(L, row.cageTable);
    const tnight = floatFor(row);
    const float = BigInt(tnight) * NIGHT;
    if (chain.balance(id) < float && !chain.seats.has(id)) {
      log(`house float: depositing ${tnight} tNIGHT for table ${row.cageTable}`);
      await callCircuit('deposit', key, [payoutOf(), float - chain.balance(id), new Uint8Array(32), 0n, 0n], `deposit house t${row.cageTable}`); // an empty permit: the house sits for itself
      return;
    }
    const seat = chain.seats.get(id);
    if (!seat) {
      log(`house float: sitting at table ${row.cageTable}`);
      await callCircuit('sit', key, [BigInt(row.cageTable), float, declaredNow()], `sit house t${row.cageTable}`);
      return;
    }
    await worker('POST', `/judge/tables/${row.id}/house`, { cageId: id, atRiskStar: String(seat.atRisk), balanceStar: String(chain.balance(id)), epoch: Number(seat.epoch) });
  }
  async function finishHouse(row, id, L) {
    const key = houseKeyFor(row.cageTable);
    if (idOf(key) !== id) return;
    const chain = chainAt(L, row.cageTable);
    const bal = chain.balance(id);
    if (bal > 0n) await callCircuit('withdraw', key, [bal], `withdraw house t${row.cageTable}`);
  }

  // ---------- the door ----------
  /** Answers the sessions waiting at the door, and keeps the balance and permit the Hall shows up to date. */
  async function answerDoors(doors, L) {
    const chain = chainAt(L, 0);
    for (const d of doors) {
      const balanceStar = String(chain.balance(d.cageId));
      const permit = permitSummary(chain, d.cageId);
      if (d.status === 'pending') {
        const r = checkDoor(d, chain, opts());
        log(`door: ${d.cageId.slice(0, 12)} ${r.ok ? 'verified' : `refused: ${r.reason}`}`);
        await worker('POST', '/judge/door', { key: d.key, ...r, balanceStar, permit });
      } else if (d.balanceStar !== balanceStar || JSON.stringify(d.permit ?? null) !== JSON.stringify(permit)) {
        await worker('POST', '/judge/door', { key: d.key, balanceStar, permit });
      }
    }
  }

  // ---------- warm tables ----------
  /** Opens a table when none is waiting ready. The judge then seats the float on it, one transaction a cycle, settles first. */
  async function replenish(tables, games = ['sealed-hand']) {
    if (prewarm <= 0 || clock() - lastWarmTry < 30_000) return;
    for (const game of games) {
      const ready = tables.filter((r) => (r.game ?? 'sealed-hand') === game && r.warm && r.status === 'open' && r.phase === 'lobby' && !r.claims.length && r.holders.every((h) => h.kind === 'house'));
      if (ready.length >= prewarm) continue;
      if (tables.filter((r) => (r.house || r.wantHouse) && !r.over).length >= MAX_HOUSE_TABLES) return;
      lastWarmTry = clock();
      const res = await worker('POST', '/judge/warm', { bots: WARM_BOTS, game });
      log(res.ok ? `warm table opened for ${game}: table ${res.body?.state?.cage?.table ?? res.body?.cage?.table ?? '?'}` : `could not open a warm table for ${game} (${res.status})`);
      return; // one a cycle
    }
  }

  // ---------- seats and moves ----------
  /** What a seat or move is planned against: the other tables, what is out there, and this player's rate limit. */
  function askOptions(tables) {
    const byNumber = new Map(tables.map((r) => [BigInt(r.cageTable), r]));
    return {
      rowOf: (n) => byNumber.get(BigInt(n)) ?? null,
      tablesBusy: journal.tablesInFlight(),
      seatOpOut: (id) => journal.seatOpOut(id),
      opsFor: (id) => journal.seatOpTimes(id),
      blockedUntil: (id) => seatTries.get(id)?.until ?? 0,
      ruleFor,
      nowMs: clock(),
    };
  }
  async function refuseAsk(row, r) {
    log(`table ${row.cageTable}: ask from ${r.cageId.slice(0, 12)} refused: ${r.reason}`);
    await worker('POST', `/judge/tables/${row.id}/verified`, { cageId: r.cageId, ok: false, code: r.code, reason: r.reason });
    row.claims = row.claims.filter((c) => c.cageId !== r.cageId); // told no: this cycle's seat step must not seat them anyway
    seatTries.delete(r.cageId);
  }
  /** One transaction. A lost socket is never resent: the seat is read back from the chain on the next cycle, and at the target table means done. */
  async function runSeatOp(op, row, L) {
    const chain = chainAt(L, row.cageTable);
    const kind = op.kind;
    const opId = `s${clock().toString(36)}${randomBytes(3).toString('hex')}`;
    const at = op.atRisk;
    const until = chain.permit(op.cageId)?.until ?? null;
    record({ type: 'seat-intent', op: opId, kind, cageId: op.cageId, table: row.id, to: String(op.to), ...(kind === 'move' ? { from: String(op.from), fromRow: op.fromRow } : {}), atRisk: String(at), ...(until === null ? {} : { until: String(until) }) });
    // One circuit for both since cage v4b: a move is seatByJudge with the table it comes from, a seat has none.
    const from = kind === 'move' ? { is_some: true, value: BigInt(op.from) } : { is_some: false, value: 0n };
    const args = [unhex(op.cageId), from, BigInt(op.to), at, declaredNow()];
    const label = kind === 'move' ? `seatByJudge, move ${op.cageId.slice(0, 12)} t${op.from} to t${op.to}` : `seatByJudge ${op.cageId.slice(0, 12)} t${op.to}`;
    // The player's window shows these steps. Words only: they never wait, and a failed one changes nothing.
    const step = (name) => { worker('POST', `/judge/tables/${row.id}/step`, { cageId: op.cageId, step: name }).catch(() => {}); };
    const started = clock();
    step('proving');
    try {
      const r = await callCircuit('seatByJudge', judgeKey, args, label, (tx) => { record({ type: 'seat-sent', op: opId, tx }); step('sent'); }, { player: op.cageId.slice(0, 12) });
      const ms = clock() - started;
      record({ type: 'seat-landed', op: opId, tx: r.id, hash: r.hash, block: r.block, status: r.status, blockAt: r.blockAt ?? null, ms });
      await worker('POST', '/judge/timing', { action: kind, ms }).catch(() => {});
      seatTries.delete(op.cageId);
      await deliverReceipts();
      return true;
    } catch (e) {
      if (e?.unknown) { log(`${label}: outcome unknown; not resending. The chain will say.`); return false; }
      record({ type: 'seat-failed', op: opId, reason: String(e?.message ?? e).slice(0, 500) });
      if (e?.dustLow) throw e;
      const entry = seatTries.get(op.cageId) ?? { n: 0, until: 0 };
      entry.n += 1;
      entry.until = clock() + SEAT_BACKOFF_MS * entry.n;
      seatTries.set(op.cageId, entry);
      log(`${label} failed (try ${entry.n}): ${String(e?.message ?? e).slice(0, 300)}`);
      if (entry.n >= SEAT_TRIES) await refuseAsk(row, { cageId: op.cageId, code: 'seat_failed', reason: 'The judge could not seat you just now. Your money is as the cage shows.' });
      return false;
    }
  }
  /** A stand that holds nothing any more, in the way of a new seat. Only the judge's release takes it off. A failure backs off like a seat's. */
  async function clearOldStand(op) {
    try {
      await callCircuit('release', judgeKey, [BigInt(op.table), unhex(op.cageId)], `release t${op.table} ${op.cageId.slice(0, 12)} (a stand that has run out, in the way of a seat)`);
      return true;
    } catch (e) {
      if (e?.dustLow) throw e;
      if (e?.unknown) return false;
      const entry = seatTries.get(op.cageId) ?? { n: 0, until: 0 };
      entry.n += 1;
      entry.until = clock() + SEAT_BACKOFF_MS * entry.n;
      seatTries.set(op.cageId, entry);
      log(`clearing an old stand for ${op.cageId.slice(0, 12)} failed: ${String(e?.message ?? e).slice(0, 200)}`);
      return false;
    }
  }

  /** One seat or move a cycle, oldest ask first, planned fresh on the chain as it is after the settles. Below the DUST floor the page falls back to its own sit, which the player pays for. */
  /** The seats, moves and clears that can go this cycle, on this chain read. Planning only: nothing is sent. */
  function seatOps(tables, L) {
    const opts = askOptions(tables);
    const ops = [];
    for (const row of tables) {
      if (!row.plan || row.status !== 'open' || !row.claims.some((c) => c.ask)) continue; // a table posted dead or blocked this cycle has no plan
      const planned = planAsks(row, chainAt(L, row.cageTable), opts);
      // A run-out stand at a table this Worker doesn't own is the other Worker's to clear: here it's the move refusal, in plain words.
      for (const op of planned.clears.filter((x) => !owns(Number(x.table)))) ops.push({ op: { ...op, kind: 'elsewhere' }, row });
      for (const op of [...planned.moves, ...planned.seats, ...planned.clears.filter((x) => owns(Number(x.table)))]) ops.push({ op, row });
    }
    return ops;
  }
  async function seatStep(tables, L) {
    const ops = seatOps(tables, L);
    if (!ops.length) return false;
    if ((await dustNow()) < minDust * 2n) { // the settles keep a reserve: seats stop first
      for (const { op, row } of ops) await refuseAsk(row, { cageId: op.cageId, code: 'judge_no_dust', reason: 'The judge is short of DUST, so it can\'t pay for your seat right now. You can sit for yourself: one approval.' });
      return false;
    }
    for (const { op, row } of ops.filter((x) => x.op.kind === 'elsewhere')) await refuseAsk(row, { cageId: op.cageId, code: 'seated_elsewhere', reason: `You hold a seat at table ${op.table} that this Hall doesn't know. Stand from it under My cage, then sit again.` });
    const mine = ops.filter((x) => x.op.kind !== 'elsewhere');
    if (!mine.length) return false;
    mine.sort((a, b) => (a.op.at ?? 0) - (b.op.at ?? 0));
    const { op, row } = mine[0];
    if (op.kind === 'clear') return clearOldStand(op);
    return runSeatOp(op, row, L);
  }

  // ---------- the loop ----------
  const chainWanted = (body) => (body.doors ?? []).some((d) => d.status === 'pending') || (body.agents ?? []).some((a) => a.status === 'pending') || body.tables.some((r) => r.claims.length || r.entries.length || r.wantHouse || r.releases.length || r.status !== 'open' || r.over) || clock() - lastRead >= CHAIN_EVERY_MS;
  async function cycle() {
    await resolveUnknown();
    await deliverReceipts();
    const seenAt = clock();
    const { body, ok, status } = await worker('GET', '/judge/tables');
    if (!ok) { log(`Worker said ${status} for the table list`); return { ok: false, status }; }
    if (body.address !== address) throw new Error(`the Worker's cage ${body.address} is not ${address}. Stopping.`);
    // Only this Worker's own tables (11-10): a number outside its range is another Worker's, or a mistake. Never settled here.
    const foreign = (body.tables ?? []).filter((r) => !owns(Number(r.cageTable)) && r.status === 'open');
    body.tables = (body.tables ?? []).filter((r) => {
      if (owns(Number(r.cageTable))) return true;
      if (!notOurs.has(r.id)) { notOurs.add(r.id); log(`table ${r.cageTable}: REFUSED, outside this Worker's table numbers; never planned, seated or settled here`); }
      return false;
    });
    let preempted = false;
    /** Whether to stop here for a Worker that comes first. Once it says so, the rest of this cycle waits. */
    const yielded = async () => { if (!preempted && preemptFn) preempted = !!(await preemptFn()); return preempted; };
    const done = () => ({ ok: true, tables: body.tables.length, ...(preempted ? { preempted: true } : {}) });
    // The drain switch: tables finish, and no new ones open. Nor while this Worker has open tables outside its numbers: each warm table
    // it opened would be refused here, and another opened 30 s later.
    if (!body.draining && !foreign.length) await replenish(body.tables, body.games);
    await syncAgents(body);
    if (!chainWanted(body)) return done();
    let L = await readChain();
    lastRead = clock();
    await answerAgents(body.agents ?? [], L); // before the doors: an agent's door needs its owner's setting
    await answerDoors(body.doors ?? [], L);
    const batch = [];
    const wanting = []; // tables with something to settle: filled into the batch fairly, after every table is planned
    const taken = journal.taken();
    const inFlight = journal.tablesInFlight();
    const asks = askOptions(body.tables);
    const asked = new Map(); // player → the table their ask is at
    for (const row of body.tables) for (const c of row.claims) if (c.ask) asked.set(c.cageId, row.id);
    // A table planned on a chain read: at the start of the cycle, and again after a settle, with the rounds the journal now has as done.
    const planFresh = (row, L2, done = journal.taken()) => planTable(row, chainAt(L2, row.cageTable), { done, knownRound: journal.knownRound(row.id), keepAliveBefore, asks, askedElsewhere: (id, table) => asked.has(id) && asked.get(id) !== table, madeSeat: (id, t) => journal.madeSeat(id, t) });
    // What a table puts forward for a batch: its entries in order, each with when its round ended, and a keep-alive if it wants one.
    const itemsOf = (row, plan) => [
      ...plan.entries.map((e) => ({ table: row.id, cageTable: row.cageTable, e, at: row.entries.find((x) => e.seqs.includes(x.seq))?.at })),
      ...(plan.keepAlive ? [{ table: row.id, cageTable: row.cageTable, e: plan.keepAlive, keepAlive: true }] : []),
    ];
    for (const row of body.tables) {
      const chain = chainAt(L, row.cageTable);
      const plan = planFresh(row, L, taken);
      if (plan.dead) {
        log(`table ${row.cageTable}: ${plan.dead}`);
        await worker('POST', `/judge/tables/${row.id}/dead`, { reason: plan.dead });
        continue;
      }
      if (plan.blocked) { log(`table ${row.cageTable} BLOCKED: ${plan.blocked}`); await worker('POST', `/judge/tables/${row.id}/alert`, { message: plan.blocked }); continue; }
      if (inFlight.has(row.id)) plan.verify = [];
      for (const claim of plan.verify) {
        const r = checkClaim(claim, row.cageTable, chain, opts());
        if (r.wait) continue;
        log(`table ${row.cageTable}: claim ${claim.cageId.slice(0, 12)} ${r.ok ? `confirmed, atRisk ${r.atRiskStar}` : `refused: ${r.reason}`}`);
        await worker('POST', `/judge/tables/${row.id}/verified`, { cageId: claim.cageId, ...r });
      }
      for (const r of plan.refusals) await refuseAsk(row, r);
      for (const id of [...plan.standing, ...plan.standingLeft]) {
        log(`table ${row.cageTable}: ${id.slice(0, 12)} is standing on chain`);
        await worker('POST', `/judge/tables/${row.id}/standing`, { cageId: id, standUntil: String(plan.standUntil[id]) });
      }
      // The Worker keeps a round from outlasting the table: it has to know the table's deadline.
      if (plan.tableUntil !== null && row.status === 'open' && String(row.tableUntil ?? '') !== String(plan.tableUntil)) await worker('POST', `/judge/tables/${row.id}/clock`, { tableUntil: String(plan.tableUntil) });
      if (plan.expired.length) log(`table ${row.cageTable}: stand run out for ${plan.expired.map((id) => id.slice(0, 12)).join(', ')}`);
      for (const d of plan.dropped) log(`table ${row.cageTable}: entry ${d.seqs} loses its line for ${d.id.slice(0, 12)} (${d.delta} chips): the stand ran out, so the rest settles and their atRisk stays as it is`);
      if (inFlight.has(row.id)) { log(`table ${row.cageTable}: holding its rounds until the transaction out there is seen or times out`); plan.releases = []; plan.strays = []; plan.entries = []; plan.keepAlive = null; } // the round out there may name a seat that looks stray
      if (!paused(row.id)) {
        const items = itemsOf(row, plan);
        if (items.length) wanting.push({ items, urgent: !!plan.urgent, deadline: earliestDeadline(plan), leaving: !!row.leaving?.length });
      }
      row.plan = plan;
    }
    // A table whose last settle failed is settled on its own until one lands: a failed batch fails every table in it, and a refused table's heartbeat
    // never moves, so by deadline it would go first in every batch and take the others down with it (review of the fair batch, H-2).
    const suspect = (w) => (tries.get(w.items[0].table)?.n ?? 0) > 0;
    const clean = wanting.filter((w) => !suspect(w)), suspects = wanting.filter(suspect);
    const settleNow = async (b) => {
      for (const x of b) if (x.keepAlive) log(`table ${x.cageTable}: a settle of nothing, to stay ready`);
      const landed = await settle(b, seenAt);
      if (landed) for (const row of body.tables) if (row.alert && b.some((x) => x.table === row.id)) await worker('POST', `/judge/tables/${row.id}/alert`, { message: '' });
      L = await readChain();
      // The Worker ends a round before the table's deadline, so a settle's new deadline shouldn't wait for the next cycle.
      for (const table of new Set(b.map((x) => x.table))) {
        const row = body.tables.find((r) => r.id === table);
        const t = row && chainAt(L, row.cageTable).table;
        if (t && row.status === 'open') await worker('POST', `/judge/tables/${table}/clock`, { tableUntil: String(t.heartbeat + L.escapeSecs) }).catch(() => {});
      }
      batch.push(...b); // the release tail below sees every table settled this cycle
      return landed;
    };
    const neediest = byNeed(suspects).slice(0, 1); // one suspect a cycle, the one that most needs it
    const shared = fillBatch([], clean.length ? clean : neediest);
    let settles = 0, lastLanded = false;
    if (shared.length) { lastLanded = await settleNow(shared); settles += 1; }
    if (clean.length && neediest.length) { const alone = fillBatch([], neediest); if (alone.length) { lastLanded = await settleNow(alone); settles += 1; } } // then that suspect, alone
    // Capacity (review of the fair batch, M-1): a batch holds ENTRIES_PER_BATCH, so with more rounds than that finishing a cycle a backlog grew without
    // end. One more settle this cycle, at most SETTLES_PER_CYCLE in all, only after the first landed, only while rounds are still waiting, and only
    // above the DUST reserve. The clean tables are planned again on the chain as it is now: their heartbeats, round numbers and stands have moved,
    // so the tables the first batch left out are nearest their deadlines and go first, and ties still go to the round that has waited longest.
    if (settles < SETTLES_PER_CYCLE && lastLanded && clean.length && !(await yielded())) {
      const more = [];
      let backlog = 0;
      for (const w of clean) {
        const row = body.tables.find((r) => r.id === w.items[0].table);
        if (!row || row.status !== 'open' || paused(row.id) || journal.tablesInFlight().has(row.id)) continue;
        const plan = planFresh(row, L);
        if (plan.dead || plan.blocked) continue; // the next cycle posts it, as the first plan would have
        for (const d of plan.dropped) log(`table ${row.cageTable}: entry ${d.seqs} loses its line for ${d.id.slice(0, 12)} (${d.delta} chips): the stand ran out, so the rest settles and their atRisk stays as it is`);
        backlog += plan.entries.length;
        const items = itemsOf(row, plan);
        if (items.length) more.push({ items, urgent: !!plan.urgent, deadline: earliestDeadline(plan), served: batch.filter((b) => b.table === row.id).length });
      }
      if (backlog > 0) {
        const dust = await dustNow();
        if (dust < minDust * SECOND_SETTLE_RESERVE) log(`backlog of ${backlog}: no second settle this cycle, DUST ${dust} is under the reserve ${minDust * SECOND_SETTLE_RESERVE}`);
        else {
          const second = fillBatch([], more);
          log(`backlog of ${backlog}: a second settle this cycle, ${second.length} item(s)`);
          await settleNow(second);
          settles += 1;
        }
      }
    }
    // A stand about to run out with a line to land: only settles go on this wallet until it has, or the line is dropped at the winners' expense.
    if (body.tables.some((r) => r.plan?.urgent)) return done();
    // Players first (11-06): a seat whose player has left is freed now, before any float or seat work and before the house. A release is one
    // transaction, so a leaver waits for their last round's settle (above) and that alone. The Worker's `leaving` names them while the round
    // is still on, which puts their table's settle first (byNeed); here the release goes as soon as the plan allows it.
    let sends = 0;
    const freed = new Set();
    const releasesOf = (row) => (batch.some((b) => b.table === row.id) ? planFresh(row, L).releases : row.plan.releases);
    const releaseOne = async (row, r) => {
      const seatNow = chainAt(L, row.cageTable).seats.get(r.cageId);
      let tx = null;
      if (seatNow && seatNow.table === BigInt(row.cageTable)) {
        sends += 1;
        const started = clock();
        const landed = await callCircuit('release', judgeKey, [BigInt(row.cageTable), unhex(r.cageId)], `release t${row.cageTable} ${r.cageId.slice(0, 12)}`);
        tx = { hash: landed?.hash ?? null, id: landed?.id ?? null, block: landed?.block ?? null, status: landed?.status ?? null, ms: clock() - started, at: clock() };
        if (r.kind !== 'house') await worker('POST', '/judge/timing', { action: 'release', ms: tx.ms }).catch(() => {});
        L = await readChain();
      }
      if (r.kind === 'house') await finishHouse(row, r.cageId, L);
      await worker('POST', `/judge/tables/${row.id}/released`, { cageId: r.cageId, ...(tx ? { tx } : {}) });
      L = await readChain();
      freed.add(`${row.id}:${r.cageId}`);
    };
    for (const row of body.tables) {
      if (!row.plan || row.status !== 'open') continue;
      if (sends >= TAIL_SENDS) break;
      for (const r of releasesOf(row).filter((x) => x.kind !== 'house')) {
        if (sends >= TAIL_SENDS || (await yielded())) break;
        log(`table ${row.cageTable}: ${r.cageId.slice(0, 12)} is on their way out: released first`);
        await releaseOne(row, r);
      }
    }
    if (await yielded()) return done();
    const playing = body.tables.some((r) => r.status === 'open' && !r.over && r.holders.some((h) => h.kind !== 'house' && !h.left));
    let floatStep = false; // one float transaction a cycle: a round that ends in the meantime settles first
    // A player waiting to sit or move goes before a spare table's float (11-09: a hop sat 30 s behind one, right after its own settle). Only an
    // ask that can go this cycle holds it back, so a hop waiting out a long round elsewhere doesn't keep the warm tables cold.
    const seatReady = seatOps(body.tables, L).length > 0;
    for (const row of body.tables) {
      if (!row.plan) continue;
      // A spare warm table waits for a moment when no player's round can be held up by it: right after a settle, or nobody playing, and no seat waiting.
      const spare = row.warm && !row.claims.length && row.holders.every((h) => h.kind === 'house');
      if (row.plan.wantHouse && !floatStep && (!spare || ((batch.length || !playing) && !seatReady))) {
        const floats = body.tables.filter((x) => x.house && !x.over).length;
        if (floats >= MAX_HOUSE_TABLES) log(`table ${row.cageTable}: wants a house float, but ${floats} are out already`);
        else if (await yielded()) return done();
        else { floatStep = true; await seatHouse(row, L); L = await readChain(); }
      }
    }
    if (await yielded()) return done();
    if (await seatStep(body.tables, L)) L = await readChain();
    for (const row of body.tables) {
      if (!row.plan) continue;
      if (sends >= TAIL_SENDS || (await yielded())) break; // the rest wait for the next cycle, after any settle that has come due
      const chain = chainAt(L, row.cageTable);
      for (const id of row.plan.strays) {
        if (sends >= TAIL_SENDS || (await yielded())) break;
        if (!chain.seats.has(id) || chain.seats.get(id).table !== BigInt(row.cageTable)) continue;
        sends += 1;
        await callCircuit('release', judgeKey, [BigInt(row.cageTable), unhex(id)], `release t${row.cageTable} ${id.slice(0, 12)} (no seat here)`);
        L = await readChain();
      }
      // A table settled this cycle is planned again on the chain as it is now, so a player who left isn't kept bound while the table plays on.
      // The fresh plan still holds back anyone who owes a line (review of the fair batch, M-2).
      const releases = releasesOf(row).filter((r) => !freed.has(`${row.id}:${r.cageId}`)); // the players went first, above; what's left is the house, and anyone freed by the float or seat step's chain read
      for (const r of [...releases].sort((x, y) => (x.kind === 'house') - (y.kind === 'house'))) { // a player waiting to withdraw comes before the house
        if (sends >= TAIL_SENDS || (await yielded())) break;
        await releaseOne(row, r);
      }
      if (preempted) break;
      if (row.status === 'dead' && row.house) await finishHouse(row, row.house, L);
      if (row.done) {
        await worker('POST', `/judge/tables/${row.id}/done`, {});
        log(`table ${row.cageTable} is finished`);
      }
    }
    return done();
  }
  return { cycle, resolveUnknown, deliverReceipts, seatTries, setPreempt: (fn) => { preemptFn = fn; } };
}

export const houseKey = (judgeKey, address, cageTable) => createHash('sha256').update(`sealed-hand:house:v1:${judgeKey}:${address}:${cageTable}`).digest('hex');
