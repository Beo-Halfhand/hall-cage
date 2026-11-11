// Writes test/dice-vectors.json from the compiled contract's own pure circuits, with made-up seeds that are never used anywhere else.
// The Worker's fair.js is tested against a copy of this file, so the page, the Worker and the circuits can't drift apart unseen.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const { pureCircuits: P } = await import('../contracts/managed/dice-proof/contract/index.js');
const hex = (u) => Buffer.from(u).toString('hex');
const fake = (label) => new Uint8Array(createHash('sha256').update(`dice-vectors:${label}`).digest());
const out = [];
for (const [n, table, round, seat, empty] of [[0, 1, 1, 0, []], [1, 115, 2, 1, [4, 5]], [2, 4294967295, 4294967295, 5, []], [3, 1000, 47, 3, [0]], [4, 7, 1, 2, [1, 3, 5]], [5, 256, 65536, 4, []]]) {
  const id = { table: BigInt(table), round: BigInt(round) }, cup = { ...id, seat: BigInt(seat) };
  const seed = fake(`seed${n}`), houseSeed = fake(`house${n}`);
  const self = fake(`self${n}`);
  const cups = Array.from({ length: 6 }, (_, k) => (empty.includes(k) ? new Uint8Array(32) : k === seat ? P.commitOf(seed, cup, self) : fake(`cup${n}.${k}`)));
  const salt = P.saltOf(houseSeed, id, cups, self);
  const roll = P.rollOf(salt, seed, cup.seat);
  out.push({ table, round, seat, seed: hex(seed), keyId: hex(P.keyId(seed)), houseSeed: hex(houseSeed), houseCommit: hex(P.houseCommitOf(houseSeed, id)), commit: hex(P.commitOf(seed, cup, self)), preseal: hex(P.preSealOf(P.commitOf(seed, cup, self), cup)), cups: cups.map(hex), self: hex(self), salt: hex(salt), roll: hex(roll), dice: P.diceOf(roll).map(Number) });
}
writeFileSync(new URL('../test/dice-vectors.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${out.length} vectors`);
