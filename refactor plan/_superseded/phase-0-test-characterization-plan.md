# Phase 0 Test Characterization Plan

## 1. Baseline and Scope

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Inputs | `target-architecture.md`, `holistic-architecture-synthesis.md`, `implementation-roadmap.md`, foundation specs, work-item handoff, and synthesized priority subsystem handoffs |
| Artifact status | Planned test characterization artifact |
| Scope | Tests to restore or recreate before behavior refactors. No implementation code changes in this planning pass. |

Evidence rule:

- Verified facts come from current non-archive code inspection.
- Restore candidates from `HEAD` are historical tracked files, not active working-tree coverage.
- Prior planning docs are synthesis context, not implemented truth.
- `archive/` was not searched, read, cited, or used.

## 2. Current Coverage Gap

### Verified Facts

| Finding | Evidence |
|---|---|
| No active non-archive `*.test.*` or `*.spec.*` files are present in the working tree. | `rg --files --glob "!archive/**" --glob "!apps/server/data/**" \| rg "(test\|spec)\.(ts\|tsx\|js\|mjs)$"` returned no files. |
| 155 tracked test/spec files are deleted in the current working tree before this session. | `git status --short \| rg "^ D .*\.(test\|spec)\.(ts\|tsx\|js\|mjs)$"` returned 155 paths. |
| Current package scripts no longer expose unit or smoke test commands. | `package.json`, `apps/server/package.json`, `packages/*/package.json` currently only keep build/typecheck-oriented scripts. |
| `HEAD` had a Node test harness using `tsx --test` plus Playwright smoke/type scripts. | `git show HEAD:package.json`, `git show HEAD:apps/server/package.json`, package manifests, and `git show HEAD:playwright.config.ts`. |
| Current implementation has many test seams still present in comments and dependency injection points. | Examples: `ProjectWebSocketHub`, `sendRuntimeHostConnectSnapshot`, `loadSessionReplayCheckpoint`, `pause-resume.ts`, `DagExecutor`, `orchestrator-review-step.ts`, `ToolContext`, and `WorkItemService`. |

### Recommendation

Restore the test harness and high-signal characterization coverage before any behavior refactor. Prefer restoring tracked tests from `HEAD` when they still match current code. Recreate tests when the old file encodes an obsolete API, but keep the current behavior being characterized explicit.

## 3. Decisions

| Decision | Status | Rationale |
|---|---|---|
| Use Phase 0 for tests and harness only. | Accepted | Behavior refactors need an executable baseline first. |
| Restore the previous `node:test` + `tsx --test` harness unless implementation proves a better local fit. | Accepted | It matches the deleted tracked tests and needs no new runtime server. |
| Keep Playwright smoke tests out of the default Phase 0 gate until isolated test-server orchestration is restored. | Accepted | Current planning rules say not to restart servers; unit/integration tests should not depend on the developer's running app. |
| Treat known bugs as explicit known-gap tests, not silent expected behavior. | Accepted | Some current behavior is risky or wrong, but Phase 0 should not make default CI red unless the user explicitly accepts a failing gate. |
| Do not use `archive/` to recover tests. | Accepted | Repo instructions explicitly prohibit archive evidence. |
| Restore scripts as part of the future test-restoration slice, not in this planning pass. | Accepted | This artifact is planning-only. |

Known-gap test policy:

- Default suite: green characterization of current behavior and compatibility contracts.
- Known-gap suite or `test.todo`: executable descriptions of high-risk bugs that should fail once unskipped.
- Fix slices must convert their relevant known-gap tests into default failing-then-passing tests before changing behavior.

## 4. Harness Restoration Plan

### Restore Candidates From `HEAD`

| Area | Restore candidate | Purpose |
|---|---|---|
| Root scripts | `test:unit`, `test:smoke`, `test:playwright:types`, `ci` from `HEAD:package.json` | Recreate the repo-level verification entry points. |
| Package scripts | `test` scripts in `apps/server`, `packages/db`, `packages/domain`, `packages/runtime`, `packages/mcp`, `packages/workflows`, `packages/agent-host` | Run package-local `node:test` suites through `tsx`. |
| Playwright config | `playwright.config.ts`, `tests/playwright/tsconfig.json`, smoke specs | Restore browser smoke coverage after isolated server setup is decided. |
| CI | `.github/workflows/ci.yml` | Re-establish typecheck, unit tests, build, and Playwright typecheck gates when CI is in scope. |

### Target Commands After Restoration

| Command | Gate |
|---|---|
| `pnpm typecheck` | Always required before and after behavior refactors. |
| `pnpm test:unit` | Default Phase 0 unit/integration characterization gate. |
| `pnpm --filter @pc/server test` | Server routes/services/runtime adapter characterization. |
| `pnpm --filter @pc/db test` | SQLite schema/repo characterization. |
| `pnpm --filter @pc/domain test` | Pure domain rules and shared policy characterization. |
| `pnpm --filter @pc/runtime test` | PTY/session/JSONL/runtime adapter characterization. |
| `pnpm --filter @pc/mcp test` | MCP tool/schema/handler characterization. |
| `pnpm --filter @pc/workflows test` | Pure DAG validation/execution characterization. |
| `pnpm --filter @pc/agent-host test` | Host protocol and service characterization. |
| `pnpm test:playwright:types` | Browser smoke type safety after Playwright files are restored. |
| `pnpm test:smoke` | Optional/manual until an isolated test server is part of the test slice. |

## 5. Required Test Inventory

### A. Live Events, WebSocket, and UI Projection

| Priority | Restore/recreate | Required cases |
|---|---|---|
| P0 | `apps/server/test/websocket-hub.test.ts` | `ProjectWebSocketHub.subscribe`, closed-socket pruning, `broadcast(projectId, msg)` project tagging, `broadcastAll(msg)` unchanged payload behavior. |
| P0 | `apps/server/test/runtime-host-websocket-connect.test.ts` | Focused connect sends session/state/runtime/replay/queue snapshots and reattaches only an existing PTY; `intent=activity` never spawns or mints a session. |
| P0 | Web hook characterization test, recreated if needed | `use-project-ws.ts` and `use-all-projects-ws.ts` currently reject envelopes with mismatched or missing `projectId`; global untagged events are dropped. |
| P0 | Reconnect/refetch hook test | `useResourceList` refetches on websocket epoch; bespoke `use-project-workflows.ts` and `use-project-stages.ts` reconnect behavior is captured as current behavior or known gap. |
| P1 | Legacy emitter shape tests | `work-item-changed`, `stages-changed`, `field-schemas-changed`, `attachment-changed`, `pod-changed`, `workflow-changed`, `workflow-v2-run-changed`, `agent-run-changed`, `statusline-snapshot`, and `channel-event` payloads. |
| P1 | Project list live gap test | Project create/update/delete/reorder routes currently have no live project-list event; characterize before adding `project.changed`. |

### B. Chat Runtime, Transcript, Send Queue, and Ask

| Priority | Restore/recreate | Required cases |
|---|---|---|
| P0 | `apps/server/test/session-replay.test.ts` | `jsonl-events.jsonl` replay order, malformed-line skip, `events.jsonl` legacy fallback, `highWaterSeq`, prefer new path over legacy path. |
| P0 | `apps/server/test/orchestrator-send-queue-delivery.test.ts` and `packages/db/test/orchestrator-send-queue.test.ts` | Ready send, queued busy/spawning/backlog, delivery attempts, cancel/retry guards, `jsonl-user` observation to `observed_in_jsonl`. |
| P0 | `apps/server/test/chat-bridges-routes.test.ts` | `/api/ask` stores an in-memory resolver, broadcasts `ask`, resolves through `ask-reply`, times out with current text, and handles missing project/session fallback. |
| P0 | `apps/server/test/runtime-host-websocket-message.test.ts` | `send`, `interrupt`, `terminal-input`, `resize`, `ask-reply`, invalid-message/no-session/error `send-ack` compatibility. |
| P1 | `apps/server/test/runtime-host-routes.test.ts` | Active session/list/history/new/resume/close/session-events/terminal-transcript route shapes. |
| P1 | `apps/server/test/terminal-mode.test.ts`, `web-terminal-transcript.test.ts` | Terminal transcript path containment, tail limit, raw input bypassing chat send queue. |
| P1 | `apps/server/test/web-agent-transcript.test.ts` | Agent transcript backfill from provider JSONL and live `agent-jsonl-event` merge/dedupe behavior. |

### C. Agents, Agent Runs, Pending Asks, and Verification

| Priority | Restore/recreate | Required cases |
|---|---|---|
| P0 | `apps/server/test/agent-pause-resume.test.ts`, `packages/db/test/pending-asks.test.ts` | `recordExplicitPause` creates `pending_asks`, marks run paused, enqueues delivery; duplicate answer/cancel idempotency; current missing-active-run outcomes. |
| P0 | Known-gap tests around `answerPendingAsk` | Current code flips `pending_asks` to answered before active-run resume is proven; mark as known gap until the fix slice. |
| P0 | `apps/server/test/agent-delivery.test.ts`, `packages/db/test/agent-inbox.test.ts` | `hybrid`, `inbox-only`, `channel-only`; pending row insert; delivered flip and audit; drain on registration. |
| P0 | `apps/server/test/agent-host-reattach.test.ts` | Host-mode state update/broadcast `rev` behavior, including stale-rev known gap if still present. |
| P1 | `apps/server/test/agent-invoke-route.test.ts`, `agent-run-routes.test.ts`, `agent-run-control.test.ts` | Dispatch row insert, continue ownership, inspect, kill, route status/error compatibility. |
| P1 | `packages/runtime/test/agent-run.test.ts`, `agent-run-registry.test.ts`, `agent-run-jsonl-tailer.test.ts` | Runtime adapter state/timer/cancel/pause/resume/transcript behavior without server routes. |
| P1 | `apps/server/test/agent-verification.test.ts`, `agent-verification-review.test.ts`, `auto-advance-done.test.ts`, `agent-work-item.test.ts` | Work-item verification mutations, approve/reject, auto-advance done, and current work-item event gaps. |
| P2 | `apps/server/test/agent-run-boot-reconcile.test.ts`, `agent-run-liveness-sweep.test.ts`, `agent-run-server-boot.test.ts` | Restart/liveness terminalization in host and non-host modes. |

### D. Workflows and Workflow Builder

| Priority | Restore/recreate | Required cases |
|---|---|---|
| P0 | `packages/workflows/test/dag-validate.test.ts`, `dag.test.ts`, `dag-step.test.ts`, `dag-triggers.test.ts` | Pure DAG shape, refs, cycles, trigger rules, `when`, and stage-entry syntax. |
| P0 | `apps/server/test/orchestrator-review-step.test.ts` | Channel post success/failure, review-pending broadcast, header/body shape, and failure when `postChannel` throws. |
| P0 | Known-gap test for default workflow Channel POST | `dag-run-service.ts` default `postChannel` omits `X-Sender` and does not check `response.ok`; characterize as known gap before mailbox/review changes. |
| P0 | `apps/server/test/dag-run-service.test.ts`, `workflow-routes.test.ts`, `workflow-compat-routes.test.ts` | Fire row creation, run writer shape, compatibility route shapes, cancel/delete current behavior. |
| P0 | Known-gap tests for review decisions | Duplicate, wrong-node, and non-paused review decisions should be documented as current risk before hardening. |
| P1 | `packages/db/test/workflows-repo.test.ts`, `workflow-runs-v2.test.ts` | Definition row CRUD/audit, run row identity, `rev`, snapshots, event rows. |
| P1 | Duplicate identity test | Duplicated workflow row currently copies parsed `def.id`; test as known gap before definition service migration. |
| P1 | `apps/server/test/workflow-builder-draft-store.test.ts`, `transient-session-routes.test.ts` | Builder draft volatility and transient event shape. |
| P2 | Runtime cancellation/restart tests | Long shell command cancellation, subagent cancellation, boot reconciliation of non-terminal workflow runs. |

### E. Work Items, Stages, Fields, Attachments

| Priority | Restore/recreate | Required cases |
|---|---|---|
| P0 | `apps/server/test/work-item-routes.test.ts`, `packages/db/test/work-items.test.ts` | Create, patch, move expected-version, legacy no-version move, soft delete/restore, callsign lookup, filtered/unfiltered list response shapes. |
| P0 | `packages/domain/test/field-schema.test.ts`, `packages/db/test/attachments-field-schemas.test.ts` | Field validation, unknown field preservation, field-schema replacement, attachment CRUD/provenance. |
| P0 | `apps/server/test/project-runtime-move-v2.test.ts` | Stage-entry workflows fire on manual move and are skipped for workflow-driven `move-work-item`. |
| P1 | `apps/server/test/stage-flags-backfill.test.ts`, work-item route stage tests | Duplicate stage ids, one new/done/cancelled stage, occupied-stage removal with fallback/force, stage revision behavior. |
| P1 | Legacy route bypass tests | Fields-only `/work-items/update` currently bypasses `WorkItemService.patch` validation; capture before mutation gateway changes. |
| P1 | Attachment live invalidation tests | `attachment-changed` payloads, rich-link invalidation, and current decision that attachment changes do not bump work-item version. |
| P1 | Agent verification work-item event tests | Mutations from verification/auto-advance paths currently may not emit `work-item-changed`; mark current gap explicitly. |

### F. MCP and Tooling

| Priority | Restore/recreate | Required cases |
|---|---|---|
| P0 | `packages/mcp/test/tools.test.ts`, `apps/server/test/pod-tool-catalog-drift.test.ts` | `TOOLS`, `PC_RIG_TOOL_NAMES`, and catalog/materializer slugs stay in parity. |
| P0 | `packages/mcp/test/work-items-tools.test.ts`, `project-config-tools.test.ts` | Tool validation, raw HTTP success/non-2xx/transport mapping, route payload compatibility. |
| P0 | `packages/runtime/test/pod-materializer.test.ts`, `low-level-spawn-args.test.ts`, `ready-gate.test.ts` | Required tools, wildcard expansion, external MCP server config filtering, strict config args, handshake gates. |
| P1 | `apps/server/test/mcp-bridge-routes.test.ts`, `mcp-config-rewrite.test.ts` | `/api/mcp-status` alive/stale/malformed, `/api/internal/mcp-handshake` routing, MCP config rewrite. |
| P1 | `packages/mcp/test/agent-runs-tools.test.ts`, `workflows-tools.test.ts`, `agents-tools.test.ts` | Agent asks/answers, dispatch, workflow publish/fire/complete-node, pod management compatibility. |
| P2 | External MCP config tests | Bad config under strict spawn, capability discovery placeholders, no secret leakage in DTO/audit surfaces. |

### G. Channel, Mailbox Compatibility, and Pending Interactions

| Priority | Restore/recreate | Required cases |
|---|---|---|
| P0 | Channel characterization test, recreated or restored from server tests | Sender allowlist rejection, `/channel-register`, `emitToSession` live recipient success/failure, no-registrant drop as current behavior. |
| P0 | `apps/server/test/agent-delivery.test.ts`, `packages/db/test/agent-inbox.test.ts` | `agent_inbox` pending/delivered/audit, registration drain, `channel-only` bypass of inbox durability. |
| P0 | `apps/server/test/orchestrator-review-step.test.ts` plus dag service known-gap test | Workflow review prompt delivery path through Channel and failure mode when rejected by allowlist. |
| P1 | Chat proxy route test | `/api/projects/:projectId/channel-send` posts to `/channel/:slug/test` with `X-Sender: test` and preserves current response behavior. |
| P1 | Pending-interaction bridge tests after contracts exist | Future shadow `pending_interactions` must not change current `/api/ask` or `pending_asks` behavior until migration slice starts. |

### H. Browser Smoke Coverage

| Priority | Restore/recreate | Required cases |
|---|---|---|
| P1 | `tests/playwright/chat-smoke.spec.ts` and `playwright.config.ts` | Chat shell loads, composer sends, basic runtime panels render against an isolated test app. |
| P2 | `tests/playwright/terminal-mode.spec.ts` | Terminal mode UI can open and render transcript/input surfaces. |
| P2 | `tests/playwright/projrail-contextmenu.spec.ts`, `snapshot.spec.ts`, onboarding specs | Project rail and setup smoke after isolated server setup is reliable. |

Browser smoke tests are useful but must not depend on an already-running developer server. The implementation slice that restores them should either start an isolated test server it owns or keep them manual.

## 6. Slice-Specific Gates

| Future slice | Tests that must exist before behavior changes |
|---|---|
| Shared contracts/app services | Harness scripts, import-boundary tests, project route parity, first DTO parser tests. |
| Live events/outbox | WS hub/filter/reconnect tests, legacy emitter shape tests, project list live-gap characterization. |
| Runtime transcript/send service | Session replay, connect snapshot no-spawn, send queue, `/api/ask`, terminal path guard. |
| Agent-run hardening | Pending ask answer/cancel tests, dispatch/continue tests, host rev tests, terminal verification tests. |
| Workflow hardening | DAG validation, duplicate identity known gap, run identity, cancellation, review decision, boot reconcile tests. |
| Work-item mutation gateway | Work-item route/repo tests, field validation, stage replacement, attachment CRUD/live invalidation, MCP parity. |
| Mailbox/Channel replacement | Channel allowlist/register/drop tests, `agent_inbox` drain tests, workflow review failure-mode tests, send queue acceptance tests. |
| MCP typed client/capability registry | Tool list parity, ToolContext HTTP mapping, materializer wildcard/required-tool tests, bridge handshake/status tests. |

## 7. Acceptance Criteria

Phase 0 is complete when:

- Root and package-level test scripts are restored or replaced with equivalent commands.
- The default unit characterization suite runs without requiring the running app to restart.
- Active tests cover current WebSocket projection, chat replay/send queue, agent pending asks, workflow review/cancel risks, MCP tool surfaces, Channel delivery, and work-item dependencies.
- Known bugs identified by the architecture docs are represented as `test.todo`, explicit skipped known-gap tests, or separate non-gating failing tests with clear names.
- Test fixtures use temp directories/databases and do not depend on `archive/` or checked-in app data.
- The tracker marks this artifact `planned`.

Implementation still requires explicit user confirmation.

## 8. Rollback and Migration Notes

- Restoring tests and scripts is additive to runtime behavior.
- Do not revert unrelated dirty working-tree changes while restoring tests.
- If a restored historical test no longer compiles because current code legitimately moved, recreate the assertion against the current public symbol instead of reviving obsolete implementation assumptions.
- Keep Phase 0 tests focused. Do not add shared contracts, outbox tables, mailbox tables, or app-service behavior in the test-restoration slice.
- For Playwright, do not restart or kill existing user servers. A later implementation agent should use isolated test-owned ports if browser smoke is restored.

## 9. Open Questions

| Question | Why it matters |
|---|---|
| Should all 155 deleted tracked tests be restored first, or should Phase 0 restore only the priority subset and leave the rest as backlog? | Full restore is safer but may be slower; priority subset is enough to unblock the first build-slice plan. |
| Should known-gap tests live as `test.todo` in the default suite or as a separate `test:known-gaps` command? | This affects CI signal and how fix slices are staged. |
| Should Playwright smoke be part of Phase 0 or deferred until the first frontend-affecting build slice? | Browser coverage is valuable, but current app-server management is outside planning scope and must avoid touching existing dev processes. |
| Should package test scripts be restored exactly from `HEAD` or replaced with a new root `tsx --test` command that enumerates all test folders? | Exact restore is low-risk; a consolidated command may simplify CI but is a harness change. |

## 10. Notes for the Next Agent

1. Start by restoring the harness and the P0 tests in this document. Do not touch implementation behavior.
2. Use `HEAD` test files as restore candidates, not as authoritative current coverage.
3. Run only test processes and typecheck commands. Do not restart app/dev servers.
4. Keep every test scoped to current behavior unless it is explicitly named as a known-gap test.
5. Once Phase 0 P0 tests are executable, create `refactor plan/build-slices/001-foundation-vertical-slice.md` with the exact tests it will require.
