# 003 Work Items, Stages, Fields, Events

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `refactor/auto-pathway` |
| Commit | baseline `e97b360e` (slice 002 verified at `5c2317b3`, tag `slice-002-verified`) |
| Artifact status | Planned build slice |
| Owning roadmap phase | Phase 4 work-item/stage/field/attachment contracts and mutation gateway |
| Slice subject | Work-item/stage/field/attachment shared contracts, an app-service mutation gateway, compatibility adapters, and durable `work-item.changed` / `stage.list.changed` live events |
| Implementation target | This repo. Do not create a parallel app. |
| Scope rule | This is a build plan only. Do not implement until the user explicitly asks to build. |

Decision:

- **Recommendation:** Extend the slice-001/002 cartridge to the work-item family. Add shared contracts for work items, stages, field schemas, and attachments; consolidate durable mutations behind one server-owned mutation gateway; add compatibility adapters between drifting domain/web/MCP shapes; and emit `work-item.changed` and `stage.list.changed` through the slice-002 `live_outbox` while keeping legacy websocket names as compatibility projections.
- **Reason:** The work-items handoff (`refactor plan/refactor plan docs/work-items-stages-fields-attachments.md`) shows multiple durable mutation paths (`agent-verification.ts`, `agent-verification-review.ts`, `auto-advance-done.ts`, `dag-run-service.ts`, and legacy branches in `features/work-items/routes.ts`) bypassing the existing `WorkItemService`/`WorkItemWriter`, and several DTO surfaces drifting across domain/web/MCP. Slices 001/002 proved the contract + app-service + durable outbox + legacy-fanout pattern on `project.changed`; this slice applies that exact pattern to the next-most-depended-on family without expanding into workflow/agent runtime internals.
- **Compatibility stance:** Keep every legacy HTTP response shape, MCP tool name, and websocket event name working. Canonical events are additive; legacy `work-item-changed` / `stages-changed` / `field-schemas-changed` / `attachment-changed` continue as compatibility projections of canonical facts.

## 2. Problem Statement

Verified facts (from the work-items handoff, code-evidence based):

- `apps/server/src/services/work-item.ts` validates stage/fields on create/patch/move/delete/restore and announces changes through `WorkItemWriter`, but it is **not** the only writer.
- `agent-verification.ts`, `agent-verification-review.ts`, `auto-advance-done.ts`, and the DAG `move-work-item` node mutate rows and broadcast `agent-run-changed` (or manual websocket events) **without** a guaranteed `work-item-changed` fact.
- Fields-only `/work-items/update` calls `dbUpdateWorkItemFields` directly, bypassing `WorkItemService.patch` field-schema validation.
- `pc_move_work_item` posts to the legacy `/work-items/move`, and `ProjectRuntime.moveAndFireV2` supports a no-expected-version move.
- Work-item DTOs are duplicated and drifting across `packages/domain`, `apps/web/src/features/work-items/types.ts`, and `packages/mcp/src/tools/work-items.ts`.
- No `live_outbox` rows exist for work-item/stage/field/attachment facts; slice 002 added `live_outbox` for `project.changed` only.
- Work-item list endpoint has incompatible shapes: no-filter returns `{ workItems }`; filtered returns `{ items, nextCursor }`.

Synthesis — this slice implements the next cartridge layer for the work-item family:

```text
contract (work-item/stage/field/attachment DTOs + adapters)
  -> app-service mutation gateway (one durable write door)
  -> route/MCP/web compatibility adapters
  -> live event fact (work-item.changed, stage.list.changed) on slice-002 outbox
  -> web client/hook + canonical/legacy fanout
  -> tests
```

## 3. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | Domain model owns work-item shape, status, history, agent-task/workflow-root flags, verification fields, `fields`, `version`, `callsign`. | `packages/domain/src/work-item.ts` |
| Verified fact | Agent contract fields (`ExpectedOutput`, `AcceptancePredicate`, `VerificationTier`, `VerificationStatus`) are domain types. | `packages/domain/src/work-item-contract.ts` |
| Verified fact | Field validation supports `text`/`number`/`boolean`/`enum`/`date`, coerces known fields, preserves unknown orphan fields. | `packages/domain/src/field-schema.ts` |
| Verified fact | Attachments store inline content with provenance (`runId`, `createdBySessionId`, `source`, `agentName`, `nodeId`). | `packages/domain/src/attachment.ts` |
| Verified fact | Stages are JSON on `projects.stages` with `projects.stagesRev`; work items reference `stage_id` with no DB FK; field schemas in `field_schemas`; attachments inline in `attachments.content`. | `packages/db/src/schema.ts` |
| Verified fact | Work-item repo provides create/list/get/callsign, optimistic `patchWorkItem`, direct `moveWorkItemStage`, field update, soft delete/restore, child listing, verification mutation helpers. | `packages/db/src/repos/work-items.ts` |
| Verified fact | `WorkItemService` validates on create/patch/move/delete/restore and announces via `WorkItemWriter`, which emits legacy `work-item-changed` snapshots. | `apps/server/src/services/work-item.ts`, `apps/server/src/services/work-item-writer.ts` |
| Verified fact | Multiple verification/auto-advance/DAG paths mutate rows without the shared work-item announcement path. | `agent-verification.ts`, `agent-verification-review.ts`, `auto-advance-done.ts`, `dag-run-service.ts` |
| Verified fact | HTTP routes expose list/create/update/move/patch/delete/restore, approve/reject, attachment CRUD, stage replacement, field-schema replacement; some legacy branches bypass the service. | `apps/server/src/features/work-items/routes.ts` |
| Verified fact | MCP tools use hand-written schemas and raw HTTP; `pc_create_work_item` description vs server `stageId` requirement drift. | `packages/mcp/src/tools/work-items.ts`, `packages/mcp/src/tools/project-config.ts` |
| Verified fact | Web client uses hand-maintained DTOs and legacy websocket names; web `WorkItem`/`Attachment` omit fields the domain carries. | `apps/web/src/features/work-items/*` |
| Verified fact | Slice 002 shipped canonical `LiveEvent`/`LiveEventFrame` contracts, `live_outbox` table/repo, `/api/live-events` replay, and dual canonical/legacy fanout for `project.changed` only. | `refactor plan/build-slices/002-project-live-outbox.md`, slice 002 implementation |
| Verified fact | No non-archive characterization tests protected work-item behavior before slice 001 restored a minimal harness. | work-items handoff `## Tests`; slice 001/002 restored harnesses for contracts/db/server/web |

## 4. Exact Scope

Implement only these behaviors when the user asks to build:

1. Add a work-item contract family to `@pc/contracts`: `WorkItemDto`, `StageDto`, `FieldSchemaDto`, `AttachmentDto`, `WorkItemMutationResult`, and request schemas (create, patch, move, soft-delete, restore, create-agent-contract, approve/reject, stage replace, field-schema replace, attachment create/delete), plus parser/guard helpers.
2. Add **compatibility adapters** that map existing domain/database rows to the new DTOs and back, without moving DB schema. Cover the drift cases the handoff records (web `WorkItem` missing verification/output fields, web `Attachment` missing provenance, list response `{ workItems }` vs `{ items, nextCursor }`).
3. Add or consolidate a server-owned **work-item mutation gateway** (extend `@pc/app-services` and/or the existing `WorkItemService`) that is the single durable write door for work-item create/patch/move/delete/restore, agent verification + approve/reject + auto-advance, workflow root/child creation and `move-work-item` moves, stage replacement, field-schema replacement, and attachment create/delete.
4. Route the bypassing paths (`agent-verification.ts`, `agent-verification-review.ts`, `auto-advance-done.ts`, the DAG `move-work-item` node, and legacy route branches incl. fields-only update) through the gateway so every durable mutation has one validation/version/history/event point.
5. Add canonical live-event families to `@pc/contracts` and emit them through the slice-002 `live_outbox` after commit: `work-item.changed` and `stage.list.changed`. Include `field-schema.list.changed` and `attachment.changed` payload contracts; emitting those two may be staged but the contracts ship in this slice.
6. Dual-fanout after committed outbox insert: canonical wrapped `{ type: 'live-event', event }` frames for new clients, plus the existing legacy websocket names (`work-item-changed`, `stages-changed`, `field-schemas-changed`, `attachment-changed`) as compatibility projections.
7. Preserve all current HTTP response shapes and MCP tool names. Move MCP/web request/response parsing onto the shared contracts via adapters only; do not rename tools or break existing imports.
8. Extend `/api/live-events` replay (added in slice 002) to allow `type=work-item.changed` and `type=stage.list.changed` filtering with the same cursor/scope semantics. Work-item events are project-scoped; stage-list events are project-scoped.
9. Add a web live-event hook/helper that consumes canonical work-item/stage frames, dedupes by `event.id`, keeps version-aware upserts, and refetches/upserts on replay/reconnect.
10. Run the listed automated verification.

Non-goals:

- Do not redesign workflow runtime internals or agent runtime internals beyond routing their durable work-item mutations through the gateway.
- Do not change `move-work-item` skip-stage-entry semantics.
- Do not move attachment storage off inline SQLite or add size/content/retention enforcement (that is a later attachment-policy slice). Define the `AttachmentDto` contract only.
- Do not implement stage-reference workflow guards or transactional field-schema migration validation beyond preserving current behavior; the handoff parks deeper stage/field guards in a later slice.
- Do not migrate the broader MCP typed-client/capability registry (slice 010).
- Do not change `/ws` connection semantics or replace `ProjectWebSocketHub`.
- Do not add destructive DB migrations. The work-item/stage/field/attachment tables already exist; reuse the slice-002 `live_outbox` table for new event families.
- Do not remove any legacy websocket event name (deferred to cleanup slice 011).
- Do not restart or kill dev servers while implementing or verifying.

## 5. Contract Plan

Files likely affected:

```text
packages/contracts/src/work-items.ts
packages/contracts/src/stages.ts
packages/contracts/src/field-schemas.ts
packages/contracts/src/attachments.ts
packages/contracts/src/live-events.ts        (extend type union; do not rewrite project members)
packages/contracts/src/index.ts
packages/contracts/test/work-items.test.ts
packages/contracts/test/live-events.test.ts  (extend)
```

Contract rules (unchanged from slice 001/002):

- Browser-safe, side-effect-free, zero runtime dependencies.
- No imports from apps, `@pc/db`, `@pc/domain`, `@pc/runtime`, `@pc/mcp`, Hono, React, or Node built-ins.
- Parsers accept `unknown` and return `ParseResult<T>`.

Core DTOs (from the handoff recommended contract family):

| Contract | Initial contents |
|---|---|
| `WorkItemDto` | id, projectId, callsign, parentId, title, body, status, stageId, type, fields, version, deletedAt, position, agent/workflow flags, expectedOutput, acceptanceCriteria, verification fields, assigned run/worktree fields. |
| `StageDto` | id, name, position, color, `isNew`, `isDone`, `isCancelled`, `rev`. |
| `FieldSchemaDto` | id, projectId, key, label, type (`text`/`number`/`boolean`/`enum`/`date`), required, options, order, updatedAt. |
| `AttachmentDto` | id, workItemId, name, content, createdAt, runId, createdBySessionId, source, agentName, nodeId. |
| `WorkItemMutationResult` | changed work item, optional changed attachments, version, canonical event id(s). |
| Request schemas | create, patch, move, soft-delete, restore, create-agent-contract, approve/reject, stage replace, field-schema replace, attachment create/delete. |

Canonical live-event extensions (build on the slice-002 `LiveEvent` envelope and `{ type: 'live-event', event }` frame):

```ts
// LiveEventEntity union extended: 'project' | 'work-item' | 'stage' | 'field-schema' | 'attachment'

export interface WorkItemChangedLivePayload {
  reason: WorkItemMutationReason; // created | patched | moved | soft-deleted | restored | verified | approved | rejected | auto-advanced
  workItem?: WorkItemDto;         // changed snapshot
  attachments?: AttachmentDto[];  // optional changed attachments
}

export interface StageListChangedLivePayload {
  stagesRev: number;
  stages: StageDto[];
  reason: 'replaced';
}
```

First canonical shapes:

```ts
{ type: 'work-item.changed', entity: 'work-item', scope: 'project', projectId, entityId: workItemId, version, payload: WorkItemChangedLivePayload }
{ type: 'stage.list.changed', entity: 'stage', scope: 'project', projectId, entityId: null, version: stagesRev, payload: StageListChangedLivePayload }
```

Contract decisions (recorded; see Open Questions for human review):

- Work-item events are **project-scoped** (`scope: 'project'`, non-null `projectId`), unlike global `project.changed`. Replay must filter by project.
- `version` on `work-item.changed` carries `work_items.version`; on `stage.list.changed` it carries `stagesRev`. This lets the web hook do version-aware upserts.
- Attachments are modeled as **separate entity facts** (`attachment.changed`) per the handoff recommendation; the `WorkItemChangedLivePayload.attachments` field is an optional convenience for the common create/verify path, not the canonical attachment channel.
- Keep legacy websocket names as compatibility projections; add `to<Legacy>Envelope(event)` adapters mirroring slice-002's `toProjectChangedRefetchEnvelope`.

## 6. Compatibility Adapter Plan

Files likely affected:

```text
packages/app-services/src/work-items/adapters.ts
packages/app-services/src/work-items/index.ts
apps/web/src/features/work-items/types.ts   (re-export/alias contract DTOs)
packages/mcp/src/tools/work-items.ts        (parse via contracts; tool names unchanged)
```

Adapter requirements:

- Pure, bidirectional row<->DTO mappers; tolerate optional/missing legacy fields; fail loud on structurally invalid input with a typed error result (no silent coercion of malformed rows).
- Provide a list-shape normalizer so both `{ workItems }` and `{ items, nextCursor }` responses can be produced/consumed behind one client interface without changing the public route bodies yet.
- Web: `apps/web/src/features/work-items/types.ts` re-exports or aliases contract DTOs so existing component imports keep working; add the missing agent/workflow/verification/attachment-provenance fields as wire-compatible additions (server already returns them from domain rows).
- MCP: keep tool names and payloads; route request parsing/response shaping through contract parsers. Lock `pc_create_work_item` `stageId` behavior to actual server behavior via a characterization test before any description change.

## 7. Mutation Gateway Plan

Files likely affected:

```text
packages/app-services/src/work-items/gateway.ts
packages/app-services/src/work-items/index.ts
apps/server/src/services/work-item.ts
apps/server/src/services/work-item-writer.ts
apps/server/src/services/agent-verification.ts
apps/server/src/services/agent-verification-review.ts
apps/server/src/services/auto-advance-done.ts
apps/server/src/services/dag-run-service.ts
apps/server/src/features/work-items/routes.ts
apps/server/src/index.ts
```

Gateway responsibilities (one durable write door):

| Operation family | Required behavior |
|---|---|
| create / patch / move / delete / restore | Stage validation, field-schema validation, optimistic version policy, row mutation, canonical `work-item.changed` emission, legacy event projection. |
| agent verification / approve / reject / auto-advance | Apply verification state, append history, optionally move to done stage, emit one coherent `work-item.changed` per changed row (closes the High-severity missing-event gap). |
| workflow root/child create and `move-work-item` | Create roots/children and move through the gateway; preserve skip-stage-entry semantics for `move-work-item`. |
| stage replacement | Current validation (duplicate ids, single new/done/cancelled, occupied-stage guard with force/fallback), revision stamping, canonical `stage.list.changed` emission. |
| field-schema replacement | Parse contract input, transact replacement, preserve orphan fields, canonical `field-schema.list.changed` emission. |
| attachment create/delete | Validate project/work-item ownership, provenance, canonical `attachment.changed` emission. |

Transaction rules:

- Validate -> persist product mutation -> insert `live_outbox` row in the **same SQLite transaction** -> fan out after commit. A rollback emits nothing (canonical or legacy).
- Boundary purity: gateway may depend on `@pc/contracts`, `@pc/db`, `@pc/domain`. It must not import Hono, React, the websocket hub, Channel, MCP SDK, or runtime process classes. Fanout is wired at the server composition layer, as in slice 002.

## 8. Replay Route and WebSocket Compatibility Plan

Files likely affected:

```text
apps/server/src/features/live-events/routes.ts
apps/server/src/index.ts
apps/server/test/live-events-routes.test.ts
apps/server/test/work-item-routes.test.ts
```

- Extend `/api/live-events` (slice 002) to accept `type=work-item.changed` and `type=stage.list.changed`. Work-item/stage events are project-scoped: require/honor `projectId`; never return another project's scoped events. Keep `project.changed` global behavior unchanged.
- After a committed gateway mutation, fan out canonical `{ type: 'live-event', event }` plus the matching legacy websocket name. Do not fan out before the outbox row commits. Zero subscribers or a fanout throw must leave the row replayable.
- Keep `/ws` and `ProjectWebSocketHub.broadcastAll` behavior unchanged.

## 9. Web Client and Hook Plan

Files likely affected:

```text
apps/web/src/features/live/client.ts          (reuse slice-002 client)
apps/web/src/features/work-items/live-events.ts
apps/web/src/features/work-items/use-project-work-items.ts
apps/web/src/features/work-items/use-project-stages.ts
apps/web/src/features/work-items/use-rich-link-invalidator.ts
apps/web/test/work-item-live-events.test.ts
```

- Accept canonical wrapped `work-item.changed` / `stage.list.changed` frames; keep version-aware upserts (work item `version`, stage `stagesRev`).
- Dedupe by `event.id`; replay after the stored cursor on reconnect/app-load using the slice-002 live client; keep legacy websocket handling working in parallel.
- Stage hook moves toward reconnect-safe projection from `stage.list.changed`; rich-link invalidator continues on attachment events (canonical `attachment.changed` when emitted).

## 10. Test Plan

Minimum automated tests (add before behavior changes where practical):

| Priority | Test | Purpose |
|---|---|---|
| P0 | `packages/contracts/test/work-items.test.ts` | Parser/guard coverage for work-item/stage/field/attachment DTOs and request schemas; canonical `work-item.changed` / `stage.list.changed` payload guards; invalid scope/project combinations rejected. |
| P0 | Compat adapter tests | Round-trip row<->DTO stability for representative fixtures; web/MCP drift fields populated; list-shape normalizer covers both response shapes; malformed input fails loud. |
| P0 | Gateway tests | create/patch/move/delete/restore, agent verification/approve/reject/auto-advance, workflow root/child + `move-work-item`, stage replace, field-schema replace, attachment create/delete each emit exactly one canonical fact; rollback emits nothing. |
| P0 | Missing-event closure test | Agent verification/auto-advance now emit `work-item.changed` (characterizes and closes the High-severity gap). |
| P0 | `apps/server/test/live-events-routes.test.ts` updates | Replay returns project-scoped `work-item.changed` / `stage.list.changed` after cursor; excludes other-project events; `project.changed` global behavior unchanged. |
| P0 | `apps/server/test/work-item-routes.test.ts` | Legacy HTTP response shapes preserved; canonical + legacy fanout after commit; reads do not emit. |
| P0 | `apps/web/test/work-item-live-events.test.ts` | Filters accept canonical work-item/stage frames; dedupe by id; version-aware upsert; reject unrelated frames. |
| P1 | MCP parity test | `pc_*` work-item/project-config request/response match server behavior; `pc_create_work_item` `stageId` drift locked. |

Expected commands:

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

If `@pc/app-services` has no test script yet, add the package-local `tsx --test "test/*.test.ts"` script as part of the implementation.

Manual verification after implementation (batched to the human end-of-section pass):

- Two browser clients: move a work item / change verification in client A; client B's kanban and stage tabs update without manual refresh.
- Replace stages in client A; client B reflects the new stage list.
- Disconnect one client websocket, mutate a work item, reconnect; replay after cursor reconciles the board.
- Confirm chat/agent run behavior is unchanged.

## 11. Migration Steps

1. Add contract tests for work-item/stage/field/attachment DTOs and canonical event payloads.
2. Add the contract files and extend `live-events.ts` + `index.ts`.
3. Add compatibility adapters and web/MCP aliasing without changing routes/tool names.
4. Build the mutation gateway in `@pc/app-services` (or consolidate `WorkItemService`) with validate -> persist -> outbox-insert -> fanout.
5. Route bypassing paths (verification, review, auto-advance, DAG move, legacy fields-only update) through the gateway.
6. Extend `/api/live-events` for the new project-scoped types; dual-fanout canonical + legacy after commit.
7. Add the web work-item/stage live hook + cursor replay.
8. Run automated verification.
9. Update trackers with implementation notes.

## 12. Rollback Plan

- New event families reuse the additive slice-002 `live_outbox`; no new migration to roll back.
- Keep legacy websocket names as the immediate UI rollback path; canonical frames can be ignored by the web hook without changing product state.
- Gateway routing is revertible call-site by call-site back to current direct helper calls; repository functions are unchanged.
- Replay-route additions can be disabled from the web hook without affecting durable state.
- Web `types.ts` aliases let UI imports revert quickly.

## 13. Stop Conditions

Stop and return to planning if implementation requires any of the following:

- Workflow runtime or agent runtime internal redesign beyond routing durable work-item mutations through the gateway.
- Changing `move-work-item` skip-stage-entry semantics.
- Moving attachment storage off inline SQLite or enforcing size/content/retention limits.
- Stage-reference workflow guards or transactional field-schema migration validation beyond current behavior.
- A destructive DB migration or rewriting existing product rows.
- Replacing `/ws`, changing connection semantics, or restarting/killing dev processes.
- Removing any legacy websocket event name.
- Changing existing work-item/stage/field/attachment HTTP response bodies or MCP tool names/payloads.
- Accepting unrelated untagged frames in work-item hooks.

## 14. Acceptance Criteria

This slice is ready to implement only when the user explicitly asks to build and these criteria are accepted:

- `@pc/contracts` owns work-item/stage/field/attachment DTOs, request schemas, parser/guard helpers, and canonical `work-item.changed` / `stage.list.changed` (plus `field-schema.list.changed` / `attachment.changed` payload) contracts.
- Compatibility adapters map domain/database rows to DTOs and back, covering recorded web/MCP drift and the divergent list response shapes.
- One server-owned mutation gateway is the durable write door; previously bypassing verification/auto-advance/DAG/legacy paths route through it.
- Each durable mutation writes its product change and a `live_outbox` row atomically and dual-fans canonical + legacy events after commit.
- `/api/live-events` replays project-scoped work-item/stage events with correct cursor/scope filtering.
- Web stores/updates a cursor, replays after reconnect, and applies version-aware work-item/stage updates from canonical frames.
- Tests cover contracts, adapters, gateway emission, the closed missing-event gap, replay filtering, legacy response parity, and web frame handling.
- Runtime, agents (beyond gateway routing), workflows (beyond gateway routing), mailbox, Channel, and MCP names remain untouched except for unaffected typecheck/test fallout.
- Tracker marks this build-slice artifact `planned`.

## 15. Open Questions

| Question | Status |
|---|---|
| Should attachment create/delete bump the work-item aggregate version, or rely only on `attachment.changed`? | Deferred. This slice models attachments as separate facts; web invalidation listens to `attachment.changed`. |
| Should field-schema replacement validate all existing work items vs warn vs require an explicit migration mode? | Deferred to a later stage/field-guard slice; this slice preserves current behavior. |
| Which workflow definitions are "active" for stage-reference guards (v2 DAGs, legacy rows, or both)? | Deferred to the stage/field-guard slice. |
| Should legacy no-version MCP moves stay last-write-wins or learn expected versions? | Deferred; this slice keeps current behavior and only routes the mutation through the gateway. |
| Should agent verification state emit work-item facts only, or both work-item and agent-run facts sharing a correlation id? | This slice emits `work-item.changed`; agent-run fact correlation is owned by slice 005. |

## 16. Notes for the Implementation Agent

- Reuse the slice-002 `live_outbox` table, replay route, and web live client; do not add a second outbox.
- Start with contracts + adapters + characterization tests; do not change mutation behavior before the gateway exists.
- The risk in this slice is mutation-path consolidation and event-after-commit ordering, not TypeScript surface area.
- Audit and route these direct mutation paths first: `agent-verification.ts`, `agent-verification-review.ts`, `auto-advance-done.ts`, `dag-run-service.ts`, and the legacy branches in `features/work-items/routes.ts`.
- Preserve `move-work-item` skip-stage-entry behavior.
- Keep MCP tool names stable; migrate internals to typed contracts only.
- Do not use `archive/` as evidence or a source for tests.
