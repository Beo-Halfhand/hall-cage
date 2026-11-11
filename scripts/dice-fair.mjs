// The dice arithmetic in plain JavaScript, with nothing from the Midnight packages. It must match contracts/dice-proof.compact to the
// bit: test/dice-proof.test.mjs holds the two together, and test/dice-vectors.json carries the same answers to the Worker's fair.js.
// persistentHash is SHA-256 of the fields in order: Bytes as they are, a Uint<N> little-endian in N/8 bytes.
import { createHash } from 'node:crypto';

const bytes32 = (b) => { if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error('expected 32 bytes'); return b; };
const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return new Uint8Array(h.digest()); };
const le = (n, bytes) => {
  if (typeof n !== 'bigint' && !Number.isInteger(n)) throw new Error('expected a whole number');
  const v = BigInt(n);
  if (v < 0n || v >= 1n << BigInt(bytes * 8)) throw new Error(`${n} doesn't fit in ${bytes} bytes`);
  const out = new Uint8Array(bytes); let x = v; for (let i = 0; i < bytes; i++) { out[i] = Number(x & 255n); x >>= 8n; } return out;
};
const tag = (name) => { const out = new Uint8Array(32); out.set(new TextEncoder().encode(`cup-and-claim:${name}:v2`)); return out; };
const roundBytes = ({ table, round }) => [le(table, 4), le(round, 4)];

export const keyId = (sk) => sha(tag('seat'), bytes32(sk));
export const houseCommitOf = (seed, id) => sha(tag('house'), bytes32(seed), ...roundBytes(id));
export const commitOf = (seed, cup, self) => sha(tag('commit'), bytes32(seed), ...roundBytes(cup), le(cup.seat, 1), bytes32(self));
export const preSealOf = (commit, cup) => sha(tag('preseal'), bytes32(commit), ...roundBytes(cup), le(cup.seat, 1));
export const saltOf = (houseSeed, id, cups, self) => { if (cups.length !== 6) throw new Error('six seats, always'); return sha(tag('salt'), bytes32(houseSeed), ...roundBytes(id), ...cups.map(bytes32), bytes32(self)); };
export const rollOf = (salt, seed, seat) => sha(tag('roll'), bytes32(salt), bytes32(seed), le(seat, 1));

const LIMITS = [10923, 21846, 32768, 43691, 54614];
export const dieOf = (hi, lo) => { if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < 0 || hi > 255 || lo < 0 || lo > 255) throw new Error('a die comes from two bytes'); const w = hi * 256 + lo; return 1 + LIMITS.filter((t) => w >= t).length; };
export const diceOf = (roll) => [0, 2, 4, 6, 8].map((i) => dieOf(bytes32(roll)[i], roll[i + 1]));
export const countOf = (dice, face) => {
  const f = Number(face);
  if (dice.length !== 5 || !Number.isInteger(f) || f < 2 || f > 6) throw new Error('five dice and a face from 2 to 6');
  return dice.filter((d) => Number(d) === f || Number(d) === 1).length;
};
