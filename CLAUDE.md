# CLAUDE.md

Project instructions live in **`AGENTS.md`** (canonical — kept as one file to avoid drift).

Quick orientation:
- **Architecture (north star):** `refactor plan/unified-process-supervision-2026-06-02.md` — five
  roles (Supervisor · Engine · Brain · Store · UI), one lifecycle, one reconciler, one wake-up.
  Visual: `refactor plan/architecture-map.html`.
- **Core principles:** one path only (a refactor deletes the old path; surface any dual process
  before fixing) · positive receipt over inference (timeouts → typed failure, never a silent hang
  or fake success) · the DB is the source of truth.
- **How we work:** fix the live issue on the one path, then migrate subsystems toward the target
  slowly — no big-bang rewrite. Don't add new dual paths.

Read `AGENTS.md` for the full rules, the current priority, and build/verify steps.
