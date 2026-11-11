// The receipt page's own "Check this round" in a real browser, as a stranger would press it (no wallet, no key). Exits 1 on any failed line.
//   node scripts/check-receipt-page.mjs <workerUrl> <receipt number | url path> [...]
// Lines come out as `pass`, `fail` or `word` (a thing the page says it cannot check). Needs playwright-core: PLAYWRIGHT_CORE or the Hall package's copy.
import { pathToFileURL } from 'node:url';
const [BASE, ...which] = process.argv.slice(2);
if (!BASE || !which.length) throw new Error('usage: check-receipt-page.mjs <workerUrl> <receipt number | /receipt/n> ...');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE ?? '../sealed-hand-hall-package/node_modules/playwright-core/index.mjs').href);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let bad = 0;
for (const w of which) {
  const path = String(w).startsWith('/') ? w : `/receipt/${w}`;
  await page.goto(`${BASE}${path}`);
  await page.waitForSelector('#check-now', { timeout: 30000 });
  await page.click('#check-now');
  await page.waitForSelector('#rc-checks li', { timeout: 60000 });
  await page.waitForTimeout(8000); // the chain lines come in after the dice lines
  const lines = await page.$$eval('#rc-checks li', (x) => x.map((li) => [li.className, li.textContent.trim()]));
  console.log(`${path} · ${(await page.textContent('#status').catch(() => '')).trim()}`);
  for (const [k, t] of lines) { console.log(`  ${k === 'pass' ? '✓' : k === 'fail' ? '✗' : '·'} ${k}: ${t}`); if (k === 'fail') bad++; }
  console.log(`  ${lines.filter(([k]) => k === 'pass').length} pass · ${lines.filter(([k]) => k === 'fail').length} fail · ${lines.filter(([k]) => k !== 'pass' && k !== 'fail').length} other`);
}
await browser.close();
process.exit(bad ? 1 : 0);
