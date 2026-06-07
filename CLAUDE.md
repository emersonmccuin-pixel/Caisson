# CLAUDE.md

Project instructions live in **`AGENTS.md`** (canonical — kept as one file to avoid drift).

Quick orientation:
- **What this is:** a local-first Electron desktop app — orchestrator chat + agent workers +
  workflows over SQLite, surfaced in a web UI. It is now **self-hosted: the daily driver.**
- **How we work (the dogfooding loop):** use the app daily → capture bugs + polish as work items →
  the **build workflow** picks them up (plan → fix → test → deploy) → the fix lands back in the app
  you're using. Operating the daily driver is the job — not a rebuild.
- **Core principles:** one path only (a refactor deletes the old path; surface any dual process
  before fixing) · positive receipt over inference (timeouts → typed failure, never a silent hang
  or fake success) · the DB is the source of truth.
- **Current priority:** the **TOP PRIORITIES** area sequence — enforce contract+isolation on every
  dispatch → orchestrator-owned git → fix the dev-stack `PC_ROOT` leak → release → the big bug push.
- **Architecture (`Sub-Systems/`):** reference for when you're deep in the engine — no longer an
  active rebuild plan.

Read `AGENTS.md` for the full rules, the current priority, and build/verify steps.
