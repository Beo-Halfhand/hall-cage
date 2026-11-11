// Read-only check (11-09): cage4's public state through Midnight.js 5 and the 0.16 build. No wallet, nothing sent.
import './mask-stdio.mjs';
import { readFileSync } from 'node:fs';
import { readCage, hex } from './l9-cage.mjs';
const addr = JSON.parse(readFileSync(process.env.CAGE_FILE ?? 'deployment.cage4.json', 'utf8')).address;
const { L, era, protocolVersion, authority } = await readCage(addr);
let sum = 0n, n = 0; for (const [, v] of L.balance) { sum += v; if (v > 0n) n++; }
console.log(`cage ${addr.slice(0, 12)}… · state era ${era} · protocol ${protocolVersion} · judge ${hex(L.judge).slice(0, 12)}… · maxGrant ${L.maxGrant}s · escape ${L.escapeSecs}s · seats ${L.maxSeats}`);
console.log(`balances: ${L.balance.size()} entries, ${n} non-zero, total ${Number(sum) / 1e6} tNIGHT · seat ${L.seat.size()} · tables ${L.tables.size()} · permits ${L.permits.size()}`);
console.log(`maintenance authority: committee ${authority?.committee?.length} · threshold ${authority?.threshold} · counter ${authority?.counter}`);
process.exit(0);
