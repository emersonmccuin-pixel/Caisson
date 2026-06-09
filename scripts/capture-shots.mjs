// Throwaway README screenshot capture. Drives the sandbox web UI (:5175) with
// playwright-core + a cached chromium, writes 01–06 PNGs into docs/images/.
//   node scripts/capture-shots.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const { chromium } = require(
  join(REPO, 'node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core'),
);
const CHROME = join(
  process.env.LOCALAPPDATA,
  'ms-playwright/chromium-1223/chrome-win64/chrome.exe',
);
const OUT = join(REPO, 'docs/images');
const BASE = 'http://127.0.0.1:5175';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
});
const page = await ctx.newPage();

async function clickTab(label) {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await sleep(900);
}
async function shot(name) {
  await page.screenshot({ path: join(OUT, name) });
  console.log('[shot]', name);
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 });
  await sleep(1500);

  // Dismiss the Claude-version mismatch banner if present.
  const dismiss = page.getByRole('button', { name: 'dismiss', exact: false });
  if (await dismiss.count()) {
    await dismiss.first().click().catch(() => {});
    await sleep(400);
  }

  // Select the Sales project.
  await page.locator('button[aria-label="Sales"]').first().click();
  await sleep(1200);

  // 02 — board: work tab → Tasks sub-tab → Kanban view
  await clickTab('work');
  await sleep(500);
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click();
  await sleep(500);
  await page.getByRole('button', { name: 'Kanban', exact: true }).first().click();
  await sleep(900);
  await shot('02-board.png');

  // 01 — chat (session list landing)
  await clickTab('chat');
  await sleep(800);
  await shot('01-orchestrator-chat.png');

  // 03 + 06 — processes tab → open the workflow → graph view
  await clickTab('processes');
  await sleep(800);
  const wf = page.getByText('Post-call follow-up').first();
  if (await wf.count()) {
    await wf.click();
    await sleep(1200);
  }
  await shot('03-workflow-builder.png');
  await sleep(300);
  await shot('06-workflow-graph.png');

  // 04 — agents / specialists (select a relatable specialist, not the meta one)
  await clickTab('agents');
  await sleep(700);
  const researcher = page.getByText('researcher', { exact: true }).first();
  if (await researcher.count()) {
    await researcher.click().catch(() => {});
    await sleep(700);
  }
  await shot('04-specialists.png');

  // 05 — work item inspector (open the rich Acme card)
  await clickTab('work');
  await sleep(900);
  const card = page.getByText('Follow-up — Acme Corp', { exact: false }).first();
  await card.click();
  await sleep(1200);
  await shot('05-work-item.png');

  console.log('[done] all shots captured');
} catch (err) {
  console.error('[capture] error:', err);
  await page.screenshot({ path: join(OUT, '_debug.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
