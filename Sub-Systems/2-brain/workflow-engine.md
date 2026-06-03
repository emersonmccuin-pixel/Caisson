# Workflow Engine (DAG)

> **Role:** Brain (control plane)
> **Status:** as-built snapshot — 2026-06-03 · active first-principles rebuild on `refactor/auto-pathway`
> **Code anchors:**
> - `packages/domain/src/workflow-v2.ts` — domain types (step/node, trigger, run state, event log)
> - `packages/workflows/src/dag/` — pure brain: step.ts · refs.ts · topo.ts · validate.ts · when.ts · triggers.ts
> - `packages/workflows/src/registry-v2.ts`, `serialize-v2.ts` — YAML parse/serialize/scan
> - `apps/server/src/services/dag-executor.ts` — orchestration shell (deps-injected)
> - `apps/server/src/services/dag-run-service.ts` — live wiring (dispatch door, card-move, review, persist)
> - `apps/server/src/services/workflow-run-writer.ts` — announcing write door (all run mutations)
> - `apps/server/src/services/workflow-import.ts` — boot YAML → DB importer
> - `apps/server/src/routes/workflow-routes.ts` — HTTP CRUD + fire
> - `apps/server/src/services/project-runtime.ts` — stage-on-entry wiring + review resume
> - `packages/app-services/src/workflows/run-gateway.ts` — durable mutation gateway
> - `packages/app-services/src/workflows/boot-reconcile.ts` — boot reconciliation

---

## What it is (plain English)

The workflow engine is the part of the app that strings AI agents together into a pipeline. You describe a series of steps — each step runs an agent that does a job and delivers output — and the engine moves a work item ("card") through your project board as each step finishes. Review gates (human or orchestrator inbox) can pause the pipeline and wait for approval before continuing. The whole thing is driven by a card entering a board stage, a manual trigger, or a scheduled/event trigger.

---

## What it's supposed to do (intent)

Own the full lifecycle of a multi-step automated run: fire on trigger → enter each step → dispatch the agent → receive the deliverable → apply the card-move transition → enter the next step or pause at a review gate → finalize. Every step's output feeds the next step's declared input ports. Completion is a positive receipt (`pc_submit_deliverable`), never inferred.

---

## How it works today (as-built)

### Trigger

A card move fires `ProjectRuntime.onWorkItemMoved` (`project-runtime.ts:362`). It calls `selectStageEntryWorkflows` (pure, `packages/workflows/src/dag/triggers.ts:52`) — matches enabled v2 workflows whose `stage-on-entry` trigger equals the destination stage — and calls `fireV2Workflow` for each match (`project-runtime.ts:374`). Forward-move detection (`isForwardStageMove`, `triggers.ts:25`) uses stage `order` values; unknown stage ids fail open (treated as forward).

The HTTP fire route (`workflow-routes.ts`) also calls `fireWorkflow` for manual/HTTP triggers.

### Boot importer

`importV2WorkflowsFromDisk` (`workflow-import.ts`) runs at project boot. It scans `<project>/.project-companion/workflows/*.yaml`, parses v2-marked files via `parseWorkflowV2Text`, and inserts DB rows (`status='active'` or `status='invalid'`). Idempotent 2-boot plan: first boot inserts; second boot deletes the YAML file and leaves the DB row canonical.

### Firing a run

`fireDagWorkflow` (`dag-run-service.ts:465`):
1. Resolves (or creates) the root work item for the run.
2. Optionally provisions a git worktree (`worktrees.ensureWorktree`).
3. Creates the `workflow_runs_v2` row with `status='running'`; calls `markStarted`; announces creation through the durable write door (`announceRunCreated`, `workflow-run-writer.ts`).
4. Builds the live `DagExecutorDeps` via `makeExecutorDeps`.
5. Constructs `DagExecutor.start(workflow, deps, ctx)` with a clean initial state (`initDagState` → all nodes `pending`).
6. Returns `{ runId, rootWorkItemId, done: exec.advance() }`. The `done` promise resolves at the first pause or terminal; HTTP callers ignore it.

### Execution loop (`DagExecutor.advance`, `dag-executor.ts:148`)

Tick-driven loop (max 1 000 ticks safety guard):
1. `isCancelled()` check — persists `cancelled` and returns.
2. `selectReady(workflow, state, resolve)` — pure function (`dag/step.ts:62`). A node is ready when all its `next`-edge predecessors (computed via `computeUpstreams`) are settled (completed/failed/skipped) AND its `trigger_rule` passes AND its `when:` guard is true. Returns `{ ready, skips }`.
3. Apply any skips (`markSkipped`) and emit `node_skipped` events.
4. If no ready nodes and no new skips: fall through to `finalize()`.
5. Review-ready and run-ready nodes are split. Non-review nodes dispatch first (in batches capped by `max_concurrency`, default 4): `markRunning` → `dispatchAgent` → `settleNode` → card-move transition effect if `node.move` is set.
6. If only review nodes are ready: `markRunning` → `markAwaitingReview` → `requestReview` → persist `awaiting-review` → return. Run pauses durably.
7. After each batch, `persistRun(computeRunStatus(...))` writes DAG state + status through the write door.

### Dispatching an agent node

`dispatchAgent` (`dag-run-service.ts:213`):
1. Validates pod exists + is project-scoped (global pods require cloning first).
2. Mints a child work item + linked contract via `createAgentWorkItem`.
3. Calls `renderBody(node.task, node.input, ctx)` — resolves declared `input:` port values (each `$nodeId.output[.field]` ref read via `ContractService.listByWorkItem`) and substitutes `{{name}}` placeholders. Also renders inline `$carry.*` substitution for reject-loop feedback.
4. Dispatches through `dispatchFreshAgent` (the one door — `agent-run-factory.ts`) with `PC_WORKFLOW_RUN_ID` and `PC_WORKFLOW_WORKTREE` env vars for path-guard confinement.
5. `await result.done` — resolves when the agent's run reaches a terminal state via the unified terminal path (Step 1, already done). Failure if `status !== 'completed'` or verification failed.

### Ref resolution

`$nodeId.output` resolves to the agent's contract deliverable (`ContractService.listByWorkItem` → `contractDeliverableText`), NOT the child work item body. `$nodeId.output.field` reads a structured `payload` deliverable's `data` field, falling back to `wi.fields[field]`. `$root.output` reads the run-root card's `body`; `$root.output.field` reads `wi.fields[field]`. A missing deliverable returns `''` (hard requirement: no task text leaks into downstream inputs). `validate.ts` enforces at save time that every ref points at a strictly-earlier step.

### Card-move transition effect

After a node settles `completed`, if `node.move` is set, `deps.moveCard(stage)` is called (`dag-run-service.ts:338`). It calls `moveWorkItemStage` (no stage-on-entry workflow re-fire — loop-safe) and announces through the durable outbox door. Review nodes also apply `node.move` on approve (`dag-executor.ts:303`) and `reject.move` on kick-back (`dag-executor.ts:316`). Card moves are a TRANSITION EFFECT — not a separate node kind.

### Review gates

When a review node is ready, the executor posts to the appropriate inbox (`requestReview`, `dag-run-service.ts:356`). Orchestrator reviews enqueue a durable mailbox message (`deliverReview` seam). Both flavors write a `workflow.review.changed` (pending) fact via `reviewGateway.commitReviewChange`. The run persists `paused`; the executor returns `'awaiting-review'`.

On a decision, `applyV2ReviewDecision` (`dag-run-service.ts:532`) loads the frozen workflow snapshot from the run row, calls `DagExecutor.resume(workflow, run.dagState, deps, ctx)`, then `exec.onReviewDecision(nodeId, decision)`. Approve → `applyReviewDecision` marks the node `completed`, applies any `node.move`, calls `advance()`. Reject → bumps `rejectIterations`, stashes notes in `state.rejectFeedback`, resets the loop subtree (`loopSubtree` in `dag/step.ts:155`) to `pending`, calls `advance()` from the kicked-back step. If the iteration ceiling is hit (`max_iterations`, default 3), the node fails and `holdForHuman` fires; downstream gets skipped and the run finalizes as `failed`.

### Persist / write door

Every DAG state or status mutation goes through `writeDagAndStatus` (or its siblings) in `workflow-run-writer.ts`. Each call goes through `WorkflowRunMutationGateway.commitRunChange` (`run-gateway.ts:118`), which runs the DB writes + inserts a `live_outbox` row in a single SQLite transaction. The live-relay drains the outbox and fans a canonical `workflow.run.changed` live-event frame to subscribers. "Forgetting to announce" is structurally impossible.

### Boot reconciliation

`reconcileWorkflowRunsOnBoot` (`boot-reconcile.ts:43`) is called from `index.ts:487` at server start. `running` and `pending` runs are fail-closed to `failed` with reason `'interrupted-on-boot'`. `paused` runs (awaiting review) are left untouched — no work was lost, the inbox item persists. Re-driving is intentionally not attempted (non-idempotent side effects).

### DAG state storage

DAG bookkeeping lives in `workflow_runs_v2.dag_state` (a JSON column). This is NOT the append-only event log target; it is today's working state store. The `workflow_run_events` table exists and `appendEvent` writes to it (`dag-run-service.ts:417`), but these writes bypass the gateway/live_outbox and the UI discards `res.events` — currently dead observability writes (ledger §0, V5). "Events = truth" is the target but not yet built.

### Save-time validation ("Saved ⇒ runnable")

`validateWorkflowV2` (`dag/validate.ts:47`) checks: non-empty name and nodes, unique node ids (no `root`), known kinds (`agent` | `review`), per-kind required fields, valid `input:` map keys, ref integrity (`next`, `reject.back_to`, `bundle_from` point at real nodes), acyclicity of forward edges (reject back-edges excluded), ref ordering (every `$nodeId.output[.field]` must point at a strictly-earlier ancestor or `$root`), `{{name}}` placeholders must bind to a declared `input:` key, `when:` grammar, trigger shape, cross-workflow stage-collision check. Errors block save; invalid YAML lands as a `status='invalid'` DB row with `parseError` set.

---

## Integrations (how it connects)

- **Depends on:**
  - Agent dispatch door: `dispatchFreshAgent` (`agent-run-factory.ts`) — the one path for all agent spawns.
  - `ContractService` (`@pc/app-services`) — reads agent deliverables to resolve `$nodeId.output` refs.
  - `workflowRunsV2Repo` (`@pc/db`) — CRUD for run rows, DAG state, event log.
  - `moveWorkItemStage` (`@pc/db`) — card-move transition effect.
  - `WorkflowRunMutationGateway` (`@pc/app-services`) — all durable write facts go through this.
  - Mailbox seams (`deliverReview`, `deliverRunFailed`) — injected from `index.ts`; wired to `MailboxService`.
  - `WorktreeService` — git worktree provisioning per run.

- **Used by:**
  - `ProjectRuntime.onWorkItemMoved` — stage-on-entry fire path.
  - `workflow-routes.ts` — HTTP manual fire + CRUD.
  - `index.ts` — boot reconciliation.
  - Orchestrator (via mailbox) — approves/rejects review gates.
  - Human inbox (UI) — approves/rejects `reviewer: human` gates.

- **Contracts / events at edges:**
  - `workflow.run.changed` live-event (via `live_outbox` → relay) — fans run state to the UI.
  - `workflow.review.changed` live-event (same path) — fans review pending/approved/rejected.
  - `workflow.definition.changed` live-event — from definition mutation routes.
  - `workflow_runs_v2` table — run row + `dag_state` JSON + `workflowYamlSnapshot`.
  - `workflow_run_events` table — append-only event log (written but currently dead for the UI; see Known Issues).

---

## Target shape (per north star)

The first-principles redesign spec (`workflow-engine-first-principles-redesign-2026-06-02.md`) replaces the old 6-node-kind, completion-by-inference model with three concepts: **step**, **transition**, **run log**.

**What's DONE on this branch:**

- Two node kinds only: `agent` + `review` (unified; old bash/script/move-work-item/split-review nodes deleted). `workflow-v2.ts:31`.
- Completion = `pc_submit_deliverable` receipt, not JSONL inference. Step 1 (`40c2a91f` + `0022872d`) fixed the terminal race; the run-keyed waiter in `ActiveRunRegistry` is the one settle path.
- Card move = transition effect (`node.move` and `reject.move`), not a separate node. Wired on agent completion (`dag-executor.ts:234`) and on review approve (`dag-executor.ts:303`) and reject kick-back (`dag-executor.ts:316`).
- Declared input ports: `input:` map on each node wires upstream outputs to named placeholders; validated at save; resolved at dispatch. `workflow-v2.ts:141`, `dag-run-service.ts:136`.
- Unified review: `reviewer: human | orchestrator` on one `review` node kind. `workflow-v2.ts:197`.
- Reject-loop carry: explicit `reject.carry: { name: $self.output.notes }` per transition; `$carry.feedback` auto-populated as a default. `dag-executor.ts:256`.
- Forked workflow-subagent dispatch deleted (slice 8b confirmed). All agent dispatch through the one door.
- Save-time validation ("Saved ⇒ runnable"): ref ordering, placeholder binding, `when:` grammar, cycle detection. `dag/validate.ts`.
- Failed-run notification to human inbox + orchestrator mailbox. `dag-run-service.ts:427`.
- Boot reconciliation: `reconcileWorkflowRunsOnBoot` (confirmed live, `index.ts:487`).

**Remaining (per spec §9 build order and MEMORY START-HERE):**

- **LOOP nodes** — the spec describes looping via `reject` back-edges (implemented), but the general "LOOP node" vocabulary is not in the current schema. (unverified whether this is a distinct gap or whether the reject-loop already covers it.)
- **User-facing resume** — a paused (`waiting-review`) run correctly persists across restarts, but the user-side resume UI surface and the `pc_continue_agent` path are not yet wired.
- **Events = truth (slice 3)** — route `appendEvent` through the gateway/live_outbox so `workflow_run_events` becomes the canonical run log (currently dead observability writes). Today `dag_state` JSON is the store.
- **Step 2+ migration** — workflow engine sits in the Brain but the broader reconciler unification (Steps 2–7, the Supervisor build) is ongoing. The workflow engine itself is not blocked on these.

---

## Known issues / scar tissue

**The original stall (AHEAD-29, 2026-06-02) — FIXED (Step 1).**
`dag-run-service.ts:321`: `await result.done` waited on a promise that never resolved. The agent delivered its output via `pc_submit_deliverable` and the terminal was applied to the DB, but the host-backed reconcile path (`applyHostTerminalSnapshot`) bypassed the settle callback, so `done` hung forever at `dag_state = {"nodes":{}}` rev 1. Root cause: two competing terminal authorities (a per-run factory `onEvent` listener + the boot-reconcile listener) where the factory listener won first but the host path didn't route through it. Fix: collapsed to ONE terminal authority (`applyAgentRunTerminalEffects`), deleted the per-run factory listener, moved settlement to the `ActiveRunRegistry` run-keyed waiter. Commits `40c2a91f` + `0022872d`.

**`workflow_run_events` is written but not read (ledger §0, V5).**
`dag-run-service.ts:417` appends events via `workflowRunsV2Repo.appendEvent`, but these rows bypass the gateway/live_outbox transaction and the UI's `WorkflowsList.tsx:871` discards `res.events`. The "append-only log = truth" target from the spec is unbuilt. Today `dag_state` JSON in the run row IS the store. This means a frozen run's event history is not observable in the UI even though the table is being populated.

**`wi.body` dual-purpose (ledger §0, re-scoped 06-03).**
`dag-run-service.ts:173`: `$root.output` resolves to the run-root card's `body` column. The body serves double duty (task given to the agent AND workflow-ref value). This is documented as intentional and must not be removed without a round-trip guard. Do not conflate with the agent's CONTRACT deliverable (stored on `agent_contracts.deliverable`), which is what `$nodeId.output` reads.

**Ref resolution reads the contract deliverable, not the work-item body.**
`dag-run-service.ts:194`: `$nodeId.output` = contract deliverable text. A step that produces no deliverable returns `''` and a downstream step reading it gets empty input. There is no fallback to the child WI body. This is intentional (the spec says "no 'done but empty' state") but means a failed agent that delivered nothing silently gives downstream steps empty inputs rather than a typed error — the node itself will be marked `failed`, which blocks downstream via `trigger_rule`, but the error message may not be surfaced clearly.

**Global-pod guard at dispatch time, not save time.**
`dag-run-service.ts:223`: the check that a pod must be project-scoped is enforced at dispatch, not at workflow save. A workflow that references a global pod will validate cleanly but fail at runtime. (unverified whether the save-time validator checks pod existence at all.)

---

## Open questions

- Should `validateWorkflowV2` check pod existence at save time, or is the runtime guard sufficient?
- The `workflow_run_events` table: when does slice 3 land? Until then, event-replay-based resume is aspirational and `dag_state` JSON remains the working store. The "frozen run is never a mystery" promise from the spec (`§3`) is not yet delivered.
- LOOP nodes: the spec mentions loops in `§2`; the current schema has reject back-edges (`RejectEdge`) but no general-purpose loop construct. Is `reject` the only intended loop mechanism, or is a separate `loop` node kind planned?
- Boot reconciliation fail-closes `running` runs but does NOT re-dispatch them (non-idempotent risk). The spec (`§5`) says "reattach to the live host run if present; else fail (lost)." The current policy skips the reattach path entirely. Gap to fill in Step 2 / the one-reconciler work.
- The `done` promise returned by `fireDagWorkflow` is fire-and-forget in the HTTP route (errors are `.catch`-logged, `project-runtime.ts:312`). An unhandled rejection from deep inside a long-running run could silently swallow an executor crash. Guard test coverage here is unclear.
