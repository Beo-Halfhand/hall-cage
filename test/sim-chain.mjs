// The cage as the chain would run it, from the real compiled circuits, with no network and no proofs. Shared by the wiring tests here and the Hall's acceptance test.
import { randomBytes } from 'node:crypto';
import { createConstructorContext, createCircuitContext, sampleContractAddress } from 'cage-l8/runtime';

const { Contract, ledger, pureCircuits } = await import(new URL(`${process.env.MANAGED ?? '../contracts/managed/sealed-cage'}/contract/index.js`, import.meta.url).href);
export { ledger, pureCircuits };

const witnesses = { secretKey: ({ privateState }) => [privateState, privateState.sk] };
export const NIGHT = 1_000_000n;
export const hex = (u) => Buffer.from(u).toString('hex');
export const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
export const b32 = () => new Uint8Array(randomBytes(32));
export const idOf = (sk) => pureCircuits.playerId(sk);

/** A cage with the real parameters: escape 1800, slack 300, roundCap 1000, 6 seats, judgeDelay 2700, maxGrant 30 days. `clock` is the block's time in seconds. */
export function simChain({ clock = () => BigInt(Math.floor(Date.now() / 1000)), seats = 6n, escape = 1800n, slack = 300n, delay = 2700n, cap = 1000n * NIGHT, maxGrant = 2_592_000n } = {}) {
  const contract = new Contract(witnesses);
  const judge = { sk: b32() };
  const address = sampleContractAddress();
  const init = contract.initialState(createConstructorContext({ sk: b32() }, '00'.repeat(32)), idOf(judge.sk), idOf(judge.sk), 0n, cap, escape, seats, slack, delay, maxGrant);
  let ctx = createCircuitContext(address, '00'.repeat(32), init.currentContractState.data, judge, undefined, undefined, Number(clock()));
  let block = 1000;
  return {
    judge,
    address: hex(typeof address === 'string' ? unhex(address) : address),
    block: () => block,
    /** Runs a circuit and lands it, or throws what the contract asserted. */
    call(sk, name, ...args) {
      const cc = { ...ctx, currentPrivateState: { sk } };
      cc.currentQueryContext.block = { ...cc.currentQueryContext.block, secondsSinceEpoch: clock() };
      const r = contract.impureCircuits[name](cc, ...args);
      ctx = r.context;
      block += 1;
      return r;
    },
    state: () => ledger(ctx.currentQueryContext.state),
    clock,
  };
}

/** What judge-cycle.mjs needs from a wallet: lands at once, counts what it sent, and can be told to fail. */
export function simWallet(chain) {
  const w = {
    sent: [],
    next: [], // what the next calls do: 'unknown', 'refused', or undefined to land
    async callCircuit(circuit, skHex, args, label, onSend) {
      const tx = `tx${w.sent.length + 1}`;
      const how = w.next.shift();
      w.sent.push({ circuit, label, tx, how: how ?? 'landed', kind: circuit === 'seatByJudge' && args[1]?.is_some ? 'move' : circuit === 'seatByJudge' ? 'seat' : circuit });
      if (how === 'refused') throw new Error('refused before the pool');
      onSend?.(tx);
      if (how === 'unknown') throw Object.assign(new Error(`submit outcome unknown for ${tx}`), { unknown: true, id: tx });
      if (how === 'unknown-landed') { chain.call(unhex(skHex), circuit, ...args); throw Object.assign(new Error(`submit outcome unknown for ${tx}`), { unknown: true, id: tx }); }
      chain.call(unhex(skHex), circuit, ...args);
      return { hash: `hash-${tx}`, id: tx, block: chain.block(), status: 'SucceedEntirely', blockAt: null };
    },
  };
  return w;
}
