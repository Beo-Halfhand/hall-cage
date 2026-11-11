// dice-house's order of work: one wallet, so the nearest deadline goes first, and no new call while a bot is owed an answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MARGIN, order, owesBots } from '../scripts/dice-house-order.mjs';

const now = 1_000_000;
const bot = (answered = false) => ({ bot: true, answered });
const person = (answered = false) => ({ bot: false, answered });
const table = (id, work) => ({ id, work });
const ids = (xs) => xs.map((t) => t.id);

test('bots owed an answer come first, nearest house deadline first', () => {
  const tables = [
    table('finishing', { stage: 'answering', houseBy: now + 400, seats: [bot(true), person()] }),
    table('late bot', { stage: 'answering', houseBy: now + 300, seats: [bot(), person()] }),
    table('soon bot', { stage: 'answering', houseBy: now + 120, seats: [bot(true), bot(), person()] }),
    table('opening', { stage: 'opening', seats: [bot(), person()] }),
  ];
  assert.deepEqual(ids(order(tables, now)), ['soon bot', 'late bot', 'finishing', 'opening']);
});

test('no new call while a bot is owed an answer, and calls go out again once none is', () => {
  const calling = table('calling', { stage: 'calling', seats: [bot(), person()] });
  const owing = table('owing', { stage: 'answering', houseBy: now + 200, seats: [bot(), person()] });
  assert.deepEqual(ids(order([calling, owing], now)), ['owing']);
  const answered = table('answered', { stage: 'answering', houseBy: now + 200, seats: [bot(true), person()] });
  assert.deepEqual(ids(order([calling, answered], now)), ['calling', 'answered']);
});

test('a bot is owed only while its answer can still land: past the margin, the call waiting behind it goes out', () => {
  const w = { stage: 'answering', houseBy: now + MARGIN, seats: [bot(), person()] };
  assert.equal(owesBots(w, now), false);
  assert.equal(owesBots({ ...w, houseBy: now + MARGIN + 1 }, now), true);
  assert.deepEqual(ids(order([table('calling', { stage: 'calling', seats: [] }), table('too late', w)], now)), ['calling', 'too late']);
});

test('a seed that has to open before its window closes is ordered by that window, with the bots', () => {
  const tables = [
    table('bot', { stage: 'answering', houseBy: now + 300, seats: [bot()] }),
    table('seed', { stage: 'sealing', openBy: now + 150, seats: [bot(), person(true)] }),
    table('revealing', { stage: 'revealing', openBy: now + 500, seats: [bot()] }),
  ];
  assert.deepEqual(ids(order(tables, now)), ['seed', 'bot', 'revealing']);
});

test('tables with no deadline keep the Worker\'s order, and a person owed an answer is not the house\'s to give', () => {
  const tables = [
    table('a', { stage: 'answering', houseBy: now + 200, seats: [person()] }),
    table('b', { stage: 'opening', seats: [] }),
    table('c', { stage: 'calling', seats: [] }),
  ];
  assert.deepEqual(ids(order(tables, now)), ['a', 'b', 'c']);
  assert.equal(owesBots(tables[0].work, now), false);
});
