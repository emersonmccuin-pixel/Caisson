# Definitive Refactor Session Pathway

This is the required path from the completed first foundation slice into the rest of the refactor. It exists to remove guessing between sessions.

## Control Rules

- Start every session with `git status --short`.
- Work only from a clean repo.
- End every session by updating the tracker files, committing completed work, and confirming `git status --short` is clean.
- Do not restart, kill, or replace running dev processes from a subagent. The human owns the live dev stack and runs the browser tests.
- Do not begin a build session unless the matching build-slice plan exists and is marked ready.
- Keep each implementation slice inside its named scope. Do not add adjacent subsystem work because it is convenient.
- Each slice has two agent session types — plan and build — followed by a human review checkpoint.
- Planning sessions may update docs only.
- Build sessions may update implementation code only inside the owning slice. The build session ends by posting a plain-English in-app test checklist for the slice.
- Human review is the advance gate: the human browser-tests the slice against that checklist. On pass, the slice is marked implemented. On a defect, the next session is a fix session for the same slice (not a fresh slice).

## How We Run This (current process, 2026-05-30)

The refactor runs **live in the working session**, not through an external orchestration pipeline.

- Claude dispatches **subagents** (the Agent tool) to do the plan and build work for each slice, supervises them, and reviews their output before committing.
- After each build, **Claude posts a plain-English in-app test checklist** for that slice.
- The **human does the per-slice review** by browser-testing against that checklist on the `refactor/auto-pathway` branch, then confirms pass.
- There are **no dedicated automated verify/close sessions** anymore. Automated tests + typechecks still run inside the build session as a pre-gate; the human review is the real advance gate.
- The old Workflow-driven pipeline under `refactor plan/orchestration/` is **retired** (kept for history). Do not drive the refactor with the Workflow tool.
- Building slice N+1 before the human has reviewed slice N is allowed (same accepted risk as before): everything lands on the branch, never main, and the human reviews in batches.

## Required Slice Order

| Slice | Owning roadmap phase | Required output | Build scope |
|---|---|---|---|
| 001 | Phase 1 and Phase 2 | `refactor plan/build-slices/001-foundation-vertical-slice.md` | Project contracts, project app-service seam, route parity, compatibility `project.changed`, web refetch integration, focused tests. |
| 002 | Phase 3 | `refactor plan/build-slices/002-project-live-outbox.md` | Durable `live_outbox` for `project.changed` only, canonical live-event contract, replay route, compatibility fanout, web cursor/refetch path, tests. |
| 003 | Phase 4 | `refactor plan/build-slices/003-work-items-stages-fields-events.md` | Work-item/stage/field/attachment shared contracts, app-service mutation gateway, route/MCP/web compatibility, `work-item.changed` and `stage.list.changed`, tests. |
| 004 | Phase 5 | `refactor plan/build-slices/004-workflow-definition-run-service.md` | Workflow definition/run/review service boundary, stable run identity/version, cancellation and boot reconciliation, compatibility routes, tests. |
| 005 | Phase 6 | `refactor plan/build-slices/005-agent-run-service.md` | Agent-run command service, pending-ask atomicity, status/rev live events, pause/resume/cancel compatibility, tests. |
| 006 | Phase 7 | `refactor plan/build-slices/006-conversation-send-replay-service.md` | Conversation/session/send/replay service seam, transcript repository over existing files, send queue facade, pending-interaction shadowing, tests. |
| 007 | Phase 8 | `refactor plan/build-slices/007-mailbox-platform.md` | Mailbox contracts, tables, repos, delivery leases, UI inbox, orchestrator-turn worker over send service, tests. |
| 008 | Phase 9 | `refactor plan/build-slices/008-channel-cutover.md` | Move agent delivery, workflow review, and external webhook delivery from Channel to mailbox. Keep fallback until verification passes. |
| 009 | Phase 10 | `refactor plan/build-slices/009-runtime-host-transient-worktrees.md` | Split runtime host, transient sessions, and worktree/path-guard seams behind compatibility facade, tests. |
| 010 | Phase 11 | `refactor plan/build-slices/010-mcp-typed-client-capabilities.md` | MCP typed localhost client, capability registry, migrate tool families after their service contracts exist, tests. |
| 011 | Phase 12 | `refactor plan/build-slices/011-compatibility-cleanup.md` | Remove obsolete event shapes, compatibility routes, old Channel target paths, and duplicated local types after static-search gates pass. |

## Session Path

| Session | Type | Required action | Advance gate |
|---:|---|---|---|
| 10 | Verify/close 001 | Re-run slice 001 verification after the project create-flow fix. Include two-client browser checks for create, metadata rename/restore, archive/delete visibility, and cleanup. Update trackers. | Slice 001 is fully verified, tracker says no remaining slice-001 blockers, repo clean. |
| 11 | Plan 002 | Create `002-project-live-outbox.md`. It must cover contracts, DB migration, repo, publisher service, replay route, websocket compatibility, web client cursor/refetch behavior, tests, rollback, and stop conditions. | Slice 002 plan exists and is marked planned. |
| 12 | Build 002 | Implement only slice 002. | Focused tests, package typechecks, two-client create/rename/archive verification, reconnect/replay verification, repo clean. |
| 13 | Verify/close 002 | Review slice 002 diff and verification evidence. Fix only slice-002 defects if found. Update trackers. | Slice 002 is marked implemented. |
| 14 | Plan 003 | Create `003-work-items-stages-fields-events.md`. | Slice 003 plan exists and is marked planned. |
| 15 | Build 003 | Implement only slice 003. | Focused tests for work items/stages/fields/attachments contracts, route/MCP/web compatibility, live events, repo clean. |
| 16 | Verify/close 003 | Review slice 003 diff and verification evidence. Fix only slice-003 defects if found. Update trackers. | Slice 003 is marked implemented. |
| 17 | Plan 004 | Create `004-workflow-definition-run-service.md`. | Slice 004 plan exists and is marked planned. |
| 18 | Build 004 | Implement only slice 004. | Workflow identity, run lifecycle, review/cancel, boot reconcile tests pass, repo clean. |
| 19 | Human review 004 | Claude posts a plain-English in-app test checklist for slice 004; human browser-tests it live. Fix-session only if a defect surfaces. Update trackers. | Human confirms slice 004 passes; slice 004 marked implemented. |
| 20 | Plan 005 | Create `005-agent-run-service.md`. | Slice 005 plan exists and is marked planned. |
| 21 | Build 005 | Implement only slice 005. End with a slice-005 test checklist. | Agent dispatch, pending ask, pause/resume/cancel, rev/live-event tests pass, repo clean. |
| 22 | Human review 005 | Claude posts a slice-005 test checklist; human browser-tests it live. Fix-session only if a defect surfaces. Update trackers. | Human confirms slice 005 passes; slice 005 marked implemented. |
| 23 | Plan 006 | Create `006-conversation-send-replay-service.md`. | Slice 006 plan exists and is marked planned. |
| 24 | Build 006 | Implement only slice 006. End with a slice-006 test checklist. | Chat start/send/replay/close/resume and legacy transcript compatibility tests pass, repo clean. |
| 25 | Human review 006 | Claude posts a slice-006 test checklist; human browser-tests it live. Fix-session only if a defect surfaces. Update trackers. | Human confirms slice 006 passes; slice 006 marked implemented. |
| 26 | Plan 007 | Create `007-mailbox-platform.md`. | Slice 007 plan exists and is marked planned. |
| 27 | Build 007 | Implement only slice 007. End with a slice-007 test checklist. | Mailbox enqueue/lease/ack/retry/dead-letter, UI inbox, orchestrator-turn worker tests pass, repo clean. |
| 28 | Human review 007 | Claude posts a slice-007 test checklist; human browser-tests it live. Fix-session only if a defect surfaces. Update trackers. | Human confirms slice 007 passes; slice 007 marked implemented. |
| 29 | Plan 008 | Create `008-channel-cutover.md`. | Slice 008 plan exists and is marked planned. |
| 30 | Build 008 | Implement only slice 008. End with a slice-008 test checklist. | Agent delivery, workflow review, external webhook delivery work through mailbox with fallback gated, repo clean. |
| 31 | Human review 008 | Claude posts a slice-008 test checklist; human browser-tests it live. Fix-session only if a defect surfaces. Update trackers. | Human confirms slice 008 passes; slice 008 marked implemented. |
| 32 | Plan 009 | Create `009-runtime-host-transient-worktrees.md`. | Slice 009 plan exists and is marked planned. |
| 33 | Build 009 | Implement only slice 009. End with a slice-009 test checklist. | Runtime host, transient-session, worktree/path-guard characterization tests pass, repo clean. |
| 34 | Human review 009 | Claude posts a slice-009 test checklist; human browser-tests it live. Fix-session only if a defect surfaces. Update trackers. | Human confirms slice 009 passes; slice 009 marked implemented. |
| 35 | Plan 010 | Create `010-mcp-typed-client-capabilities.md`. | Slice 010 plan exists and is marked planned. |
| 36 | Build 010 | Implement only slice 010. End with a slice-010 test checklist. | MCP tool family parity, typed client, capability registry tests pass, repo clean. |
| 37 | Human review 010 | Claude posts a slice-010 test checklist; human browser-tests it live. Fix-session only if a defect surfaces. Update trackers. | Human confirms slice 010 passes; slice 010 marked implemented. |
| 38 | Plan 011 | Create `011-compatibility-cleanup.md`. | Slice 011 plan exists and is marked planned. |
| 39 | Build 011 | Implement only slice 011. End with a slice-011 test checklist. | Static search gates and integration tests prove removed paths have no active callers, repo clean. |
| 40 | Human review 011 | Claude posts a final cleanup test checklist; human browser-tests it live. | Human confirms cleanup passes; cleanup marked implemented and no stale target-path references remain. |

## Failure Path

If a session fails its advance gate:

1. Do not start the next numbered session.
2. Update `refactor plan/refactor-tracker.md` with the blocker.
3. Update `refactor plan/refactor-session-tracker.md` by adding a fix session immediately after the failed session.
4. The fix session prompt must name the failing slice and failing verification command.
5. Commit any docs or safe fixes that were completed.
6. End with a clean repo.

## Session 10 Gate

Session 10 is not complete until all of these pass:

- Slice 001 focused automated tests still pass.
- Full repo typecheck still passes.
- Two-client browser verification passes for project create visibility.
- Two-client browser verification passes for project metadata rename and restore.
- Two-client browser verification passes for project archive/delete visibility.
- Test-created project files are cleaned up or intentionally archived with the row left hidden.
- Trackers record the result.
- Repo is clean.

## Slice 002 Required Shape

Slice 002 must be the next planned slice. It is not optional and should not be swapped for mailbox, workflows, agents, or chat.

Required scope:

- `packages/contracts` live-event envelope for `project.changed`.
- `packages/db` additive `live_outbox` migration and repo.
- `packages/app-services` or server-owned live publisher boundary for project mutations.
- Server replay route for live events after cursor.
- Current websocket compatibility emission for existing clients.
- Web hook/client cursor/refetch behavior for project list/project metadata.
- Tests for scope filtering, cursor replay, transaction rollback, and two-client behavior.

Out of scope:

- Runtime transcript events.
- Mailbox events.
- Work-item events.
- Workflow events.
- Agent events.
- Channel removal.
- Deep `ProjectRuntime` changes.
