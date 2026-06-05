# AGENTS.md — Caisson (PC)

Project instructions for anyone (human or agent) working in this repo. This is the canonical
instruction file; `CLAUDE.md` is a pointer to it (one file, no drift).

## What this is

A local-first desktop app (Electron) where an **orchestrator** converses with the user, **agent
workers** do jobs, and **workflows** chain steps — backed by SQLite, surfaced in a web UI. All AI
work is Claude Code (`claude.exe`) processes.

## The architecture (north star)

The durable architecture reference lives in **`Sub-Systems/`** — one folder per role (Store ·
Engine · Brain · Product · UI · Supervisor-Ops), each documenting the as-built design. Start at
`Sub-Systems/README.md` and `Sub-Systems/_Foundation-Decisions.md`.

The target in one line: five roles, one home each — **Supervisor** (dumb, durable; keeps service
processes alive) · **Engine/host** (the single owner of every `claude.exe`) · **Brain** (stateless
control plane; owns the truth; ONE reconciler) · **Store** (append-only event log = truth) · **UI
shell** (pure view). One lifecycle, one "done" signal, one thing waking whoever's waiting.

> The detailed rebuild-sequencing and milestone-scope planning was archived out of the repo
> (local-only `archive/`, gitignored). `Sub-Systems/` is the source of architectural truth now.

## Core principles (non-negotiable)

- **One path only.** A fix/refactor DELETES the old path — never patch one path and keep a fallback.
  The instant you spot a dual process / two code paths doing the same job, **STOP and surface it**
  before fixing.
- **Positive receipt over inference.** "Done" / "ready" / "paused" are explicit signals
  (`pc_submit_deliverable`, the ready-gate, an explicit ask). Timeouts/exits only ever produce a
  **typed failure with a reason** — never a silent hang or a fake success.
- **The DB is the source of truth.** Runtime processes + in-memory registries are projections of it.
- **One owner per concern.** Each job lives in exactly one of the five roles.

## How we work (execution model)

- **Not a big-bang rewrite.** Fix the live issue on the one path, get workflows working, then migrate
  subsystems toward the target **slowly / opportunistically** (when you're already in that code).
- The discipline that makes slow migration safe: **don't add NEW dual paths**; every new feature
  builds toward the target; when you consolidate a concern, add a single-path guard test so it can't
  regrow a second path.
- **Verify before you trust a verdict.** The audit caught code that *looked* dead but runs the app —
  confirm in code before deleting.

## Current priority

**Step 1 — one terminal authority + run-keyed waiter:** make a finished agent run *advance its
workflow* (today a second listener wins the terminal race and the workflow's `done` never resolves,
so cards don't move).

## Build & verify

- Working branch: **`refactor/auto-pathway`**.
- Typecheck: per-package `npx tsc --noEmit`, or `pnpm -r typecheck`.
- **ONE RUNTIME (Step 7):** the stack is the Electron app — its main process supervises the API +
  agent-host as child processes running the **dist bundles** (`node server.mjs`/`host.mjs`), dev and
  packaged alike. `pnpm dev:app` (= `pnpm dev`) adds the tooling around it: esbuild `--watch`
  rebuilds the bundles on save; Vite serves the UI. Load rebuilt code: server →
  `POST /api/dev/restart` (exit 75 → respawn); host → kill its pid from
  `data/agent-host/host.lock.json` (supervisor respawns). ☠ `dev-supervisor.mjs`, tsx-run API, and
  the packaged in-process server import are deleted (ONE-SUPERVISOR gate).
- Restart the dev stack **only** via the `restart-stack` skill / `scripts/restart-stack.ps1` — never
  hand-kill pids. Restart only at testing time or when asked.
- Commit completed work before stopping; keep `git status --short` clean at handoff.

## Hard rules

- Don't restart servers, kill Node/Vite/Electron/Caisson, or call restart endpoints — except a
  sanctioned testing-time restart via the `restart-stack` skill.
- Don't leave completed work uncommitted at handoff.
- Don't change code during a planning/design discussion unless asked.
- Don't assume a prior recommendation is implemented — verify in code.
- Don't silently resolve a cross-subsystem conflict — surface it.

## System thesis (the through-line)

Durable state lives in SQLite / server-owned services. Runtime processes **emit facts**; live events
**project** those facts to the UI; chat is a view over durable conversation/runtime events. Agents and
workflows communicate through explicit app-owned **contracts**. The durable **mailbox** is the notify
door. **MCP** is an adapter over shared contracts and services, not a separate product API.
