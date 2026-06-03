# Work Items

> **Role:** Store (durable state) + cross-cutting (agents, workflows, and UI all act on it)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> - `packages/domain/src/work-item.ts` — canonical domain type + history entry shapes
> - `packages/domain/src/work-item-policy.ts` — "does this output need a WI home?" policy
> - `packages/contracts/src/work-items.ts` — wire DTO, live-event shapes, request parsers
> - `packages/db/src/repos/work-items.ts` — all SQLite reads/writes
> - `packages/app-services/src/work-items/gateway.ts` — mutation gateway (transaction + outbox)
> - `packages/app-services/src/work-items/adapters.ts` — domain↔DTO mappers
> - `apps/server/src/services/work-item.ts` — `WorkItemService` (create/patch/move/delete)
> - `apps/server/src/services/work-item-writer.ts` — `announceWorkItemRow` write-door
> - `apps/server/src/services/agent-work-item.ts` — `createAgentWorkItem` (Section 26.3)
> - `apps/server/src/features/work-items/routes.ts` — HTTP routes
> - `apps/web/src/features/work-items/` — web client, live-event helpers, types

---

## What it is (plain English)

A work item is the basic unit of work — a task, bug, feature, or spike that sits in one stage
(column) of a project's kanban board. Cards on the board ARE work items. Each one has a title, a
body/brief, optional child work items, custom field values, a status, and an append-only activity
log. Agents are dispatched against work items; workflows use them as their root record.

---

## What it's supposed to do (intent)

Hold durable intent. Every task the system needs to do — whether a user typed it or an agent
minted it — has exactly one row in `work_items`. The DB row is the truth: status, position, body,
and history are what they say they are. Runtime processes and UI views are projections.

---

## How it works today (as-built)

### Schema (SQLite `work_items` table)

The `WorkItem` domain type (`packages/domain/src/work-item.ts`) maps 1:1 to the DB row:

- **Identity:** `id` (ULID), `projectId`, `parentId | null` (child WI), `callsign` (e.g. `pc-2`, `pc-2.1` — write-once, project-scoped)
- **Position:** `stageId` (current kanban column), `position` (sort key within stage + parent), `areaId | null` (Slice 010 area bucket)
- **Content:** `title`, `body` (the brief OR the agent's task — dual-purpose, see Known Issues), `type` (`task | bug | feature | spike`), `fields` (JSON blob for custom field schemas)
- **Status:** `status` (one of 8 values), `statusReason | null`, `version` (optimistic-concurrency counter bumped on every write)
- **Workflow anchor:** `isWorkflowRoot` — true when this row is a v2 workflow run's root; DAG state lives in `workflow_runs_v2` keyed by this id (`packages/domain/src/work-item.ts:54`)
- **History:** `history` — append-only JSON array of `WorkItemHistoryEntry` objects, rendered in the UI's Activity tab. Entry kinds: `move`, `update`, `agent-invoke`, `agent-ask-*`, `agent-approval-request`, `agent-answer`, `agent-completed`, `agent-failed`
- **Soft-delete:** `deletedAt | null`; `status='archived'` is the user-facing concept; live queries filter `deletedAt IS NULL`

### Write path (the one door)

All mutations follow one pattern: **validate → write DB row → insert `live_outbox` row in the same transaction → return**.

1. **`WorkItemService`** (`apps/server/src/services/work-item.ts`) — the server-side facade. Owns create, patch, move, softDelete, restore, list, get. Validates stage existence, validates field schemas (via `@pc/domain validateFields`), and does optimistic-concurrency checks (`version` must match `expectedVersion`). Calls repo helpers then calls `announceWorkItemRow`.
2. **`announceWorkItemRow`** (`apps/server/src/services/work-item-writer.ts`) — inserts a `work-item.changed` row into `live_outbox` in its own transaction, immediately after the product write. The live-relay picks it up and fans it to WebSocket subscribers. "Forgetting to announce" is structurally prevented — all mutation paths go through `WorkItemService` which always calls it.
3. **`WorkItemMutationGateway`** (`packages/app-services/src/work-items/gateway.ts`) — the lower-level gateway used by secondary paths (verification, auto-advance, DAG). Runs the product mutation AND the `insertLiveEvent` in the **same transaction**, so a rollback emits nothing. Has three entry points:
   - `commitWorkItemChange` — mutation + outbox in one atomic transaction
   - `announceWorkItemChange` — outbox only (mutation already happened outside)
   - `announceWorkItemById` — re-reads the row by id, then announces it

### Stage moves

`WorkItemService.move` (`apps/server/src/services/work-item.ts:311`) is version-checked. When moving to a different stage it calls `moveWorkItemStage` (repo), which appends a `'move'` history entry with `from`/`to` and computes a target status from the destination stage's flags (`isDone → 'complete'`, `isCancelled → 'cancelled'`, else `'pending'`). Workflow triggers fire separately — `WorkItemService.move` does NOT fire workflows; callers that want both compose `service.move + workflow-runtime.moveWorkItemStage` on top (`apps/server/src/services/work-item.ts:8-10`).

### Agent work items (`createAgentWorkItem`)

`apps/server/src/services/agent-work-item.ts` handles the `pc_create_agent_work_item` MCP tool path (Section 26.3):

1. Resolves `expected_output` (caller-supplied → pod DB row → stock map; hard-fails if none found)
2. Derives acceptance criteria from `expected_output` via `deriveAcceptanceCriteriaV2`
3. Calls `WorkItemService.create` with `title` + `task` as the body
4. Optionally mints a first-class `agent_contracts` row linked to the WI (the verification spine)

### Work-item policy (`expectedOutputRequiresWorkItem`)

`packages/domain/src/work-item-policy.ts` answers "does this agent output type need a work-item home?" Used by the dispatch guard to reject a dispatch that declares a WI-requiring output but has no WI linked. Current answers: `prose` (unless `store:'contract'`) → yes; `repo` → yes; `answer`, `payload`, `action`, `external`, `binary` → no (with some open forks).

### Callsign minting

`createWorkItem` in the repo (`packages/db/src/repos/work-items.ts:153`) mints callsigns inside the same SQLite transaction as the insert so concurrent creates can't race on the sequence counter. Top-level items get `{slug}-{seq}` (e.g. `pc-2`); children get `{parent}.{suffix}` (e.g. `pc-2.1`). Write-once — stable across re-parenting.

### HTTP routes (server)

`apps/server/src/features/work-items/routes.ts` exposes:
- `GET /api/projects/:id/work-items` — list, with area/stage/parent/cursor/archived filters
- `POST /api/projects/:id/work-items/move` — move via stage id or flag (`done`/`cancelled`/`new`); calls `moveAndFireV2` (workflow trigger path)
- `POST /api/projects/:id/work-items/update` — field/body/title/area update for agents (calls `dbUpdateWorkItemFields` directly, bypassing `WorkItemService`)
- CRUD routes for create, patch, soft-delete, restore, approval/rejection

### UI consumption (web)

`apps/web/src/features/work-items/` holds the browser-side client (`client.ts`), type definitions, and live-event helpers. `work-item-live-events.ts` provides `workItemHistoryRows` and `latestFieldSchemas` — pure functions over the live-event store used by the detail modal's Activity tab and field-schema panel.

---

## Integrations (how it connects)

- **Depends on:** `@pc/db` (SQLite `work_items` table via Drizzle), `@pc/domain` (types, `validateFields`, `postMoveStatusForStage`), `@pc/contracts` (DTOs, live-event payloads), `live_outbox` table (via `insertLiveEvent`)
- **Used by:**
  - **Orchestrator** — creates/moves work items via MCP tools (`pc_create_work_item`, `pc_move_work_item`, `pc_update_work_item`)
  - **Agent dispatch** — `createAgentWorkItem` mints a WI + contract; the run links back to it via the contract
  - **Workflow engine** — creates a WI as the workflow root (`isWorkflowRoot: true`); DAG nodes create child WIs; `dag-run-service.ts:173` reads `wi.body` live to resolve `$root.output` workflow variable refs
  - **Verification/review** — `applyRunOutcome` + `updateWorkItemStatus` flip status + history at run end; `approveAgentWorkItem` / `rejectAgentWorkItem` advance or reject items at a human-gate step
  - **UI** — kanban board renders one card per work item; detail modal shows body, children, documents, activity; `WorkItemDetailModal` consumes `work-item.changed` live events
- **Contracts / events crossed:**
  - `work-item.changed` live event (`packages/contracts/src/work-items.ts:82`) — project-scoped, entity `work-item`, carries `WorkItemChangedLivePayload` (reason + DTO snapshot + optional attachments)
  - Legacy `work-item-changed` WebSocket envelope — still emitted alongside the canonical event for backward-compat
  - `WorkItemMutationReason` — typed reason on every change (`created`, `patched`, `moved`, `soft-deleted`, `restored`, `verified`, `approved`, `rejected`, `auto-advanced`)
  - `agent_contracts` table — a linked contract is created at the same time as an agent WI and is the verification authority

---

## Target shape (per north star)

Per the consolidation ledger (`consolidation-ledger-2026-06-02.md §2 "Sources of truth"`):

- **`work_items.history` → KEEP as truth** (HIGH confidence). The denormalized `position` and `status` are projections; `history` is the append-only log.
- **`work_items.body` → KEEP, do NOT delete** (HIGH confidence, re-scoped 2026-06-03). `dag-run-service.ts:173` reads it live to resolve `$root.output` workflow variable refs. It serves dual purpose: the original task brief AND the agent's deliverable landing zone. A round-trip guard test should be added (`ledger §6 row 11`).
- **`workflow_run_events` → CREATE (aspirational)** — the target "events = truth" path is unbuilt; today `dag_state` JSON is the workflow store. Routing `appendEvent` through the gateway/live_outbox is Slice-3 work (`ledger §6 row 12`).

In the five-role target, the work-item store is owned by **Brain** (control plane). Every WI mutation goes through the gateway, posts to `live_outbox`, and the live-relay (owned by Brain) fans it to subscribers. The `history` array grows into a proper append-only event log (Slice-3). No behavioral change to the mutation interface is needed — the gateway pattern already matches the target.

---

## Known issues / scar tissue

- **`wi.body` dual purpose** — the body column serves as both the original task brief (written at create time by the orchestrator) and the agent's prose deliverable (written by `updateWorkItemFields` when the agent calls `pc_update_work_item`). `dag-run-service.ts:173` reads `wi.body` to resolve `$root.output` refs. Pre-F#3, agents wrote their output into `fields.body` instead of the `body` column, silently freezing the column and breaking workflow refs and `body_contains` AC predicates. Fixed in `updateWorkItemFields` (`packages/db/src/repos/work-items.ts:306-348`) which now promotes string `body`/`title` keys from the fields map onto their real columns.
- **`/api/projects/:id/work-items/update` bypasses `WorkItemService`** — the agent-update route calls `dbUpdateWorkItemFields` directly (`apps/server/src/features/work-items/routes.ts`) then calls `announceWorkItemRow` separately. This is a second write path that skips `WorkItemService`'s field validation. It works for agent writes (agents don't use custom field schemas), but is a structural inconsistency.
- **`workflow_run_events` dead writes** — `appendEvent` writes to this table but the gateway/live_outbox pipeline is bypassed and the UI discards `res.events`. The writes are observability stubs that go nowhere today. Live events as truth (Slice-3) is unbuilt (`ledger §0 row 3`).
- **Callsign minting in the same TX as insert** — correct, but the per-parent suffix scan (`packages/db/src/repos/work-items.ts:196-213`) does a full sibling read to find max suffix. At scale this is a linear scan. Acceptable for current volumes; not indexed.

---

## Open questions

- Should `WorkItemService` absorb the agent-update route's direct `dbUpdateWorkItemFields` call, so there's truly one write door? (The current bypass skips field-schema validation, which is intentional for agent writes — but it's a second path.)
- When Slice-3 lands (workflow events = truth), does `history` on the WI row become redundant for workflow-related entries, or do both coexist?
- `expectedOutputRequiresWorkItem` has three open forks (`repo`, `external`, `binary`) leaning toward current defaults. When do these forks close?
- The `body_contains` AC predicate and `$root.output` workflow ref both depend on `wi.body` being the agent's deliverable. Should this be formalized as a contract field rather than relying on the body column's dual role?
