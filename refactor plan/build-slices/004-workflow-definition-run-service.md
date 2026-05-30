# 004 Workflow Definition / Run / Review Service

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `refactor/auto-pathway` |
| Commit | baseline `e97b360e` (slice 003 closed; slice 002 verified at tag `slice-002-verified`) |
| Artifact status | Planned build slice |
| Owning roadmap phase | Phase 5 workflow definition/run/review service boundary |
| Slice subject | Workflow definition/run/review service seam, stable run identity + pinned version, cancellation, boot reconciliation, compatibility routes, and durable `workflow.*` live events |
| Implementation target | This repo. Do not create a parallel app. |
| Scope rule | This is a build plan only. Do not implement until the user explicitly asks to build. |

Decision:

- **Recommendation:** Extend the slice-001/002/003 cartridge to the workflow family. Add shared contracts for workflow definitions, runs, and review decisions; put a single server-owned write door in front of every `workflow_runs_v2` row mutation (mirroring the slice-003 `WorkItemMutationGateway`); formalize the **already-existing** definition snapshot as the stable run identity/version surface; define node-boundary cancellation and a deterministic boot-reconcile pass for non-terminal runs; and emit canonical `workflow.run.changed` / `workflow.review.changed` / `workflow.definition.changed` facts through the slice-002 `live_outbox` while keeping the legacy `workflow-v2-run-changed`, `workflow-v2-review-pending`, and `workflow-changed` websocket names as compatibility projections.
- **Reason:** The workflows handoff (`refactor plan/refactor plan docs/workflows-and-workflow-builder.md`) flags run-subsystem risks. After code inspection the precise gaps in THIS checkout are: run-row writes are announced through `workflow-run-writer.ts` but the broadcast is **not transactional with the write** and **not durable** (no outbox row); cancellation is a bare status flip that does not stop in-flight work; non-terminal runs have **no boot reconciliation**; review decisions are accepted with thin state validation; and run facts are non-durable transient broadcasts. Slices 001/002/003 proved the contract + write-door + durable outbox + legacy-fanout pattern; this slice applies it to the workflow run subsystem without redesigning the DAG engine in `@pc/workflows`/`dag-executor.ts` or the agent-run subsystem (slice 005).
- **Compatibility stance:** Keep every legacy HTTP route, MCP behavior, and websocket event name working. Canonical events are additive; legacy `workflow-v2-run-changed` / `workflow-v2-review-pending` / `workflow-changed` continue as compatibility projections of the canonical facts.

## 2. Problem Statement

Verified facts (code-evidence based, this checkout):

- A workflow run **already pins an immutable definition snapshot**. `fireDagWorkflow` (`apps/server/src/services/dag-run-service.ts:730`) creates the run with `workflowYamlSnapshot: JSON.stringify(workflow)`, and `applyV2ReviewDecision` (`:765`) resumes by `JSON.parse(run.workflowYamlSnapshot)`. The executor runs against that frozen snapshot, so later edits to the definition do **not** change an in-flight run. The "runs identify by slug" concern is about the `workflow_runs_v2.workflow_id = slug` column used for the in-flight delete guard/listing, not the executed graph.
- Run-row writes go through the announcing write-door `apps/server/src/services/workflow-run-writer.ts` (`announceRunCreated`, `writeDagState`, `writeRunStatus`, `writeDagAndStatus`). Each bumps `rev`, reads back the full row, and broadcasts a `workflow-v2-run-changed` snapshot. The broadcast is **not transactional** with the repo write and writes **no durable outbox row**.
- `workflow_runs_v2` (migration `0022_workflow_v2_schema.sql`) columns: `id, workflow_id, workflow_name, project_id, work_item_id, trigger, stage_id, triggered_by_session_id, status, workflow_yaml_snapshot, worktree_path, dag_state, trigger_context, metadata, last_reason, created_at, started_at, ended_at, last_activity_at`. The repo (`packages/db/src/repos/workflow-runs-v2.ts`) adds a `rev` counter. Statuses (`WorkflowV2.WorkflowRunStatus`): `pending | running | paused | completed | failed | cancelled` (note: there is **no** distinct `review` status — review pause persists as `paused`; see `toRunStatus` mapping `awaiting-review → paused`).
- The `workflows` definitions table (created `0000_init.sql`, promoted `0026`/`0027`) carries `slug, scope, project_id, name, display_name, description, yaml, yaml_hash, parsed_definition, status, parse_error, disabled, origin, created_at, updated_at, deleted_at` — a content hash (`yaml_hash`) but **no numeric version counter**. PUT mutates the same row in place; slug is immutable.
- Cancellation is observed cooperatively: the executor deps expose `isCancelled: () => workflowRunsV2Repo.getRun(run.id)?.status === 'cancelled'` (`dag-run-service.ts:664`). The status flip to `cancelled` happens via a repo write elsewhere; there is no transactional+durable cancel fact.
- Review: `applyV2ReviewDecision` loads the snapshot + `dag_state` and drives `DagExecutor.resume(...).onReviewDecision(nodeId, decision)`. The review-pending signal is the transient `workflow-v2-review-pending` broadcast emitted from `requestReview` (`dag-run-service.ts:621`); it is **not durable**.
- Run HTTP surface: `apps/server/src/features/workflow-compat/routes.ts` — list/get runs, review (`POST /api/projects/:projectId/workflow-v2/review`), failed-run dismiss, builder-draft. Definition HTTP surface: `apps/server/src/routes/workflow-routes.ts` — list/get/create/update/delete/promote/duplicate/audit + `POST /api/workflows/:id/fire`; mutations emit `workflow-changed` via `broadcastTo`/`broadcastAll` (`emitChanged`).
- The fire/review services are composed at server boot (`apps/server/src/index.ts:615` `registerWorkflowRoutes`, `:713` `registerWorkflowCompatRoutes`) and per-`ProjectRuntime` (`apps/server/src/services/project-runtime.ts:265` `dagRunOptions`, which supplies the project-scoped `broadcast`). There is no single long-lived `DagRunService` class — `fireDagWorkflow` / `applyV2ReviewDecision` are module functions taking `DagRunServiceOptions`.
- **No boot reconciliation exists for workflow runs.** `apps/server/src/index.ts` reconciles only agent runs (`agent-run-boot-reconcile.ts` / `agent-run-server-boot.ts`). `listRunsByProject` exists but there is no `listRunsByStatus`; reconciliation will need a new repo read (or filter `listRunsByProject`).
- `@pc/contracts` has no workflow module (`packages/contracts/src/` = projects, work-items, stages, field-schemas, attachments, live-events, shared). Slices 002/003 shipped the `LiveEvent`/`LiveEventFrame` envelope, `live_outbox` table/repo, `/api/live-events` replay, and dual canonical/legacy fanout.
- DAG domain types live in `packages/domain/src/workflow-v2.ts` (`WorkflowV2` namespace). The pure DAG engine is `apps/server/src/services/dag-executor.ts` + `@pc/workflows`.

Synthesis — this slice implements the next cartridge layer for the workflow run family:

```text
contract (workflow definition / run / review DTOs + canonical event payloads)
  -> app-service write door (single durable run-mutation gateway over workflow-run-writer writes)
  -> route/compat adapters (preserve workflow-compat + workflow-routes wire shapes)
  -> live event fact (workflow.run.changed, workflow.review.changed, workflow.definition.changed) on slice-002 outbox
  -> web client/hook + canonical/legacy fanout
  -> tests
```

## 3. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | Runs already pin an immutable definition snapshot (`workflowYamlSnapshot`); the executor runs/resumes against it, not the live def. | `dag-run-service.ts` `fireDagWorkflow` (`:730`), `applyV2ReviewDecision` (`:765`) |
| Verified fact | Run-row writes flow through `workflow-run-writer.ts`, which bumps `rev`, reads back, and broadcasts `workflow-v2-run-changed` non-transactionally and non-durably. | `apps/server/src/services/workflow-run-writer.ts` |
| Verified fact | `workflow_runs_v2` has `workflow_yaml_snapshot`, `dag_state`, `rev`; statuses `pending\|running\|paused\|completed\|failed\|cancelled` (no `review` status — review = `paused`). | `0022_workflow_v2_schema.sql`; `packages/db/src/repos/workflow-runs-v2.ts`; `packages/domain/src/workflow-v2.ts:269` |
| Verified fact | Definitions table has `yaml_hash` but no numeric version; PUT mutates in place; slug immutable. | `0000_init.sql:86`, `0026`/`0027`; `apps/server/src/routes/workflow-routes.ts` `normaliseDef` |
| Verified fact | Cancellation is a cooperative status flip observed via `isCancelled` polling `getRun().status === 'cancelled'`. | `dag-run-service.ts:664` |
| Verified fact | Review-pending is the transient `workflow-v2-review-pending` broadcast; resolution via `applyV2ReviewDecision` → `onReviewDecision`. | `dag-run-service.ts:607-630`, `:765` |
| Verified fact | Run HTTP surface in `workflow-compat/routes.ts`; definition HTTP surface in `workflow-routes.ts` (emits `workflow-changed`). | `apps/server/src/features/workflow-compat/routes.ts`, `apps/server/src/routes/workflow-routes.ts` |
| Verified fact | Fire/review composed at server boot + per-`ProjectRuntime` (`dagRunOptions` supplies project broadcast). No singleton `DagRunService` class. | `apps/server/src/index.ts:615,713`; `apps/server/src/services/project-runtime.ts:265` |
| Verified fact | No workflow-run boot reconciliation exists; only agent runs are reconciled. | `apps/server/src/index.ts` (agent-run reconcile only); `agent-run-boot-reconcile.ts` |
| Verified fact | Repo has `listRunsByProject` but no `listRunsByStatus`. | `packages/db/src/repos/workflow-runs-v2.ts` |
| Verified fact | `@pc/contracts` has no workflow module. | `packages/contracts/src/` listing |
| Verified fact | Slice 002 outbox + replay + dual fanout pattern shipped and reused by slice 003. | `refactor plan/build-slices/002-project-live-outbox.md`, `003-work-items-stages-fields-events.md` |

## 4. Exact Scope

Implement only these behaviors when the user asks to build:

1. Add a workflow contract family to `@pc/contracts`: `WorkflowDefinitionDto`, `WorkflowRunDto`, `WorkflowDagStateDto` (browser-safe mirror of `WorkflowV2.WorkflowDagState`), `WorkflowReviewDecision` (`'approve' | 'reject'` + optional `notes`), request schemas (fire, review), and parser/guard helpers. Mirror `WorkflowV2.WorkflowRunStatus` (`pending|running|paused|completed|failed|cancelled`).
2. Add canonical live-event payload contracts (built on the slice-002 `LiveEvent` envelope + `{ type: 'live-event', event }` frame): `workflow.run.changed` (project-scoped, `version` = run `rev`), `workflow.review.changed` (project-scoped), and `workflow.definition.changed` (project- or global-scoped per row scope). Extend `LiveEventEntity` with `'workflow-run' | 'workflow-review' | 'workflow-definition'` (names already reserved in `foundation specs/live-events-and-outbox.md`).
3. Add a server-owned **workflow run mutation gateway** (a write door, mirroring the slice-003 `WorkItemMutationGateway`) that is the single durable path for run create / dag-state / status / cancel mutations. It wraps the product write (`workflowRunsV2Repo`) and the `live_outbox` insert in **one SQLite transaction**, then fans out after commit. The existing `workflow-run-writer.ts` functions (`announceRunCreated`, `writeDagState`, `writeRunStatus`, `writeDagAndStatus`) become thin delegators to the gateway so their exported names keep compiling for `dag-run-service.ts`.
4. Route the cancel path and the review broadcast through the gateway too, so every durable run transition produces one coherent `workflow.run.changed` (and, for review-pending/resolution, one `workflow.review.changed`) fact. The DAG-walking logic in `dag-executor.ts`/`@pc/workflows` and the dispatch logic in `dag-run-service.ts` are NOT redesigned.
5. **Stable run identity + pinned version — formalize, don't reinvent.** The run already freezes the graph via `workflowYamlSnapshot`. This slice surfaces that as durable identity on `WorkflowRunDto`: keep `workflowSlug` (= `workflow_id`) and add `definitionHash` derived from the snapshot (e.g. sha256 of `workflowYamlSnapshot`, matching the definitions table's `yaml_hash` convention) so a run is traceable to the exact definition content it ran. No new column needed (the snapshot already lives in `workflow_yaml_snapshot`). Add a contract-level invariant + test that the executed graph comes from the snapshot, never a live re-resolve.
6. **Cancellation (node-boundary).** Formalize cancel as a node-boundary stop routed through the gateway: a cancel sets `cancelled` + writes the outbox fact in one tx; the executor's existing `isCancelled` poll observes it at the next node boundary and stops. A node already in flight (notably an agent dispatch) is NOT preempted in this slice — interrupting in-flight agent work is slice 005. Keep the cooperative `isCancelled` mechanism; only move the status write + fact emission into the gateway.
7. **Boot reconciliation.** Add a deterministic reconcile pass at server boot (in `apps/server/src/index.ts`, alongside the agent-run reconcile) and/or at `ProjectRuntime` init, scanning non-terminal runs and restoring or failing them. Add a `workflowRunsV2Repo.listRunsByStatus(statuses)` read (new, additive) or filter `listRunsByProject`. Emit each transition through the gateway. Mirror `agent-run-boot-reconcile.ts`.
8. Dual-fanout after committed outbox insert: canonical `{ type: 'live-event', event }` frames for new clients, plus the existing legacy `workflow-v2-run-changed` (run), `workflow-v2-review-pending` (review-pending), and `workflow-changed` (definition) websocket names as compatibility projections.
9. Preserve all current HTTP routes and response shapes in `workflow-compat/routes.ts` and `workflow-routes.ts`, and the `POST /api/workflows/:id/fire` + legacy review endpoints. Move request/response parsing onto the shared contracts via adapters only; do not rename routes or change bodies.
10. Extend `/api/live-events` (slice 002) to allow `type=workflow.run.changed`, `type=workflow.review.changed`, and `type=workflow.definition.changed` with the same cursor/scope semantics. Run/review events are project-scoped; definition events follow the row scope.
11. Add a web live-event hook/helper that consumes canonical workflow-run/review/definition frames, dedupes by `event.id`, applies `rev`-aware run upserts, and refetches/upserts on replay/reconnect. The existing `workflow-v2-run-changed` handling keeps working in parallel.
12. Run the listed automated verification.

Non-goals (explicitly OUT — and which slice owns each):

- **Agent-run service** — slice 005. The `dispatchAgent` path (`dag-run-service.ts:361`) stays as-is; this slice does NOT build the agent-run command service, pending-ask atomicity, or `agent.run.*` family, and does NOT make cancellation interrupt an in-flight agent dispatch.
- **Conversation / session / send / replay** — slice 006.
- **Mailbox platform** — slice 007. Workflow review/orchestrator-review delivery via mailbox is slice 008.
- **Channel cutover** — slice 008. This slice ADDS the workflow projection layer; it does not retire any legacy WS path and does not move orchestrator-review off the Channel `postChannel` call.
- Do not redesign the DAG engine (`dag-executor.ts` / `@pc/workflows`) or the `WorkflowV2` domain model.
- Do not implement edge-guard / conditional-`when` evaluation, reject-edge, or retry semantics beyond current behavior.
- Do not change the workflow-builder/authoring transient session, `workflow-import.ts`, or `workflow-builder-pod-content.ts`.
- Do not add destructive DB migrations; prefer no migration (see DB section).
- Do not remove any legacy websocket event name (deferred to cleanup slice 011).
- Do not restart or kill dev servers while implementing or verifying.

## 5. Contract Plan

Files likely affected:

```text
packages/contracts/src/workflow-definitions.ts
packages/contracts/src/workflow-runs.ts
packages/contracts/src/live-events.ts        (extend entity/type union; do not rewrite project/work-item members)
packages/contracts/src/index.ts
packages/contracts/test/workflow.test.ts
packages/contracts/test/live-events.test.ts  (extend)
```

Contract rules (unchanged from slices 001/002/003): browser-safe, side-effect-free, zero runtime deps; no imports from apps, `@pc/db`, `@pc/domain`, `@pc/runtime`, `@pc/mcp`, Hono, React, or Node built-ins; parsers accept `unknown` and return `ParseResult<T>`.

Core DTOs:

| Contract | Initial contents |
|---|---|
| `WorkflowDefinitionDto` | id, slug, scope (`'global' \| 'project'`), projectId, name, displayName, description, status (`'active' \| 'invalid'`), disabled, yamlHash, updatedAt. (Graph/`yaml` stays server-side; the DTO is the rail/detail surface.) |
| `WorkflowRunDto` | id, projectId, workflowSlug (= `workflow_id`), workflowName, definitionHash, status (`pending\|running\|paused\|completed\|failed\|cancelled`), rev, trigger, stageId, workItemId, worktreePath, lastReason, createdAt, startedAt, endedAt, dagState (`WorkflowDagStateDto`). |
| `WorkflowDagStateDto` | nodes: `Record<nodeId, { state, workItemId?, iteration?, error?, output?, startedAt?, endedAt? }>`, rejectIterations?, rejectFeedback? — a browser-safe mirror of `WorkflowV2.WorkflowDagState`. |
| `WorkflowReviewDecision` | `{ decision: 'approve' \| 'reject'; notes?: string }` (matches the `{ kind: 'approve' } \| { kind: 'reject'; notes? }` runtime shape). |
| Request schemas | fire (`{ trigger?, projectId? }`), review (`{ runId, nodeId, decision: 'approve'\|'reject', notes? }`). |

Canonical live-event extensions (build on slice-002 `LiveEvent` + frame):

```ts
// LiveEventEntity union extended: ... | 'workflow-definition' | 'workflow-run' | 'workflow-review'

export interface WorkflowRunChangedLivePayload {
  reason: 'fired' | 'advanced' | 'review-pending' | 'review-resolved' | 'cancelled' | 'failed' | 'completed' | 'reconciled';
  run?: WorkflowRunDto;
}

export interface WorkflowReviewChangedLivePayload {
  runId: string;
  nodeId: string;
  flavor: 'human' | 'orchestrator';
  state: 'pending' | 'approved' | 'rejected';
  prompt?: string | null;
  notes?: string;
}

export interface WorkflowDefinitionChangedLivePayload {
  change: 'created' | 'updated' | 'deleted';
  definition?: WorkflowDefinitionDto;
  workflowId?: string; // for delete envelopes (mirrors current deletedEnvelope)
}
```

First canonical shapes:

```ts
{ type: 'workflow.run.changed',        entity: 'workflow-run',        scope: 'project', projectId, entityId: runId, version: rev,  payload: WorkflowRunChangedLivePayload }
{ type: 'workflow.review.changed',     entity: 'workflow-review',     scope: 'project', projectId, entityId: runId, version: rev,  payload: WorkflowReviewChangedLivePayload }
{ type: 'workflow.definition.changed', entity: 'workflow-definition', scope, projectId, entityId: workflowId, version: null,       payload: WorkflowDefinitionChangedLivePayload }
```

Contract decisions (recorded; see Open Questions):

- Run / review events are **project-scoped**. Definition events follow the row's `scope` (global rows fan to all projects, mirroring today's `broadcastAll`).
- `version` on `workflow.run.changed` / `workflow.review.changed` carries `workflow_runs_v2.rev` so the web hook does rev-aware upserts. Definition `version` is `null` (no numeric version; the client refetches).
- Review is modeled as its own fact family (`workflow.review.changed`, mirroring the transient `workflow-v2-review-pending`) AND a `workflow.run.changed` (the `paused`/`running` transition). The review fact is the human-action/audit surface; the run fact is the state.
- Keep legacy WS names as compatibility projections; add `toLegacyWorkflowRunChanged(event)`, `toLegacyReviewPending(event)`, `toLegacyWorkflowChanged(event)` adapters mirroring slice-002/003's `to<Legacy>Envelope`.

## 6. App-Service / Repo Boundary

Files likely affected:

```text
packages/app-services/src/workflows/run-gateway.ts
packages/app-services/src/workflows/adapters.ts
packages/app-services/src/workflows/index.ts
apps/server/src/services/workflow-run-writer.ts   (delegate to gateway; keep exported names)
apps/server/src/services/dag-run-service.ts        (cancel + review broadcast through gateway; surface definitionHash)
packages/db/src/repos/workflow-runs-v2.ts          (additive listRunsByStatus read for reconcile)
apps/server/src/index.ts / project-runtime.ts      (wire gateway + reconcile)
```

Gateway responsibilities (one durable write door for run mutations):

| Operation | Required behavior |
|---|---|
| run created (fire) | Persist run row (snapshot already in `workflow_yaml_snapshot`); insert `workflow.run.changed` (`reason:'fired'`) outbox row in the same tx; fan out canonical + legacy after commit. |
| dag-state / status persist (advance) | `setDagState` + `setStatus` (`rev++`) and `live_outbox` insert in one tx; emit `workflow.run.changed` (`reason:'advanced' \| 'review-pending' \| 'completed' \| 'failed'`). |
| review-pending | When `requestReview` fires, emit `workflow.review.changed` (`state:'pending'`) durably (currently a transient `workflow-v2-review-pending` broadcast only). |
| review resolve | After `applyV2ReviewDecision`, emit BOTH `workflow.review.changed` (`approved`/`rejected`) and `workflow.run.changed` (`reason:'review-resolved'`) from the same tx that persists the resulting dag-state/status. |
| cancel | Guard terminal-state no-op; set `cancelled` + outbox row in one tx; emit `workflow.run.changed` (`reason:'cancelled'`). |
| reconcile | Per non-terminal run, apply the reconcile decision (below) + emit `workflow.run.changed` (`reason:'reconciled'`). |

Transaction + purity rules (same as slice 003): validate -> persist product mutation -> insert `live_outbox` row in the **same SQLite transaction** -> fan out after commit. A rollback emits nothing (canonical or legacy). The gateway may depend on `@pc/contracts`, `@pc/db`, `@pc/domain`; it must NOT import Hono, React, the websocket hub, Channel, MCP SDK, or runtime process classes. Fanout (`broadcast`) is injected at the composition layer / via `DagRunServiceOptions.broadcast`, as today.

Definition mutations (`workflow-routes.ts`): repoint `emitChanged` to also write a `workflow.definition.changed` outbox row (same tx as the `workflowsRepo` write where one exists) and keep the legacy `workflow-changed` envelope as a projection. The slug/name/scope validation logic in `normaliseDef` and the route handlers is unchanged.

## 7. Route / Compat Adapter Plan

Files likely affected:

```text
apps/server/src/features/workflow-compat/routes.ts   (parse via contracts; bodies unchanged)
apps/server/src/routes/workflow-routes.ts            (parse via contracts; bodies unchanged)
apps/server/test/workflow-compat-routes.test.ts
apps/server/test/workflow-routes.test.ts
```

- Preserve every route and response shape:
  - `GET  /api/projects/:projectId/workflow-v2/runs`
  - `GET  /api/projects/:projectId/workflow-v2/runs/:runId`
  - `POST /api/projects/:projectId/workflow-v2/review`
  - `POST /api/projects/:projectId/workflow-runs/:runId/dismiss`
  - `GET  /api/projects/:projectId/workflow-v2/definitions[/:wfId]`
  - `GET/POST /api/projects/:projectId/workflow-builder/draft[...]`
  - `GET/POST/PUT/DELETE /api/workflows[...]`, `/promote-to-global`, `/duplicate`, `/audit`, `/:id/fire`
- Handlers continue delegating fire/review to `fireDagWorkflow` / `applyV2ReviewDecision`; those now write through the gateway. Route bodies and status codes are unchanged. (Note: there is currently no dedicated run-cancel HTTP route in `workflow-compat/routes.ts`; cancel flows via the definition-delete `?cancel=1` path's `cancelInFlightRuns`. Route that cancel through the gateway too; do not add a new cancel route unless the build reveals one is needed — if so, STOP and confirm.)
- MCP: there are no `pc_*` workflow run-control tools in the current codebase (`rg` over `packages/mcp` finds workflow only in non-run-control contexts). The cartridge's MCP stage is N/A this slice. If a future slice adds workflow MCP tools they delegate to the gateway (note for 005+).

## 8. Live Event / Replay / WebSocket Compatibility Plan

Files likely affected:

```text
apps/server/src/features/live-events/routes.ts
apps/server/src/index.ts
apps/server/test/live-events-routes.test.ts
```

- Extend `/api/live-events` (slice 002) to accept `type=workflow.run.changed`, `type=workflow.review.changed`, `type=workflow.definition.changed`. Run/review events are project-scoped: honor `projectId`, never return another project's scoped events. Definition events follow row scope (global returned when `includeGlobal=1`). `project.changed` / `work-item.changed` behavior unchanged.
- After a committed gateway mutation, fan out canonical `{ type: 'live-event', event }` plus the matching legacy name (`workflow-v2-run-changed`, `workflow-v2-review-pending`, or `workflow-changed`). Do not fan out before the outbox row commits; zero subscribers or a fanout throw must leave the row replayable.
- Keep `/ws` and `ProjectWebSocketHub.broadcastAll` behavior unchanged.

## 9. Identity / Version / Lifecycle

**Stable run identity + pinned version (already present; formalize).** A run freezes its graph in `workflow_yaml_snapshot` at fire and resumes from it — in-flight runs are already immune to later definition edits. This slice surfaces durable identity on `WorkflowRunDto` (`workflowSlug` + a `definitionHash` derived from the snapshot) and adds a test asserting the executed graph comes from the snapshot, not a live re-resolve. Decision (Open Q1, resolved): keep the existing snapshot mechanism; do NOT add a definition version counter to the `workflows` table (PUT-in-place means a counter would not add in-flight immunity that the snapshot already provides) and do NOT add a `definition_snapshot` column (the snapshot already lives in `workflow_yaml_snapshot`).

**Cancellation (node-boundary).** Preserve + formalize the cooperative model: cancel flips status to `cancelled` through the gateway (durable fact + atomic write); the executor's existing `isCancelled` poll observes it at the next node boundary and stops. A node already executing (especially an agent dispatch) completes — no preemption this slice. Interrupting in-flight agent work is slice 005.

**Boot reconciliation.** None exists today. Add a reconcile pass at server boot (next to the agent-run reconcile in `index.ts`) and/or `ProjectRuntime` init, mirroring `agent-run-boot-reconcile.ts`:
- Scan non-terminal runs via a new additive `workflowRunsV2Repo.listRunsByStatus(['pending','running','paused'])`.
- `paused` runs: leave as-is (a human/orchestrator review is the blocker; the crash lost no work). No event.
- `running` runs: mid-advance when the process died. v1 policy — mark `failed` with `last_reason='interrupted-on-boot'` and emit `workflow.run.changed` (`reason:'reconciled'`). Rationale: re-driving advance could double-execute a non-idempotent node side effect (`move-work-item`/`bash`/`script`/agent dispatch are not guarded); fail-closed is safe and observable. (Open Q2, resolved as fail-closed for v1; a later slice can make node side effects idempotent + auto-resume.)
- `pending` runs (created but never advanced): fail-closed identically to `running` for uniformity. Decision (Open Q3, resolved): fail-closed for v1; revisit when idempotency lands.

## 10. DB

- **Migration needed: no (preferred).** All required tables exist: `live_outbox` (slice 002), `workflow_runs_v2` (`0022`), and `workflows` (`0000`/`0026`/`0027`). The definition snapshot used for version pinning already lives in `workflow_runs_v2.workflow_yaml_snapshot`. The only DB-layer change is an **additive read** (`listRunsByStatus`) in the repo — no schema change.
- No new table is added. `workflow_run_events` already exists as a workflow audit/observability table; this slice does NOT repurpose it as the live outbox — the slice-002 `live_outbox` is the canonical fact channel. The two coexist: `workflow_run_events` stays the per-run audit log, `live_outbox` carries the replayable live facts.
- If you conclude a stored `definition_hash` column on `workflow_runs_v2` is cleaner than deriving the hash from the snapshot at read time, that is an **additive** migration; STOP and confirm before adding it (deriving from the snapshot is the default, no-migration path).

## 11. Test Plan

Minimum automated tests (add before behavior changes where practical), mirroring the slice-002/003 style:

| Priority | Test | Purpose |
|---|---|---|
| P0 | `packages/contracts/test/workflow.test.ts` | Parser/guard coverage for definition/run/review DTOs + request schemas; canonical `workflow.run.changed` / `workflow.review.changed` / `workflow.definition.changed` payload guards; invalid scope/project combos rejected. |
| P0 | Version-pinning test | A run executes the frozen `workflowYamlSnapshot`; a subsequent definition PUT does NOT change the in-flight run's executed graph; `definitionHash` stable on the run and matches the snapshot's hash. |
| P0 | Gateway emission tests | fire / advance / review-pending / review-approve / review-reject / cancel / reconcile each emit exactly one canonical `workflow.run.changed` (+ a `workflow.review.changed` on review); rollback emits nothing (no orphan outbox row). |
| P0 | Atomicity test | A forced failure in a run write rolls back BOTH the row mutation and the `live_outbox` insert — proves the single-tx write door. |
| P0 | Cancellation test | A run cancelled mid-walk stops at the next node boundary (`isCancelled` observed), ends `cancelled`, emits `workflow.run.changed` (`reason:'cancelled'`), executes no further node side effects. |
| P0 | Boot reconcile test | Seed a `running` run + a `paused` run + a `pending` run; run reconcile; assert `running`/`pending` -> `failed`/`interrupted-on-boot` (+ event) and `paused` untouched (no event); counts correct. |
| P0 | `apps/server/test/live-events-routes.test.ts` updates | Replay returns project-scoped `workflow.run.changed` / `workflow.review.changed` after cursor; excludes other-project events; definition scope honored; `project.changed`/`work-item.changed` unchanged. |
| P0 | `apps/server/test/workflow-compat-routes.test.ts` | Legacy run/review HTTP response shapes preserved; canonical + legacy fanout after commit; reads do not emit. |
| P0 | `apps/server/test/workflow-routes.test.ts` | Definition routes preserved; `workflow.definition.changed` + legacy `workflow-changed` both emitted; in-flight delete guard still works. |
| P0 | Two-client equivalence | Two subscribers tail the outbox from seq 0 across fire -> advance -> review-pending -> approve -> complete; assert identical ordered `workflow.*` streams. |
| P1 | `apps/web/test/workflow-live-events.test.ts` | Filters accept canonical workflow frames; dedupe by id; `rev`-aware run upsert; reject unrelated frames. |

Gate commands (run from repo root; matches slices 002/003):

```powershell
pnpm --filter @pc/contracts test
pnpm --filter @pc/contracts typecheck
pnpm --filter @pc/db test
pnpm --filter @pc/db typecheck
pnpm --filter @pc/app-services test
pnpm --filter @pc/app-services typecheck
pnpm --filter @pc/server test
pnpm --filter @pc/server typecheck
pnpm --filter @pc/web test
pnpm --filter @pc/web typecheck
pnpm typecheck
git diff --check
```

If `@pc/app-services` has no test script yet, add the package-local `tsx --test "test/*.test.ts"` script as part of the implementation (slice 003 added it for that package; reuse it).

Manual verification after implementation (batched to the human end-of-section pass):

- Two browser clients: fire a workflow in client A; client B's run panel shows the run advancing without manual refresh.
- Hit a review node; approve in client A; client B reflects resume + completion.
- Disconnect one client websocket, advance a run, reconnect; replay after cursor reconciles the run panel.
- Edit a workflow definition while a run of it is in flight; confirm the in-flight run keeps executing the pinned snapshot (version-pinning behavior).
- Confirm chat/agent run behavior is unchanged.

## 12. Migration Steps

1. Add contract tests for workflow definition/run/review DTOs + canonical event payloads.
2. Add the contract files and extend `live-events.ts` + `index.ts`.
3. Add the workflow run mutation gateway in `@pc/app-services` (validate -> persist -> outbox-insert -> fanout); add row<->DTO adapters; add `definitionHash` derivation.
4. Repoint `workflow-run-writer.ts` to delegate to the gateway (keep exported names) so `dag-run-service.ts` compiles unchanged.
5. Route the cancel status write + the `requestReview`/`applyV2ReviewDecision` facts through the gateway.
6. Add `workflowRunsV2Repo.listRunsByStatus`; add the boot-reconcile pass next to the agent-run reconcile in `index.ts` (and/or `ProjectRuntime` init); emit reconcile facts.
7. Repoint definition-route `emitChanged` to dual-emit canonical `workflow.definition.changed` + legacy `workflow-changed`.
8. Extend `/api/live-events` for the new types; dual-fanout canonical + legacy after commit.
9. Add the web workflow live hook + cursor replay.
10. Run automated verification.
11. Update trackers with implementation notes.

## 13. Rollback Plan

- New event families reuse the additive slice-002 `live_outbox`; no new migration to roll back (the `listRunsByStatus` read is additive and inert if unused).
- Keep legacy `workflow-v2-run-changed` / `workflow-v2-review-pending` / `workflow-changed` as the immediate UI rollback path; canonical frames can be ignored by the web hook without changing product state.
- Gateway routing is revertible: restore `workflow-run-writer.ts`'s direct repo writes + broadcasts; revert the cancel/review fact emission.
- Remove the reconcile call from `index.ts`/`ProjectRuntime` init to disable boot reconciliation.
- Replay-route additions can be disabled from the web hook without affecting durable state.
- Revert `workflow-definitions`/`workflow-runs` contracts to drop the workflow family.

## 14. Stop Conditions

Stop and return to planning if implementation requires any of the following:

- Building the agent-run command service, pending-ask atomicity, or `agent.run.*` events (slice 005), or making cancellation preempt an in-flight agent dispatch.
- Redesigning the DAG engine (`dag-executor.ts` / `@pc/workflows`) or the `WorkflowV2` domain model.
- Changing `workflow-builder` / authoring / import behavior.
- Adding a new run-cancel HTTP route (confirm first — current cancel rides the definition-delete `?cancel=1` path).
- A destructive DB migration or rewriting existing run/definition rows. (Default is no migration; an additive `definition_hash` column requires explicit confirmation.)
- Replacing `/ws`, changing connection semantics, or restarting/killing dev processes.
- Removing any legacy websocket event name.
- Changing existing workflow HTTP response bodies or route paths.
- Accepting unrelated untagged frames in workflow hooks.
- Implementing edge-guard / conditional-`when`, reject-edge, or retry semantics beyond current behavior.

## 15. Acceptance Criteria

This slice is ready to implement only when the user explicitly asks to build and these criteria are accepted:

- `@pc/contracts` owns workflow definition/run/review DTOs, request schemas, parser/guard helpers, and canonical `workflow.run.changed` / `workflow.review.changed` / `workflow.definition.changed` payload contracts.
- A single server-owned run mutation gateway is the durable write door; the `workflow-run-writer.ts` functions delegate to it; cancel + review facts route through it.
- Each run mutation writes its product change and a `live_outbox` row atomically and dual-fans canonical + legacy events after commit.
- Run identity surfaces the existing immutable definition snapshot (`workflowSlug` + `definitionHash`); a test proves in-flight runs are immune to later definition edits.
- Cancellation is a deterministic node-boundary stop; boot reconciliation fails-closed for interrupted `running`/`pending` runs and leaves `paused` untouched.
- `/api/live-events` replays project-scoped workflow run/review events and scope-correct definition events with correct cursor filtering.
- Web stores/updates a cursor, replays after reconnect, and applies `rev`-aware run updates from canonical frames.
- Tests cover contracts, gateway emission, atomicity, version-pinning, cancellation, boot reconcile, replay filtering, legacy response parity, and web frame handling.
- Agent runs, conversation/send, mailbox, Channel, and the DAG engine remain untouched except for unaffected typecheck/test fallout.
- Tracker marks this build-slice artifact `planned`.

## 16. Open Questions

| Question | Status |
|---|---|
| Surface run identity via snapshot-derived `definitionHash` vs an additive `definition_hash` column on `workflow_runs_v2`? | Resolved for v1: derive from the existing `workflow_yaml_snapshot` (no migration). Additive column allowed only with explicit confirmation. |
| Boot reconcile policy for interrupted `running` runs: fail-closed vs auto-resume? | Resolved for v1: fail-closed (`interrupted-on-boot`). Auto-resume waits for idempotent node side effects. |
| Boot reconcile policy for `pending` runs: re-drive once vs fail-closed? | Resolved for v1: fail-closed for uniformity; revisit with idempotency. |
| Should review be its own `workflow.review.changed` fact or only a `workflow.run.changed` transition? | Resolved: both — review fact for the human-action/audit surface (mirrors `workflow-v2-review-pending`), run fact for state. |
| Should cancellation eventually preempt in-flight agent dispatch? | Deferred to slice 005 (agent-run service). This slice is node-boundary cooperative only. |
| Should orchestrator-review / review delivery move to the mailbox (off the Channel `postChannel` call)? | Deferred to slice 008 (Channel cutover). |
| Should the legacy `workflow-v2-run-changed` / `workflow-v2-review-pending` / `workflow-changed` names be removed after canonical adoption? | Deferred to compatibility cleanup slice 011. |

## 17. Notes for the Implementation Agent

- Reuse the slice-002 `live_outbox` table, replay route, and web live client; do not add a second outbox.
- The run **already** freezes its graph in `workflow_yaml_snapshot` — do NOT invent a new snapshot mechanism. Just surface `definitionHash` and test the invariant.
- Start with contracts + adapters + the version-pinning + atomicity tests; do not change run behavior before the gateway exists.
- The risk in this slice is run-write consolidation, event-after-commit ordering, and the new durable review/cancel/reconcile facts — not TypeScript surface area.
- Fire/review are module functions (`fireDagWorkflow`, `applyV2ReviewDecision`) composed per-`ProjectRuntime` via `DagRunServiceOptions`; wire the gateway through that options object's `broadcast` seam and the writer delegation. There is no singleton service class to retrofit.
- Keep `dag-executor.ts` and `@pc/workflows` untouched; only change where run-row writes go and add the durable facts + reconcile.
- `listRunsByProject` exists; add the small additive `listRunsByStatus` for reconcile.
- Do not use `archive/` as evidence or a source for tests.
