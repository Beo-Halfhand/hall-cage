// The judge's decisions, with no network and no wallet, so they can be tested. judge.mjs does the I/O.
//
// planTable: given what the Worker reports for one table and what the cage says, what should happen next.
// Journal: what has been sent and landed, read back on restart. It's what keeps a round from settling twice,
// because the contract's round number is only a counter: it can't tell a repeat from the next round.

export const STAR_PER_CHIP = 1_000_000n;
export const LINES_PER_ENTRY = 6;
export const ENTRIES_PER_BATCH = 4; // the cage's settleBatch takes 4: with 8, its proof took too long to dismiss for a small settle to land on preprod
export const DEAD_MARGIN_SECS = 30n;
export const CLAIM_PATIENCE_MS = 5 * 60_000;
export const KEEP_ALIVE_BEFORE = 10n * 60n; // a warm table gets its settle of nothing this long before it would go quiet
export const HOLD_MARGIN_SECS = 420n; // a hold for a standing player ends this long before a deadline, so what is already finished still lands
export const SEAT_MARGIN_SECS = 90n; // a permit needs at least this long left, or a seat could run past it before it lands
export const HOP_PATIENCE_MS = 30 * 60_000; // an ask can wait for the player's round at the old table: up to a slow round, then it is refused
export const HOP_GAP_MS = 30_000; // at most one judge-paid seat or move per player in this long
export const HOPS_PER_HOUR = 30; // and this many an hour. Each one spends the judge's DUST
export const SLOW_ROUND_SECS = 1380n; // 15 s turns put a slow round at 23 minutes (NOTES.md)
export const URGENT_SECS = 600n;
// ---------- agents on tNIGHT (phase 2, 11-08) ----------
/** The table's buy-in max: no tNIGHT seat, a person's or an agent's, places more than 250 at a table. */
export const BUY_IN_MAX_STAR = 250n * 1_000_000n;
/** An agent's daily cap, in tNIGHT of net loss per Pacific day, until its owner raises or removes it. */
export const DEFAULT_DAILY_CAP = 1000n;
/**
 * What an owner signs with the wallet their agent's cage id pays out to: this agent key may play that cage id, with this daily cap.
 * limit: a whole number of tNIGHT (the default is 1000), "none" (the owner removed the cap) or "stop" (the kill switch). The newest
 * signed one wins; signedAt is in seconds.
 */
export const agentMessage = (address, cageId, agent, limit, signedAt) => `sealed-hand:agent:v1|${address}|${cageId}|${agent}|${limit}|${signedAt}`;
const AGENT_LIMIT = /^(stop|none|[1-9]\d{0,8})$/;
/** Midnight in Los Angeles on the day of nowMs, in ms: the daily cap's day. */
export function pacificDayStart(nowMs = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  return nowMs - (((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + (nowMs % 1000));
}
/**
 * Checks an owner's signed setting against the cage: only the wallet this cage id pays out to can sign it, for this message.
 * It says nothing about what the agent may do today: agentRule does, with the day's losses.
 */
export function checkAgentSetting(setting, chain, { address, addressFromKey, verify, now = Date.now() }) {
  const { cageId, agent, limit, signedAt, verifyingKey, signature, message } = setting ?? {};
  if (!/^[0-9a-f]{64}$/.test(cageId ?? '') || !/^[0-9a-f]{64}$/.test(agent ?? '')) return { ok: false, reason: 'cageId and agent must be 64 hex characters.' };
  if (!AGENT_LIMIT.test(String(limit))) return { ok: false, reason: 'limit must be a whole number of tNIGHT, "none" or "stop".' };
  if (!Number.isInteger(signedAt) || signedAt * 1000 > now + 5 * 60_000) return { ok: false, reason: 'signedAt must be when it was signed, in seconds.' };
  if (message !== agentMessage(address, cageId, agent, limit, signedAt)) return { ok: false, reason: 'The signed message is not the one for this setting.' };
  const payTo = chain.payTo(cageId);
  if (!payTo) return { ok: false, reason: 'That cage id has no payout address on chain: the agent deposits first.' };
  let keyAddress;
  try {
    keyAddress = addressFromKey(verifyingKey);
  } catch {
    return { ok: false, reason: 'verifyingKey is not a valid key.' };
  }
  if (keyAddress !== payTo) return { ok: false, reason: 'Only the wallet this cage id pays out to (the agent\'s owner) can sign its settings.' };
  if (!verify(verifyingKey, message, signature)) return { ok: false, reason: 'The signature does not match.' };
  return { ok: true };
}
/**
 * The rule a verified setting makes today: stopped, or how much more this cage id may put at risk before its daily cap.
 * null with no setting (a person, or an agent paying out to itself): no agent rule. leftStar null: the owner removed the cap.
 */
export function agentRule(setting, lossTodayStar = 0n) {
  if (!setting) return null;
  if (setting.limit === 'stop') return { stopped: true, leftStar: 0n, capStar: 0n };
  if (setting.limit === 'none') return { stopped: false, leftStar: null, capStar: null };
  const capStar = BigInt(setting.limit) * STAR_PER_CHIP;
  const left = capStar - (lossTodayStar > 0n ? lossTodayStar : 0n);
  return { stopped: false, leftStar: left > 0n ? left : 0n, capStar };
}
const tn = (star) => (Number(star) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 });
const STOPPED_REASON = 'This agent\'s owner has stopped it. The owner can start it again from its settings.';
const capReason = (rule) => `This agent has reached its owner's daily cap of ${tn(rule.capStar)} tNIGHT (net loss since midnight Pacific). It can sit again after midnight, or when its owner raises the cap.`; // a stand this close to running out, with a line to land: nothing else goes on this wallet until it has

/** Whether the contract's alive() would still hold, a little conservatively. */
export const tableAlive = (t, nowSecs, escapeSecs) => !!t && t.seated > 0n && nowSecs + DEAD_MARGIN_SECS < t.heartbeat + escapeSecs;
/** Whether the contract's standExpired() holds, or would by the time a settle built now has landed. Same margin. */
export const standRunOut = (s, nowSecs, escapeSecs) => !!s?.standing && nowSecs + DEAD_MARGIN_SECS >= s.standAt + escapeSecs;

/** Nets entries into one, for a seat standing on chain: the first line naming it frees it, so later ones couldn't name it. */
// A line that nets to zero stays. It's what frees a standing seat, and an entry with no lines at all is refused by the
// node (Custom error 168, FeeCalculation: seen on preprod, table 3).
function mergeEntries(entries) {
  const net = new Map();
  for (const e of entries) for (const l of e.lines) net.set(l.id, (net.get(l.id) ?? 0) + l.delta);
  return {
    seqs: entries.flatMap((e) => e.seqs ?? [e.seq]),
    rounds: entries.flatMap((e) => e.rounds),
    lines: [...net].map(([id, delta]) => ({ id, delta })),
  };
}

function toChainEntry(e, roundNo, dropped = []) {
  return {
    roundNo,
    seqs: e.seqs ?? [e.seq],
    rounds: e.rounds,
    lines: e.lines.map((l) => ({ id: l.id, debit: l.delta < 0 ? BigInt(-l.delta) * STAR_PER_CHIP : 0n, credit: l.delta > 0 ? BigInt(l.delta) * STAR_PER_CHIP : 0n })),
    ...(dropped.length ? { dropped } : {}),
  };
}

/**
 * The rule for a line naming a stand that has run out. The cage refuses that line, and with it the whole entry, so it is dropped: that
 * player's balance and atRisk are left untouched and the rest of the entry settles. The contract still wants debits to equal credits, so what
 * was dropped comes off the other side, shared by size, largest remainder first, then in line order. An expired loser means the winners get
 * less, and an expired winner means the losers pay less. A line shaved to nothing stays: it may be what frees a standing seat.
 * Returns the lines to settle, what was dropped, and whether the rest could be made to add up.
 */
export function dropExpiredLines(lines, isExpired) {
  const dropped = lines.filter((l) => isExpired(l.id));
  if (dropped.length === 0) return { lines, dropped, balanced: true };
  // An entry that never added up is a fault, not something to shave into shape. One that did can always be shaved: the other side covers the gap.
  if (lines.reduce((sum, l) => sum + BigInt(l.delta), 0n) !== 0n) return { lines, dropped, balanced: false };
  const kept = lines.filter((l) => !isExpired(l.id)).map((l) => ({ ...l }));
  const gap = kept.reduce((sum, l) => sum + BigInt(l.delta), 0n); // over 0: credits are short of debits to pay them. Under 0: debits are over
  if (gap === 0n) return { lines: kept, dropped, balanced: true };
  const side = kept.filter((l) => (gap > 0n ? l.delta > 0 : l.delta < 0));
  const size = (l) => BigInt(Math.abs(l.delta));
  const total = side.reduce((sum, l) => sum + size(l), 0n);
  const owed = gap > 0n ? gap : -gap;
  const shares = side.map((l, i) => ({ l, i, cut: (owed * size(l)) / total, rest: (owed * size(l)) % total }));
  let left = owed - shares.reduce((sum, x) => sum + x.cut, 0n);
  for (const x of [...shares].sort((a, b) => (a.rest === b.rest ? a.i - b.i : a.rest > b.rest ? -1 : 1))) {
    if (left === 0n) break;
    x.cut += 1n;
    left -= 1n;
  }
  for (const x of shares) x.l.delta -= Number(gap > 0n ? x.cut : -x.cut);
  return { lines: kept, dropped, balanced: true };
}

/** Whether a seat binds, as the contract's bound() would say, a little conservatively. `chain.tableAt` reads any table. */
export function seatBinds(seat, chain) {
  if (!seat || standRunOut(seat, chain.nowSecs, chain.escapeSecs)) return false;
  const t = chain.tableAt(seat.table);
  return !!t && seat.epoch === t.epoch && tableAlive(t, chain.nowSecs, chain.escapeSecs);
}

const refuse = (code, reason) => ({ kind: 'refuse', code, reason });
const wait = (why) => ({ kind: 'wait', why });

/**
 * A player has asked to be seated at this table under their permit. What to do, checked against what the contract will check before a proof is spent:
 *   verify: the seat is here on chain, so the claim's read-back takes over. Nothing to send, and this comes first, so a lost socket is never sent twice.
 *   seat: seatByJudge with no from-table. move: seatByJudge from a table the Worker says they have finished at (cage v4b merged moveByJudge into it).
 *   wait: not yet. refuse: never, and the page falls back. need_grant means one new approval from the player.
 *
 * Settle first, always. The contract can't see a live round, and a move voids any line still owed at the old table, so a move needs the Worker to list the
 * player as free to release there (left, no line still to come, no entry open) and neither table to have a transaction out. A player must never hop away from a loss.
 */
export function planAsk(claim, work, chain, { rowOf = () => null, tablesBusy = new Set(), seatOpOut = () => false, opsFor = () => [], blockedUntil = () => 0, ruleFor = () => null, nowMs = Date.now() } = {}) {
  const id = claim.cageId;
  const seat = chain.seats.get(id) ?? null;
  const here = BigInt(work.cageTable);
  const t = chain.table;
  if (seat && seat.table === here && t && seat.epoch === t.epoch && !seat.standing && tableAlive(t, chain.nowSecs, chain.escapeSecs)) return { kind: 'verify' };
  // An agent whose owner pressed Stop, or that has lost its daily cap today, gets no seat: nothing is spent on it.
  const rule = ruleFor(id);
  if (rule?.stopped) return refuse('agent_stopped', STOPPED_REASON);
  if (rule && rule.leftStar !== null && rule.leftStar < BigInt(work.ante ?? 1) * STAR_PER_CHIP) return refuse('daily_cap', capReason(rule));
  if (seatOpOut(id)) return wait('a seat or move for this player is out there, and is never sent twice');
  if (work.phase !== 'lobby') return refuse('table_started', 'This table has started, so it can\'t take another seat now.');
  if (seat?.standing && seatBinds(seat, chain)) return refuse('standing', 'That seat is standing on chain: it frees at the next settle, then you can sit again.');

  const p = chain.permit(id);
  if (!p) return refuse('need_grant', 'No permit on chain: approve one deposit and the judge can seat you.');
  if (p.judge !== chain.judgeId) return refuse('need_grant', 'The judge\'s key has changed, and your permit names the old one: approve one deposit to grant it again.');
  if (p.until <= chain.nowSecs + SEAT_MARGIN_SECS) return refuse('need_grant', 'Your permit has run out: approve one deposit to grant it again.');

  const balance = chain.balance(id);
  const above = balance > p.floor ? balance - p.floor : 0n;
  // Never more than roundCap: a standing seat is freed by its first line, so a debt over it could never be collected (review of v4b, H-3).
  // And never more than the table's buy-in max (250), or what an agent has left under its owner's daily cap.
  const most = [BigInt(claim.ask.atRiskStar), p.cap, above, BUY_IN_MAX_STAR, ...(chain.roundCap != null ? [chain.roundCap] : []), ...(rule && rule.leftStar !== null ? [rule.leftStar] : [])].reduce((a, b) => (b < a ? b : a));
  if (most < BigInt(work.ante ?? 1) * STAR_PER_CHIP) return refuse('need_grant', 'Your permit has too little left to place at this table: approve one deposit to grant it again.');
  if (t && tableAlive(t, chain.nowSecs, chain.escapeSecs) && t.seated >= chain.maxSeats) return refuse('table_full', 'This table is full on chain.');

  const ops = opsFor(id);
  if (ops.filter((at) => nowMs - at < 3_600_000).length >= HOPS_PER_HOUR) return refuse('too_many_hops', 'That is a lot of moves in an hour. Try again in a while.');
  if (ops.some((at) => nowMs - at < HOP_GAP_MS)) return wait('one seat or move per player in this long');
  if (blockedUntil(id) > nowMs) return wait('backing off after a failed seat');
  if (tablesBusy.has(work.id)) return wait('this table has a transaction out');

  // A stand that has run out, or at a table long gone: it holds nothing, but the contract won't seat over it, and only a release takes it off. Then the seat, next time round.
  if (seat?.standing) return { kind: 'clear', cageId: id, table: seat.table };

  if (!seatBinds(seat, chain)) return { kind: 'seat', cageId: id, to: here, atRisk: most, ...(seat ? { replaces: seat.table } : {}) };

  // Bound at another table. It may only come off if that table is finished with them.
  const from = rowOf(seat.table);
  if (!from) return refuse('seated_elsewhere', `You hold a seat at table ${seat.table} that this Hall doesn't know. Stand from it under My cage, then sit again.`);
  if (tablesBusy.has(from.id)) return wait('the old table has a transaction out');
  if (from.claims.some((c) => c.cageId === id)) return wait('a claim at the old table is still with the judge');
  if (from.entries.some((e) => e.lines.some((l) => l.id === id))) return wait('settle first: an entry naming this seat is still open at the old table');
  const holder = from.holders.find((h) => h.cageId === id);
  if (holder && !holder.released && !from.releases.some((r) => r.cageId === id)) return wait('settle first: their round at the old table is not over');
  return { kind: 'move', cageId: id, from: seat.table, fromRow: from.id, to: here, atRisk: most };
}

/** Every ask at one table, sorted into what to send, what waits and what is refused. An ask that has waited too long is refused. */
export function planAsks(work, chain, opts = {}) {
  const out = { verify: [], seats: [], moves: [], clears: [], waits: [], refusals: [] };
  const nowMs = opts.nowMs ?? Date.now();
  for (const claim of work.claims) {
    if (!claim.ask) { out.verify.push(claim); continue; }
    const a = planAsk(claim, work, chain, opts);
    if (a.kind === 'verify') out.verify.push(claim);
    else if (a.kind === 'seat') out.seats.push({ ...a, at: claim.at });
    else if (a.kind === 'move') out.moves.push({ ...a, at: claim.at });
    else if (a.kind === 'clear') out.clears.push({ ...a, at: claim.at });
    else if (a.kind === 'refuse') out.refusals.push({ cageId: claim.cageId, code: a.code, reason: a.reason });
    else if (nowMs - (claim.at ?? 0) > HOP_PATIENCE_MS) out.refusals.push({ cageId: claim.cageId, code: 'seat_timeout', reason: `The judge waited too long to seat you: ${a.why}.` });
    else out.waits.push({ cageId: claim.cageId, why: a.why });
  }
  return out;
}

/**
 * work: one row of GET /judge/tables. chain: { table, seats: Map(id → seat), balance: (id) → star, nowSecs, escapeSecs }.
 * done: Set of "tableId:seq" this judge has already landed or sent. knownRound: the highest chain round on record.
 */
export function planTable(work, chain, { done = new Set(), knownRound = 0n, keepAliveBefore = KEEP_ALIVE_BEFORE, asks = {}, askedElsewhere = () => false, madeSeat = () => false } = {}) {
  const out = { dead: null, verify: [], seats: [], moves: [], clears: [], waits: [], refusals: [], standing: [], standingLeft: [], urgent: false, standUntil: {}, tableUntil: null, expired: [], dropped: [], hold: false, entries: [], releases: [], heldForMove: [], strays: [], blocked: null, wantHouse: false, keepAlive: null };
  const t = chain.table;
  const seated = work.holders.filter((h) => !h.released);

  // A seat in a table the chain has voided means nothing now, and nothing can settle there.
  if (work.status === 'open' && seated.length > 0) {
    const stale = seated.some((h) => t && h.epoch !== Number(t.epoch));
    if (!tableAlive(t, chain.nowSecs, chain.escapeSecs) || stale) {
      out.dead = stale ? 'a newer sit voided these seats: the table had no settle for 30 minutes.' : 'the cage escape fired: no settle for 30 minutes.';
      return out;
    }
  }
  if (work.status !== 'open') return out;

  // A claim with an ask goes to the judge's permit path. One without is today's "I have sat, read it". The chain's read-back is the same for both.
  if (work.claims.some((c) => c.ask)) Object.assign(out, planAsks(work, chain, asks));
  else out.verify = work.claims;
  out.wantHouse = work.wantHouse;
  if (t) out.tableUntil = t.heartbeat + chain.escapeSecs;

  const onTable = (id) => { const s = chain.seats.get(id); return s && t && s.table === BigInt(work.cageTable) && s.epoch === t.epoch ? s : null; };

  // Someone called stand on chain. The Worker must let their last round finish before anything settles that names them,
  // and the cage only waits escapeSecs for that: standUntil is when the seat goes free, so no round should outlast it.
  const expired = (id) => standRunOut(onTable(id), chain.nowSecs, chain.escapeSecs);
  const standing = new Set(work.holders.filter((h) => onTable(h.cageId)?.standing && !expired(h.cageId)).map((h) => h.cageId));
  const stillPlaying = work.holders.filter((h) => standing.has(h.cageId) && !h.left);
  out.standing = stillPlaying.map((h) => h.cageId);
  // Someone who left first and stood after is standing too: the Worker needs their deadline for a line still to come, and to mark them freed. They only need telling once.
  out.standingLeft = work.holders.filter((h) => standing.has(h.cageId) && h.left && h.standUntil == null).map((h) => h.cageId);
  for (const id of [...out.standing, ...out.standingLeft]) out.standUntil[id] = onTable(id).standAt + chain.escapeSecs;
  out.expired = work.holders.filter((h) => expired(h.cageId)).map((h) => h.cageId);
  // Someone a settle of nothing can name: on this table and not leaving it, because a line naming a standing seat frees it.
  const carrier = work.holders.find((h) => !h.released && !standing.has(h.cageId) && !expired(h.cageId) && onTable(h.cageId));
  // The hold waits out a standing player's last round, but no further than it is safe to. Past this, a loser could run out the clock and void
  // what is already finished. A table with someone to carry it gets a settle of nothing long before this, below, so its own deadline only comes this
  // close if those have been failing, or if there is nobody to name.
  const soon = (deadline) => chain.nowSecs + HOLD_MARGIN_SECS >= deadline;
  const mustSettle = stillPlaying.some((h) => soon(onTable(h.cageId).standAt + chain.escapeSecs)) || (!!t && soon(t.heartbeat + chain.escapeSecs));
  if (stillPlaying.length > 0 && !mustSettle) out.hold = true;

  const lastRound = t?.lastRound ?? 0n;
  if (lastRound > BigInt(work.lastChainRound) && lastRound > knownRound) {
    out.blocked = `chain says round ${lastRound} but the Worker and the journal know ${work.lastChainRound} and ${knownRound}: refusing to settle until a person looks`;
    return out;
  }

  let pending = work.entries.filter((e) => !done.has(`${work.id}:${e.seq}`));
  // Anything naming a standing seat has to go in one entry: the seat is freed by the first line that names it.
  const standers = pending.reduce((last, e, i) => (e.lines.some((l) => standing.has(l.id)) ? i : last), -1);
  if (standers > 0) pending = [mergeEntries(pending.slice(0, standers + 1)), ...pending.slice(standers + 1)];
  out.urgent = [...standing].some((id) => onTable(id).standAt + chain.escapeSecs - chain.nowSecs <= URGENT_SECS && (work.live || pending.some((e) => e.lines.some((l) => l.id === id))));

  if (!out.hold) {
    let roundNo = lastRound;
    const balances = new Map();
    const atRisks = new Map();
    for (const pendingEntry of pending) {
      roundNo += 1n;
      const seqs = pendingEntry.seqs ?? [pendingEntry.seq];
      // Also someone who has left and whose seat has gone: freed by a settle at the end of a hold, or back on another table after their stand ran out. The
      // cage can't take the line. Blocking would only let the table die with everyone's rounds, so it goes the same way as a stand that has run out.
      // Also one a settle freed: their stand's seat is gone even if they have sat back down at this table, and a line must not land on the new seat. That re-sit is N-2.
      const gone = (id) => work.holders.some((h) => h.cageId === id && h.left && (h.freed || !onTable(id)));
      const { lines, dropped, balanced } = dropExpiredLines(pendingEntry.lines, (id) => expired(id) || gone(id));
      if (!balanced) {
        out.blocked = `entry ${seqs} names a stand that has run out, and its lines don't add up`;
        return out;
      }
      if (dropped.length > 0 && lines.length === 0) {
        // Nothing left, and an entry with no lines is refused by the node. A zero line for someone still seated carries the round.
        if (!carrier) {
          out.blocked = `entry ${seqs} names only stands that have run out, and nobody else is seated to carry it`;
          return out;
        }
        lines.push({ id: carrier.cageId, delta: 0 });
      }
      const e = { ...pendingEntry, lines };
      const entry = toChainEntry(e, roundNo, dropped.map((l) => ({ id: l.id, delta: l.delta })));
      for (const l of dropped) out.dropped.push({ seqs, id: l.id, delta: l.delta });
      for (const l of entry.lines) {
        const seat = onTable(l.id);
        if (!seat) {
          out.blocked = `entry ${entry.seqs} names ${l.id.slice(0, 12)}, who has no seat at table ${work.cageTable} on chain`;
          return out;
        }
        const bal = balances.get(l.id) ?? chain.balance(l.id);
        const risk = atRisks.get(l.id) ?? seat.atRisk;
        if (l.debit > risk || l.debit > bal) {
          out.blocked = `entry ${entry.seqs} debits ${l.id.slice(0, 12)} ${l.debit} over atRisk ${risk} or balance ${bal}`;
          return out;
        }
        // The cage refuses a line over roundCap every time. Sending it would only fail the batch again and again, so a person decides (review of v4b, H-3).
        if (chain.roundCap != null && l.debit > chain.roundCap) {
          out.blocked = `entry ${entry.seqs} debits ${l.id.slice(0, 12)} ${l.debit}, over the cage's roundCap ${chain.roundCap}: the cage would refuse it every time`;
          return out;
        }
        balances.set(l.id, bal - l.debit + l.credit);
        atRisks.set(l.id, risk - l.debit);
      }
      if (entry.lines.length > LINES_PER_ENTRY) {
        out.blocked = `entry ${entry.seqs} has ${entry.lines.length} lines; the contract takes ${LINES_PER_ENTRY}`;
        return out;
      }
      out.entries.push(entry);
    }
  }

  // Standing on chain at this table with nothing here to answer for: they sat, then never got a seat. A stand that has run out too:
  // its owner is free, but the table still counts the seat. Never with a round waiting: a release frees a seat a stranger could sit in,
  // and each sit makes the waiting settle fail, so doing this then would hand a griefer an endless supply of free seats.
  // And a seat the judge made under a permit with no holder and no live claim: its claim was refused or timed out, so it binds with nobody playing.
  const known = new Set([...work.holders.map((h) => h.cageId), ...work.claims.map((c) => c.cageId), ...work.releases.map((r) => r.cageId)]);
  if (pending.length === 0) {
    for (const [id, seat] of chain.seats) {
      if (seat.table !== BigInt(work.cageTable) || !t || seat.epoch !== t.epoch) continue;
      if (seat.standing ? !known.has(id) || standRunOut(seat, chain.nowSecs, chain.escapeSecs) : !known.has(id) && madeSeat(id, work.cageTable)) out.strays.push(id);
    }
  }

  // A warm table with only the house on it: nothing settles, so it needs a settle of nothing to stay ready. A player's seat is
  // never kept this way: their escape is theirs, and this stops as soon as anyone sits.
  // A hop on its way counts as nobody yet: it can wait a long round at its old table, and the table has to be alive when it gets here.
  if (work.warm && work.phase === 'lobby' && work.house && work.claims.every((c) => c.ask) && out.entries.length === 0 && seated.every((h) => h.kind === 'house') && t && onTable(work.house) && chain.nowSecs - t.heartbeat >= chain.escapeSecs - keepAliveBefore) {
    out.keepAlive = { roundNo: lastRound + 1n, seqs: [], rounds: [], lines: [{ id: work.house, debit: 0n, credit: 0n }] };
  }

  // A round in play, or a hold, has to be able to finish. A slow round can outlast the time a table has left when it is dealt, and if the table dies its
  // finished rounds are void. This is a table in use: a seated player with no round going still gets no settle of nothing, and anyone can stand to leave.
  // A round dealt too late to finish before the table's deadline gets its settle at its start, once: the settle moves the deadline past it. So does a deal the Worker is holding back for this.
  // Past a round's longest possible age it is stuck, not slow (N-7): no more settles for it, unless a hold needs one.
  if (!out.keepAlive && out.entries.length === 0 && t && carrier) {
    const dealtAt = work.dealtAt ? BigInt(Math.floor(work.dealtAt / 1000)) : null;
    const stuck = !!dealtAt && work.live && chain.nowSecs - dealtAt > 2n * SLOW_ROUND_SECS;
    const late = !!dealtAt && work.live && !stuck && dealtAt + SLOW_ROUND_SECS > t.heartbeat + chain.escapeSecs;
    const quiet = chain.nowSecs - t.heartbeat >= chain.escapeSecs - keepAliveBefore;
    if (work.dealWaiting || late || (quiet && ((work.live && !stuck) || out.hold))) out.keepAlive = { roundNo: lastRound + 1n, seqs: [], rounds: [], lines: [{ id: carrier.cageId, debit: 0n, credit: 0n }] };
  }

  // Never free a seat that still owes a line, planned or held: its line couldn't land after that. The Worker doesn't list such a seat, and this doesn't rely on it.
  const owing = new Set(pending.flatMap((e) => e.lines.map((l) => l.id)));
  // On Leave: release, unless the next table is already known. Then the move takes the seat off this table, with no gap for a stranger's rescue.
  for (const r of work.releases) {
    if (owing.has(r.cageId)) continue;
    if (askedElsewhere(r.cageId, work.id)) out.heldForMove.push(r.cageId);
    else out.releases.push({ ...r, onChain: !!onTable(r.cageId) });
  }
  return out;
}

const utf8 = (s) => new TextEncoder().encode(s);
/**
 * The bytes a key may have signed for a message. An agent wallet signs them as they are. Lace's signData prefixes
 * `midnight_signed_message:<byteLength>:` (lace apps/lace-sdk/src/sign-midnight-data.ts). Either proves the key.
 */
export const signedForms = (message) => [utf8(message), utf8(`midnight_signed_message:${utf8(message).length}:${message}`)];

/**
 * Checks one session at the door against the cage: this player key's balance pays out to the wallet that signed, the message
 * says what the session claims, and it hasn't run out. It says nothing about any seat: a table asks about that itself.
 */
export function checkDoor(session, chain, { address, addressFromKey, verify, settingFor = () => null, now = Date.now() }) {
  if (session.expires * 1000 <= now) return { ok: false, reason: 'That session has run out.' };
  if (session.message !== `sealed-hand:door:v1|${address}|${session.cageId}|${session.payout}|${session.expires}`) return { ok: false, reason: 'The signed message is not the one for this session.' };
  const payTo = chain.payTo(session.cageId);
  if (!payTo) return { ok: false, reason: 'That cage id has no payout address on chain: deposit first.' };
  if (payTo !== session.payout) return { ok: false, reason: 'That wallet is not the payout address of this cage id.' };
  let keyAddress;
  try {
    keyAddress = addressFromKey(session.verifyingKey);
  } catch {
    return { ok: false, reason: 'verifyingKey is not a valid key.' };
  }
  if (keyAddress !== payTo) {
    // An agent with its own wallet, paying out to its owner: its key may sign the door only under a setting its owner signed.
    const setting = settingFor(session.cageId);
    if (!setting || setting.agent !== keyAddress) return { ok: false, reason: 'That key is not the payout address of this cage id.' };
    if (setting.limit === 'stop') return { ok: false, reason: STOPPED_REASON };
    if (!verify(session.verifyingKey, session.message, session.signature)) return { ok: false, reason: 'The signature does not match.' };
    return { ok: true, agent: true };
  }
  if (!verify(session.verifyingKey, session.message, session.signature)) return { ok: false, reason: 'The signature does not match.' };
  return { ok: true };
}

/** Checks one seat claim against the cage. Signature checking is passed in, so tests can use the real ledger functions. */
export function checkClaim(claim, cageTable, chain, { address, addressFromKey, verify, ruleFor = () => null, now = Date.now() }) {
  const seat = chain.seats.get(claim.cageId);
  const young = now - (claim.at ?? 0) < CLAIM_PATIENCE_MS;
  const t = chain.table;
  if (!seat || seat.table !== BigInt(cageTable) || !t || seat.epoch !== t.epoch) {
    return young ? { wait: true } : { ok: false, reason: `No seat at table ${cageTable} on chain for that cage id. Sit first, then ask again.` };
  }
  if (!tableAlive(t, chain.nowSecs, chain.escapeSecs)) return { ok: false, reason: 'That table has gone quiet on chain, so the seat no longer binds.' };
  if (seat.standing) return { ok: false, reason: 'That seat is standing on chain.' };
  const payTo = chain.payTo(claim.cageId);
  if (!payTo) return { ok: false, reason: 'That cage id has no payout address on chain.' };
  // A seat with more at risk than roundCap can't be dealt in: a standing seat pays at most one line, and a line at most roundCap (review of v4b, H-3).
  if (chain.roundCap != null && seat.atRisk > chain.roundCap) return { ok: false, reason: `That seat has ${seat.atRisk} STAR at risk, over the cage's limit of ${chain.roundCap} for one round. Sit again with that or less.` };
  // A seat its own key made on chain answers to the same table rules as one the judge made: the buy-in max, and an agent's owner.
  if (seat.atRisk > BUY_IN_MAX_STAR) return { ok: false, code: 'buy_in_max', reason: `That seat has ${tn(seat.atRisk)} tNIGHT at risk, over the table's buy-in max of 250. Stand, and sit again with 250 or less.` };
  const rule = ruleFor(claim.cageId);
  if (rule?.stopped) return { ok: false, code: 'agent_stopped', reason: STOPPED_REASON };
  if (rule && rule.leftStar !== null && seat.atRisk > rule.leftStar) return { ok: false, code: 'daily_cap', reason: rule.leftStar < STAR_PER_CHIP ? capReason(rule) : `That seat has ${tn(seat.atRisk)} tNIGHT at risk, more than the ${tn(rule.leftStar)} this agent has left under its owner's daily cap today. Stand, and sit again with that or less.` };
  // A seat claimed with a session from the door: the key and wallet were proven there, and the seat is this player key's own.
  if (claim.door) return { ok: true, atRiskStar: String(seat.atRisk), balanceStar: String(chain.balance(claim.cageId)), epoch: Number(seat.epoch), lastRound: String(t.lastRound) };
  let keyAddress;
  try {
    keyAddress = addressFromKey(claim.verifyingKey);
  } catch {
    return { ok: false, reason: 'verifyingKey is not a valid key.' };
  }
  if (keyAddress !== payTo) return { ok: false, reason: 'That key is not the payout address of this cage id.' };
  if (claim.message.split('|')[1] !== address) return { ok: false, reason: 'The signed message names a different cage.' };
  if (!verify(claim.verifyingKey, claim.message, claim.signature)) return { ok: false, reason: 'The signature does not match.' };
  return { ok: true, atRiskStar: String(seat.atRisk), balanceStar: String(chain.balance(claim.cageId)), epoch: Number(seat.epoch), lastRound: String(t.lastRound) };
}

/**
 * The journal, as lines of JSON. Replayed on start:
 *   intent  → sent  → landed → written
 *   intent  → failed (nothing can land; the rounds go back to pending)
 * `sent` is written before the transaction leaves, so a crash can only leave a transaction we know the id of.
 */
export class Journal {
  constructor(lines = []) {
    this.batches = new Map();
    this.seatOps = new Map(); // seats and moves the judge sent under a permit. They carry no round number, so the chain's read-back is the guard, and this is the record
    for (const line of lines) this.apply(line);
  }

  apply(r) {
    if (r.type?.startsWith('seat-')) return this.applySeatOp(r);
    if (r.type === 'intent') this.batches.set(r.batch, { ...r, state: 'intent', written: [] });
    const b = this.batches.get(r.batch);
    if (!b) return;
    if (r.type === 'sent') Object.assign(b, { state: 'sent', id: r.id, sentAt: r.at });
    if (r.type === 'landed') Object.assign(b, { state: 'landed', id: r.id, hash: r.hash, block: r.block, status: r.status, blockAt: r.blockAt ?? null, landedAt: r.at ?? null });
    if (r.type === 'failed') Object.assign(b, { state: 'failed', reason: r.reason });
    if (r.type === 'written') b.written.push(r.table);
  }

  /**
   * A player's net loss (debits less credits, in STAR) in every settle since sinceMs that landed or may land: an agent's daily cap is counted
   * from this. A settle out there that nobody has seen land yet counts, so the cap can't be outrun by a slow block.
   */
  lossSince(id, sinceMs) {
    let net = 0n;
    for (const b of this.batchList()) {
      if (b.state === 'failed') continue;
      const t = Date.parse(b.landedAt ?? b.sentAt ?? b.at ?? '');
      if (!(t >= sinceMs)) continue;
      for (const e of b.entries) for (const l of e.lines ?? []) if (l.id === id) net += BigInt(l.debit) - BigInt(l.credit);
    }
    return net;
  }

  /** Every "tableId:seq" that a live or landed transaction covers. These are not to be planned again. */
  taken() {
    const out = new Set();
    for (const b of this.batchList()) {
      if (b.state === 'failed') continue;
      for (const e of b.entries) for (const seq of e.seqs) out.add(`${e.table}:${seq}`);
    }
    return out;
  }

  /** The highest chain round this judge has landed or may have sent, per table. */
  knownRound(table) {
    let most = 0n;
    for (const b of this.batchList()) {
      if (b.state === 'failed') continue;
      for (const e of b.entries) if (e.table === table && BigInt(e.roundNo) > most) most = BigInt(e.roundNo);
    }
    return most;
  }

  /** Tables with a transaction out that nobody has seen land or fail. Nothing more settles there, so rounds go in order. */
  tablesInFlight() {
    const out = new Set();
    for (const b of this.unresolved()) for (const e of b.entries) out.add(e.table);
    return out;
  }

  unresolved() { return this.batchList().filter((b) => b.state === 'intent' || b.state === 'sent'); }

  applySeatOp(r) {
    if (r.type === 'seat-intent') { this.seatOps.set(r.op, { ...r, state: 'intent', written: false }); return; }
    const o = this.seatOps.get(r.op);
    if (!o) return;
    if (r.type === 'seat-sent') Object.assign(o, { state: 'sent', tx: r.tx, sentAt: r.at });
    if (r.type === 'seat-landed') Object.assign(o, { state: 'landed', tx: r.tx, hash: r.hash, block: r.block, status: r.status, blockAt: r.blockAt ?? null, ms: r.ms ?? null, landedAt: r.at });
    if (r.type === 'seat-failed') Object.assign(o, { state: 'failed', reason: r.reason });
    if (r.type === 'seat-written') o.written = true;
  }

  /** Seats and moves nobody has seen land or fail. */
  seatOpsOut() { return this.opList().filter((o) => o.state === 'intent' || o.state === 'sent'); }
  seatOpOut(id) { return this.seatOpsOut().some((o) => o.cageId === id); }

  /** When this player's seats and moves left, for the rate limit. A failed one still spent a proof, and maybe a fee. */
  seatOpTimes(id) { return this.opList().filter((o) => o.cageId === id).map((o) => Date.parse(o.at)).filter(Number.isFinite); }

  /** Whether the judge's last landed seat for this player was at this table: the only seats it may free as strays. */
  madeSeat(id, cageTable) {
    let last = null;
    for (const o of this.opList()) if (o.cageId === id && o.state === 'landed') last = o;
    return !!last && String(last.to) === String(cageTable);
  }

  /** Landed, with the receipt still to reach the Worker. */
  seatOpsUnwritten() { return this.opList().filter((o) => o.state === 'landed' && !o.written); }

  /** Landed, with receipts still to deliver to the Worker. */
  unwritten() {
    const out = [];
    for (const b of this.batchList()) {
      if (b.state !== 'landed') continue;
      for (const e of b.entries) if (!b.written.includes(e.table)) out.push({ batch: b.batch, entry: e, tx: { hash: b.hash, id: b.id, block: b.block, status: b.status, chainRound: e.roundNo, blockAt: b.blockAt ?? null } });
    }
    return out;
  }

  /**
   * One Worker's part of a journal two Workers share (11-10: one judge for staging and live). Every line a site writes carries `site`;
   * lines from before that carry none and are the `legacy` site's (staging's). What goes back to a Worker, and what holds its tables
   * (receipts, rounds taken, round numbers, transactions out), is that site's alone, so a receipt never reaches the other Worker.
   * What belongs to a player and the chain is shared: one cage, one seat a player, one daily cap for an agent's owner.
   */
  forSite(site, { legacy = false } = {}) {
    const mine = (x) => (x.site ?? (legacy ? site : null)) === site;
    const view = Object.create(this);
    view.batchList = () => this.batchList().filter(mine);
    view.opList = () => this.opList().filter(mine);
    // A seat or move out for a player holds their next one, whichever Worker asked: the chain has one seat for them. Their hop rate,
    // the seats the judge made them, and an agent's daily loss are theirs, not a Worker's.
    for (const name of ['seatOpOut', 'seatOpTimes', 'madeSeat', 'lossSince']) view[name] = (...a) => this[name](...a);
    view.site = site;
    return view;
  }
  batchList() { return [...this.batches.values()]; }
  opList() { return [...this.seatOps.values()]; }
}
