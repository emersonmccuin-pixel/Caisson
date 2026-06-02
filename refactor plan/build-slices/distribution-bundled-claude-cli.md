# Slice (distribution) — Bundled, pinned, isolated Claude Code CLI

> Status: **backlog — captured, not yet planned.** This is a requirement-capture stub, not a gated code-grounded slice plan. A full plan/build needs its own planning session per `AGENTS.md`.
> Track: **distribution / onboarding (Section 10)** — OUTSIDE the refactor's numbered switchover sequence. Deliberately not numbered 020–023 (those are reserved by slice 019 for the contract-first arc). Sequence with the onboarding/desktop-shell work, not the contract slices.
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

## Open decisions (STOP-and-confirm at planning)
- **Vendoring mechanism — OPEN.** Vendor the npm package `@anthropic-ai/claude-code@2.1.160` into the build vs. ship the native-installer binary artifact. Cross-platform reach (Windows-first, but don't paint macOS/Linux into a corner). User undecided; resolve during planning.
- **Resolver precedence vs config/env** — confirm explicit override/`claudeExe`/`CLAUDE_EXE` still win over bundled (escape hatch), with bundled beating PATH/homedir. (Lean: yes.)

## Non-goals
- Auto-updating the bundled CLI (the point is a deliberate pin).
- Supporting arbitrary user-chosen CC versions inside the app beyond the override escape hatch.
- The broader first-run onboarding wizard (separate Section 10 phase).

## Tracker
Registered in `refactor plan/refactor-tracker.md` (Planning Artifact Tracker + Change Log) as backlog. Promote to a real slice plan when distribution/onboarding work is prioritized.
