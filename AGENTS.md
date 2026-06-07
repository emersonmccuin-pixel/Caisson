# AGENTS.md — Caisson (PC)

Project instructions for anyone (human or agent) working in this repo. This is the canonical
instruction file; `CLAUDE.md` is a pointer to it (one file, no drift).

## What this is

A local-first desktop app (Electron) where an **orchestrator** converses with the user, **agent
workers** do jobs, and **workflows** chain steps — backed by SQLite, surfaced in a web UI. All AI
work is Claude Code (`claude.exe`) processes.

Caisson is now **self-hosted — it's the daily driver.** We use it every day to run this very
project. That posture drives everything below.

## How we work (the dogfooding loop)

The center of gravity is a single loop, and the **build workflow is its assembly line**:

1. **Use the app daily** — orchestrator chat, agent dispatch, workflows, the board.
2. **Capture bugs + polish as work items** the moment you hit them — that's the intake.
3. **The build workflow picks them up** — plan → fix → typecheck/test → deploy.
4. **The fix lands back in the app you're using.** Close the loop, repeat.

The job is to **operate the daily driver**: fix bugs, polish rough edges, keep the loop turning.
That is the work now — not a ground-up rebuild.

### Guardrails the loop depends on

These were decided this session and are the safety rails for the bug push. **Two are still being
fixed in TOP PRIORITIES — describe the target loop, but don't trust the loop as safe until they
land:**

- **Every dispatch has a contract + isolation, via one path** ([pc-pty-chat-273](pc://work-item/pc-pty-chat-273)).
  No dispatch should run without a machine-checkable contract and a provisioned isolation
  (worktree). This is being made structural — enforced in code, not by convention.
- **Git is orchestrator-owned and verified** ([pc-pty-chat-270](pc://work-item/pc-pty-chat-270)).
  The build workflow's merge/restart/push steps are honor-system gate prompts today — approving
  them performs NO git, so a run can "complete" without merging/testing/pushing. Until fixed, the
  orchestrator owns and verifies git directly; don't assume a green workflow shipped anything.

## Core principles (non-negotiable)

- **One path only.** A fix/refactor DELETES the old path — never patch one path and keep a fallback.
  The instant you spot a dual process / two code paths doing the same job, **STOP and surface it**
  before fixing.
- **Positive receipt over inference.** "Done" / "ready" / "paused" are explicit signals
  (`pc_submit_deliverable`, the ready-gate, an explicit ask). Timeouts/exits only ever produce a
  **typed failure with a reason** — never a silent hang or a fake success.
- **The DB is the source of truth.** Runtime processes + in-memory registries are projections of it.
- **One owner per concern.** Each job lives in exactly one place.
- **Every agent dispatch has a contract + (when declared) provisioned isolation — or it refuses
  loudly.** A contract is a hard precondition of spawn: if one cannot be created, the dispatch is
  aborted with `cause: 'contract-required'` before the agent ever starts. If `isolation: "worktree"`
  is declared, a real git worktree must be provisioned before spawn; falling back to the main repo
  folder is a silent integrity violation and is categorically refused (`cause:
  'worktree-provision-failed'`). This is enforced structurally in code — there is no code path for
  any work-item source or dispatch shape that brings up an agent without meeting both conditions.

## Current priority

The **TOP PRIORITIES** area is the ordered, do-this-first sequence. As of this writing:

1. **[pc-pty-chat-273](pc://work-item/pc-pty-chat-273)** — enforce contract + isolation on every
   dispatch (structural, in code).
2. **[pc-pty-chat-270](pc://work-item/pc-pty-chat-270)** — orchestrator-owned git / fix the build
   workflow's shipping steps.
3. **[pc-pty-chat-272](pc://work-item/pc-pty-chat-272)** — fix the dev-stack `PC_ROOT` leak so
   fixes can be tested cleanly.
4. **Release** — ship the above plus the already-merged terminal/scroll/Playwright fixes to the
   packaged app.
5. **The big bug-fixing push** — run the dogfooding loop at full tilt.

Check the TOP PRIORITIES area for the live list; it's authoritative over this snapshot.

## Build & verify

- Typecheck: per-package `npx tsc --noEmit`, or `pnpm -r typecheck`.
- **ONE RUNTIME:** the stack is the Electron app — its main process supervises the API +
  agent-host as child processes running the **dist bundles** (`node server.mjs`/`host.mjs`), dev and
  packaged alike. `pnpm dev:app` (= `pnpm dev`) adds the tooling around it: esbuild `--watch`
  rebuilds the bundles on save; Vite serves the UI. Load rebuilt code: server →
  `POST /api/dev/restart` (exit 75 → respawn); host → kill its pid from
  `data/agent-host/host.lock.json` (supervisor respawns).
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

## Architecture reference (for when you're deep in the engine)

The as-built architecture lives in **`Sub-Systems/`** — one folder per role (Store · Engine ·
Brain · Product · UI · Supervisor-Ops). Start at `Sub-Systems/README.md` and
`Sub-Systems/_Foundation-Decisions.md`. This is **reference material** for when you're working
inside the engine — no longer an active rebuild plan.

The shape in one line: five roles, one home each — **Supervisor** (dumb, durable; keeps service
processes alive) · **Engine/host** (the single owner of every `claude.exe`) · **Brain** (stateless
control plane; owns the truth; ONE reconciler) · **Store** (append-only event log = truth) · **UI
shell** (pure view). One lifecycle, one "done" signal, one thing waking whoever's waiting.

The discipline that keeps the codebase healthy while we operate it: **don't add NEW dual paths**;
every new feature builds toward that target shape; when you consolidate a concern, add a single-path
guard test so it can't regrow a second path. **Verify before you trust a verdict** — the audit
caught code that *looked* dead but runs the app; confirm in code before deleting.

## System thesis (the through-line)

Durable state lives in SQLite / server-owned services. Runtime processes **emit facts**; live events
**project** those facts to the UI; chat is a view over durable conversation/runtime events. Agents and
workflows communicate through explicit app-owned **contracts**. The durable **mailbox** is the notify
door. **MCP** is an adapter over shared contracts and services, not a separate product API.

> Note: as the orchestrator's Project Brief + Operating Notes ship
> ([pc-pty-chat-256](pc://work-item/pc-pty-chat-256)), "how the assistant should behave in this
> project" migrates THERE. AGENTS.md then settles into its lean role: the on-disk,
> always-true-even-without-Caisson rules for anyone working in the repo. Don't cram
> orchestrator-behavior here that belongs in Operating Notes.
