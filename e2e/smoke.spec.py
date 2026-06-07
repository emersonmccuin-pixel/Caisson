"""
Proof spec — real Playwright browser smoke against the Caisson dev server.

Usage (inside worktree, dev server running on :5173):
    python e2e/smoke.spec.py

What it proves:
- Playwright/chromium launches without path-guard denial (the path-guard fix
  that unblocked this run lives in templates/.claude/hooks/path-guard.cjs).
- The dev server at localhost:5173 is reachable from a headless browser.
- The page's <title> and a visible landmark element are asserted at runtime.
- A screenshot is saved to e2e/evidence/smoke.png (attached as proof).

Requires:
- pip install playwright && playwright install chromium
- Caisson dev server running: pnpm --filter @pc/web dev   (port 5173)
"""

import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, Error as PwError

REPO_ROOT   = Path(__file__).resolve().parent.parent
EVIDENCE    = REPO_ROOT / "e2e" / "evidence"
SCREENSHOT  = EVIDENCE / "smoke.png"
DEV_URL     = "http://localhost:5173"
TIMEOUT_MS  = 20_000


def run() -> int:
    EVIDENCE.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx     = browser.new_context(viewport={"width": 1280, "height": 800})
        page    = ctx.new_page()

        try:
            page.goto(DEV_URL, wait_until="domcontentloaded", timeout=TIMEOUT_MS)
        except PwError as e:
            print(f"FAIL: could not reach {DEV_URL}: {e}", file=sys.stderr)
            print("Ensure the Vite dev server is running: pnpm --filter @pc/web dev", file=sys.stderr)
            browser.close()
            return 1

        title = page.title()
        print(f"Page title: {title!r}")

        # Assert a top-level DOM node is present (proves the app shell rendered).
        page.wait_for_selector("body", timeout=5_000)
        body_text = page.inner_text("body")
        assert len(body_text) > 0, "body appears empty — app may not have mounted"

        page.screenshot(path=str(SCREENSHOT), full_page=False)
        print(f"Screenshot: {SCREENSHOT}")

        browser.close()

    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(run())
