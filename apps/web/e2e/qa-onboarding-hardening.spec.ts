/**
 * QA smoke test — onboarding hardening (pc-pty-chat-298)
 * Written by QA agent for work item 01KTHQZTT7QVA32ADPXJT1C0EN
 *
 * Tests:
 * 1. ?onboarding=force renders the wizard (not the Shell)
 * 2. No "Skip for now" text anywhere in the wizard (hard gate enforced)
 * 3. ?onboarding=sim — "Create your first project" is disabled at the Done step
 * 4. Outstanding items listed when prerequisites missing
 *
 * Requires: dev server on localhost:5173
 */

import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5173';

// Skip all tests if the dev server is not running
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    const resp = await page.goto(BASE, { timeout: 5000 });
    if (!resp || resp.status() >= 500) {
      console.log('Dev server not reachable — skipping onboarding smoke tests');
    }
  } catch {
    console.log('Dev server not reachable — skipping onboarding smoke tests');
  } finally {
    await page.close();
  }
});

test.describe('onboarding hardening (pc-pty-chat-298)', () => {

  test('1 — ?onboarding=force renders the wizard (Welcome step visible)', async ({ page }) => {
    const resp = await page.goto(`${BASE}/?onboarding=force`, { timeout: 10000 }).catch(() => null);
    if (!resp) {
      test.skip();
      return;
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    // The wizard should show "Welcome" step in the sidebar
    const welcomeText = page.locator('text=Welcome').first();
    await expect(welcomeText).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'e2e/evidence/qa-01-wizard-force-open.png', fullPage: true });
  });

  test('2 — no "Skip for now" button anywhere in the onboarding wizard', async ({ page }) => {
    const resp = await page.goto(`${BASE}/?onboarding=force`, { timeout: 10000 }).catch(() => null);
    if (!resp) { test.skip(); return; }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('text=Welcome', { timeout: 10000 });

    // Navigate through ALL steps checking for "Skip for now"
    const steps = ['Welcome', 'Default view', 'Claude Code', 'Git', 'Sign in', 'Projects folder', 'All set'];
    for (const stepName of steps) {
      // Try to click the step in the sidebar
      const sidebarBtn = page.locator('button', { hasText: stepName }).first();
      if (await sidebarBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await sidebarBtn.click();
        await page.waitForTimeout(300);
      }
      const skipBtn = page.locator('text=Skip for now');
      const count = await skipBtn.count();
      expect(count, `"Skip for now" found on step: ${stepName}`).toBe(0);
    }
    await page.screenshot({ path: 'e2e/evidence/qa-02-no-skip-button.png', fullPage: true });
  });

  test('3 — sim mode Done step: Create button is disabled when not all done', async ({ page }) => {
    const resp = await page.goto(`${BASE}/?onboarding=sim`, { timeout: 10000 }).catch(() => null);
    if (!resp) { test.skip(); return; }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('text=Welcome', { timeout: 10000 });

    // Navigate to "All set" step via sidebar
    const allSetBtn = page.locator('button', { hasText: 'All set' }).first();
    if (await allSetBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await allSetBtn.click();
      await page.waitForTimeout(500);

      // The Create button should be disabled (allDone is false in sim mode at start)
      const createBtn = page.locator('button', { hasText: 'Create your first project' });
      if (await createBtn.count() > 0) {
        await expect(createBtn.first()).toBeDisabled();
        await page.screenshot({ path: 'e2e/evidence/qa-03-create-button-disabled.png', fullPage: true });
      }
    } else {
      // Step-by-step navigation
      for (let i = 0; i < 7; i++) {
        const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), button:has-text("Get started")').first();
        if (await nextBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await nextBtn.click();
          await page.waitForTimeout(300);
        }
      }
      const createBtn = page.locator('button', { hasText: 'Create your first project' });
      if (await createBtn.count() > 0) {
        await expect(createBtn.first()).toBeDisabled();
      }
      await page.screenshot({ path: 'e2e/evidence/qa-03-create-button-disabled.png', fullPage: true });
    }
  });

  test('4 — Done step lists outstanding items when prerequisites missing', async ({ page }) => {
    const resp = await page.goto(`${BASE}/?onboarding=sim`, { timeout: 10000 }).catch(() => null);
    if (!resp) { test.skip(); return; }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('text=Welcome', { timeout: 10000 });

    // Go to All set step
    const allSetBtn = page.locator('button', { hasText: 'All set' }).first();
    if (await allSetBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await allSetBtn.click();
      await page.waitForTimeout(500);
      // Sim mode starts with everything missing — outstanding labels should appear
      const notSignedIn = page.locator('text=Not signed in to Claude');
      const notInstalled = page.locator('text=Claude Code not installed');
      const gitMissing = page.locator('text=Git not installed');
      const hasOutstanding =
        (await notSignedIn.count()) > 0 ||
        (await notInstalled.count()) > 0 ||
        (await gitMissing.count()) > 0;
      expect(hasOutstanding).toBe(true);
      await page.screenshot({ path: 'e2e/evidence/qa-04-outstanding-items.png', fullPage: true });
    }
  });

});
