# Refactor Plan Tracker

This tracker coordinates subsystem architecture handoff documents.

Subsystem documents belong in `refactor plan/refactor plan docs/`.

Use `refactor plan/subsystem-architecture-handoff-prompt.md` to create each subsystem document.

Use `refactor plan/target-architecture.md` as the north-star architecture for every subsystem document.

The target architecture is desired direction, not current implementation truth.

## Status Values

- `not started`: subsystem is identified but not documented.
- `in progress`: analysis is underway.
- `documented`: subsystem handoff doc exists.
- `needs synthesis`: doc has cross-subsystem conflicts or decisions to reconcile.
- `synthesized`: included in the holistic architecture synthesis.
- `planned`: implementation plan exists.
- `implemented`: implementation completed and verified.

## Current Refactor Priority

These are the subsystems of concern because they do not always work as expected.

Each priority subsystem document must include a `Target Architecture Alignment` section that compares the subsystem to `refactor plan/target-architecture.md`.

| Order | Focus | Tracker Subsystem | Target Doc | Why Priority | Notes |
|---|---|---|---|---|---|
| 1 | UI refresh / WebSocket system | WebSocket/event propagation | `refactor plan/refactor plan docs/ui-refresh-websocket-event-propagation.md` | Stale or missing UI updates make every other subsystem appear unreliable. | Establish event contracts, invalidation rules, frontend subscriptions, and ownership of projected state. |
| 2 | Chat | Chat runtime and transcript UI | `refactor plan/refactor plan docs/chat-runtime-and-transcript-ui.md` | Chat is the main runtime surface and currently mixes transcript, runtime state, tool events, pending prompts, and UI projection. | Decide whether chat is source of truth or a view over durable runtime/session events. |
| 3 | Agents | Agent runs | `refactor plan/refactor plan docs/agents-and-agent-runs.md` | Agent lifecycle, dispatch, recovery, transcript persistence, and control behavior are core app reliability concerns. | Include agent host, pods/orchestrator, verification, pause/resume, and active-run state as related areas. |
| 4 | Workflows | Workflows and workflow builder | `refactor plan/refactor plan docs/workflows-and-workflow-builder.md` | Workflows connect UI-authored plans, DAG execution, agents, work items, and durable run state. | Clarify whether workflows are orchestration records, templates, or both. |
| 5 | MCP and tooling | MCP bridge and MCP tools | `refactor plan/refactor plan docs/mcp-and-tooling.md` | Tool availability and MCP integration affect what agents can actually do. | Define canonical tool registry, tool availability, and app-owned vs external tools. |
| 6 | Channel server replacement | Channel server | `refactor plan/refactor plan docs/channel-server-agent-messaging-inbox.md` | Current channel behavior should be reconsidered as an app-owned agent/orchestrator messaging inbox. | Treat as replacement design: durable messages, delivery state, ack/read state, retries, ordering, and recovery. |
| 7 | Whole system at large | Holistic synthesis | `refactor plan/holistic-architecture-synthesis.md` | Reconcile the subsystem recommendations into one coherent architecture. | Run after the six priority subsystem docs exist. |

Lower priority for now:

- Desktop shell.
- Web app shell.
- Other supporting subsystems unless they become blockers during priority analysis.

## Planning-to-Build Workflow

The six priority subsystem handoffs and the holistic synthesis are complete. The next phase is to turn those findings into buildable, testable slices without losing cross-system coherence.

### Refactor Target Decision

The real implementation target is the current repo, not a blank rewrite in a new directory.

- Build new clean boundaries inside this repo.
- Use scratch directories only for disposable spikes or experiments.
- Preserve existing data/runtime/MCP/UI compatibility until replacement paths are tested.
- Do not start a parallel replacement app unless the user explicitly changes this decision.

### New Session Startup

Every new planning, implementation-planning, or build-slice session should start here:

1. Run `git status --short`.
2. If the worktree is dirty, stop and resolve the dirty state before starting new planning or implementation work unless the user explicitly asked to review, commit, stash, or clean it.
3. Read `AGENTS.md`.
4. Read `refactor plan/refactor-session-tracker.md` to identify the manual session row.
5. Read `refactor plan/definitive-session-pathway.md`.
6. Read `refactor plan/target-architecture.md`.
7. Read `refactor plan/holistic-architecture-synthesis.md`.
8. Read this tracker.
9. If a planning artifact is marked `in progress` or `not started`, read that artifact; otherwise read the artifact named by the next unchecked session row.
10. Read the build-slice plan named by the active session when one exists.
11. Inspect current code only for the scope being planned or implemented.
12. Update this tracker and `refactor plan/refactor-session-tracker.md` before ending the session.
13. Commit completed work or explicitly stash deferred work, then confirm `git status --short` is clean.

Current next action:

- Manual Session 12 is complete.
- Slice 001 is fully verified and has no remaining slice-001 blockers.
- Slice 002 is implemented and verified/closed in Session 13 (tag `slice-002-verified`); browser test pending for the human end-of-section pass.
- The next unchecked manual row is Session 13 in `refactor plan/refactor-session-tracker.md`.
- The required session order is defined in `refactor plan/definitive-session-pathway.md`.
- Session 13 verified/closed slice 002 (tag `slice-002-verified`).
- Session 14 planned slice 003 at `refactor plan/build-slices/003-work-items-stages-fields-events.md`: work-item/stage/field/attachment contracts, compatibility adapters, a server-owned mutation gateway consolidating the bypassing verification/auto-advance/DAG/legacy paths, and durable `work-item.changed` / `stage.list.changed` events on the slice-002 `live_outbox`. The next unchecked session is Session 15: build slice 003 only.
- Slice 002 is fixed as durable `live_outbox` for `project.changed` only. Do not swap it for agents, workflows, mailbox, chat, or runtime work.
- Session 9 follow-up two-client verification found and fixed one slice bug: background project websocket sockets were being torn down on metadata-only project refetches, creating a short blind spot for back-to-back `project.changed` events. Reversible project rename/restore now propagates between two browser clients without refresh.
- Session 9 follow-up create verification found and fixed the attach-to-git scaffold bug: with no seed workflow YAMLs, create wrote only an empty `.project-companion/workflows/` directory, so `git commit -m Add Caisson scaffold` had nothing to commit. Scaffold creation now renders `setup-wizard-prompt.md` into `.project-companion/` and tolerates empty partial `.project-companion/` directories left by the failed attempt.
- Session 10 re-ran slice 001 verification. Automated tests/typechecks passed, and two isolated browser clients verified project create visibility, metadata rename/update, name restore, archive/delete visibility, and scaffold cleanup on the running dev stack without restarting dev processes.
- Session 11 created the slice 002 plan. The plan chooses wrapped canonical websocket frames `{ type: 'live-event', event }`, keeps the legacy top-level `project.changed` refetch hint during migration, uses global-only `project.changed` production events, and defers retention pruning.
- Session 12 built slice 002: canonical live-event contracts, additive `live_outbox` migration/repo, atomic project mutation plus outbox writes, replay route, dual canonical/legacy fanout, web cursor/replay/refetch handling, and focused tests. Automated gates passed. The already-running API returned 404 for `/api/live-events`, so browser verification against the dev stack remains for Session 13 after the stack has loaded the new server code; an in-process two-client fanout/replay test covers the missed-event recovery path without restarting processes.
- Do not treat manual Session 10 as roadmap Phase 10. Roadmap phases remain separate from manual workflow session numbers.

### Process Flow

| Step | Output | Purpose | Gate before moving on |
|---|---|---|---|
| 1 | `refactor plan/implementation-roadmap.md` | Convert synthesis into phases, PR boundaries, dependencies, rollback notes, and acceptance criteria. | Roadmap names build phases and first vertical slice without changing implementation code. |
| 2 | Foundation specs | Resolve the blocking architecture decisions that every build slice depends on. | Each spec defines schemas, ownership, migration phases, compatibility, and tests. |
| 3 | Work-item dependency handoff | Document work items/stages/fields/attachments because agents and workflows depend on them. | Agent/workflow plans can reference work-item contracts without guessing. |
| 4 | Phase 0 test characterization plan | Define the tests to restore or recreate before behavior refactors. | Test plan covers current WS, chat replay/send queue, agent asks, workflow review/cancel, MCP tools, and Channel delivery. |
| 5 | First build-slice plan | Pick a small vertical slice, likely shared contracts plus one low-risk feature. | Slice has scope, files, tests, rollback, compatibility, and stop conditions. |
| 6 | Build only when explicitly requested | Implementation follows the slice plan. | User explicitly asks to build; planning docs and tests/verification are sufficient for the slice. |

### Foundation Spec Queue

These specs should be concise and practical, not new long-form audits. Each should include decisions, proposed contract shapes, ownership, migration phases, acceptance criteria, tests, and open questions.

| Order | Artifact | Status | Output Path | Depends On | Exit Criteria |
|---|---|---|---|---|---|
| 1 | Implementation roadmap | planned | `refactor plan/implementation-roadmap.md` | Holistic synthesis | Ordered build phases, PR/checkpoint boundaries, first vertical slice, rollback strategy, and test gates are documented. |
| 2 | Shared contracts and app services spec | planned | `refactor plan/foundation specs/shared-contracts-and-app-services.md` | Implementation roadmap | Contract package rules, app-service boundaries, validation approach, MCP access rule, and first migrated feature are defined. |
| 3 | Live events and outbox spec | planned | `refactor plan/foundation specs/live-events-and-outbox.md` | Shared contracts direction | Canonical envelope, scope/global semantics, cursor/replay, outbox table, legacy adapter, and tests are defined. |
| 4 | Mailbox and pending interactions spec | planned | `refactor plan/foundation specs/mailbox-and-pending-interactions.md` | Shared contracts direction, Channel synthesis | Recipient identity, message/delivery/ack model, pending-interaction ownership, UI inbox, orchestrator-turn policy, and migration path are defined. |
| 5 | Runtime transcript and conversation store spec | planned | `refactor plan/foundation specs/runtime-transcript-and-conversation-store.md` | Shared contracts direction, chat handoff | Transcript repository strategy, file compatibility, SQLite mirror decision, replay cursor, send queue service boundary, and tests are defined. |
| 6 | Work items/stages/fields/attachments handoff | planned | `refactor plan/refactor plan docs/work-items-stages-fields-attachments.md` | Existing subsystem docs | Work-item contracts and stage/field/attachment dependencies for agents/workflows/MCP/live events are documented. |
| 7 | Phase 0 test characterization plan | planned | `refactor plan/phase-0-test-characterization-plan.md` | Foundation specs | Restore/recreate test inventory, current behavior characterization, known-bug tests, and CI/local commands are documented. |
| 8 | First build-slice plan | implemented | `refactor plan/build-slices/001-foundation-vertical-slice.md` | Roadmap and Phase 0 plan | Implemented in manual Session 9 and fully verified in Session 10. Scope remained limited to project list/project metadata shared contracts, a narrow project service seam, route parity, non-durable `project.changed` refetch, web contract/refetch integration, and focused tests. |

### Build-Readiness Gates

Do not start implementation refactors until the relevant slice has:

- an owning roadmap phase;
- explicit contracts or compatibility contract;
- current-state evidence from code;
- migration and rollback steps;
- test plan, including characterization tests where behavior is risky;
- a tracker update marking the artifact or subsystem `planned`;
- user confirmation that implementation should begin.

### Slice Shape

Every planned build slice should follow the same cartridge shape:

```text
contract
  -> app service / repo boundary
  -> route adapter
  -> live event or mailbox fact
  -> web client/hook
  -> MCP adapter when relevant
  -> tests
```

## Subsystem Inventory

| Subsystem | Status | Doc | Owner Area | Runtime Process | Baseline Branch | Baseline Commit | Migration Risk | Target Recommendation | Key Dependencies | Open Questions |
|---|---|---|---|---|---|---|---|---|---|---|
| Desktop shell | not started |  | `apps/desktop` | Electron main/preload |  |  | unknown | unknown | Web UI, server, dev controls |  |
| Web app shell | not started |  | `apps/web` | Renderer/Vite |  |  | unknown | unknown | API client, project state, chat surface |  |
| Shared contracts and app-service layer | planned | `refactor plan/foundation specs/shared-contracts-and-app-services.md` | future `packages/contracts`, future `packages/app-services`, `apps/server`, `apps/web`, `packages/mcp` | Server/renderer/MCP adapters | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | new foundational layer; zero-dependency browser-safe contracts first, server-side app services behind narrow ports, typed localhost MCP client first, project list/project metadata as first migrated feature | All priority subsystems, DB repos, domain, live events, MCP typed client | Canonical live-event/outbox semantics are deferred to the next foundation spec; project creation service ownership remains partly open because current create flow owns git/scaffold/runtime registration. |
| Chat runtime and transcript UI | synthesized | `refactor plan/refactor plan docs/chat-runtime-and-transcript-ui.md` | `apps/web`, `apps/server`, `packages/runtime`, `packages/db` | Renderer/server/runtime/Claude PTY | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | split/refactor; keep JSONL tailer, session rows, and send queue; add shared contracts, durable transcript/interactions, canonical live envelope | Runtime host, WebSocket/event propagation, agent runs/transcripts, workflows, MCP/channel, database | Should normalized transcript events move to SQLite directly or through a repository shim? Should pending asks belong to mailbox or pending-interactions? How should agent transcripts converge with chat replay? |
| Conversation/runtime transcript store | planned | `refactor plan/foundation specs/runtime-transcript-and-conversation-store.md` | future `packages/contracts`, future `packages/app-services`, `packages/runtime`, `packages/db`, `apps/server`, `apps/web` | Server/runtime/renderer/Claude PTY | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | new/refactor; keep `orchestrator_sessions` and `orchestrator_send_queue`, introduce file-backed `TranscriptRepository` first, treat SQLite transcript storage as mirror-only until parity tests pass, split transcript `seq` replay cursor from live outbox cursor, and expose a `ConversationSendService` facade for mailbox runtime turns | Chat runtime, agent transcripts, live events/outbox, mailbox pending interactions, runtime host, send queue, MCP typed contracts | Exact first after-seq route shape; whether SQLite mirror writes are synchronous or async; feature flag for mirror rollback; how `/api/ask` shadow pending interactions terminalize after server restart; first mailbox message kind to use `enqueueRuntimeTurn`. |
| Runtime host and PTY sessions | not started |  | `apps/server`, `packages/runtime` | Server/runtime process |  |  | unknown | unknown | Agent runs, terminal mode, project runtime |  |
| Agent runs | synthesized | `refactor plan/refactor plan docs/agents-and-agent-runs.md` | `apps/server`, `packages/runtime`, `packages/db`, `packages/domain`, `packages/mcp`, `apps/web` | Server/runtime/optional agent-host/Claude child/database | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | refactor behind shared contracts and an agent-run app-service boundary; keep DB-first run state; replace Channel delivery through mailbox later | Runtime host, agent host, WebSocket/event propagation, Channel/mailbox, work items, workflows, MCP, transcripts | Can paused runs survive server restart without host? Should `agent_runs` store resolved pod ID/scope? Should pending asks get a first-class UI surface? |
| Agent host process | not started |  | `packages/agent-host`, `apps/server` | External host process/server |  |  | unknown | unknown | Runtime host, agent runs, desktop shell |  |
| Pods and orchestrator | not started |  | `apps/server`, `packages/domain`, `packages/db` | Server/database |  |  | unknown | unknown | Agent runs, send queue, pod catalog, MCP tools |  |
| Workflows and workflow builder | synthesized | `refactor plan/refactor plan docs/workflows-and-workflow-builder.md` | `apps/server`, `apps/web`, `packages/workflows`, `packages/db` | Server/renderer/database | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | split/refactor; keep pure DAG package and current UI pieces; add durable definition/run/review services, shared contracts, active-run cancellation/recovery, and canonical live events | DAG executor, work items/stages, agents/agent host, WebSocket/event propagation, MCP, transient sessions, Channel/mailbox, database | Should runs reference workflow row/version or immutable definition revision? How should active workflow runs recover/cancel across restarts? Should `human-review` ship or be disabled until a durable inbox exists? Where should builder drafts live? |
| Work items, stages, and fields | planned | `refactor plan/refactor plan docs/work-items-stages-fields-attachments.md` | `apps/server`, `apps/web`, `packages/db`, `packages/domain`, `packages/mcp` | Server/renderer/database/MCP adapters | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | refactor around shared work-item, stage, field-schema, and attachment contracts plus a server-owned mutation gateway that emits canonical live events while preserving legacy HTTP/MCP/websocket compatibility | Projects, agents and agent runs, workflows, MCP, live events/outbox, mailbox/pending interactions, attachments/rich links | Stage-reference guarding, agent verification event emission, field-schema migration/revalidation, attachment size/provenance policy, and legacy route/tool compatibility semantics remain open. |
| Project lifecycle and registry | not started |  | `apps/server`, `apps/web`, `packages/db` | Server/renderer/database |  |  | unknown | unknown | Worktrees, settings, project context, runtime |  |
| Project worktrees | not started |  | `apps/server`, `packages/runtime`, `packages/db` | Server/filesystem/git |  |  | unknown | unknown | Projects, runtime sessions, agent runs |  |
| Files and project context | not started |  | `apps/server`, `apps/web` | Server/renderer/filesystem |  |  | unknown | unknown | Projects, chat, memory drawer, attachments |  |
| Settings and onboarding | not started |  | `apps/server`, `apps/web`, `packages/db` | Server/renderer/database |  |  | unknown | unknown | Project setup, auth/install checks, app settings |  |
| Dev controls and dogfood runtime | not started |  | `apps/server`, `apps/web`, `apps/desktop` | Server/renderer/Electron |  |  | unknown | unknown | Dev supervisor, ports, restart endpoints |  |
| MCP bridge and MCP tools | synthesized | `refactor plan/refactor plan docs/mcp-and-tooling.md` | `packages/mcp`, `apps/server`, `packages/runtime`, `packages/domain`, `packages/db`, `apps/web` | Server/MCP child/Claude runtime/renderer | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | refactor/split; keep pc-rig stdio adapter and session-local mcp config; add shared contracts, typed local client, canonical capability registry, and app-service command/query path | Agents/pods, agent runs, workflows, work items, runtime host, WebSocket/live events, Channel/mailbox, database | Where should the canonical capability registry live? Should MCP call app services directly or through a typed localhost client? Which subsystem owns `pc_ask_*` after mailbox/pending-interactions migration? How should external MCP server capabilities be discovered and validated? Does Channel replacement remove the orchestrator `webhook` MCP server? |
| MCP capability registry and external tool discovery | not started |  | future `packages/contracts` or `packages/domain`, `packages/mcp`, `apps/web`, `packages/runtime` | MCP child/server/renderer |  |  | medium/high | split from ad hoc metadata; one registry for tool names, slugs, labels, descriptions, risk, wildcard expansion, and external discovery | MCP tools, pods, materializer, web agent settings, stock pod seed | Should the registry live in contracts, domain, or a new browser-safe package? How much external MCP discovery is required before spawn? |
| Statusline and usage telemetry | not started |  | `apps/server`, `apps/web`, `packages/db`, `packages/domain` | Server/renderer/database |  |  | unknown | unknown | Runtime sessions, usage caps, snapshots |  |
| Transient sessions | not started |  | `apps/server`, `apps/web`, `packages/db` | Server/renderer/database |  |  | unknown | unknown | Chat UI, runtime host, project state |  |
| WebSocket/event propagation | synthesized | `refactor plan/refactor plan docs/ui-refresh-websocket-event-propagation.md` | `apps/server`, `apps/web`, `packages/runtime` | Server/renderer/runtime | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | refactor/split | Runtime host, chat events, project state, work items, workflows, agents, channel/mailbox, live outbox | What is the canonical durable live-event envelope and cursor/replay contract? How should global events be scoped? Should runtime chat events stay file-backed or move behind SQLite live events? |
| Live event contracts and outbox | planned | `refactor plan/foundation specs/live-events-and-outbox.md` | `packages/contracts`, `packages/db`, `apps/server`, `apps/web`, future `packages/app-services` | Server/renderer/database | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | new foundational live-event layer; canonical `LiveEvent` envelope with `scope`, nullable `projectId`, global monotonic cursor, `live_outbox` table, replay API, legacy envelope adapters, and `project.changed` as first event family | WebSocket/event propagation, shared contracts/app services, projects, work items, workflows, agents, statusline, mailbox, runtime transcript store | First retention policy, whether first canonical WS frames are direct `LiveEvent` objects or `{ type: 'live-event', event }`, and whether `project.changed` emits global-only or both global and project-scoped events. Runtime transcript and mailbox event details are deferred to their specs. |
| Mailbox service and delivery workers | planned | `refactor plan/foundation specs/mailbox-and-pending-interactions.md` | future `packages/mailbox`, future `packages/contracts`, `packages/db`, future `packages/app-services`, `apps/server`, `apps/web`, `packages/mcp` | Server mailbox worker/renderer/runtime send service | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | new/replace; durable messages, typed recipients, delivery leases, retries, ack/read/action/dead-letter/audit, UI inbox, and orchestrator-turn delivery through the app send service facade | Channel server, agents, workflows, pending interactions, runtime send queue, live events, runtime transcript store | First mailbox route shape, first message kind to migrate, fallback flag shape, and whether agent `pending_asks` initially mirror into `pending_interactions` or expose through an adapter DTO. |
| Database and persistence layer | not started |  | `packages/db` | Database/repository layer |  |  | unknown | unknown | Domain models, server routes, migrations |  |
| Domain model package | not started |  | `packages/domain` | Shared TypeScript package |  |  | unknown | unknown | DB repos, server services, web types |  |
| Channel server | synthesized | `refactor plan/refactor plan docs/channel-server-agent-messaging-inbox.md` | `apps/server`, `channel-server`, `packages/db`, `packages/domain`, future `packages/contracts`/`packages/mailbox` | Server mailbox worker plus runtime send service; current per-Claude Channel bridge is legacy deletion target | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | replace with durable mailbox/message-inbox, UI inbox delivery, and app-injected orchestrator turns; delete Channel/dev-channel bridge | WebSocket/event propagation, chat pending interactions, agent-run pause/resume, workflow review delivery, MCP contracts, recipient identity model, runtime send queue/orchestrator turn injection, UI inbox | What is the canonical recipient identity? Should `pending_asks` be mailbox-owned or referenced by mailbox messages? What counts as acknowledgement for an injected orchestrator turn? Should external webhooks target active sessions, all sessions, user inbox, or project inbox? |
| Human review inbox and approval surfaces | not started |  | `apps/server`, `apps/web`, `packages/workflows`, future `packages/mailbox` | Server/renderer/database |  |  | high | unknown | Mailbox, workflows, work items, agents, chat UI | Code and stock prompts reference a Human Review inbox, but current guidance says `human-review` parks without an actionable surface; should this be merged with mailbox or built as a separate user inbox? |
| Pending interactions and approvals | planned | `refactor plan/foundation specs/mailbox-and-pending-interactions.md` | `apps/server`, `packages/db`, `packages/domain`, future `packages/contracts`, future `packages/app-services`, future `packages/mailbox`, `apps/web` | Server/renderer/runtime | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | high | new/refactor; pending-interaction state owns ask/review/approval lifecycle while mailbox delivers actionable references; keep agent `pending_asks` as compatibility until agent-run resume semantics move safely | Chat asks, agent `pending_asks`, workflow review, human review inbox, MCP `pc_answer_pending`, MCP `pc_complete_node`, mailbox, runtime transcript store | How blocking chat `/api/ask` moves to durable interactions, whether `pc_complete_node` eventually answers an interaction id or keeps `(runId,nodeId)`, and when `human-review` is rejected versus inbox-backed. |
| Attachments and rich links | planned | `refactor plan/refactor plan docs/work-items-stages-fields-attachments.md` | `apps/server`, `apps/web`, `packages/db`, `packages/domain` | Server/renderer/database | `dev` | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` | medium/high | keep inline DB attachments initially, but define attachment DTO/provenance, canonical `attachment.changed` events, ownership checks, rich-link invalidation, and size/content/retention policy before heavier agent/workflow output use | Work items, chat transcript, agents/workflows, live events/outbox | Whether attachment mutations bump work-item aggregate versions or remain separate entity events; attachment size/content-type/retention limits. |

## Holistic Synthesis

| Document | Status | Inputs | Output | Notes |
|---|---|---|---|---|
| `refactor plan/holistic-architecture-synthesis.md` | synthesized | `refactor plan/target-architecture.md`, the six priority subsystem plans, `refactor plan/refactor-tracker.md`, targeted current-code checks | `refactor plan/holistic-architecture-synthesis.md` | Reconciles subsystem flow, conflicts, migration sequencing, and newly exposed supporting subsystems. |
| `refactor plan/refactor-session-tracker.md` | active | Manual prompt sequence and completion notes | `refactor plan/refactor-session-tracker.md` | Use this to track session-by-session progress through the planning-to-build workflow. |
| `refactor plan/definitive-session-pathway.md` | active | Roadmap phases, foundation specs, completed slice 001 evidence, required no-guessing session order | `refactor plan/definitive-session-pathway.md` | Controls required slice order and plan/build/verify session sequence from Session 10 through compatibility cleanup. |

## Planning Artifact Tracker

Use this table for the post-synthesis planning workflow.

| Artifact | Status | Output | Owner Area | Dependencies | Notes |
|---|---|---|---|---|---|
| Implementation roadmap | planned | `refactor plan/implementation-roadmap.md` | Whole system | Holistic synthesis | Created from tracker and holistic synthesis; next artifact is the shared contracts and app services foundation spec. |
| Shared contracts and app services spec | planned | `refactor plan/foundation specs/shared-contracts-and-app-services.md` | Contracts/app-services/server/web/MCP | Implementation roadmap | Created; chooses project list/project metadata as first migrated feature and typed localhost HTTP as the first MCP access rule. |
| Live events and outbox spec | planned | `refactor plan/foundation specs/live-events-and-outbox.md` | Live events/server/web/DB | Shared contracts direction | Created; settles canonical envelope, global/project scope, cursor/replay, `live_outbox`, legacy adapter migration, and `project.changed` as the first event family. |
| Mailbox and pending interactions spec | planned | `refactor plan/foundation specs/mailbox-and-pending-interactions.md` | Mailbox/agents/workflows/chat/MCP | Shared contracts direction, Channel synthesis | Created; defines mailbox as delivery state, pending interactions as action state, typed recipient addresses, UI inbox and orchestrator-turn policy, send-queue acceptance as first runtime-turn ack, and Channel compatibility rollback. |
| Runtime transcript and conversation store spec | planned | `refactor plan/foundation specs/runtime-transcript-and-conversation-store.md` | Chat/runtime/DB/web | Shared contracts direction, chat handoff | Created; chooses file-backed `TranscriptRepository` before storage migration, keeps `jsonl-events.jsonl` plus legacy `events.jsonl` compatibility, defines session-local transcript `seq` replay separately from live outbox cursor, keeps SQLite transcript storage mirror-only until parity tests pass, and defines `ConversationSendService`/`enqueueRuntimeTurn` as the mailbox-facing send boundary. |
| Work items/stages/fields/attachments handoff | planned | `refactor plan/refactor plan docs/work-items-stages-fields-attachments.md` | Work items/server/web/db/domain/MCP | Workflows, agents, MCP, live events | Created; captures current write paths, contract drift, stage/field risks, attachment provenance/lifecycle gaps, MCP compatibility issues, and live-event dependencies. |
| Phase 0 test characterization plan | planned | `refactor plan/phase-0-test-characterization-plan.md` | Test strategy/all priority subsystems | Foundation specs | Created; defines harness restoration, current coverage gap, P0/P1/P2 tests to restore or recreate, known-gap policy, local/CI commands, and slice-specific gates before behavior refactors. |
| First foundation build-slice plan | implemented | `refactor plan/build-slices/001-foundation-vertical-slice.md` | First implementation slice | Roadmap, Phase 0 plan | Implemented in manual Session 9 after explicit user confirmation and fully verified in Session 10. Added `@pc/contracts`, `@pc/app-services`, route/service parity, compatibility `project.changed` refetch, web client/hook typing, and minimal restored tests. No `live_outbox`, DB migrations, runtime/agents/workflows/MCP/mailbox/transcript changes, or dev-server restarts. Verification passed: `pnpm --filter @pc/contracts test`, `pnpm --filter @pc/contracts typecheck`, `pnpm --filter @pc/app-services typecheck`, `pnpm --filter @pc/server test`, `pnpm --filter @pc/server typecheck`, `pnpm --filter @pc/web test`, `pnpm --filter @pc/web typecheck`, and `pnpm typecheck`. Two-client browser verification on the running dev stack passed for project create visibility, metadata rename/update, name restore, archive/delete visibility, and scaffold cleanup. |
| Project live outbox build-slice plan | implemented | `refactor plan/build-slices/002-project-live-outbox.md` | Live events/server/web/DB/projects | Slice 001, live events and outbox spec, definitive session pathway | Created in manual Session 11 and built in manual Session 12. Scope stayed durable `live_outbox` for `project.changed` only: canonical live-event contracts, additive DB migration/repo, atomic project mutation/outbox publisher boundary, replay route, websocket dual fanout, web cursor/refetch behavior, tests, rollback, and stop conditions. Verified/closed in Session 13 (commit `5c2317b3`, tag `slice-002-verified`): all gates green; browser test pending for the human end-of-section pass. |
| Work items stages fields events build-slice plan | building | `refactor plan/build-slices/003-work-items-stages-fields-events.md` | Work items/stages/fields/attachments/server/web/MCP/live events | Slice 002, work-items handoff, definitive session pathway | Created in manual Session 14. Built in manual Session 15: `@pc/contracts` work-item/stage/field-schema/attachment DTOs + request parsers + guards; `live-events.ts` entity union + canonical type names widened (`work-item.changed`/`stage.list.changed`/`field-schema.list.changed`/`attachment.changed`) and `parseListLiveEventsQuery` updated; `@pc/db` `live_outbox.entity` TS type widened (additive, no migration); `@pc/app-services` `work-items/` adapters (bidirectional row<->DTO + `{workItems}`/`{items,nextCursor}` normalizer, fail-loud) and `WorkItemMutationGateway` (validate -> persist -> outbox insert in one txn -> post-commit canonical+legacy publication; rollback emits nothing) covering create/patch/move/delete/restore + verify/approve/reject/auto-advanced + stage replace + field-schema replace + attachment create/delete; `/api/live-events` replay extended for project-scoped work-item/stage events; web canonical-frame acceptors added alongside legacy envelope guard. All focused tests (contracts 18, db 5, app-services 12, server 13, web 5) + package typechecks + full `pnpm typecheck` + `git diff --check` GREEN; in-process gateway-outbox + replay-route tests stand in for the two-client browser pass. DEFERRED to Session 16 (verify/fix): rewiring the bypassing verification/auto-advance/DAG/legacy fields-only call sites to announce through the gateway at the server composition layer (gateway + contract in place + tested; call-site rewires touch the live runtime fanout layer and need browser verification). Next session is Session 16: verify/close slice 003. |
| Definitive session pathway | active | `refactor plan/definitive-session-pathway.md` | Refactor execution control | Roadmap, foundation specs, slice 001 implementation | Created to remove discretionary next-step choices. It fixes the required order as: close slice 001, plan/build/verify slice 002 project live outbox, then work items, workflows, agents, conversation send/replay, mailbox, Channel cutover, runtime split, MCP typed client, and compatibility cleanup. |

## Change Log

| Date | Change |
|---|---|
| 2026-05-30 | Incorporated `target-architecture.md` as the north-star architecture for subsystem analysis and holistic synthesis. |
| 2026-05-30 | Marked priority refactor sequence: UI refresh/WebSocket, chat, agents, workflows, MCP/tooling, channel-server replacement, then whole-system synthesis. |
| 2026-05-30 | Created tracker and subsystem handoff prompt. |
| 2026-05-30 | Documented chat runtime and transcript UI subsystem; marked it `needs synthesis` because transcript storage, live envelope replay, pending asks, and agent transcript convergence cross subsystem boundaries. |
| 2026-05-30 | Added agent runs subsystem handoff at `refactor plan/refactor plan docs/agents-and-agent-runs.md`; marked tracker row `needs synthesis` because it conflicts with WebSocket/live-event, mailbox, chat transcript, workflow, and MCP contract decisions. |
| 2026-05-30 | Documented WebSocket/event propagation handoff and marked it `needs synthesis`; added live event contracts/outbox as a discovered subsystem candidate. |
| 2026-05-30 | Documented MCP/tooling handoff and marked it `needs synthesis` because tool contracts, capability registry ownership, runtime MCP readiness, external MCP server validation, workflows, agents, live events, and mailbox ownership need cross-subsystem reconciliation. |
| 2026-05-30 | Documented Channel server replacement / agent messaging inbox handoff and marked it `needs synthesis`; added human review inbox and approval surfaces as a discovered subsystem candidate. |
| 2026-05-30 | Documented workflows and workflow builder handoff and marked it `needs synthesis` because workflow identity, live events, active-run recovery/cancellation, review inbox, agents, MCP, and transient builder state cross subsystem boundaries. |
| 2026-05-30 | Updated Channel replacement target to no-channel architecture: durable mailbox plus UI inbox and app-injected orchestrator turns; Channel/dev-channel bridge is a delete target, not a compatibility adapter. |
| 2026-05-30 | Created holistic architecture synthesis at `refactor plan/holistic-architecture-synthesis.md`; marked six priority subsystem docs as `synthesized`; added follow-up candidates for shared contracts/app-services, transcript store, mailbox workers, capability registry, and pending interactions/approvals. |
| 2026-05-30 | Added post-synthesis planning-to-build workflow, foundation spec queue, build-readiness gates, and planning artifact tracker so new sessions can proceed toward implementation coherently. |
| 2026-05-30 | Updated `AGENTS.md` for the post-synthesis planning-to-build workflow and added README guidance for `foundation specs/`, `build-slices/`, and subsystem docs. |
| 2026-05-30 | Recorded refactor target decision: build the new architecture inside the current repo; use separate scratch directories only for disposable spikes, not the real implementation. |
| 2026-05-30 | Added manual session tracker at `refactor plan/refactor-session-tracker.md` and linked it from `AGENTS.md` and the tracker startup workflow. |
| 2026-05-30 | Created implementation roadmap at `refactor plan/implementation-roadmap.md`; marked roadmap artifact `planned`; named first foundation vertical slice and confirmed shared contracts/app services spec as the next planning artifact. |
| 2026-05-30 | Created shared contracts and app services foundation spec at `refactor plan/foundation specs/shared-contracts-and-app-services.md`; marked the artifact and subsystem `planned`; selected project list/project metadata as the first contract family and typed localhost HTTP as the first MCP adapter path. |
| 2026-05-30 | Created live events and outbox foundation spec at `refactor plan/foundation specs/live-events-and-outbox.md`; marked the artifact and subsystem `planned`; defined canonical `LiveEvent` scope/cursor semantics, proposed `live_outbox`, preserved legacy WS adapters during migration, and selected `project.changed` as the first event family. |
| 2026-05-30 | Created mailbox and pending interactions foundation spec at `refactor plan/foundation specs/mailbox-and-pending-interactions.md`; marked the artifact plus mailbox and pending-interaction subsystem rows `planned`; defined typed recipient addresses, mailbox delivery state, pending-interaction action ownership, UI inbox/orchestrator-turn policy, and send-queue acceptance as the first runtime-turn acknowledgement. |
| 2026-05-30 | Created runtime transcript and conversation store foundation spec at `refactor plan/foundation specs/runtime-transcript-and-conversation-store.md`; marked the artifact and conversation/runtime transcript store subsystem `planned`; defined file-backed transcript repository first, SQLite mirror-only storage until parity tests pass, transcript `seq` replay cursor versus live outbox cursor, send queue service boundary, `/api/ask` compatibility, and mailbox-facing `enqueueRuntimeTurn`. |
| 2026-05-30 | Created work items/stages/fields/attachments handoff at `refactor plan/refactor plan docs/work-items-stages-fields-attachments.md`; marked the artifact plus work-item and attachment subsystem rows `planned`; documented agent/workflow/MCP/live-event dependencies, event gaps, stage/field risks, attachment policy gaps, and characterization-test needs. |
| 2026-05-30 | Created Phase 0 test characterization plan at `refactor plan/phase-0-test-characterization-plan.md`; marked the artifact `planned`; documented the missing active test harness, 155 deleted tracked tests as restore candidates, P0/P1/P2 characterization coverage by subsystem, known-gap policy, local/CI commands, and slice-specific test gates. |
| 2026-05-30 | Created first foundation build-slice plan at `refactor plan/build-slices/001-foundation-vertical-slice.md`; marked the artifact `planned`; selected project list/project metadata as the smallest contract-first slice and limited implementation scope to shared contracts, a narrow project service seam, route parity, a non-durable `project.changed` refetch event, web contract/refetch integration, and focused tests. |
| 2026-05-30 | Prepared manual Session 9 by syncing `refactor-session-tracker.md` through Session 8, clarifying that Session 9 is the first build slice rather than roadmap Phase 9, updating startup workflow when no planning artifact is in progress, and standardizing the first project live/refetch event name to `project.changed`. |
| 2026-05-30 | Completed manual Session 9 / build slice 001. Restored minimal focused tests, added project shared contracts and app-service seam, adapted project routes to preserve wire compatibility and publish a non-durable `project.changed` refetch hint, updated the web project client/types and WS filtering/refetch handling, and verified with scoped tests/typechecks plus full `pnpm typecheck`. |
| 2026-05-30 | Fixed follow-up project create blocker from Session 9 verification: attach-to-git scaffold now writes a tracked `.project-companion/setup-wizard-prompt.md` file before the scaffold commit and accepts empty partial `.project-companion/` directories from the previous failed attempt. Added `apps/server/test/project-create.test.ts`; verified with targeted project-create test, `@pc/server` test, and `@pc/server` typecheck. |
| 2026-05-30 | Added clean-worktree requirement for future sessions: start by checking `git status --short`, resolve dirty state before new work, commit completed work or explicitly stash deferred work before handoff, and end with a clean status. |
| 2026-05-30 | Ran follow-up two-client live-event verification. Fixed background project websocket target stability so metadata-only refetches no longer reconnect sockets and miss back-to-back `project.changed` events. Reversible project rename/restore now propagates across two clients without refresh; final create/archive two-client verification is the Session 10 closeout gate. |
| 2026-05-30 | Added `refactor plan/definitive-session-pathway.md` and expanded the session tracker through slice 011 so future sessions follow a fixed plan/build/verify pathway instead of choosing ad hoc next steps. |
| 2026-05-30 | Closed manual Session 10 / slice 001 verification. Re-ran the slice 001 automated gates and full repo typecheck, then verified two isolated browser clients for project create visibility, metadata rename/update, name restore, archive/delete visibility, and scaffold cleanup on the running dev stack. Slice 001 is fully verified; the next slice is fixed as `refactor plan/build-slices/002-project-live-outbox.md` planning only. |
| 2026-05-30 | Completed manual Session 11 / slice 002 planning. Created `refactor plan/build-slices/002-project-live-outbox.md`; marked the build-slice plan `planned`; fixed the scope to durable `live_outbox` for `project.changed` only with contracts, DB migration/repo, publisher boundary, replay route, websocket compatibility fanout, web cursor/refetch behavior, tests, rollback, and stop conditions. |
| 2026-05-30 | Completed manual Session 12 / build slice 002. Implemented canonical `project.changed` live-event contracts, additive `live_outbox` schema/migration/repo, atomic project mutation plus outbox writes, `/api/live-events` replay, canonical plus legacy fanout, and web cursor/replay/refetch handling. Automated gates passed; browser verification against the already-running dev stack is deferred to Session 13 because the current API process had not loaded the new replay route and was not restarted. |
| 2026-05-30 | Completed manual Session 14 / slice 003 planning. Created `refactor plan/build-slices/003-work-items-stages-fields-events.md` and marked the build-slice plan `planned`. Scope is work-item/stage/field/attachment shared contracts, compatibility row<->DTO adapters, a server-owned mutation gateway consolidating the bypassing agent-verification/auto-advance/DAG-move/legacy fields-only mutation paths, and durable `work-item.changed` / `stage.list.changed` live events on the reused slice-002 `live_outbox` (with `field-schema.list.changed` / `attachment.changed` payload contracts and legacy websocket projections). No implementation code changed; no new DB migration. |
