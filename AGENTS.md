# AGENTS.md — Refactor Planning and Build Readiness

This repo is currently in a post-synthesis refactor-planning phase.

The six priority subsystem architecture handoffs and whole-system synthesis now exist. The current job is to turn that architecture work into a cohesive implementation roadmap, foundation specs, test characterization plan, and then small build-slice plans.

Do not implement refactors unless the user explicitly asks.

## Refactor Execution Model (current, 2026-05-30)

The refactor now runs **live in the working session**, driven by Claude with **subagents** (the Agent tool) doing the plan and build work for each slice. There is no external Workflow-orchestration pipeline; the docs under `refactor plan/orchestration/` are retired and kept for history only.

Per slice: **plan** (subagent, docs only) → **build** (subagent, in-scope code only) → Claude posts a **plain-English in-app test checklist** → the **human browser-tests** the slice on `refactor/auto-pathway` and confirms pass. The human review is the advance gate; the old automated verify/close sessions are retired (automated tests/typechecks still run inside the build as a pre-gate). See `refactor plan/definitive-session-pathway.md` → "How We Run This".

## Refactor Planning Files

- North star: `refactor plan/target-architecture.md`
- Reusable prompt: `refactor plan/subsystem-architecture-handoff-prompt.md`
- Tracker: `refactor plan/refactor-tracker.md`
- Manual session tracker: `refactor plan/refactor-session-tracker.md`
- Definitive session pathway: `refactor plan/definitive-session-pathway.md`
- Subsystem docs folder: `refactor plan/refactor plan docs/`
- Holistic synthesis output: `refactor plan/holistic-architecture-synthesis.md`
- Implementation roadmap output: `refactor plan/implementation-roadmap.md`
- Foundation specs folder: `refactor plan/foundation specs/`
- Phase 0 test plan output: `refactor plan/phase-0-test-characterization-plan.md`
- Build slice plans folder: `refactor plan/build-slices/`

## Priority Order

The priority subsystem plans are:

1. UI refresh / WebSocket / event propagation
   - `refactor plan/refactor plan docs/ui-refresh-websocket-event-propagation.md`
2. Chat runtime and transcript UI
   - `refactor plan/refactor plan docs/chat-runtime-and-transcript-ui.md`
3. Agents and agent runs
   - `refactor plan/refactor plan docs/agents-and-agent-runs.md`
4. Workflows and workflow builder
   - `refactor plan/refactor plan docs/workflows-and-workflow-builder.md`
5. MCP and tooling
   - `refactor plan/refactor plan docs/mcp-and-tooling.md`
6. Channel server replacement / agent messaging inbox
   - `refactor plan/refactor plan docs/channel-server-agent-messaging-inbox.md`
7. Whole-system synthesis
   - `refactor plan/holistic-architecture-synthesis.md`

These priority docs have been synthesized. Do not redo them unless the user asks for an update or current code has materially changed.

Desktop shell and web app shell are lower priority unless they block one of the above.

## Current Planning-to-Build Order

Follow this order now:

1. Implementation roadmap
   - `refactor plan/implementation-roadmap.md`
2. Foundation specs
   - `refactor plan/foundation specs/shared-contracts-and-app-services.md`
   - `refactor plan/foundation specs/live-events-and-outbox.md`
   - `refactor plan/foundation specs/mailbox-and-pending-interactions.md`
   - `refactor plan/foundation specs/runtime-transcript-and-conversation-store.md`
3. Work-item dependency handoff
   - `refactor plan/refactor plan docs/work-items-stages-fields-attachments.md`
4. Phase 0 test characterization plan
   - `refactor plan/phase-0-test-characterization-plan.md`
5. First build-slice plan
   - `refactor plan/build-slices/001-foundation-vertical-slice.md`
6. Implementation
   - Only after the user explicitly asks to build.

The tracker is the control plane for this workflow. Update `refactor plan/refactor-tracker.md` at the end of each planning session.

Current status:

- All planning artifacts (roadmap, foundation specs, work-item handoff, Phase 0 test plan, slice plans 001-004) exist and are marked `planned`.
- Slices 001, 002, 003 are implemented and verified. Slice 004 (workflow definition/run/review) is built and awaiting human review.
- The next unchecked manual row lives in `refactor plan/refactor-session-tracker.md`; trust the tracker, never a hardcoded number.
- The required long-term order is controlled by `refactor plan/definitive-session-pathway.md`.
- Execution now runs live in-session with subagents and per-slice human review (see "Refactor Execution Model" above), not the retired Workflow pipeline.

## Refactor Target Decision

The implementation target is this current repo, not a blank rewrite in a new directory.

- Build new clean boundaries inside this repo, such as contracts, app services, live events, mailbox, and transcript repositories.
- Use separate scratch directories only for throwaway spikes or experiments.
- Do not start a parallel replacement app unless the user explicitly changes this decision.
- Preserve compatibility with existing data, runtime behavior, MCP tools, and UI surfaces until each replacement path is proven.

## Required Workflow

At the start of every new planning, implementation-planning, or build-slice session:

1. Run `git status --short`.
2. If the worktree is dirty, stop and resolve the dirty state before starting new planning or implementation work. The only exception is when the user explicitly asks to review, commit, stash, or clean the dirty state.
3. Read this `AGENTS.md`.
4. Read `refactor plan/refactor-session-tracker.md` and identify the next unchecked manual session row.
5. Read `refactor plan/definitive-session-pathway.md`.
6. Read `refactor plan/target-architecture.md`.
7. Read `refactor plan/holistic-architecture-synthesis.md`.
8. Read `refactor plan/refactor-tracker.md`.
9. If a planning artifact is marked `in progress` or `not started`, read that artifact; otherwise read the artifact named by the next unchecked session row.
10. Read the build-slice plan named by the active session when one exists.
11. Read relevant subsystem docs as context.
12. Inspect current code for the exact scope being planned or implemented.

At the end of every session:

1. Update `refactor plan/refactor-tracker.md` and `refactor plan/refactor-session-tracker.md` as needed.
2. Run the relevant verification commands for the touched scope or document why they were not run.
3. Commit completed work before stopping, or stash explicitly deferred work with a clear stash message.
4. Confirm `git status --short` is clean.

Before writing a subsystem doc:

1. Read `refactor plan/target-architecture.md`.
2. Read `refactor plan/subsystem-architecture-handoff-prompt.md`.
3. Read `refactor plan/refactor-tracker.md`.
4. Read existing subsystem docs in `refactor plan/refactor plan docs/`.
5. Inspect current code for the target subsystem.

Then:

1. Create or update the subsystem doc in `refactor plan/refactor plan docs/`.
2. Base current-state analysis on code only.
3. Treat prior subsystem docs as context, not implemented truth.
4. Treat `target-architecture.md` as the north star, not current-state evidence.
5. Clearly label verified behavior, inference, recommendation, conflict, and open question.
6. Update `refactor plan/refactor-tracker.md`.

Before writing roadmap, foundation specs, test plans, or build-slice plans:

1. Read `refactor plan/holistic-architecture-synthesis.md`.
2. Read `refactor plan/refactor-tracker.md`.
3. Read all directly relevant subsystem docs.
4. Inspect only the code needed to verify current boundaries, contracts, and risks.
5. Clearly label verified facts, synthesis, recommendations, conflicts, and open questions.
6. Keep the artifact concise and build-oriented.
7. Update `refactor plan/refactor-tracker.md`.

## Build-Readiness Gates

Do not start implementation refactors until the relevant slice has:

- an owning roadmap phase;
- explicit contracts or compatibility contract;
- current-state evidence from code;
- migration and rollback steps;
- test plan, including characterization tests where behavior is risky;
- a tracker update marking the artifact or subsystem `planned`;
- user confirmation that implementation should begin.

The slice order is not discretionary. Follow `refactor plan/definitive-session-pathway.md`. If a verification gate fails, fix and reverify the same slice before advancing.

Every planned build slice should follow this cartridge shape:

```text
contract
  -> app service / repo boundary
  -> route adapter
  -> live event or mailbox fact
  -> web client/hook
  -> MCP adapter when relevant
  -> tests
```

## Hard Rules

- Do not start new refactor planning or implementation from a dirty worktree.
- Do not leave completed work uncommitted at handoff.
- Do not restart servers or the app.
- Do not kill Node, Vite, Electron, Caisson, or dev processes.
- Do not call restart endpoints.
- Do not change implementation code during planning unless explicitly asked.
- Do not assume previous recommendations are implemented unless verified in code.
- Do not silently resolve cross-subsystem conflicts. Record them for synthesis.
- Do not use `archive/` as evidence.

Ignore `archive/` entirely:

- Do not search it.
- Do not read it.
- Do not cite it.
- Do not include it in maps, issue lists, or plans.

Use searches like:

```powershell
rg "pattern" --glob "!archive/**"
rg --files --glob "!archive/**"
```

## What Each Subsystem Doc Must Do

Each subsystem doc must include:

- baseline branch and commit;
- current system trace;
- integration map;
- state ownership;
- invariants and compatibility requirements;
- current issues with evidence and severity;
- first-principles design;
- target architecture alignment;
- recommended practical architecture;
- migration strategy;
- acceptance criteria;
- test plan;
- implementation notes for the next agent;
- handoff metadata;
- open questions.

Use exact file paths and symbols where possible.

Prefer concise bullets and tables.

## System Thesis

Target direction:

- durable state lives in SQLite/server-owned services;
- runtime processes emit facts;
- websocket/live events project facts to the UI;
- chat is a view over durable conversation/runtime events;
- agents and workflows communicate through explicit app-owned contracts;
- Channel should be replaced by a durable mailbox/message-inbox system;
- MCP should be an adapter over shared contracts and services, not a separate product API.
