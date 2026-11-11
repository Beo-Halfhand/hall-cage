// What dice-house does next. It has one wallet, so one transaction at a time, and each takes about half a minute to land. A bot's answer has
// to land inside the house's window and the seed inside the open window, so the nearest deadline goes first. No new call goes out while a
// bot is still owed an answer, because each call starts a house window of its own. A held call only waits: if its time runs out, the round is
// voided and every stake goes back, which is better than a bot going quiet and the house losing a call it should have won.
export const MARGIN = 45; // seconds: a proof and a block. No bot's answer starts later than this before the house's deadline.

/** A table whose bots still owe an answer, while there's time to give one. */
export const owesBots = (w, now) =>
  w.stage === 'answering' && w.houseBy != null && now < Number(w.houseBy) - MARGIN && (w.seats ?? []).some((s) => s?.bot && !s.answered);

const deadline = (w, now) => {
  if (owesBots(w, now)) return Number(w.houseBy) - MARGIN;
  if ((w.stage === 'sealing' || w.stage === 'revealing') && w.openBy != null) return Number(w.openBy) - MARGIN;
  return Infinity;
};

/** The tables to try, in order, without the calls that have to wait. dice-house sends at most one transaction, then asks the Worker again. */
export function order(tables, now) {
  const busy = tables.some(({ work }) => owesBots(work, now));
  return tables
    .filter(({ work }) => !(busy && work.stage === 'calling'))
    .map((t, i) => ({ t, i, d: deadline(t.work, now) }))
    .sort((a, b) => (a.d - b.d) || (a.i - b.i))
    .map(({ t }) => t);
}
