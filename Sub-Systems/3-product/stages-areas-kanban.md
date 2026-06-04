# Stages, Areas & Kanban

> **Role:** Store (stage/area data) · UI (Kanban surface) · Brain (trigger wiring)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `packages/domain/src/project.ts` · `packages/contracts/src/stages.ts` · `packages/contracts/src/areas.ts` · `packages/db/src/repos/areas.ts` · `apps/server/src/features/areas/routes.ts` · `apps/server/src/features/work-items/routes.ts:658` · `apps/server/src/services/stage-writer.ts` · `apps/server/src/services/project-runtime.ts:318` · `apps/server/src/services/dag-run-service.ts:334` · `packages/workflows/src/dag/triggers.ts` · `apps/web/src/components/KanbanBoard.tsx`

---

## What it is (plain English)

Your project board has **columns** — Inbox, In Progress, Done, whatever you name them. Those columns are called **stages**. Every card lives in exactly one stage at a time; dragging a card moves it to a new column.

Cards can also belong to a **grouping track** — something like a feature area or epic — called an **area**. Areas appear as a filter rail on the left side of the board. They're purely organizational: changing a card's area doesn't change which column it's in.

When a card enters a specific column, the board can automatically kick off a workflow. That trigger is wired directly to the column's id — no roles, no tags, no categories in between (locked decision). ☠ **Sentenced by FD-10:** stage-entry triggering is deleted in the rebuild — runs start only from the orchestrator's fire tool or manual "run now."

---

## What it's supposed to do (intent)

Own the column layout and grouping structure of a project, and fire automation when a card lands somewhere new. One law: the trigger is a direct stage-id match — there is no abstract layer between "the column" and "the workflow that fires when a card arrives there." *(The fire-automation half of this intent dies in the rebuild — FD-10. The no-abstract-layer law survives wherever a stage id is referenced, e.g. Move-card steps.)*

---

## The parts (every component, plain English)

### 1. Stages — the columns

A stage is a **named column with a position** in your board. Stages are stored as a JSON list directly on the project row (not a separate table). (`packages/db/src/schema.ts:49`)

Each stage has:

| Field | Plain meaning | Example |
|---|---|---|
| **id** | A stable short slug you write workflows against — not auto-generated | `"done"`, `"in-review"` |
| **name** | The display label — freely editable without breaking anything | `"Done"` |
| **order** | Sort position in the board | `3` |
| **isDone** | Cards moved here flip to `complete` status | (one per project max) |
| **isCancelled** | Cards moved here flip to `cancelled` status | (one per project max) |
| **isNew** | The intake column; also the fallback when a workflow omits an explicit stage | (one per project max) |
| **rev** | A counter stamped at every write — the UI uses it to throw away stale updates | `7` |

At most one stage per project may carry each flag. The server enforces this on every save. (`work-items/routes.ts:685–693`)

### 2. Editing stages

All changes to columns go through one endpoint: `PATCH /api/projects/:projectId/stages` (`work-items/routes.ts:658`).

The save path:
1. Validates the incoming list — no duplicate ids, flag limits respected.
2. If you removed a column that still has cards, it refuses with `409 STAGE_HAS_ITEMS` and tells you how many cards are in each affected column — unless you pass `force: true` and name a fallback column to receive the orphaned cards.
3. Writes the new list to the database.
4. Updates the in-memory project runtime so trigger matching is immediately current.
5. Broadcasts a `stage.list.changed` live event so every open browser tab updates without a reload.

### 3. Areas — the grouping tracks

An area is a **named track** that a card can optionally belong to. Unlike stages, areas live in their own database table (one area = one row). Each area has a `sortOrder`, a `version` for safe concurrent edits, and a `deletedAt` field — deleting an area hides it rather than erasing it (a "soft delete").

A card's area is just a nullable reference to an area id. When an area is soft-deleted, the system clears that reference on every member card in the same database transaction — so no card is left pointing at a ghost area. (`repos/areas.ts:161`)

Area changes broadcast a `area.changed` live event the same way stage changes do. Routes: `apps/server/src/features/areas/routes.ts`.

### 4. The Kanban board (UI)

`KanbanBoard.tsx` renders one column per stage, sorted by `order`. The cancelled column is hidden when the project's visibility setting says so. Cards within each column are sorted by a floating-point `position` value that midpoint-splices on drag — you can always insert a card between any two others without renumbering.

**Dragging a card:**
- Same column → updates the card's position only.
- Different column → moves the card to the new stage and position. (A move never starts a workflow — ☠ FD-10.)

**Staying live:** the board merges incoming `work-item.changed` events without re-fetching the whole list — identity-keyed on card id, version-checked so stale frames are discarded. (`KanbanBoard.tsx:140`)

**Area filter:** the left rail loads areas on mount and refetches whenever it sees an `area.changed` event. When an area is deleted, the board does an extra full card-list refetch because the bulk-null reassignment produces no per-card change events (see Known issues). (`KanbanBoard.tsx:165–169`)

### 5. Moving a card (one door, no firing)

Every card move — whether you drag it on the board or the orchestrator calls `pc_move_work_item` — runs through `ProjectRuntime.moveWorkItemV2` (`project-runtime.ts`):

1. Confirms the target stage exists in this project.
2. Commits the move to the database (version-checked).
3. Broadcasts a `work-item.changed` live event.

> ☠ **FD-10 EXECUTED (M6 slice A, 2026-06-04):** the stage-entry trigger mechanism is **deleted**.
> A card entering a stage never starts a workflow; runs start only from the orchestrator's fire tool
> or manual "Run now" (either can target a card via the fire's `workItemId`). `dag/triggers.ts`,
> the firing half of `moveAndFireV2` (renamed `moveWorkItemV2`), the trigger types, the schedule/
> event vapor kinds, the run-row trigger columns (migration 0043), and the trigger UI are all gone;
> a boot sweep stripped `triggers:` from stored definitions. The no-abstract-layer law (stage id,
> nothing in between) carries forward to every remaining stage-id reference.

### 6. Card-move as a workflow effect (not a step)

When a workflow step finishes and has a `move` field set, the engine moves the card directly through the gateway. Card-move is a **property on a step's transition**, not a separate node kind. (`dag-run-service.ts`, `workflow-v2.ts`)

> ☠ **FD-9 (locked 2026-06-03, reverses the above):** in the rebuild, **Move card is a visible step
> of its own** in the graph — the move-as-property mechanism dies, including "on reject, move back."
> What the graph shows = what happens.

---

## How it connects

- **Depends on:** `@pc/db` (`areas`, `projects` tables; stage/area CRUD; `moveWorkItemStage`) · `live_outbox` + live-relay (durable fanout for `stage.list.changed` and `area.changed`) · `ProjectRuntime` (holds the in-memory stage list used for move validation).
- **Used by:** `dag-run-service.ts` (move card as a transition effect) · `KanbanBoard.tsx` + area filter rail (UI) · `pc_move_work_item` MCP tool (the orchestrator's move door).
- **Events crossed:** `StageDto` / `StageListChangedLivePayload` (`@pc/contracts/stages.ts`) · `AreaDto` / `AreaChangedLivePayload` (`@pc/contracts/areas.ts`).

---

## Target shape (per north star + Foundation Decisions)

The consolidation ledger (`consolidation-ledger-2026-06-02.md`) has no verdict row for this subsystem — it is not a consolidation target and is not in the five-role conflict zone.

Per the north-star design (`unified-process-supervision-2026-06-02.md`): stage and area data are Store — DB-backed, announced through the outbox, projected via the live-relay. The `announceStageList` / `announceWorkItemRow` outbox pattern is already the target write-door.

**What changes from today (Foundation Decisions, locked 2026-06-03):**
- ☠ **Stage-entry triggers are deleted (FD-10).** ✅ EXECUTED M6 slice A (2026-06-04) — see §5.
- ☠ **Card-move-as-effect is deleted (FD-9).** Moving a card becomes a visible **Move card step** in the workflow graph; the `move` property on step transitions dies. (M6 slice B.)
- **Areas get promoted (FD-19).** Page renamed "Areas"; cards (title · summary · open-vs-complete counts) → click → edit modal; every area carries a description; the orchestrator considers and assigns an area when creating work items, and can maintain area descriptions itself.

---

## Known issues / scar tissue

- **Area delete creates a silent bulk move.** Soft-deleting an area nulls out every member card's area reference in one transaction — but no per-card `work-item.changed` event is emitted. The board works around this by detecting the deleted-area frame and doing a full card-list refetch. (`KanbanBoard.tsx:161–169`, `area-live-events.ts`) If that refetch window is missed (race), cards show as "Uncaptured" only after the next navigation.
- **Stage ids are slugs, not auto-generated ids.** If a stage id (the short slug field, not the display name) is changed after a workflow has been published, that workflow's trigger silently stops matching. The save-time validator checks that referenced stage ids exist at publish time, but doesn't track renames after the fact.
- ~~**`workflow_run_events` bypasses the live-relay.**~~ ✅ fixed in M3a (2026-06-04): every diary line through the run gateway + a `workflow.run.event` live fact; the run panel renders the timeline.
- **Stage list staleness window.** The in-memory stage list in `ProjectRuntime` is refreshed via `deps.refreshProject` after a `PATCH /stages`. A concurrent card move in the gap between the DB write and the refresh would trigger-match against a stale stage list — it would fail open (treated as a forward move).

---

## Decisions & open questions

**For Emerson (product calls):**
1. **Renaming a stage id should probably be blocked or auto-migrated.** FD-10 removes triggers, but Move-card steps (FD-9) still name stage ids — so a slug rename can still silently break a published workflow's move target. Worth deciding in the rebuild: block the rename, or auto-update affected workflows?

**Resolved 2026-06-03 → Foundation Decisions:**
- ~~`also_fire_on_regression`~~ — moot; dies with the whole trigger mechanism (FD-10).
- ~~Areas page design / orchestrator-and-areas~~ — locked as FD-19.

**Technical:**
- Should `area.changed` (delete) emit per-card `work-item.changed` rows instead of relying on the board's full-refetch workaround? The refetch is cheap today but fragile.
- ~~`workflow_run_events`: route `appendEvent` through the gateway/`live_outbox`~~ ✅ done (M3a 2026-06-04).
- `refreshProject` race: moot under FD-10 for trigger matching (no triggers); the stage list is still used for move validation, where staleness only risks rejecting a valid move — fail-safe.
