# 005 Agent-Run Command Service

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `refactor/auto-pathway` |
| Commit | baseline `6f0eb962` (slice 004 built; slices 001/002/003 verified — tags `slice-00{1,2,3}-verified`) |
| Artifact status | Planned build slice |
| Owning roadmap phase | Phase 6 agent-run command service boundary |
| Slice subject | Agent-run command service seam (single durable write door over `agent_runs` state changes), pending-ask atomicity, durable `agent.run.changed` live events, and pause/resume/cancel compatibility with the runtime + agent-host paths |
| Implementation target | This repo. Do not create a parallel app. |
| Scope rule | This is a build plan only. Do not implement until the user explicitly asks to build. |

Decision:

- **Recommendation:** Extend the slice-001/002/003/004 cartridge to the agent-run family. Add shared contracts for the agent-run record + pending-ask DTOs; put a single server-owned write door in front of every `agent_runs` status/terminal transition (mirroring the slice-003 `WorkItemMutationGateway` and slice-004 `WorkflowRunMutationGateway`); make the pending-ask pause/answer/cancel transitions durable + atomic with their run-state transition so no ask is lost or double-resolved; and emit canonical `agent.run.changed` facts through the slice-002 `live_outbox` while keeping the legacy `agent-run-changed` websocket name as a compatibility projection. The high-frequency `agent-jsonl-event` transcript stream stays a transient broadcast (it is a conversation/replay concern owned by slice 006).
- **Reason:** The agents handoff (`refactor plan/refactor plan docs/agents-and-agent-runs.md`) flags four code-verified gaps in THIS checkout: (1) `agent-run-changed` broadcasts are ad hoc, non-durable, and not transactional with the row write — reconnect recovery depends on refetch + JSONL backfill, not durable replay (High); (2) `answerPendingAsk` flips `pending_asks` to `answered` BEFORE confirming the run is resumable, so a failed resume strands an answered ask (High); (3) `cancelPendingAsk` only finalizes the run if a live registry handle exists, so a phantom paused run survives non-terminal with no open ask (High); (4) host-mode broadcasts can carry a stale `rev` because the DTO is built from the pre-update row (High). Slices 001/002/003/004 proved the contract + write-door + durable-outbox + legacy-fanout pattern; this slice applies it to the agent-run subsystem WITHOUT redesigning the runtime `AgentRun` state machine (`packages/runtime/src/agent-run.ts`), the agent-host protocol, or the agent-host split (slice 009).
- **Compatibility stance:** Keep every legacy HTTP route, MCP tool behavior, and websocket event name working. Canonical events are additive; the legacy `agent-run-changed` envelope continues as a compatibility projection of the canonical fact. `agent-jsonl-event` and `channel-event` are untouched.

## 2. Problem Statement

Verified facts (code-evidence based, this checkout):

- **`agent_runs` already persists the full state machine** (`queued | spawning | running | paused | completed | failed | cancelled`) with a monotonic `rev` counter (`packages/db/src/schema-agent-system.ts:39`; `packages/db/src/repos/agent-runs.ts`). Restart reconciliation is a `SELECT * WHERE status IN (non-terminal)` — there is no in-memory state to lose.
- **Run-row writes go through scattered repo helpers, NOT one write door.** `updateAgentRunStatus` (`rev++`), `markAgentRunTerminal` (`rev++`), `updateAgentRunPid` (no rev), `touchAgentRunActivity` (no rev) are called directly from `agent-run-factory.ts`, `pause-resume.ts`, `agent-run-terminal-effects.ts`, `agent-run-control.ts`, `agent-host-reattach.ts`, and the boot reconcile. Each transition that the UI cares about is followed by a SEPARATE, non-transactional `broadcast({ type: 'agent-run-changed', record })` — and the broadcast is NOT durable (no `live_outbox` row).
- **The `agent-run-changed` envelope is a hand-built v1-shape `AgentRunRecord`** (`runId, sessionId, agentName, model:'opus', projectId, parentWorkItemId, dispatcherSessionId, wait:false, worktreeDir, startedAt, status, result, failureReason, failureCause, endedAt, rev`). It is constructed in at least five places (`agent-run-factory.ts` `broadcastStateChanged`/`broadcastAgentRunChanged`/`broadcastHostRunChanged`, `agent-run-terminal-effects.ts` `finishTerminalEffects`, `agent-run-boot-reconcile.ts`). Several read `rev` post-write (`getAgentRunRow(...).rev`), but the host-mode adapters build the DTO from the pre-update row (handoff High issue #3).
- **Terminal finalization is centralized** in `applyAgentRunTerminalEffects` (`agent-run-terminal-effects.ts`): idempotent `markAgentRunTerminal` (no-op if already terminal), unregister active handle, optional cleanup, async verification + Channel envelope + the terminal `agent-run-changed` broadcast. This is the closest thing to a write door today, but it covers only the terminal transition and the broadcast is non-durable.
- **Pending-ask lifecycle is atomic at the ROW level but not as a saga.** `createPendingAsk` writes one `open` row; `markPendingAskAnswered` / `markPendingAskCancelled` are atomic `UPDATE ... WHERE status='open'` flips (replay-safe). BUT in `pause-resume.ts::answerPendingAsk` the row is flipped to `answered` BEFORE the active-run lookup and `resumeWithAnswer`, so a `unknown-run`/`wrong-state`/`resume-failed` return leaves the ask answered with the run not resumed (handoff High issue #1). And `cancelPendingAsk` flips the ask to `cancelled` then only calls `entry.run.cancel()` when a registry entry exists — a phantom paused run is never finalized in the DB (handoff High issue #2).
- **Pause writes the run + the ask + the delivery as three separate non-transactional steps** (`recordExplicitPause`: `createPendingAsk` → `entry.run.markPaused` → `updateAgentRunStatus('paused')` → `enqueueAndPush`). No single durable fact ties the pause together; the `agent-asks-*` event is a Channel/inbox push, not a `live_outbox` row.
- **Cancellation has three live entry points, none durable-fact-emitting in one tx:** the `/cancel` route (`features/agent-runs/routes.ts:170`, registry `entry.run.cancel()` only — 404s on a phantom), `/kill` (`agent-run-control.ts::hardKillAgentRun` — force-kills the persisted pid then finalizes via `applyAgentRunTerminalEffects`, works on phantoms), and `cancelPendingAsk`. The terminal-effects path emits the legacy broadcast but no `live_outbox` row.
- **Boot reconciliation already exists for agent runs** (unlike workflows in slice 004). `reattachAgentRunsDuringServerBoot` (`agent-run-server-boot.ts`) runs at `apps/server/src/index.ts:350`. Without a host client it uses the announcing legacy sweep (`listAndReconcileOrphanedRuns` → bulk `failed`/`server-restart` → broadcast each). With a host client it reconciles DB rows against host snapshots, preserving `paused` runs that still have an open ask + on-disk JSONL. An in-process liveness sweep (`agent-run-liveness-sweep.ts`) runs every 30s when no host client exists.
- **`@pc/contracts` has no agent module.** `packages/contracts/src/` = projects, work-items, stages, field-schemas, attachments, workflow-definitions, workflow-runs, live-events, shared. The web agent-run DTOs are hand-written (`apps/web/src/features/agent-runs/types.ts`), not imported from contracts.
- **`agent.run.changed` / entity `agent-run` are RESERVED** for this family in `refactor plan/foundation specs/live-events-and-outbox.md` (legacy `agent-run-changed` → canonical `agent.run.changed`, `project`-scoped, "Full run DTO with current `rev`"). `LiveEventEntity` in `packages/contracts/src/live-events.ts` does NOT yet include `agent-run`.
- **The web hook is already `rev`-aware.** `useProjectAgentRuns` (`apps/web/src/hooks/use-project-agent-runs.ts`) consumes `agent-run-changed` through `useResourceList`, keying on `runId`, versioning on `rev`, dropping terminal rows and refetching the active-list endpoint. It does NOT yet read the canonical `live_outbox` cursor/replay path.
- **Slice 002 shipped** the `LiveEvent`/`LiveEventFrame` envelope, `live_outbox` table/repo (`insertLiveEvent`, `listLiveEventsAfter`), `/api/live-events` replay, and dual canonical/legacy fanout; slices 003/004 reused it.

Synthesis — this slice implements the next cartridge layer for the agent-run family:

```text
contract (agent-run + pending-ask DTOs + canonical agent.run.changed payload)
  -> app-service write door (single durable run-mutation gateway over the agent_runs writes)
  -> route/MCP compat adapters (preserve agent-runs + pending-asks wire shapes)
  -> live event fact (agent.run.changed) on slice-002 outbox
  -> web client/hook + canonical/legacy fanout
  -> tests
```

## 3. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | `agent_runs` persists the full state machine + a monotonic `rev`; reconcile is a non-terminal `SELECT`. | `packages/db/src/schema-agent-system.ts:39`; `packages/db/src/repos/agent-runs.ts` |
| Verified fact | Run-row writes are scattered repo helpers (`updateAgentRunStatus`/`markAgentRunTerminal`/`updateAgentRunPid`/`touchAgentRunActivity`), each followed by a separate non-durable `agent-run-changed` broadcast. | `agent-run-factory.ts`, `pause-resume.ts`, `agent-run-terminal-effects.ts`, `agent-run-control.ts`, `agent-run-boot-reconcile.ts` |
| Verified fact | The `agent-run-changed` record is a hand-built v1 `AgentRunRecord` constructed in 5+ places; host-mode adapters can build it from a stale pre-update row. | `agent-run-factory.ts` `broadcastStateChanged`/`broadcastHostRunChanged`; `agent-run-terminal-effects.ts` `finishTerminalEffects`; `agent-run-boot-reconcile.ts`; handoff issue #3 |
| Verified fact | `applyAgentRunTerminalEffects` is the idempotent terminal write door (covers terminal only; broadcast non-durable). | `apps/server/src/services/agent-run-terminal-effects.ts` |
| Verified fact | `pending_asks` row flips are atomic (`UPDATE ... WHERE status='open'`), but `answerPendingAsk` answers BEFORE checking resumability → strands the ask on resume failure. | `packages/db/src/repos/pending-asks.ts`; `pause-resume.ts::answerPendingAsk`; handoff High issue #1 |
| Verified fact | `cancelPendingAsk` flips the ask cancelled then only finalizes the run if a registry handle exists → phantom paused row stranded. | `pause-resume.ts::cancelPendingAsk`; handoff High issue #2 |
| Verified fact | Pause is three non-transactional steps (`createPendingAsk` → `markPaused` → `updateAgentRunStatus` → `enqueueAndPush`); no single durable pause fact. | `pause-resume.ts::recordExplicitPause` |
| Verified fact | Three cancel entry points: `/cancel` (registry-only, 404s on phantom), `/kill` (pid kill + terminal effects, phantom-safe), `cancelPendingAsk`. | `features/agent-runs/routes.ts:170,188`; `agent-run-control.ts`; `pause-resume.ts` |
| Verified fact | Boot reconciliation already exists (legacy announcing sweep + host-snapshot reconcile + 30s liveness sweep). | `agent-run-server-boot.ts`; `agent-run-boot-reconcile.ts`; `agent-run-liveness-sweep.ts`; `index.ts:350` |
| Verified fact | `@pc/contracts` has no agent module; web agent-run DTOs are hand-written. | `packages/contracts/src/` listing; `apps/web/src/features/agent-runs/types.ts` |
| Verified fact | `agent.run.changed` / entity `agent-run` reserved in the live-events spec (legacy `agent-run-changed`, project-scoped, full run DTO + current `rev`). | `refactor plan/foundation specs/live-events-and-outbox.md:116,275` |
| Verified fact | Web `useProjectAgentRuns` is already `rev`-aware via `useResourceList` (drop-on-terminal + refetch) but not wired to the canonical replay cursor. | `apps/web/src/hooks/use-project-agent-runs.ts` |
| Verified fact | Web client `listAgentPendingAsks` GETs `/agent-pending-asks`, but the server registers only POST/answer/cancel — the GET is a dead client API. | `apps/web/src/features/agent-runs/client.ts:45`; `features/agent-runs/routes.ts` (no GET); handoff Medium issue |
| Verified fact | Slice 002 outbox + replay + dual fanout pattern shipped; reused by slices 003/004. | `refactor plan/build-slices/002`,`003`,`004` |

## 4. Exact Scope

Implement only these behaviors when the user asks to build:

1. Add an agent-run contract family to `@pc/contracts`: `AgentRunDto` (browser-safe mirror of the broadcast `AgentRunRecord` — `runId, sessionId, agentName, model, projectId, parentWorkItemId, dispatcherSessionId, worktreeDir, startedAt, status, result, failureReason, failureCause, endedAt, rev`), `AgentRunStatus` mirror (`queued|spawning|running|paused|completed|failed|cancelled`), `PendingAskDto` (`id, agentRunId, ccSessionId, projectId, parentWorkItemId, kind, promptBody, context, options, status, answeredBy, createdAt, answeredAt, cancelledAt`), `PendingAskKind` (`orchestrator|user|approval`), `PendingAskStatus` (`open|answered|cancelled`), request schemas (invoke, continue, create-pending-ask, answer-pending-ask, cancel-pending-ask), and parser/guard helpers. Mirror domain enums exactly; do not invent new states.
2. Add a canonical live-event payload contract built on the slice-002 `LiveEvent` envelope + `{ type: 'live-event', event }` frame: `agent.run.changed` (project-scoped, `version` = `agent_runs.rev`). Extend `LiveEventEntity` with `'agent-run'`, `LiveEventTypeName` with `'agent.run.changed'`, and `parseListLiveEventsQuery`'s accept-list (names reserved in `foundation specs/live-events-and-outbox.md`). Add a `toLegacyAgentRunChanged(event)` adapter that reproduces the exact v1 `AgentRunRecord` envelope.
3. Add a server-owned **agent-run mutation gateway** in `@pc/app-services` (`AgentRunMutationGateway`, mirroring the slice-003/004 gateways) that is the single durable path for run status/terminal transitions that the UI cares about. It wraps the product write (`updateAgentRunStatus` / `markAgentRunTerminal`) and the `live_outbox` insert in **one SQLite transaction**, re-reads the post-write row for the correct `rev`, and returns a publication the server composition layer fans out (canonical frame + legacy `agent-run-changed`) AFTER commit. A rollback emits nothing.
4. Route the existing UI-relevant broadcast sites through the gateway so every durable run transition produces ONE coherent `agent.run.changed` fact with a non-stale `rev`:
   - `agent-run-factory.ts` `broadcastStateChanged` (queued/spawning/running/paused) and the host-mode `broadcastHostRunChanged`/`broadcastAgentRunChanged` (closes handoff High issue #3 — stale `rev`).
   - `agent-run-terminal-effects.ts::finishTerminalEffects` terminal broadcast.
   - `agent-run-boot-reconcile.ts` announcing path (legacy + host).
   These call sites keep their existing helper signatures; the broadcast body is replaced by the gateway publication. The `AgentRun` state machine, timers, PID capture (`updateAgentRunPid`), and activity stamping (`touchAgentRunActivity`) are NOT moved (they are not UI version transitions — no `rev` bump today; leave them as-is).
5. **Pending-ask atomicity (the slice's core durability work).** Make the pause/answer/cancel transitions correct and recoverable:
   - **Pause:** wrap `createPendingAsk` + the `agent_runs` `paused` write in one transaction and emit one `agent.run.changed` (`reason:'paused'`) fact through the gateway in that tx. Keep `entry.run.markPaused` (runtime state) and the `enqueueAndPush` Channel/inbox delivery as the post-commit step (delivery stays best-effort; the Channel cutover is slice 008).
   - **Answer:** reorder so resumability is validated BEFORE the `open→answered` flip — check the active run exists and is `paused` first, then flip the ask + persist `spawning`/`podRevisionAtResume` + emit `agent.run.changed` (`reason:'resumed'`) in one tx, then drive `resumeWithAnswer`. On a resume-drive failure AFTER the flip, finalize through the gateway to a recoverable terminal/`failed` state rather than leaving an answered ask with a stuck run (closes handoff High issue #1). Preserve the atomic `WHERE status='open'` replay-safety.
   - **Cancel:** route cancel through the gateway so the `agent_runs` row is finalized to `cancelled` (durable fact + atomic write) EVEN WHEN no registry handle exists (phantom paused run), then best-effort `entry.run.cancel()` if present (closes handoff High issue #2). Mirror the phantom-safe pattern `hardKillAgentRun` already uses.
6. **Pause / resume / cancel compatibility with the runtime + agent-host paths.** Preserve the in-process `AgentRun` resume-via-`resumeWithAnswer` path and the host-backed path (`HostBackedActiveRunHandle`, `agent-host-reattach.ts`). The gateway owns the DURABLE DB transition + fact; the runtime/host owns process lifecycle. Do not change the agent-host wire protocol, the reattach logic, or the liveness sweep cadence; only swap their broadcast emission for the gateway publication where they emit `agent-run-changed` today.
7. Dual-fanout after the committed outbox insert: canonical `{ type: 'live-event', event }` frames for new clients, plus the existing legacy `agent-run-changed` websocket name as a compatibility projection. The high-frequency `agent-jsonl-event` transcript stream and `channel-event` stay untouched transient broadcasts.
8. Extend `/api/live-events` (slice 002) to allow `type=agent.run.changed` with the same cursor/scope semantics. Agent-run events are project-scoped: honor `projectId`, never return another project's scoped events.
9. Add a web live-event helper that consumes the canonical `agent.run.changed` frame, dedupes by `event.id`, applies `rev`-aware run upserts, and replays/refetches on reconnect via the slice-002 live client. The existing `agent-run-changed` `useResourceList` handling keeps working in parallel; the web agent-run `types.ts` re-exports/aliases the contract `AgentRunDto` so component imports keep compiling.
10. Run the listed automated verification.

Non-goals (explicitly OUT — and which slice owns each):

- **Conversation / session / send / replay + transcript repository** — slice 006. This slice does NOT move `agent-jsonl-event` onto the outbox, does NOT build a transcript repository over the provider JSONL, and does NOT change `/agent-runs/:runId/events` backfill.
- **Mailbox platform** — slice 007. Pending-ask / `agent-asks-*` delivery stays on the current `enqueueAndPush` (inbox + best-effort Channel). This slice makes the pending-ask STATE durable + atomic; it does not move DELIVERY to a mailbox or add leases/ack/dead-letter. Whether `pending_asks` mirror into a `pending_interactions` table is a slice 007 decision.
- **Channel cutover** — slice 008. The `agent-completed`/`agent-failed`/`agent-asks-*`/`agent-queued-started` Channel envelopes stay on the existing path; this slice does not retire `postChannel`/`enqueueAndPush`.
- **Runtime-host split / transient worktrees** — slice 009. Do not change the agent-host protocol, the in-process vs host-backed seam, `agent-host-client.ts`, reattach, or worktree/path-guard behavior beyond swapping the broadcast emission for the gateway publication.
- **MCP typed client / capability registry** — slice 010. Keep `packages/mcp/src/tools/agent-runs.ts` tool names + HTTP payloads; only route request/response parsing through contract parsers where it does not change the wire.
- Do not redesign the `AgentRun` runtime state machine (`packages/runtime/src/agent-run.ts`), `AgentRunRegistry` cap/queue, or `ActiveRunRegistry`.
- Do not change the continuation lineage model (`continues` self-FK), the JSONL-retention guard, or the single-active-continuation guard.
- Do not implement the dead web `GET /agent-pending-asks` projection as new product surface (the handoff parks it); add the shared contract and either alias or leave the client API dormant. If the build needs a GET projection, STOP and confirm.
- Do not add destructive DB migrations; prefer no migration (see DB section).
- Do not remove any legacy websocket event name (deferred to cleanup slice 011).
- Do not restart or kill dev servers while implementing or verifying.

## 5. Contract Plan

Files likely affected:

```text
packages/contracts/src/agent-runs.ts
packages/contracts/src/pending-asks.ts
packages/contracts/src/live-events.ts        (extend entity/type union; do not rewrite existing members)
packages/contracts/src/index.ts
packages/contracts/test/agent-runs.test.ts
packages/contracts/test/live-events.test.ts  (extend)
```

Contract rules (unchanged from slices 001–004): browser-safe, side-effect-free, zero runtime deps; no imports from apps, `@pc/db`, `@pc/domain`, `@pc/runtime`, `@pc/mcp`, Hono, React, or Node built-ins; parsers accept `unknown` and return `ParseResult<T>`.

Core DTOs:

| Contract | Initial contents |
|---|---|
| `AgentRunDto` | runId, sessionId (= ccSessionId), agentName, model, projectId, parentWorkItemId, dispatcherSessionId, worktreeDir, startedAt, status (`queued\|spawning\|running\|paused\|completed\|failed\|cancelled`), result, failureReason, failureCause, endedAt, rev. (Mirrors the broadcast v1 `AgentRunRecord` so the legacy adapter is lossless. `wait` is dropped from the DTO — it is a constant `false` shim; the legacy adapter re-adds it.) |
| `PendingAskDto` | id, agentRunId, ccSessionId, projectId, parentWorkItemId, kind (`orchestrator\|user\|approval`), promptBody, context, options (`{ label, value }[]`), status (`open\|answered\|cancelled`), answeredBy (`orchestrator\|user\|null`), createdAt, answeredAt, cancelledAt. |
| Request schemas | invoke (`{ input, parentWorkItemId?, workItemId?, parentInvokeDepth?, dispatcherSessionId }`), continue (`{ input, dispatcherSessionId, workItemId? }`), create-pending-ask (`{ agentRunId, kind, promptBody, context?, options? }`), answer-pending-ask (`{ answer, answeredBy }`), cancel-pending-ask (`{}`). Parse-only; bodies/status codes unchanged. |

Canonical live-event extension (build on slice-002 `LiveEvent` + frame):

```ts
// LiveEventEntity union extended: ... | 'agent-run'
// LiveEventTypeName union extended: ... | 'agent.run.changed'

export type AgentRunChangedReason =
  | 'queued' | 'spawning' | 'running' | 'paused' | 'resumed'
  | 'completed' | 'failed' | 'cancelled' | 'reconciled';

export interface AgentRunChangedLivePayload {
  reason: AgentRunChangedReason;
  run: AgentRunDto;          // full snapshot with current rev
  pendingAskId?: ULID | null; // set on reason:'paused'
}
```

First canonical shape:

```ts
{ type: 'agent.run.changed', entity: 'agent-run', scope: 'project', projectId, entityId: runId, version: rev, payload: AgentRunChangedLivePayload }
```

Contract decisions (recorded; see Open Questions):

- Agent-run events are **project-scoped** (`scope: 'project'`, non-null `projectId`), matching the legacy `broadcastTo(projectId, ...)` fanout and the spec reservation.
- `version` on `agent.run.changed` carries `agent_runs.rev` so the web hook keeps its existing `rev`-aware discard. The fact must be built from the POST-write row (the gateway re-reads it) — this is the fix for handoff High issue #3.
- **Pending asks do NOT get their own canonical live-event family in this slice.** A pause is surfaced as `agent.run.changed` (`reason:'paused'`, with `pendingAskId`); the ask itself is delivered through the existing `agent-asks-*` Channel/inbox path. A dedicated `pending-ask.changed` / mailbox interaction fact is deferred to slice 007 (mailbox/pending-interactions). The `PendingAskDto` contract still ships this slice for the request/response surfaces.
- Keep the legacy `agent-run-changed` WS name as a compatibility projection; add `toLegacyAgentRunChanged(event)` mirroring slices 002–004's `to<Legacy>` adapters, reproducing the exact `{ type:'agent-run-changed', record }` shape (including `model`, `wait:false`).

## 6. App-Service / Repo Boundary

Files likely affected:

```text
packages/app-services/src/agent-runs/run-gateway.ts
packages/app-services/src/agent-runs/adapters.ts
packages/app-services/src/agent-runs/index.ts
apps/server/src/services/agent-run-factory.ts          (state + host broadcasts through gateway)
apps/server/src/services/agent-run-terminal-effects.ts (terminal broadcast through gateway)
apps/server/src/services/agent-run-boot-reconcile.ts   (reconcile broadcast through gateway)
apps/server/src/services/pause-resume.ts               (pause/answer/cancel through gateway, reordered)
apps/server/src/services/agent-run-control.ts          (hardKill terminal fact through gateway)
apps/server/src/index.ts                               (wire gateway broadcast seam)
packages/db/src/repos/agent-runs.ts                    (no schema change; reuse existing helpers)
```

Gateway responsibilities (one durable write door for the UI-relevant run transitions):

| Operation | Required behavior |
|---|---|
| status transition (queued→spawning→running→paused→resumed) | Run `updateAgentRunStatus` (`rev++`) + insert `agent.run.changed` outbox row in one tx; re-read post-write row for the fact's `rev`; fan out canonical + legacy after commit. |
| pause | `createPendingAsk` + `updateAgentRunStatus('paused')` + the outbox fact (`reason:'paused'`, `pendingAskId`) in one tx; runtime `markPaused` + delivery are post-commit. |
| answer/resume | After resumability validated: atomic `markPendingAskAnswered` (`WHERE status='open'`) + `updateAgentRunStatus('spawning', podRevisionAtResume)` + outbox fact (`reason:'resumed'`) in one tx; `resumeWithAnswer` post-commit; finalize through the gateway on resume failure. |
| cancel | Guard terminal-state no-op; `markAgentRunTerminal('cancelled')` (+ optional `markPendingAskCancelled` for a paused run) + outbox fact (`reason:'cancelled'`) in one tx; best-effort `entry.run.cancel()`/pid-kill post-commit. Phantom-safe (no registry handle required). |
| terminal (completed/failed/cancelled) | Keep `applyAgentRunTerminalEffects`'s idempotent `markAgentRunTerminal` guard; record the terminal `agent.run.changed` fact in the same tx as the row flip; verification + Channel envelope stay post-commit async. |
| reconcile (boot) | Per reconciled row, record `agent.run.changed` (`reason:'reconciled'`) through the gateway in the announcing path; keep the host-snapshot reconcile and `paused`+open-ask preservation. |

Transaction + purity rules (same as slices 003/004): validate → persist product mutation → insert `live_outbox` row in the **same SQLite transaction** → re-read the post-write row → fan out after commit. A rollback emits nothing. The gateway may depend on `@pc/contracts`, `@pc/db`, `@pc/domain`; it must NOT import Hono, React, the websocket hub, Channel, MCP SDK, or runtime process classes (`AgentRun`, `LowLevelSpawn`, host client). Fanout (`broadcast`) and the runtime/delivery side effects are wired at the server composition layer / injected through the existing `DispatchAgentDeps.broadcast` / `PauseResumeDeps` seams.

## 7. Route / Compat Adapter Plan

Files likely affected:

```text
apps/server/src/features/agent-runs/routes.ts   (parse via contracts; bodies unchanged)
apps/server/test/agent-run-routes.test.ts
packages/mcp/src/tools/agent-runs.ts             (parse via contracts; tool names/payloads unchanged)
```

- Preserve every route and response shape:
  - `GET  /api/projects/:projectId/agent-runs`
  - `GET  /api/projects/:projectId/agent-runs/:runId/events`
  - `POST /api/projects/:projectId/agent-runs/:runId/cancel`
  - `POST /api/projects/:projectId/agent-runs/:runId/kill`
  - `GET  /api/projects/:projectId/agent-runs/:runId/inspect`
  - `POST /api/projects/:projectId/agents/:name/invoke`
  - `POST /api/projects/:projectId/agent-runs/:runId/continue`
  - `GET  /api/projects/:projectId/agent-runs/by-dispatcher`
  - `POST /api/projects/:projectId/agent-pending-asks`
  - `POST /api/projects/:projectId/agent-pending-asks/:askId/answer`
  - `POST /api/projects/:projectId/agent-pending-asks/:askId/cancel`
- Handlers keep delegating to `dispatchFreshAgent` / `dispatchContinueAgent` / `recordExplicitPause` / `answerPendingAsk` / `cancelPendingAsk` / `hardKillAgentRun`; those now write through the gateway. Route bodies and status codes are unchanged. Move request parsing onto the shared contract parsers via adapters only.
- The `/cancel` route currently 404s when there is no registry handle. Routing cancel through the gateway makes it phantom-safe; **preserve the existing 404 response contract for an unknown run id** but allow a phantom-but-known run to finalize. If making `/cancel` phantom-safe changes its observable response for a known-phantom run, STOP and confirm (it may need to mirror `/kill`'s 200).
- MCP: `packages/mcp/src/tools/agent-runs.ts` tool names + HTTP payloads unchanged; route parsing through contracts only.

## 8. Live Event / Replay / WebSocket Compatibility Plan

Files likely affected:

```text
apps/server/src/features/live-events/routes.ts   (no code change if accept-list is contract-driven; verify)
apps/server/src/index.ts                         (wire gateway publication fanout)
apps/server/test/live-events-routes.test.ts
```

- Extend `/api/live-events` (slice 002) to accept `type=agent.run.changed`. The route reads `parseListLiveEventsQuery`, so widening `LiveEventTypeName` + the accept-list in `@pc/contracts` is the only change needed; verify no server-side allow-list duplication. Agent-run events are project-scoped: honor `projectId`, never return another project's scoped events. `project.changed` / `work-item.changed` / `workflow.*` behavior unchanged.
- After a committed gateway mutation, fan out canonical `{ type: 'live-event', event }` plus legacy `agent-run-changed`. Do not fan out before the outbox row commits; zero subscribers or a fanout throw must leave the row replayable.
- Keep `/ws`, `ProjectWebSocketHub.broadcastTo`/`broadcastAll`, `agent-jsonl-event`, and `channel-event` behavior unchanged.

## 9. Identity / Atomicity / Lifecycle

**Run identity.** A run is identified by its PC-minted ULID (`agent_runs.id`); continuations mint a new id linked via the `continues` self-FK and reuse the parent `ccSessionId`. This slice does not change identity; the canonical fact carries `entityId: runId` and `version: rev`.

**Pending-ask atomicity (the slice's core invariant).** Today the ask flip and the run transition are separate non-transactional steps with an ordering bug on answer and a missing finalization on phantom cancel. After this slice:
- A pause writes the `open` ask + the `paused` run transition + the durable fact in one tx (or, if the ask write must precede the runtime `markPaused`, in a tightly-ordered sequence with the fact committed atomically with the row flip).
- An answer validates resumability, then flips `open→answered` + persists `spawning` + emits the fact atomically, then drives resume; a post-flip resume failure finalizes through the gateway to a recoverable state. The atomic `WHERE status='open'` flip preserves JSONL-replay safety (a replayed answer is a no-op).
- A cancel finalizes the `agent_runs` row to `cancelled` durably even for a phantom paused run (no registry handle), closing the stranded-row gap.

**Cancellation.** Three entry points stay (`/cancel`, `/kill`, `cancelPendingAsk`); all route their DURABLE DB transition + fact through the gateway. `/kill`'s pid-kill + phantom finalization behavior is preserved (it already works on phantoms via `applyAgentRunTerminalEffects`); only its broadcast becomes the gateway publication. Interrupting an in-flight node-dispatched agent from a workflow cancel remains out of scope (that was deferred from slice 004 to here only for the AGENT side — and is itself bounded: this slice makes the agent-run cancel durable + phantom-safe, but does not add new preemption semantics to the workflow DAG walk).

**Boot reconciliation.** Already exists; this slice makes its emissions durable facts. The legacy announcing sweep, the host-snapshot reconcile, the `paused`+open-ask+JSONL preservation rule, and the 30s liveness sweep are all preserved — only the `agent-run-changed` broadcast they emit becomes the gateway publication (canonical + legacy).

## 10. DB

- **Migration needed: no (preferred).** All required tables exist: `agent_runs` + `pending_asks` (`schema-agent-system.ts`) and `live_outbox` (slice 002). `agent_runs.rev` already exists for versioned UI discard. The only DB-layer change is widening the `live_outbox.entity` drizzle `$type` union to include `'agent-run'` (additive type-only change, as slice 004 did for `workflow-*`) and the matching `LiveOutboxEntity` TS type — **no schema/migration**.
- No new table is added. `pending_asks` stays the durable pause-state table; `live_outbox` carries the replayable run facts. Whether `pending_asks` mirror into a `pending_interactions` table is a slice 007 decision and OUT here.
- If you conclude a transactional pause/answer requires a schema change (e.g. a new column on `pending_asks` to link the resume attempt), that is an **additive** migration; STOP and confirm before adding it (the default no-migration path reuses the existing atomic `WHERE status='open'` flips).

## 11. Test Plan

Minimum automated tests (add before behavior changes where practical), mirroring the slice-002/003/004 style:

| Priority | Test | Purpose |
|---|---|---|
| P0 | `packages/contracts/test/agent-runs.test.ts` | Parser/guard coverage for `AgentRunDto` / `PendingAskDto` + request schemas; canonical `agent.run.changed` payload guard; invalid scope/project combos rejected; legacy `agent-run-changed` adapter round-trips the exact v1 record (incl. `model`, `wait:false`). |
| P0 | Gateway emission tests | queued/spawning/running/paused/resumed/terminal/cancel/reconcile each emit exactly one canonical `agent.run.changed` with the POST-write `rev`; rollback emits nothing (no orphan outbox row). |
| P0 | Atomicity test | A forced failure in a run write rolls back BOTH the row transition and the `live_outbox` insert — proves the single-tx write door. |
| P0 | Stale-rev closure test | A status transition's fact carries the post-write `rev`, not a pre-update value (characterizes + closes handoff High issue #3 on the host-mode path). |
| P0 | Answer-ordering test | `answerPendingAsk` against a non-resumable run does NOT leave the ask `answered` (resumability validated first); a successful answer flips + persists `spawning` + emits `resumed` atomically; a replayed answer is a no-op (closes handoff High issue #1). |
| P0 | Phantom-cancel test | Cancelling a paused run with NO registry handle finalizes the `agent_runs` row to `cancelled` + cancels the open ask + emits `agent.run.changed` (`reason:'cancelled'`) (closes handoff High issue #2). |
| P0 | `apps/server/test/live-events-routes.test.ts` updates | Replay returns project-scoped `agent.run.changed` after cursor; excludes other-project events; `project.changed`/`work-item.changed`/`workflow.*` unchanged. |
| P0 | `apps/server/test/agent-run-routes.test.ts` | Legacy agent-run/pending-ask HTTP response shapes + status codes preserved; canonical + legacy fanout after commit; reads (`/agent-runs`, `/inspect`, `/events`, `by-dispatcher`) do not emit. |
| P0 | Pause/resume/cancel compatibility test | In-process resume via `resumeWithAnswer` and the cancel paths still drive the runtime handle; host-backed path emits the gateway publication without changing the host protocol. |
| P0 | Two-client equivalence | Two subscribers tail the outbox from seq 0 across queued → running → paused → resumed → completed; assert identical ordered `agent.run.changed` streams. |
| P1 | `apps/web/test/agent-run-live-events.test.ts` | Filters accept the canonical `agent.run.changed` frame; dedupe by id; `rev`-aware upsert + drop-on-terminal; reject unrelated frames; legacy `agent-run-changed` still applies in parallel. |
| P1 | MCP parity test | `pc_invoke_agent`/`pc_continue_agent`/pause/answer request+response match server behavior after contract-parsing migration. |

Gate commands (run from repo root; matches slices 002–004):

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

`@pc/app-services` already has the package-local `tsx --test "test/*.test.ts"` script (added in slice 003); reuse it.

Manual verification after implementation (batched to the human end-of-section pass):

- Two browser clients: dispatch an agent in client A; client B's Activity Panel shows the run advance queued → running → terminal without manual refresh.
- Trigger a pause (`pc_ask_*`); both clients show the paused run; answer it; both clients show resume → completion.
- Cancel a paused run from one client; confirm it terminalizes in both (and that a phantom paused run — e.g. after the active handle is gone — still finalizes via the cancel/kill path).
- Disconnect one client websocket, advance a run, reconnect; replay after cursor reconciles the Activity Panel.
- Relaunch the server mid-run (NOT during this build session — human-controlled end-of-section); confirm boot reconcile fails interrupted runs and announces them, and that a paused run with an open ask + on-disk JSONL is preserved.
- Confirm chat/workflow/work-item behavior is unchanged.

## 12. Migration Steps

1. Add contract tests for `AgentRunDto` / `PendingAskDto` + canonical `agent.run.changed` payload + the legacy adapter.
2. Add the contract files and extend `live-events.ts` + `index.ts`.
3. Add the `AgentRunMutationGateway` in `@pc/app-services` (validate → persist → outbox-insert → re-read → fanout); add the row→DTO adapter + the legacy-record adapter.
4. Widen the `@pc/db` `live_outbox.entity` `$type` union + `LiveOutboxEntity` to include `'agent-run'` (additive, no migration).
5. Route the state/host/terminal/reconcile broadcast sites through the gateway (keep helper signatures; fix the host-mode stale-`rev`).
6. Reorder + transact `pause-resume.ts` answer (validate-first), pause (atomic ask+run+fact), and cancel (phantom-safe finalize) through the gateway.
7. Make `hardKillAgentRun`'s terminal broadcast the gateway publication.
8. Extend `/api/live-events` for `agent.run.changed` (contract-driven accept-list); dual-fanout canonical + legacy after commit.
9. Add the web agent-run live helper + cursor replay; alias the contract DTO in web `types.ts`.
10. Run automated verification.
11. Update trackers with implementation notes.

## 13. Rollback Plan

- New event family reuses the additive slice-002 `live_outbox`; no new migration to roll back (the `live_outbox.entity` union widening is type-only and inert if unused).
- Keep legacy `agent-run-changed` as the immediate UI rollback path; canonical frames can be ignored by the web hook without changing product state.
- Gateway routing is revertible call-site by call-site back to the current direct `updateAgentRunStatus`/`markAgentRunTerminal` + broadcast pairs; repo functions are unchanged.
- The pause/answer/cancel reordering is the riskiest change: revert `pause-resume.ts` to the current ordering to restore prior behavior (re-introducing the known issues, but unblocking). Keep the reorder behind focused tests.
- Replay-route additions can be disabled from the web hook without affecting durable state.
- Revert `agent-runs`/`pending-asks` contracts to drop the agent family.

## 14. Stop Conditions

Stop and return to planning if implementation requires any of the following:

- Moving `agent-jsonl-event` onto the outbox, building a transcript repository, or changing `/agent-runs/:runId/events` backfill (slice 006).
- Moving pending-ask DELIVERY to a mailbox, adding leases/ack/retry/dead-letter, or mirroring `pending_asks` into `pending_interactions` (slice 007).
- Retiring any Channel envelope path or `enqueueAndPush` (slice 008).
- Changing the agent-host wire protocol, the in-process vs host-backed seam, reattach, the liveness sweep cadence, or worktree/path-guard behavior (slice 009).
- Renaming MCP tools or changing their payloads (slice 010).
- Redesigning the `AgentRun` runtime state machine, `AgentRunRegistry`, or `ActiveRunRegistry`.
- Changing the `continues` lineage model, JSONL-retention guard, or single-active-continuation guard.
- A destructive DB migration or rewriting existing `agent_runs`/`pending_asks` rows. (Default is no migration; any additive column requires explicit confirmation.)
- Changing the observable `/cancel` response for a known-phantom run (it may need to mirror `/kill`'s 200 — confirm first).
- Implementing the dead web `GET /agent-pending-asks` as new product surface.
- Replacing `/ws`, changing connection semantics, or restarting/killing dev processes.
- Removing any legacy websocket event name.
- Changing existing agent-run/pending-ask HTTP response bodies, status codes, or route paths.
- Accepting unrelated untagged frames in the agent-run web hook.

## 15. Acceptance Criteria

This slice is ready to implement only when the user explicitly asks to build and these criteria are accepted:

- `@pc/contracts` owns `AgentRunDto` / `PendingAskDto`, request schemas, parser/guard helpers, the canonical `agent.run.changed` payload contract, and the lossless legacy `agent-run-changed` adapter.
- A single server-owned agent-run mutation gateway is the durable write door for UI-relevant run transitions; the scattered state/host/terminal/reconcile/pause/answer/cancel broadcast sites route through it.
- Each durable run transition writes its product change and a `live_outbox` row atomically, builds the fact from the POST-write row (correct `rev`), and dual-fans canonical + legacy events after commit.
- Pending-ask atomicity is fixed: answer validates resumability before the flip; pause writes ask+run+fact atomically; cancel finalizes a phantom paused run durably (closes the three handoff High issues + the stale-`rev` issue).
- Pause / resume / cancel stay compatible with both the in-process `AgentRun` path and the host-backed path; the host protocol, reattach, and liveness sweep are unchanged except for the broadcast emission.
- `/api/live-events` replays project-scoped `agent.run.changed` with correct cursor/scope filtering.
- Web stores/updates a cursor, replays after reconnect, and applies `rev`-aware run updates from canonical frames; the legacy `useResourceList` path still works.
- Tests cover contracts, gateway emission, atomicity, stale-rev closure, answer-ordering, phantom-cancel, replay filtering, legacy response parity, runtime/host compatibility, and web frame handling.
- Conversation/send, mailbox, Channel, runtime-host split, MCP names, and the `AgentRun` runtime remain untouched except for unaffected typecheck/test fallout.
- Tracker marks this build-slice artifact `planned`.

## 16. Open Questions

| Question | Status |
|---|---|
| Should pending asks get their own canonical `pending-ask.changed` / mailbox-interaction fact, or stay surfaced via `agent.run.changed (reason:'paused')`? | Resolved for v1: surface via `agent.run.changed`; ship `PendingAskDto` for request surfaces; a dedicated interaction fact is deferred to slice 007. |
| Should the answer flow flip then resume, or resume-validate then flip? | Resolved: validate resumability FIRST, then flip+persist+emit atomically, then drive resume; finalize through the gateway on post-flip resume failure (closes handoff High issue #1). |
| Should `/cancel` become phantom-safe (mirroring `/kill`) and change its 404-on-no-handle response? | Open: default preserves the 404 for an unknown run id but finalizes a known-phantom run durably. If making it phantom-safe changes the observable response for a known-phantom run, STOP and confirm. |
| Should `pending_asks` mirror into a `pending_interactions` table now? | Deferred to slice 007 (mailbox/pending-interactions). This slice keeps `pending_asks` as the durable state table. |
| Should `agent-jsonl-event` move onto the durable outbox? | Deferred to slice 006 (conversation/send/replay). High-frequency transcript stream stays transient. |
| Should the pod-revision drift detection (`lookupPodScope` always returns null) be fixed here? | Deferred. It is a correctness gap in pause/continue but orthogonal to the durable-fact work; route the existing behavior through the gateway unchanged and note it for a later slice. |
| Should agent delivery move off Channel? | Deferred to slice 008 (Channel cutover). |
| Should the legacy `agent-run-changed` name be removed after canonical adoption? | Deferred to compatibility cleanup slice 011. |

## 17. Notes for the Implementation Agent

- Reuse the slice-002 `live_outbox` table, replay route, and web live client; do not add a second outbox. Mirror the slice-004 `WorkflowRunMutationGateway` shape closely (`packages/app-services/src/workflows/run-gateway.ts`) — `commitRunChange` / `announceRunChange` + `InsertLiveEventDraft` / `LiveOutboxEvent` / a `build*Draft` helper.
- The risk in this slice is broadcast-site consolidation, event-after-commit ordering, the host-mode stale-`rev` fix, and the pending-ask reordering — NOT TypeScript surface area. Start with contracts + adapters + the atomicity/ordering tests; do not change pause/answer behavior before the gateway + tests exist.
- The terminal write door already exists (`applyAgentRunTerminalEffects`, idempotent `markAgentRunTerminal`). Wrap its row flip + the durable fact in one tx; keep its async verification/Channel-envelope tail post-commit.
- The boot reconcile + liveness sweep already exist; only swap their `agent-run-changed` broadcast for the gateway publication. Do NOT change the legacy vs host-mode selection or the `paused`+open-ask+JSONL preservation rule.
- Keep `updateAgentRunPid` / `touchAgentRunActivity` as-is (no `rev` bump, not UI version transitions).
- Keep MCP tool names + payloads stable; migrate request parsing to contracts only.
- Do not use `archive/` as evidence or a source for tests.
