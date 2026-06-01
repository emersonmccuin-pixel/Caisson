# Slice 010 — Areas (focus buckets for work items)

> Status: built 2026-05-31 (commit 3753c876) — gates green, awaiting human browser-review. Live "Update with agent" summary button deferred (optional fast-follow per Key Decisions). Web area filter is client-side (backend `?areaId=` exists, unused). Delete-area emits only `area.changed (deleted)` (no per-item facts) → UI refetches the work-item list on that reason.

## Roadmap Alignment
- New feature slice (not in the original 001–011 roadmap). Inserted as 010; the prior 010 (MCP typed client) shifts to 011 and cleanup to 012.
- Depends on slice 003 (work-item contracts + mutation gateway, verified) and slice 002 (durable `live_outbox`, canonical `LiveEvent` envelope, `/api/live-events` replay).
- Depends on nothing in 009/011/012 — can be planned/built without waiting on the 009 review.

## Concept
An **Area** is a first-class, project-scoped bucket that a work item can belong to (or not). It is the human's "big stuff" altitude: open a project and see a handful of Areas, not a task firehose. Areas are deliberately flexible — an outcome ("AI Chat in Dashboard"), a category ("Bugs"), or a junk drawer ("Random thoughts", "Recipes"). No semantics are forced on them.

- UI tab name: **Focus** (replaces the current "Dashboard" tab under Work Items).
- Object name in UI: **Area**.
- A work item belongs to **exactly one** Area, or to **none ("Uncaptured")**.

## Scope (in)
- `Area` shared contract in `@pc/contracts` + `areaId: string | null` added to the work-item DTO.
- `area.changed` durable live event on the slice-002 outbox.
- Additive DB migration: `areas` table + nullable `work_items.area_id` FK + index.
- `AreaService` in `@pc/app-services` (list / create / rename / reorder / delete / set-summary); work-item mutation gateway extended to set/clear `areaId`.
- Route adapters: `/api/projects/:id/areas` CRUD; work-item update accepts `areaId`; list endpoints accept `?areaId=` (including `uncaptured`).
- Web: **Focus tab** (Area cards: create/rename/reorder/delete + plain summary field); **left-panel filter rail** in Kanban + Table (`All / each Area / Uncaptured` + live counts); inspector dropdown `Area: none ▾`.
- Thin MCP surface: `pc_list_areas` + allow create/update to set `areaId`.
- Focused tests.

## Scope (out)
- Milestones / progress bars (deferred — revisit later).
- "Needs you" / review-queue grouping by Area (parked; the FK makes it free when built).
- Auto-routing rules (e.g. "all bugs → Bugs"); a "default Area for new items" setting is a fast-follow, not this slice.
- Full typed MCP migration (rides the new slice 011).
- Many-to-many membership (one Area per item is a hard V1 rule).

## Current-State Evidence
- Work Items has a flat list plus a "Dashboard" tab; no altitude above the task level.
- Parent/child exists but reads as bookkeeping, not a place you navigate to.
- Work-item writes already funnel through the slice-003 mutation gateway, so adding an `areaId` mutation is a single seam, not scattered edits.

## Target Shape (cartridge)
```
contract (@pc/contracts: Area + parsers; work-item DTO gains areaId)
  -> db (areas table + work_items.area_id FK + areas repo)
  -> app-service (AreaService + WorkItemService.setArea via the gateway)
  -> route adapters (apps/server) + thin MCP adapter (packages/mcp)
  -> durable events (area.changed; work-item.changed already covers reassignment) on live_outbox
  -> web (Focus tab + left-panel filter rail + inspector Area dropdown)
  -> tests
```

## Files
- `packages/contracts/src/areas.ts` (new) + `area.changed` payload guard
- `packages/contracts/src/work-items.ts` (extend DTO with `areaId`)
- `packages/db/drizzle/00XX_areas.sql` (new migration) + `packages/db/src/schema.ts` (areas table, `work_items.area_id`)
- `packages/db/src/repos/areas.ts` (new); `packages/db/src/repos/work-items.ts` (area filter + assignment)
- `packages/app-services/src/areas/service.ts` (new); work-item service `setArea`
- `apps/server/src/features/areas/routes.ts` (new); work-item routes accept `areaId`; list routes accept `?areaId=`
- `packages/mcp/src/server.ts` (`pc_list_areas`; create/update accept `areaId`)
- `apps/web` — Focus tab (replaces Dashboard tab), left-panel filter rail in Kanban + Table, inspector Area dropdown, `api/areas.ts`
- tests across each package

## Key Decisions (locked)
- **Delete an Area → its items fall back to Uncaptured** (`area_id` set null). Never deletes work items.
- **Summary = plain editable field** this slice. The **"Update with agent"** button is a thin add: it dispatches a normal agent run (slice-005 plumbing) scoped to the Area with a write-back tool. Ship the field as core; if the button gets fiddly it drops to a fast-follow without blocking the slice. No SDK / `-p` mode.
- **Per-project** Areas (FK to project), manual `sortOrder`, single-select left-panel filter.

## Migration / Rollback
- Additive migration only: new `areas` table + nullable `work_items.area_id`. No backfill required (everything starts Uncaptured).
- Rollback: drop the Focus tab + filter rail (web), stop emitting `area.changed`; the nullable column + table are inert if unused.

## Tests
- Contract parser round-trips (Area, work-item DTO with `areaId`).
- DB: migration applies; areas repo CRUD + `sortOrder`; work-item area filter; `uncaptured` filter; **delete-reassigns-to-null**.
- AreaService: create/rename/reorder/delete/set-summary emit `area.changed` on the outbox atomically.
- Work-item gateway: set/clear `areaId` emits `work-item.changed`.
- Route: `?areaId=` filter (including `uncaptured`) returns correct sets.
- Web: Focus tab renders Areas + counts; left-panel filter narrows Kanban + Table; inspector dropdown assigns/clears.

## Stop Conditions
- Do not add milestones, progress bars, or auto-routing rules.
- Do not build the "needs you" review queue.
- Do not allow more than one Area per work item.
- Do not remove the legacy "Dashboard" code beyond swapping the tab (deletions belong to slice 012 cleanup).
