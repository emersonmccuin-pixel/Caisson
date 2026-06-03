# Stages, Areas & Kanban

> **Role:** Store (stage/area data) · UI (Kanban surface) · Brain (trigger wiring)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> - `packages/domain/src/project.ts` — `Stage`, `Project`, `postMoveStatusForStage`
> - `packages/contracts/src/stages.ts` — `StageDto`, `StageListChangedLivePayload`
> - `packages/contracts/src/areas.ts` — `AreaDto`, `AreaChangedLivePayload`
> - `packages/db/src/repos/areas.ts` — area CRUD + `setWorkItemArea`
> - `apps/server/src/features/areas/routes.ts` — area HTTP routes
> - `apps/server/src/features/work-items/routes.ts:658` — `PATCH /api/projects/:id/stages`
> - `apps/server/src/services/stage-writer.ts` — `announceStageList`
> - `apps/server/src/services/stage-flags-backfill.ts` — one-time flag migration
> - `apps/server/src/services/project-runtime.ts:318` — `moveAndFireV2`
> - `apps/server/src/services/dag-run-service.ts:334` — card-move transition effect
> - `packages/workflows/src/dag/triggers.ts` — `selectStageEntryWorkflows`, `firesOnStageEntry`
> - `packages/domain/src/workflow-v2.ts:53` — `StageOnEntryTrigger`
> - `apps/web/src/components/KanbanBoard.tsx` — board UI
> - `apps/web/src/hooks/use-project-areas.ts` — live area list
> - `apps/web/src/features/areas/area-live-events.ts` — delete-frame detector

---

## What it is (plain English)

Each project has a list of named columns called **stages** (e.g. Inbox, In Progress, Done). Work items (cards) each live in exactly one stage at a time. The Kanban board shows one column per stage; dragging a card between columns moves it. Separately, each project has **areas** — named groupings (like feature tracks or epics) a card can optionally belong to. Areas filter the board via a left-side rail but don't change which column a card is in.

---

## What it's supposed to do (intent)

Provide the structural skeleton for a project — the ordered column set (stages) and the cross-cutting grouping layer (areas) — and be the hook point for workflow automation. When a card lands in a specific stage, any workflow with a matching `stage-on-entry` trigger fires automatically. There is no role/tag/category indirection: the trigger references the stage id directly.

---

## How it works today (as-built)

### Stage storage

Stages are **not a table**. They are a JSON array stored inline on the `projects` table (`packages/db/src/schema.ts:49`):

```
projects.stages: text (JSON) → Stage[]
projects.stagesRev: integer   — monotonic write counter
```

Each `Stage` (`packages/domain/src/project.ts:6`) has:
- `id` — slug string (e.g. `"done"`), **not a ULID**. Workflow YAMLs reference this by slug for human readability. The id is stable; the name is freely editable.
- `name`, `order` (sort position), optional `isDone`, `isCancelled`, `isNew` flags.
- `rev` — stamped from `stagesRev` at write time; the UI uses it to discard stale WS frames.

**Flags:** at most one stage per project may carry each flag. `isDone` auto-flips moved cards to `complete`; `isCancelled` to `cancelled`; `isNew` marks the intake column for new cards and for workflows that omit an explicit stage. Validated at write (`work-items/routes.ts:685–693`). A one-time backfill (`stage-flags-backfill.ts`) stamps existing projects that had no flags.

### Editing stages

`PATCH /api/projects/:projectId/stages` (`work-items/routes.ts:658`):
1. Validates the incoming array (no duplicate ids, at most one of each flag).
2. If any existing stage is removed and it still holds cards, returns `409 STAGE_HAS_ITEMS` with per-stage counts — unless `force: true` is passed, which requires a `fallbackStageId` and reassigns all orphan cards first.
3. Calls `updateProjectStages` (DB), gets back rev-stamped stages.
4. Calls `deps.refreshProject` to update the in-memory project runtime.
5. Calls `announceStageList` (`stage-writer.ts`) — writes a `stage.list.changed` row to `live_outbox`; the live-relay fans it to WS subscribers. No inline broadcast.

### Area storage

Areas **are** a real table (`areas`), per project, with `sortOrder`, soft-delete (`deletedAt`), and optimistic-concurrency `version`. A work item has a nullable `areaId` FK (stored as a plain string, no FK constraint). When an area is soft-deleted, its member items' `areaId` is set to null ("Uncaptured") atomically in the same transaction (`repos/areas.ts:161`).

Area CRUD goes through `AreaService` → `repos/areas.ts`; mutations announce via `area.changed` live-event in `live_outbox` (no inline broadcast). Routes: `apps/server/src/features/areas/routes.ts`.

### Kanban board (UI)

`KanbanBoard.tsx` renders one `Column` per stage (sorted by `order`, cancelled column hidden if the resolved visibility flag says so). Cards are sorted within each column by `position` (a float that midpoint-splices on drag).

- **Live updates:** uses `useLiveWorkItems` (identity-keyed live store) to merge `work-item.changed` frames without re-fetching — version-keyed so it survives chat-timeline rebuilds (`KanbanBoard.tsx:140`).
- **Area filter:** `useProjectAreas` fetches on mount; refetches on any `area.changed` frame via `useLiveEntitySignature` (`use-project-areas.ts:47`). A deleted-area frame also triggers a full work-item refetch because the reassignment produces no per-item `work-item.changed` facts (`KanbanBoard.tsx:165–169`).
- **Drag-drop:** `@dnd-kit`. Same-column reorder → `PATCH` with new `position`; cross-column drag → `POST /move` with `stageId + position + version`. `computePosition` midpoint-splices the float ladder.

### Card move → workflow trigger

A card move (drag or MCP `pc_move_work_item`) calls `ProjectRuntime.moveAndFireV2` (`project-runtime.ts:330`):

1. Resolves the destination stage; validates it exists in the project.
2. Commits the move (version-checked or legacy path via `moveWorkItemStage`).
3. Calls `announceWorkItemRow` → `work-item.changed` outbox row.
4. If `fromStageId !== toStageId`, calls `selectStageEntryWorkflows` (pure, `packages/workflows/src/dag/triggers.ts:52`):
   - Filters v2 workflows whose `triggers[]` contains `{ kind: 'stage-on-entry', stage: toStageId }`.
   - Forward-move detection uses stage `order` values; unknown ids fail open (treated as forward).
   - Multiple matches fire all (`fireV2Workflow` called for each).
5. `stage-on-entry` is a direct stage-id match — **no role, tag, or category layer exists between the trigger and the stage**.

**Card-move as a workflow effect (not a node kind):** `dag-run-service.ts:334` defines `moveCard` — when a workflow step completes and has a `move` field on the node, it calls `moveWorkItemStage` directly (bypassing `moveAndFireV2`, so it does **not** re-fire stage-entry workflows — loop-safe). This was a locked decision: card-move is a transition effect on a node, not a separate node kind (`workflow-v2.ts:156`).

---

## Integrations (how it connects)

- **Depends on:**
  - `@pc/db` — `areas`, `projects` tables; `updateProjectStages`, `moveWorkItemStage`, `reassignStage`, `countWorkItemsInStage`.
  - `live_outbox` + live-relay — durable fanout for `stage.list.changed` and `area.changed` frames.
  - `ProjectRuntime` — holds the in-memory project (stages array used by trigger matching + move validation).
- **Used by:**
  - `dag-run-service.ts` — move card as a transition effect; reads stage list to validate target.
  - `project-runtime.ts` — trigger matching on every card move.
  - `packages/workflows/src/dag/triggers.ts` — pure matcher, no I/O.
  - `KanbanBoard.tsx` + `WorkItemsToolbar` + `AreaFilterRail` — UI.
  - `pc_move_work_item` MCP tool — the orchestrator's move door (lands in `moveAndFireV2`).
- **Contracts / events crossed:**
  - `StageDto` / `StageListChangedLivePayload` (`@pc/contracts/stages.ts`) — the WS event shape.
  - `AreaDto` / `AreaChangedLivePayload` (`@pc/contracts/areas.ts`) — area WS event shape.
  - `WorkflowV2.StageOnEntryTrigger` (`packages/domain/src/workflow-v2.ts:63`) — the trigger schema a workflow declares.

---

## Target shape (per north star)

The ledger (`consolidation-ledger-2026-06-02.md`) has no explicit verdict row for this subsystem — it is not a consolidation target. It is not in the five-role conflict zone.

Per the north-star design (`unified-process-supervision-2026-06-02.md`):
- Stage and area **data** are Store — they are DB-backed truth, announced through the outbox, and projected to the UI via the live-relay. This matches the target already.
- The **trigger matching** (stage-entry → workflow fire) is Brain logic in `ProjectRuntime`. No consolidation needed unless `ProjectRuntime` itself migrates (Steps 4–5 cover the orchestrator/modal sessions, not stage wiring).
- The **card-move-as-effect** pattern (`dag-run-service.ts`) is already the correct locked design.

**What changes from today:** nothing structural in this subsystem. The `announceStageList` / `announceWorkItemRow` outbox pattern is already the target write-door. The live-relay already drains those rows. No dual paths here.

---

## Known issues / scar tissue

- **Area delete creates a silent bulk move.** When an area is soft-deleted, member work items' `areaId` is set to null in the same transaction — but no per-item `work-item.changed` outbox row is written. The Kanban board detects this by listening for a `deleted` area frame and doing a full work-item refetch (`KanbanBoard.tsx:161–169`; `area-live-events.ts`). If the refetch window is missed (race), cards will appear under "Uncaptured" only after the next navigation.
- **Stage ids are slugs, not ULIDs.** If a user renames a stage id (the id field in the editor, not the display name), any workflow YAML referencing that id silently stops triggering. The save-time validator checks that trigger stages exist in the project at publish time, but it does not track renames.
- **`workflow_run_events` bypasses the live-relay.** `dag-run-service.ts` calls `appendEvent` which writes to the `workflow_run_events` table but bypasses `live_outbox` and the gateway. The UI discards `res.events` (`WorkflowsList.tsx:871`). These are dead observability writes today. This is a slice-3 gap (ledger §2, sources of truth row).
- **Card-move transition effect does not announce status change.** `moveCard` in `dag-run-service.ts` calls `moveWorkItemStage` and then `announceWorkItemRow`, so the board does update — but the status side-effect (`postMoveStatusForStage` — done/cancelled flag flips `status`) runs inside `moveWorkItemStage` and is included in the announced row, so this is correct.
- **Stage list lives in the in-memory project runtime** (`this.project.stages` in `ProjectRuntime`). After `PATCH /stages`, `deps.refreshProject` is called to update it. If `refreshProject` ever races with a concurrent move, the trigger matching uses a stale stage list (would fail open per `isForwardStageMove`).

---

## Open questions

- Should renaming a stage id be blocked or auto-migrated in saved workflow YAMLs? Currently both the editor and the API allow it silently.
- Should the area-delete bulk-null emit per-item `work-item.changed` rows instead of relying on the board's full-refetch workaround? (The refetch is cheap for now but fragile.)
- Forward-only trigger default makes sense for most cases, but `also_fire_on_regression` is in the schema and not exposed in the UI — when does it get a UI surface?
- `workflow_run_events` table: slice-3 work (route `appendEvent` through the gateway/live_outbox so events become truth). No current owner.
