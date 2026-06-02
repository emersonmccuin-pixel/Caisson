# Slice (distribution) — Bundled, pinned, isolated Claude Code CLI

> Status: **BUILT (Windows), 2026-06-02 — pending packaged-app verification.** Code + packaging wiring + tests landed and all automated gates are green (resolver tests, full `pnpm typecheck`, agent-host build, staging script verified against the real 2.1.160 binary). NOT yet confirmed inside an installed packaged build (the one remaining check — see "Verification boundary").
> Track: **distribution / onboarding (Section 10)** — OUTSIDE the refactor's numbered switchover sequence. Deliberately not numbered 020–023 (those are reserved by slice 019 for the contract-first arc).
> Created 2026-06-02.

## Problem
Caisson spawns whatever `claude` it finds on the machine. There is no pinned version and no isolation.

- **No version pin → updates break the app.** PC is tightly coupled to Claude Code CLI surface behavior: welcome-banner rendering, queue protocol, JSONL transcript shape, `--resume` timing, system-prompt precedence. A global CLI auto-update silently changes any of these and breaks boot detection / chat rendering / dispatch. (This failure class has already burned multiple sessions — banner cursor-escapes, the ≥2.1 queue protocol shift, interleaved-thinking dual end_turn, etc.)
- **No isolation → the user can't have their own newer CLI.** Today the app and the user share one binary. A person who wants a more recent `claude` on their machine for their own work can't have it without risking the app, and vice versa.

## Goal
Ship a **pinned** Claude Code CLI **inside the Caisson app**, used by default, **isolated** from the user's global install.
- The app always runs the version it was built+verified against — reproducible, update-proof.
- The user's global `claude` is independent: they can install/upgrade/remove it freely with zero effect on the app.

## Current-state evidence
- `packages/runtime/src/claude-resolver.ts` is the single resolution point. Order today (highest first): per-call override → `GlobalSettings.claudeExe` → `CLAUDE_EXE` env → PATH (`where`/`which claude`) → `~/.local/bin/claude(.exe)` → not-found.
- **No bundled candidate exists** in that chain — every path lands on whatever the machine happens to have.
- Header comment already frames this file as "the foundation of Section 10 (onboarding/distribution)."
- Resolver is the consumer of all spawns (`low-level-spawn.ts`, `pty-session.ts` go through it). On this dev box it currently resolves to the global install, **Claude Code 2.1.160**.
- Packaging today: Electron app under `apps/desktop`, electron-builder, Windows-first (per onboarding work). Electron pinned at 35 due to a better-sqlite3/V8 constraint.

## Direction (to confirm at planning — not locked)
1. **Add a `bundled` candidate to the resolver.** A CLI shipped with the app, resolved from the packaged resources dir (e.g. `process.resourcesPath`) in production and from a known dev path in dev. Record its version.
2. **Resolution precedence.** Keep explicit user intent on top (per-call override, `claudeExe` setting, `CLAUDE_EXE`) so a power user can still point at their own. But move **bundled ABOVE PATH/`~/.local/bin`**, so a random global install never silently shadows the pinned one. Default experience = bundled.
3. **Pin a version + vendor it reproducibly.** Pin to **2.1.160** (locked). Decide vendoring mechanism (see open decisions).
4. **Packaging.** Bundle as an electron-builder `extraResources`; if it's an npm-package-shaped CLI, `asarUnpack` it (native bits can't run from inside asar). Resolve dev vs packaged paths.
5. **Surface the bundled version** in settings/UI so it's visible which CLI the app is running, and make the pin a deliberate, tested bump.

## Decisions (user, 2026-06-02)
- **Pin version: 2.1.160 — LOCKED.** Confirmed by the user as a good version. (Must stay the version PC's boot/queue/JSONL parsers are verified against; bumping is a deliberate, tested step.)
- **Auth/config: SHARE the user's `~/.claude` — LOCKED.** Reuse their existing login; isolate only the binary/version, NOT auth. No isolated `CLAUDE_CONFIG_DIR` and no forced re-auth.

## Resolved decisions (now settled by evidence + build)
- **Vendoring mechanism = ship the native single-file binary.** Investigation showed 2.1.160 installs as a native ~238 MB `claude.exe` (at `~/.local/bin/`, with the installer's `.old.1` self-update backup) — it is NOT an npm package. So we vendor that binary as an electron-builder `extraResources` drop-in: one self-contained file, no Node-runtime dependency.
- **Resolver precedence = explicit override/`claudeExe`/`CLAUDE_EXE` win; bundled beats PATH/homedir.** Implemented exactly so.

## What landed
- **Resolver** (`packages/runtime/src/claude-resolver.ts`): new `bundled` candidate at priority #4 (after the 3 explicit hatches, before PATH/`~/.local/bin`), existence-gated so a missing/dev bundle falls through. New `setBundledClaudeExe()` setter (exported from `@pc/runtime`).
- **Server boot** (`apps/server/src/index.ts`): reads `PC_BUNDLED_CLAUDE_EXE` env and registers it before any PTY starts.
- **Agent host** (`packages/agent-host/src/cli.ts`): same registration — dispatched agents run the pinned CLI too (the desktop forwards the env to the host process).
- **Desktop** (`apps/desktop/src/main.ts`): sets `PC_BUNDLED_CLAUDE_EXE = <resources>/claude/claude(.exe)` before booting the in-process server.
- **Packaging** (`apps/desktop/scripts/stage-claude.mjs` + `package.json`): a `stage:claude` step (chained into `prepackage` after `stage`) copies the pinned binary from `~/.local/bin` (or `PC_CLAUDE_SRC`) into `staging/claude/`, **asserts the version == 2.1.160** (build fails on mismatch), writes a `VERSION` provenance marker; new `extraResources` entry ships it as `<resources>/claude/`.
- **Tests** (`packages/runtime/test/claude-resolver.test.ts`): 8 cases covering precedence + existence-gating + trim/clear.

## Auth (per locked decision)
No `CLAUDE_CONFIG_DIR` is set for the bundled CLI — it inherits the user's `~/.claude`, so their existing login is reused. Only the binary/version is isolated. The existing `claudeConfigDir` setting still works if true config isolation is ever wanted.

## Verification boundary (what's left)
- **Packaged-app launch check (human/product):** build `pnpm --filter @pc/desktop dist:dir`, install/run, start a chat + dispatch an agent, confirm both use the bundled `<resources>/claude/claude.exe` (not a global install). Can't be done from this session (no packaged run + no app restart per `AGENTS.md`).
- **Cross-platform:** only the Windows binary is wired/tested. `dist:mac`/Linux need their platform's pinned `claude` provided via `PC_CLAUDE_SRC` (the stage step hard-fails without it — intentional, so an unpinned app can't ship).

## Non-goals
- Auto-updating the bundled CLI (the point is a deliberate pin).
- Supporting arbitrary user-chosen versions beyond the override escape hatch.
- The broader first-run onboarding wizard (separate Section 10 phase).
- Surfacing the bundled version in the settings UI (nice-to-have follow-up; `VERSION` marker + provenance exist on disk).

## Tracker
Registered in `refactor plan/refactor-tracker.md` (Planning Artifact Tracker + Change Log).
