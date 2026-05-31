# 006 Conversation / Send / Replay Service

> **Resolved (build, Session 24, 2026-05-30): pending-interaction ask-shadow DEFERRED to slice 007.**
> The human decided slice 006 ships **ZERO database migrations** and makes **no schema changes**.
> Sections §4.6, §4.7, §7 (`/api/ask` shadow), §9 (pending-interaction lifecycle), §10 (the `pending_interactions` table), and the §16 ask-shadow open question are **deferred to slice 007** alongside the mailbox/pending-interactions platform.
> `/api/ask` semantics, the in-memory blocking resolver, and `chat-bridges/routes.ts` are **untouched** this slice. The parse-only `runtime-hook-ask.ts` wire-mirror contract still ships (additive, browser-safe, no DB) so 007 can adopt it without re-deriving the wire.

> **Fix: send-queue drain/coalesce/echo-recovery (fix session after Session 24 human review).**
> Human review reproduced a wedge: while the orchestrator was busy, rapid discrete sends queued; delivery of a head turn returned `echo-timeout` and the drain stopped, stranding the remaining queued prompts (`N queued prompt pending` stuck) — they only moved on the next user send.
> **Root cause:** `deliverNextQueuedPromptOnce` (live path, via `pty-handlers` state→ready) and the facade `ConversationSendService.deliverNextQueuedTurnOnce` delivered exactly ONE row then returned. On SUCCESS the queue advances correctly one-at-a-time via the `jsonl-user` FIFO correlation; on a FAILURE there is NO `jsonl-user` event to re-trigger the drain, so the queue wedged. The observed no-separator `testingOKay` glue was a downstream PTY-composer artifact of `echo-timeout` (the bracketed paste is written but `\r` is never sent, leaving text in Claude's composer); the queue itself never concatenates — discrete sends are discrete rows.
> **Fix (slice-006 queue scope only):** both drain loops now mark the head `failed` and CONTINUE to the next queued row on non-ok/throw, returning only after a SUCCESS (preserving the FIFO single-flight-pending-jsonl on success). The PTY echo-ack protocol (`sendBracketedPaste`/`SendResult`) is UNTOUCHED. Regression tests: `packages/app-services/test/conversation-send-service.test.ts` (facade echo-timeout recovery + all-failures drain) and new `apps/server/test/orchestrator-send-queue-delivery.test.ts` (live-path echo-timeout recovery + all-failures drain). Gates: app-services 53 / server 25 pass; `pnpm typecheck` exit 0; `git diff --check` clean.

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `refactor/auto-pathway` |
| Commit | baseline `cd645616` (slice 005 built; slices 001/002/003 verified — tags `slice-00{1,2,3}-verified`; 004/005 built, human review pending) |
| Artifact status | Planned build slice |
| Owning roadmap phase | Phase 7 conversation/session/send/replay service boundary |
| Slice subject | A read/command service seam over the EXISTING orchestrator chat runtime: a file-backed transcript repository over the on-disk JSONL, a send-queue facade with a mailbox-safe `enqueueRuntimeTurn`, an after-seq replay surface, and a durable `/api/ask` pending-interaction shadow — all behind contracts, preserving the chat UI, transcript files, and runtime behavior |
| Implementation target | This repo. Do not create a parallel app. |
| Scope rule | This is a build plan only. Do not implement until the user explicitly asks to build. |

Decision:

- **Recommendation:** Extend the slice-001..005 cartridge to the conversation/runtime family, but recognize this slice is **mostly a read + command-facade seam, not a durable-write-door slice**. Add browser-safe contracts for the session DTO, transcript replay DTO, send-queue DTO, and hook-ask DTO; introduce a `TranscriptRepository` (file-backed first) + `ConversationReplayService` that the existing session-events route and connect snapshot delegate to with **byte-identical** responses; wrap the existing send-queue repo + delivery helper behind a `ConversationSendService` facade exposing the current behaviors plus a mailbox-safe `enqueueRuntimeTurn`; add an after-seq replay endpoint (additive, behind the existing checkpoint route); and write a durable `pending_interactions` shadow row for `/api/ask` while **keeping the in-memory blocking resolver as the authoritative response path**. The high-frequency transcript `jsonl` stream stays a transient broadcast over `jsonl-events.jsonl` and is NOT moved onto `live_outbox`.
- **Reason:** The runtime/transcript foundation spec (`refactor plan/foundation specs/runtime-transcript-and-conversation-store.md`) is explicit: keep `orchestrator_sessions` + `orchestrator_send_queue` as durable identity/intent tables; introduce a transcript repository abstraction BEFORE changing storage; keep SQLite transcript storage mirror-only until parity tests pass; keep transcript `seq` replay cursor SEPARATE from the global live-outbox cursor; move send/enqueue/cancel/retry/observe behind a `ConversationSendService`; and keep `/api/ask` blocking behavior as compatibility until pending interactions can safely replace the in-memory resolver. Code inspection confirms the runtime is already a faithful render of JSONL: `loadSessionReplayCheckpoint` reads `jsonl-events.jsonl` (legacy `events.jsonl` fallback) and assigns per-session `seq`/`highWaterSeq`; the web `chat-session-reducer` already orders by that `seq` and tracks `highWaterSeq` — the transcript replay cursor already exists and is already distinct from the slice-002 global outbox cursor. So slice 006 is the SEAM (contracts + repository + service facades + after-seq read + ask shadow), not a storage migration and not a new high-frequency live-event family.
- **Compatibility stance:** Keep every legacy HTTP route, websocket envelope, send-queue status string, JSONL file format, replay `seq`/`highWaterSeq` contract, and `/api/ask` blocking response working unchanged. New surfaces are additive. No SQLite transcript primary; no `jsonl`-stream-on-outbox; no Channel change.

## 2. Problem Statement

Verified facts (code-evidence based, this checkout `cd645616`):

- **Chat is already a faithful render of JSONL; PTY is control-plane only.** `loadSessionReplayCheckpoint` (`apps/server/src/services/session-replay.ts:146`) sources `<sessionDataPath>/jsonl-events.jsonl`, falls back to legacy `events.jsonl`, skips malformed lines, assigns a per-session `seq`, and returns `highWaterSeq`. The PTY tailer writes the normalized JSONL; the live `jsonl` WS frame is a projection of the same rows. There is no SQLite transcript store: a `rg` over `apps`/`packages` finds NO `conversation_events`, `runtime_events`, `transcript_events`, or `pending_interactions` table (confirmed this checkout).
- **The transcript replay cursor already exists and is already separate from the live-outbox cursor.** Per-session `seq`/`highWaterSeq` come from `session-replay.ts`; the web `chat-session-reducer.ts` (`apps/web/src/hooks/chat-session-reducer.ts:17,41`) orders by `sessionId`+`seq` and tracks `highWaterSeq` (`MAX_TIMELINE_ENTRIES`). The slice-002 `live_outbox` global cursor is a different, additive system the chat reducer does NOT consume.
- **Session identity is durable.** `orchestrator_sessions` stores `jsonl_path`, `jsonl_line_cursor`, `status` (one active per project, DB-enforced), `provider`/`providerSessionId`/`model`/`title` (`packages/db/src/repos/orchestrator-sessions.ts`). `getActiveOrchestratorSession`, `listOrchestratorSessionsForProject`, `createOrchestratorSession`, `reactivateOrchestratorSession`, `endOrchestratorSession`, and the JSONL path/cursor setters all exist.
- **The send queue is durable and FIFO-correlated.** `orchestrator_send_queue` statuses are `queued_busy|queued_spawning|queued_backlog|delivering|delivered_to_pty|observed_in_jsonl|failed|cancelled` (`packages/db/src/repos/orchestrator-send-queue.ts:7`), unique by `(session_id, client_message_id)`. Delivery + observation logic lives in `apps/server/src/services/orchestrator-send-queue-delivery.ts` (`deliverNextQueuedPrompt`, `deliverNextQueuedPromptOnce`, `maybeAdvanceSendQueueConfirmation` — the one-time text+FIFO `jsonl-user` → `observed_in_jsonl` mark + `clientMessageId` stamp). The send path itself is in `websocket-message.ts::handlePromptSend` (direct ready send → `recordDeliveredOrchestratorSend`; busy/spawning/backlog → `enqueueOrchestratorSend`; `send-ack` envelope), and cancel/retry are HTTP routes in `runtime-host/routes.ts`.
- **The runtime routes/connect snapshot are the compatibility surface.** `runtime-host/routes.ts` exposes `GET /session`, `GET /orchestrator/runtime`, `GET /sessions`, `GET /sessions/:sessionId/events` (delegates to `loadRuntimeSessionReplay` → checkpoint), `GET /sessions/:sessionId/terminal-transcript`, `POST /sessions/new|:targetId/resume|close`, and `POST /send-queue/:sendId/cancel|retry`. `websocket-connect.ts::sendRuntimeHostConnectSnapshot` is the deterministic, NON-spawning reconnect checkpoint (`session-changed`, optional `state`, runtime snapshot, `session-replay`, `send-queue-snapshot`).
- **`/api/ask` is an in-memory blocking resolver.** `chat-bridges/routes.ts` (`InMemoryPendingAskStore`, `app.post('/api/ask')`) broadcasts the `ask` WS envelope, then `await`s a `Promise` keyed by `toolUseId` (resolved by the `ask-reply` WS message in `websocket-message.ts:152`) or a 10-minute timeout. A server restart loses the resolver and cannot cleanly answer the in-flight hook. The ask-intercept hook posts to `/api/ask` only when `PC_SESSION_ID` is present and times out at 10 minutes (foundation-spec verified).
- **Agent transcripts are a separate, deferred read surface.** Agent-run transcript backfill is `GET /agent-runs/:runId/events` + live `agent-jsonl-event` (slice 005 owns the agent-run state facts but explicitly LEFT `agent-jsonl-event`/transcript to slice 006). Subagent transcript reads are `GET /api/subagent-transcript?path=...` with a `~/.claude/projects/` path guard.
- **`@pc/contracts` has no conversation/runtime module.** `packages/contracts/src/` = projects, work-items, stages, field-schemas, attachments, workflow-definitions, workflow-runs, pending-asks, agent-runs, live-events, shared. The web runtime DTOs/envelopes are hand-written (`apps/web/src/features/runtime/{client,types,ws-types}.ts`).
- **There are no `conversation.*` live-event names reserved as canonical-required.** The foundation spec (Section 11) lists `conversation.session.changed`, `conversation.transcript.appended`, `conversation.send-queue.changed`, `conversation.ask.changed` as RECOMMENDED nudges "after the live-outbox layer exists" — and rules that live events must NOT replace `session-replay`, the `jsonl` stream stays legacy, and `live_outbox.payload` must not carry transcript history. `LiveEventEntity` (`packages/contracts/src/live-events.ts`) does NOT include any runtime/conversation entity.
- **Slice 002 shipped** the `LiveEvent`/`LiveEventFrame` envelope, `live_outbox` table/repo, `/api/live-events` replay, dual canonical/legacy fanout, and the web `liveEventsApi` client; slices 003/004/005 reused it.

Synthesis — this slice implements the conversation seam layer, which is read/facade-shaped, not a durable-write-door:

```text
contract (session / transcript-replay / send-queue / hook-ask DTOs)
  -> repository + read service (TranscriptRepository file-backed -> ConversationReplayService)
  -> command facade (ConversationSendService over the existing send queue, + enqueueRuntimeTurn)
  -> route/connect adapters (existing routes + connect snapshot delegate; identical wire shapes)
  -> additive after-seq replay endpoint (transcript seq cursor, NOT the live-outbox cursor)
  -> pending-interaction SHADOW for /api/ask (durable row; in-memory resolver still answers)
  -> tests
```

## 3. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | Chat replay is file-backed over `jsonl-events.jsonl` with legacy `events.jsonl` fallback; per-session `seq`/`highWaterSeq`; malformed rows skipped. | `apps/server/src/services/session-replay.ts:146,179` |
| Verified fact | The transcript replay cursor (per-session `seq`/`highWaterSeq`) is already distinct from the slice-002 global outbox cursor; the web reducer orders by `seq`. | `apps/web/src/hooks/chat-session-reducer.ts:17,41,59`; `session-replay.ts` |
| Verified fact | No SQLite transcript / conversation / pending-interaction table exists. | `rg` over `apps`/`packages` returned no `conversation_events`/`pending_interactions` matches (this checkout) |
| Verified fact | `orchestrator_sessions` is the durable session identity (one active per project, `jsonl_path`/`jsonl_line_cursor`). | `packages/db/src/repos/orchestrator-sessions.ts`; `packages/db/src/schema.ts` |
| Verified fact | `orchestrator_send_queue` durable statuses + FIFO `observed_in_jsonl` correlation + `(session_id, client_message_id)` uniqueness. | `packages/db/src/repos/orchestrator-send-queue.ts:7`; `services/orchestrator-send-queue-delivery.ts:133` |
| Verified fact | Send path: direct ready send → `recordDeliveredOrchestratorSend`; busy/spawning/backlog → `enqueueOrchestratorSend`; `send-ack` statuses `received\|queued\|invalid-message\|no-session\|error`. | `apps/server/src/features/runtime-host/websocket-message.ts:111,161` |
| Verified fact | Cancel/retry are HTTP routes guarded by active session + status. | `apps/server/src/features/runtime-host/routes.ts:260,285` |
| Verified fact | Session events route delegates to `loadRuntimeSessionReplay` → `{ ok, sessionId, highWaterSeq, events }`. | `runtime-host/routes.ts:145` |
| Verified fact | Connect snapshot is non-spawning and emits `session-changed`/optional `state`/runtime snapshot/`session-replay`/`send-queue-snapshot`. | `runtime-host/websocket-connect.ts:38` |
| Verified fact | `/api/ask` is an in-memory blocking resolver keyed by `toolUseId`, resolved by `ask-reply`, 10-min timeout; restart loses it. | `apps/server/src/features/chat-bridges/routes.ts:16,122`; `websocket-message.ts:152` |
| Verified fact | The `jsonl-user` → `observed_in_jsonl` mark stamps the matched `clientMessageId` onto the canonical `jsonl` envelope (id-keyed placeholder reconcile). | `services/orchestrator-send-queue-delivery.ts:133`; `runtime-host/pty-handlers.ts:153` |
| Verified fact | `@pc/contracts` has no conversation/runtime module; web runtime DTOs/envelopes are hand-written. | `packages/contracts/src/` listing; `apps/web/src/features/runtime/*.ts` |
| Verified fact | `conversation.*` live events are RECOMMENDED nudges only; the spec forbids replacing `session-replay` or putting transcript history in `live_outbox.payload`. | `foundation specs/runtime-transcript-and-conversation-store.md` §11 |
| Verified fact | `agent-jsonl-event`/agent transcript backfill + `/api/subagent-transcript` path guard exist and are deferred to this slice by slice 005. | `agent-runs/routes.ts`; `chat-bridges/routes.ts:152`; slice 005 §4 non-goals |
| Verified fact | Slice 002 outbox + replay + dual fanout + web `liveEventsApi` shipped; reused 003/004/005. | `refactor plan/build-slices/002..005`; `apps/web/src/features/live/client.ts` |

## 4. Exact Scope

Implement only these behaviors when the user asks to build:

1. Add a conversation/runtime contract family to `@pc/contracts` (`conversations.ts`, `runtime-transcript.ts`, `runtime-send-queue.ts`, and a hook-ask shape): `ConversationSessionDto` (mirror of `OrchestratorSession`: id, projectId, provider, providerSessionId, model, title, status, endedReason, startedAt, endedAt, jsonlPath, jsonlLineCursor), `ConversationKind` (`'orchestrator-session' | 'agent-run' | 'subagent-transcript'`), `TranscriptEventDto` + `TranscriptSourceDto` + `TranscriptReplayResponse` (browser-safe mirror of the `ReplayEnvelope`/`SessionReplayCheckpoint` shape, carrying `seq`/`highWaterSeq`), `RuntimeSendQueueItemDto` + `RuntimeSendStatus` (the existing 8 status strings) + `SendRuntimeTurnRequest`/`SendRuntimeTurnResponse`, and `RuntimeHookAskRequest`/`RuntimeHookAskResponse`. Parser/guard helpers per the contracts convention. Mirror the existing wire shapes exactly; do not invent fields the routes do not already emit (drop unused spec fields rather than widen the wire).
2. Add a `TranscriptRepository` abstraction in `@pc/app-services` (or a server-local first seam) with a `FileTranscriptRepository` first implementation that wraps the existing `loadSessionReplayCheckpoint()` behavior for `ConversationKind='orchestrator-session'`: `loadCheckpoint({ projectId, conversationId, sessionId })` and `listAfter({ ..., afterSeq, limit })`. The repository reads the same `jsonl-events.jsonl` (legacy `events.jsonl` fallback), skips malformed rows, and returns the same `seq`/`highWaterSeq`. **It does NOT change `InteractiveSession`'s writes** and does NOT add an append path this slice.
3. Add a `ConversationReplayService` that the existing `GET /api/projects/:projectId/sessions/:sessionId/events` route delegates to, mapping back to the **byte-identical** current response `{ ok, sessionId, highWaterSeq, events }`. The connect snapshot (`sendRuntimeHostConnectSnapshot`) and the new-session/resume routes keep emitting the same `session-replay` envelope via the same `sessionReplayPayload`, now sourced through the service.
4. Add an **additive** after-seq transcript replay surface for reconnect-without-full-checkpoint: `GET /api/projects/:projectId/sessions/:sessionId/events?afterSeq=<n>&limit=<n>` returning `{ ok, sessionId, highWaterSeq, events }` with only rows whose `seq > afterSeq`. This uses the **transcript `seq` cursor, NOT the global live-outbox cursor**. The default (no `afterSeq`) path is the unchanged full checkpoint. Clients dedupe by row `id`.
5. Add a `ConversationSendService` facade in `@pc/app-services` (or server-local first seam) over the existing send-queue repo + delivery helper, exposing the current behaviors as named commands: `sendUserTurn` (the `handlePromptSend` policy: ensure active session, direct-vs-enqueue, `send-ack`), `enqueueRuntimeTurn` (idempotent by `(sessionId, clientMessageId)`, for mailbox/system turns — returns the queue row; **no raw PTY send**), `deliverNextQueuedTurn`, `observeUserJsonl` (the `maybeAdvanceSendQueueConfirmation` correlation), `cancelQueuedTurn`, `retryFailedTurn`, `listVisibleTurns`. The facade is a thin wrapper: the existing `websocket-message.ts` and `runtime-host/routes.ts` call sites delegate to it; wire shapes (`send-ack`, `send-queue-snapshot`, status codes) are unchanged. A runtime turn port (`getState`/`sendToPty`) is injected so the facade does not import PTY classes.
6. Add a **pending-interaction shadow** for `/api/ask`: write a durable `pending_interactions` row (additive table — see DB section) when a hook ask arrives, keep the **existing in-memory resolver as the authoritative blocking response path**, and terminalize the shadow row to `expired`/`cancelled`/`answered` on timeout/answer. The `/api/ask` HTTP response stays `{ answer }`; the `ask` / `ask-reply` WS envelopes are unchanged. A `RuntimeHookAskAdapter` seam owns the shadow write so the resolver behavior is untouched. On server restart the orphaned shadow row is inspectable and can be swept to `expired` (it cannot unblock the lost HTTP connection — documented).
7. **Pending-interaction shadowing scope boundary.** This slice creates and terminalizes the shadow row and exposes it for inspection. It does NOT make the shadow row the answer authority, does NOT change the hook protocol, does NOT add a mailbox delivery, and does NOT migrate agent `pending_asks` into `pending_interactions` (that convergence is a slice-007 decision). The UI answer command continues to target `toolUseId`.
8. (Optional, behind the spec's "after the live-outbox layer exists" rule and only if it adds value without risk) Add LOW-frequency canonical nudges on the slice-002 `live_outbox` — `conversation.session.changed` and `conversation.send-queue.changed` (refetch hints, NO transcript payload) — with the existing `session-changed` / `send-queue-snapshot` WS envelopes preserved as legacy projections. **Do NOT** add `conversation.transcript.appended` for the high-frequency per-row `jsonl` stream this slice; the transcript stream stays the legacy `jsonl` broadcast (foundation-spec rule). If adding even the low-frequency nudges expands the diff beyond the read/facade seam, defer them and note it — they are not required for slice 006 (the pathway line for 006 does not mention live events).
9. Keep agent/subagent transcript reads as a READ-CONTRACT convergence only: map `ConversationKind='agent-run'`/`'subagent-transcript'` onto the existing `GET /agent-runs/:runId/events` + `/api/subagent-transcript` behind the transcript-read contract WITHOUT moving their storage, changing the path guard, or migrating `agent-jsonl-event` onto the outbox. This is optional for slice 006; if it touches the live agent fanout layer, defer to a later slice and note it.
10. Run the listed automated verification.

Non-goals (explicitly OUT — and which slice owns each):

- **Mailbox platform** — slice 007. This slice adds `enqueueRuntimeTurn` as the SEND FACADE the mailbox worker will later call, but does NOT build mailbox tables, delivery leases, ack/retry/dead-letter, the UI inbox, or the orchestrator-turn worker. Whether agent `pending_asks` mirror into `pending_interactions` is a slice-007 decision and OUT here.
- **Channel cutover** — slice 008. The `channel-send` proxy and any Channel delivery stay as-is.
- **Runtime-host / transient-worktrees split** — slice 009. Do NOT change `ProjectRuntime`, the PTY spawn/`ensurePty`/`InteractiveSession`, the JSONL tailer, transient-session handling, worktree/path-guard behavior, or split runtime methods into ports beyond the read-only `RuntimeTurnPort` injection the send facade needs. **The deferred host-resume defect (paused host-backed agent answer not threaded as the next user turn) is a slice-009 runtime-host concern and is explicitly NOT in this slice.**
- **MCP typed client / capability registry** — slice 010.
- **Compatibility cleanup** — slice 011. Do NOT remove any legacy route, WS envelope, send-queue status string, or `events.jsonl` fallback.
- Do NOT migrate transcripts to SQLite, make a SQLite transcript store the primary, or add a `conversation_events` mirror table this slice (mirror-only-after-parity is a later phase; this slice is file-backed-repository-first).
- Do NOT move the high-frequency `jsonl` transcript stream onto `live_outbox`, and do NOT put transcript history in `live_outbox.payload`.
- Do NOT change `/api/ask` blocking semantics, the `ask`/`ask-reply` envelopes, or make the shadow row the answer authority.
- Do NOT change the one-active-session-per-project invariant, the non-spawning connect snapshot, or send-queue `(sessionId, clientMessageId)` idempotency.
- Do NOT restart or kill dev servers while implementing or verifying.

## 5. Contract Plan

Files likely affected:

```text
packages/contracts/src/conversations.ts
packages/contracts/src/runtime-transcript.ts
packages/contracts/src/runtime-send-queue.ts
packages/contracts/src/runtime-hook-ask.ts
packages/contracts/src/live-events.ts        (extend entity/type union ONLY if §4.8 low-frequency nudges are kept; otherwise untouched)
packages/contracts/src/index.ts
packages/contracts/test/conversations.test.ts
packages/contracts/test/runtime-transcript.test.ts
packages/contracts/test/runtime-send-queue.test.ts
```

Contract rules (unchanged from slices 001–005): browser-safe, side-effect-free, zero runtime deps; no imports from apps, `@pc/db`, `@pc/domain`, `@pc/runtime`, `@pc/mcp`, Hono, React, or Node built-ins; parsers accept `unknown` and return `ParseResult<T>`.

Core DTOs (mirror the existing wire EXACTLY):

| Contract | Initial contents |
|---|---|
| `ConversationKind` | `'orchestrator-session' \| 'agent-run' \| 'subagent-transcript'`. |
| `ConversationSessionDto` | id, projectId, provider, providerSessionId, model, title, status (`'active'\|'ended'`), endedReason, startedAt, endedAt, jsonlPath, jsonlLineCursor. (Mirror of `OrchestratorSession`; `deletedAt` stays server-side / out of the rail DTO unless a route already returns it.) |
| `TranscriptSourceDto` | kind (`'claude-jsonl'\|'legacy-events-jsonl'` to match the current `ReplaySource.kind`; the spec's broader `TranscriptSourceKind` union is reserved for the later agent/terminal convergence), cursor (`number\|null`). |
| `TranscriptEventDto` | id, sessionId, seq, type (`'jsonl'\|'event'`), kind (`string\|null`), event (`unknown`), source (`TranscriptSourceDto`), optional clientMessageId. (Mirror of `ReplayEnvelope`; do NOT add `projectId`/`conversationKind`/`conversationId`/`createdAt` to the wire unless the route emits them — keep the response byte-identical.) |
| `TranscriptReplayResponse` | `{ ok: true; sessionId; highWaterSeq; events: TranscriptEventDto[]; resetRequired? }`. (Mirror of `{ ok, sessionId, highWaterSeq, events }`; `resetRequired` is reserved for the expired-cursor path.) |
| `RuntimeSendStatus` | the 8 existing strings: `queued_busy\|queued_spawning\|queued_backlog\|delivering\|delivered_to_pty\|observed_in_jsonl\|failed\|cancelled`. |
| `RuntimeSendQueueItemDto` | id, clientMessageId, text, status, createdAt, updatedAt, deliveryAttempts, failureReason. (Mirror of `PublicSendQueueItem`; do NOT add `projectId`/`sessionId` to the public item unless `publicSendQueueItem` already emits them.) |
| `SendRuntimeTurnRequest` / `SendRuntimeTurnResponse` | request `{ projectId, sessionId?, clientMessageId, text, source: 'user'\|'mailbox'\|'workflow'\|'system', sourceRef? }`; response `{ ok, status: 'received'\|'queued', queueItem }`. (For the `enqueueRuntimeTurn` facade; `source`/`sourceRef` are recorded but the queue row shape is unchanged.) |
| `RuntimeHookAskRequest` / `RuntimeHookAskResponse` | request `{ projectId, sessionId, toolName, toolUseId, toolInput }`; response `{ answer, interactionId? }`. (Parse-only over the existing `/api/ask` body + response; `interactionId` is the optional shadow-row id, additive and ignorable by the hook.) |

Contract decisions (recorded; see Open Questions):

- Contracts mirror the EXISTING wire, not the foundation spec's fuller shapes. The spec's `TranscriptEventDto<TEvent>` carries `projectId`/`conversationKind`/`conversationId`/`createdAt`; the current `ReplayEnvelope` does not. **Keep the response byte-identical** — add the richer fields only when a later slice introduces the cross-kind transcript table. (Open Q: confirm before widening the wire.)
- The transcript replay cursor is **per-session `seq`/`highWaterSeq`**, NOT a live-outbox cursor. The after-seq endpoint takes `afterSeq` (a transcript seq), distinct from `/api/live-events`'s `after` (a global outbox cursor).
- `enqueueRuntimeTurn` is idempotent by `(sessionId, clientMessageId)` (the existing unique index); a mailbox replay returns the existing row.
- The `/api/ask` shadow is a side write; the response authority remains the in-memory resolver. `interactionId` on the response is additive and optional.

## 6. App-Service / Repo Boundary

Files likely affected:

```text
packages/app-services/src/conversations/transcript-repository.ts   (FileTranscriptRepository)
packages/app-services/src/conversations/replay-service.ts          (ConversationReplayService)
packages/app-services/src/conversations/send-service.ts            (ConversationSendService)
packages/app-services/src/conversations/adapters.ts                (row/checkpoint -> DTO)
packages/app-services/src/conversations/index.ts
packages/app-services/src/index.ts                                 (re-export)
apps/server/src/services/session-replay.ts                         (source for FileTranscriptRepository; behavior unchanged)
apps/server/src/features/runtime-host/routes.ts                    (delegate session-events + cancel/retry; add afterSeq read)
apps/server/src/features/runtime-host/websocket-connect.ts         (replay via service; envelope unchanged)
apps/server/src/features/runtime-host/websocket-message.ts         (send path via ConversationSendService facade)
apps/server/src/services/orchestrator-send-queue-delivery.ts       (wrapped by the send facade; behavior unchanged)
apps/server/src/features/chat-bridges/routes.ts                    (ask shadow write via RuntimeHookAskAdapter)
packages/db/src/repos/orchestrator-sessions.ts                     (no schema change; reuse)
packages/db/src/repos/orchestrator-send-queue.ts                   (no schema change; reuse; add an idempotent enqueue helper if needed)
packages/db/src/repos/pending-interactions.ts                      (NEW repo over the additive table — see DB)
```

Service responsibilities:

| Service | Owns | Must not own |
|---|---|---|
| `FileTranscriptRepository` | Read-through of `jsonl-events.jsonl` (legacy fallback), `loadCheckpoint`/`listAfter`, `seq`/`highWaterSeq`, malformed-row skipping | Writes to JSONL, `InteractiveSession`, PTY, SQLite mirror, live events |
| `ConversationReplayService` | Map repository reads to the existing replay response shape; honor `afterSeq` | Storage decisions, PTY, send-queue transitions |
| `ConversationSendService` | `sendUserTurn`/`enqueueRuntimeTurn`/`deliverNextQueuedTurn`/`observeUserJsonl`/`cancelQueuedTurn`/`retryFailedTurn`/`listVisibleTurns` over the existing repo + delivery helper, via an injected `RuntimeTurnPort` | Raw PTY classes, WS hub, Channel, mailbox leases, HTTP status mapping (stays in the route/WS adapter) |
| `RuntimeHookAskAdapter` | Write/terminalize the `pending_interactions` shadow row around the existing resolver | The blocking resolve authority (stays the in-memory store), the hook protocol |

Purity rules (same as slices 003/004/005): the services may depend on `@pc/contracts`, `@pc/db`, `@pc/domain`; they must NOT import Hono, React, the websocket hub, Channel, MCP SDK, or runtime process classes (`InteractiveSession`, `ProjectRuntime`, PTY). The runtime turn port and the broadcast/fanout callbacks are injected at the server composition layer. **This slice has NO single-transaction durable-write-door** like slices 003/004/005 — the transcript repository is read-only over files, the send facade wraps an already-durable repo, and the ask shadow is a side write — so the "validate → persist → outbox-insert in one tx → fanout after commit" pattern applies ONLY to the optional §4.8 low-frequency nudges, if kept.

## 7. Route / Compat Adapter Plan

Files likely affected:

```text
apps/server/src/features/runtime-host/routes.ts          (delegate; add afterSeq query)
apps/server/src/features/runtime-host/websocket-connect.ts
apps/server/src/features/runtime-host/websocket-message.ts
apps/server/src/features/chat-bridges/routes.ts          (ask shadow)
apps/server/test/runtime-host-routes.test.ts
apps/server/test/chat-bridges-routes.test.ts
```

- Preserve every route and response shape:
  - `GET  /api/projects/:projectId/session`
  - `GET  /api/projects/:projectId/orchestrator/runtime`
  - `GET  /api/projects/:projectId/sessions`
  - `GET  /api/projects/:projectId/sessions/:sessionId/events` (full checkpoint; **add** optional `?afterSeq=&limit=`)
  - `GET  /api/projects/:projectId/sessions/:sessionId/terminal-transcript`
  - `POST /api/projects/:projectId/sessions/new`
  - `POST /api/projects/:projectId/sessions/:targetId/resume`
  - `POST /api/projects/:projectId/sessions/close`
  - `POST /api/projects/:projectId/send-queue/:sendId/cancel`
  - `POST /api/projects/:projectId/send-queue/:sendId/retry`
  - `POST /api/ask`
  - `GET  /api/subagent-transcript`
- The session-events route delegates to `ConversationReplayService`; with no `afterSeq` it returns the identical full checkpoint; with `afterSeq` it returns only newer rows (same envelope). The connect/new/resume `session-replay` and `send-queue-snapshot` envelopes are unchanged.
- The send path delegates to `ConversationSendService.sendUserTurn`; `send-ack` statuses + status codes preserved. Cancel/retry routes delegate to `cancelQueuedTurn`/`retryFailedTurn`; their 404/409 contracts preserved.
- `/api/ask` writes the shadow row through `RuntimeHookAskAdapter`, then runs the UNCHANGED resolver/timeout; response `{ answer }` (optionally `+ interactionId`). If adding `interactionId` to the response changes any current client's parsing, STOP and confirm (default: response is unchanged and `interactionId` is omitted).
- No MCP stage this slice (conversation send/replay is not exposed as a `pc_*` tool today; the mailbox runtime-turn worker that will call `enqueueRuntimeTurn` is slice 007). If the build reveals an MCP caller, STOP and confirm.

## 8. Live Event / Replay / WebSocket Compatibility Plan

Files likely affected:

```text
apps/web/src/features/runtime/client.ts        (add afterSeq query option)
apps/web/src/hooks/chat-session-reducer.ts      (apply after-seq rows by seq + dedupe by id; behavior-preserving)
apps/web/src/hooks/use-project-ws.ts            (optional: request after-seq on reconnect instead of always full checkpoint)
apps/server/src/features/live-events/routes.ts  (ONLY if §4.8 nudges are kept; contract-driven accept-list)
apps/server/test/live-events-routes.test.ts     (ONLY if §4.8 nudges are kept)
```

- **Transcript replay stays repository-backed, NOT live-event-backed.** The reconnect/refresh path remains `session-replay` (full checkpoint) plus the new optional after-seq read. Live events do NOT carry transcript rows.
- The high-frequency `jsonl` WS frame is unchanged (transient projection of `jsonl-events.jsonl`). The `clientMessageId` stamp on `jsonl-user` (placeholder reconcile) is preserved.
- If the §4.8 low-frequency nudges are kept: extend `/api/live-events` to accept `type=conversation.session.changed` / `type=conversation.send-queue.changed` (project-scoped; honor `projectId`); fan out canonical `{ type:'live-event', event }` AFTER the outbox row commits, plus the legacy `session-changed`/`send-queue-snapshot` envelopes. Otherwise this section is read/facade-only and `/api/live-events` is untouched.
- Keep `/ws`, `ProjectWebSocketHub.broadcastTo`/`broadcastAll`, and all existing runtime envelopes unchanged.

## 9. Identity / Cursor / Lifecycle

**Conversation identity.** `orchestrator_sessions` remains the durable session identity (one active per project). The contract `ConversationKind` distinguishes orchestrator sessions from agent-run and subagent transcripts for the read contract; only `'orchestrator-session'` is wired to a live repository this slice.

**Two distinct cursors (do not conflate).** The transcript replay cursor is the per-session `seq`/`highWaterSeq` from `jsonl-events.jsonl` (after-seq read uses it). The slice-002 live-outbox cursor is the global monotonic `live_outbox.seq` (used by `/api/live-events`). The chat reducer already uses the transcript cursor; it does NOT consume the outbox cursor. The after-seq endpoint MUST NOT be implemented against the outbox cursor.

**Send lifecycle.** Unchanged: direct ready send → `delivered_to_pty`; busy/spawning/backlog → queued; `jsonl-user` FIFO match → `observed_in_jsonl`; cancel only on queued; retry only on failed. `enqueueRuntimeTurn` adds a mailbox/system entry point with the same idempotency; it never raw-sends to the PTY (the delivery loop drains it).

**Pending-ask / interaction lifecycle.** The in-memory resolver remains the answer authority. The shadow `pending_interactions` row is created on `/api/ask`, terminalized on answer/timeout, and swept to `expired` on boot for orphans. It is inspectable but cannot unblock a lost HTTP connection. Agent `pending_asks` (slice 005) are NOT merged into this table this slice.

## 10. DB

- **Migration needed: yes — ONE additive table, only for the pending-interaction shadow.** All other surfaces reuse existing tables: `orchestrator_sessions`, `orchestrator_send_queue`, and (only if §4.8 nudges are kept) the slice-002 `live_outbox`. The transcript repository is file-backed (no table). The send facade wraps the existing send-queue repo (no schema change). The ONLY required schema change is an **additive** `pending_interactions` table for the `/api/ask` shadow.

  Proposed additive `pending_interactions` (additive, nullable/defaulted columns, no rewrite of any existing row):

  ```text
  pending_interactions
    id            (ULID, pk)
    project_id
    session_id            (nullable)
    kind                  ('hook-ask' for this slice)
    tool_name             (nullable)
    tool_use_id           (the /api/ask correlation key; unique with kind)
    tool_input_json       (nullable)
    status                ('open' | 'answered' | 'cancelled' | 'expired')
    answer                (nullable)
    created_at
    answered_at           (nullable)
    terminated_at         (nullable)
  ```

  Indexes: unique `(kind, tool_use_id)`; index `(project_id, status)`.

- **If the user prefers zero migration this slice**, the shadow can be deferred: ship the contracts + repository + replay service + send facade + after-seq read WITHOUT the `pending_interactions` table, and keep `/api/ask` entirely as-is (the shadow becomes a slice-007 concern alongside mailbox/pending-interactions). The migration is additive and low-risk, but it is the only schema change in the slice — **STOP and confirm the table vs defer-the-shadow choice before adding the migration** (prior slices were strictly no-migration; this is the first that may add one, by design of the foundation spec's Phase 7 ask-shadow step).
- No `conversation_events` SQLite transcript table is added (mirror-only-after-parity is a later phase). No existing table is altered destructively.

## 11. Test Plan

Minimum automated tests (add before behavior changes where practical), mirroring the slice-002/003/004/005 style:

| Priority | Test | Purpose |
|---|---|---|
| P0 | `packages/contracts/test/conversations.test.ts` + `runtime-transcript.test.ts` + `runtime-send-queue.test.ts` | Parser/guard coverage for session/transcript/send-queue/hook-ask DTOs; mirror-exactness (no extra wire fields); invalid status/scope rejected; round-trip of the existing replay envelope + public send-queue item. |
| P0 | `FileTranscriptRepository` parity test | `loadCheckpoint` returns the SAME `{ sessionId, highWaterSeq, events }` as `loadSessionReplayCheckpoint` for fixtures (jsonl-events valid, malformed-skip, legacy `events.jsonl` fallback, empty). |
| P0 | `listAfter(afterSeq)` test | Returns only rows with `seq > afterSeq`, dedupe by `id`, `highWaterSeq` stable; `afterSeq=0` equals the full checkpoint; `afterSeq>=highWaterSeq` returns empty. |
| P0 | `ConversationReplayService` route-parity test | `GET /sessions/:id/events` returns byte-identical `{ ok, sessionId, highWaterSeq, events }`; `?afterSeq=` returns the trimmed set in the same envelope. |
| P0 | `ConversationSendService` behavior tests | ready send → `received` + `delivered_to_pty`; busy/spawning/backlog → `queued` with correct status; `observeUserJsonl` marks the first FIFO match `observed_in_jsonl` once and stamps `clientMessageId`; cancel only queued; retry only failed; `enqueueRuntimeTurn` idempotent by `(sessionId, clientMessageId)` and never raw-sends. |
| P0 | Connect-snapshot non-spawn test | The connect snapshot through the service does not spawn a PTY and emits the same `session-changed`/`session-replay`/`send-queue-snapshot` envelopes. |
| P0 | `apps/server/test/runtime-host-routes.test.ts` | All listed routes preserve bodies + status codes; session/sessions/events/new/resume/close/cancel/retry unchanged; the after-seq query is additive. |
| P0 | Ask-shadow test | `/api/ask` still broadcasts `ask`, blocks on the in-memory resolver, resolves via `ask-reply`, times out with the current text; the shadow row is written `open` and terminalized `answered`/`expired`; the HTTP response is `{ answer }` (shadow does not change it). |
| P1 | Ask-shadow boot-sweep test | An orphaned `open` shadow row is swept to `expired` on boot and does not attempt to unblock anything. |
| P1 | `apps/web/test/chat-after-seq-replay.test.ts` | The reducer applies after-seq rows by `seq`, dedupes by `id`, and yields the same timeline as a full checkpoint; out-of-order/duplicate rows are coalesced. |
| P1 | (only if §4.8 nudges kept) `live-events-routes.test.ts` updates | Replay returns project-scoped `conversation.session.changed`/`conversation.send-queue.changed` after cursor; excludes other-project events; transcript history never appears in `live_outbox.payload`; `project.changed`/`work-item.changed`/`workflow.*`/`agent.run.changed` unchanged. |

Gate commands (run from repo root; matches slices 002–005):

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

`@pc/app-services` already has the package-local `tsx --test "test/*.test.ts"` script (slice 003); reuse it. If the additive `pending_interactions` table is added, `pnpm --filter @pc/db test` must cover the new repo + the migration applying cleanly on a fresh DB (mirror the slice-002 `live_outbox` migration test).

Manual verification after implementation (batched to the human end-of-section pass):

- Start chat, send a prompt, refresh mid-turn; confirm replay + send-queue state is coherent (no duplicate user rows).
- Disconnect the chat socket during a turn, reconnect; confirm the after-seq path (or full checkpoint) recovers the visible transcript without duplication.
- Send multiple identical prompts; confirm placeholder reconciliation (`clientMessageId` stamp) remains stable.
- Switch to a past session, view events, resume it; confirm the active session changes correctly and the replay matches.
- Cancel a queued prompt and retry a failed one; confirm the queue snapshot updates.
- Trigger `AskUserQuestion`; confirm one ask card appears, answering unblocks the hook, and (if the shadow shipped) the `pending_interactions` row terminalizes.
- Use terminal mode; confirm raw input/output still works and bypasses the send queue.
- Confirm agent transcript modal backfill + live append still work.
- Confirm chat/workflow/work-item/agent-run behavior is otherwise unchanged.

## 12. Migration Steps

1. Add contract tests + the contract files (`conversations`, `runtime-transcript`, `runtime-send-queue`, `runtime-hook-ask`); extend `index.ts`.
2. Add `FileTranscriptRepository` (read-through of `loadSessionReplayCheckpoint`) + parity tests.
3. Add `ConversationReplayService`; repoint the session-events route + connect/new/resume replay to it (identical envelopes); add the additive `?afterSeq=` read.
4. Add `ConversationSendService` over the existing send-queue repo + delivery helper (inject the `RuntimeTurnPort`); repoint `handlePromptSend` + cancel/retry routes; add `enqueueRuntimeTurn`.
5. (If confirmed) add the additive `pending_interactions` table + repo; add `RuntimeHookAskAdapter`; write the shadow row around the unchanged `/api/ask` resolver + a boot sweep.
6. Add the web after-seq client option + reducer handling (behavior-preserving).
7. (Optional, if kept) add the low-frequency `conversation.session.changed`/`conversation.send-queue.changed` outbox nudges + replay-route accept-list + legacy projections.
8. Run automated verification.
9. Update trackers with implementation notes.

## 13. Rollback Plan

- Contracts are additive; revert the conversation/runtime files to drop the family.
- `ConversationReplayService` delegates to the existing `loadSessionReplayCheckpoint`; the route can be reverted to call it directly. The after-seq read is additive (drop the query handling).
- `ConversationSendService` is a thin wrapper; revert the call sites to the current `handlePromptSend`/delivery-helper/route code. `enqueueRuntimeTurn` is additive and inert if no caller exists (mailbox is slice 007).
- The `pending_interactions` shadow is a side write: disable the adapter to restore the exact current `/api/ask` behavior; the additive table is inert if unused. If the table was not added (defer-the-shadow choice), there is nothing to roll back.
- The optional outbox nudges reuse the additive slice-002 `live_outbox`; they can be ignored by the web client without changing product state, and the legacy `session-changed`/`send-queue-snapshot` envelopes remain the UI path.
- No transcript file format or `events.jsonl` fallback changes, so old sessions keep replaying regardless.

## 14. Stop Conditions

Stop and return to planning if implementation requires any of the following:

- Migrating transcripts to SQLite, making a SQLite transcript store primary, adding a `conversation_events` mirror table, or changing `InteractiveSession` JSONL writes.
- Moving the high-frequency `jsonl` transcript stream onto `live_outbox` or putting transcript history in `live_outbox.payload`.
- Changing `/api/ask` blocking semantics, the `ask`/`ask-reply` envelopes, or making the shadow row the answer authority.
- Adding more than the single additive `pending_interactions` table, or any destructive/altering migration. (The `pending_interactions` table is the only allowed schema change, and only after explicit confirmation of table-vs-defer.)
- Building mailbox tables/leases/ack/retry/dead-letter, the UI inbox, or the orchestrator-turn worker (slice 007), or merging agent `pending_asks` into `pending_interactions`.
- Retiring or changing the Channel `channel-send` proxy or any Channel delivery (slice 008).
- Changing `ProjectRuntime`, PTY spawn/`ensurePty`/`InteractiveSession`, the JSONL tailer, transient-session handling, worktree/path-guard behavior, or splitting runtime methods into ports beyond the read-only `RuntimeTurnPort` (slice 009). **Including any work on the deferred host-resume defect (slice 009).**
- Renaming routes, changing existing response bodies/status codes, or removing any legacy WS envelope or send-queue status string (cleanup is slice 011).
- Adding `interactionId` to the `/api/ask` response in a way that changes current client parsing.
- Exposing conversation send/replay as a new `pc_*` MCP tool (slice 010).
- Replacing `/ws`, changing connection/spawn semantics, the one-active-session invariant, or restarting/killing dev processes.
- Conflating the transcript `seq` cursor with the global live-outbox cursor.

## 15. Acceptance Criteria

This slice is ready to implement only when the user explicitly asks to build and these criteria are accepted:

- `@pc/contracts` owns session / transcript-replay / send-queue / hook-ask DTOs + parser/guard helpers, mirroring the existing wire exactly.
- A file-backed `TranscriptRepository` + `ConversationReplayService` back the session-events route and connect snapshot with byte-identical responses; an additive after-seq read uses the transcript `seq` cursor.
- A `ConversationSendService` facade owns send/enqueue/cancel/retry/observe over the existing send queue, exposes a mailbox-safe `enqueueRuntimeTurn`, and never raw-sends; the existing call sites delegate with unchanged wire shapes.
- `/api/ask` keeps blocking semantics; the (confirmed) durable `pending_interactions` shadow row is created/terminalized/inspectable and is NOT the answer authority.
- The high-frequency `jsonl` stream stays legacy/transient; transcript history never enters `live_outbox`.
- DB change is at most one additive `pending_interactions` table (or none, if the shadow is deferred); no destructive migration.
- Tests cover contracts, repository parity, after-seq replay, send-service behavior, route/envelope parity, the ask shadow, and (if kept) the low-frequency nudges.
- Mailbox, Channel, runtime-host split (incl. the deferred host-resume defect), MCP, and cleanup remain untouched except for unaffected typecheck/test fallout.
- Tracker marks this build-slice artifact `planned`.

## 16. Open Questions

| Question | Status |
|---|---|
| Should the transcript DTO mirror the current `ReplayEnvelope` exactly, or adopt the spec's richer `TranscriptEventDto` (projectId/conversationKind/conversationId/createdAt)? | Resolved for v1: mirror the existing wire exactly (byte-identical responses). Widen only when a cross-kind transcript table lands (later slice). |
| First after-seq route shape: new `/conversations/*` routes, or `?afterSeq=` on the existing `/sessions/:id/events`? | Resolved for v1: add `?afterSeq=` to the existing route (additive, lowest risk). New `/conversations/*` routes wait for the cross-kind convergence. |
| Add the `pending_interactions` shadow (one additive table) this slice, or defer the ask shadow to slice 007? | **Resolved (human decision, build Session 24): DEFER the durable pending-interaction shadow + its `pending_interactions` table to slice 007.** Slice 006 ships zero migrations / no schema change; `/api/ask` is untouched. The parse-only `runtime-hook-ask` wire-mirror contract still ships. |
| Keep the optional low-frequency `conversation.session.changed`/`conversation.send-queue.changed` outbox nudges, or leave the slice read/facade-only? | Resolved for v1: leave them OUT unless they add clear value without expanding the diff — the pathway line for 006 does not mention live events, and the spec forbids transcript-on-outbox. If kept, they are refetch-only nudges with legacy projections. |
| Should `enqueueRuntimeTurn`'s `source`/`sourceRef` be persisted on the send-queue row? | Resolved for v1: recorded by the facade for the mailbox target ref, but the queue row shape stays unchanged (no migration on `orchestrator_send_queue`); mailbox owns the target-ref store (slice 007). |
| Should agent/subagent transcript reads converge onto the transcript-read contract this slice? | Resolved for v1: read-contract mapping only, and only if it does not touch the live agent fanout layer; otherwise defer and note. Storage convergence is later. |
| How should an orphaned hook-ask shadow row terminalize after a server restart? | Resolved for v1: boot sweep to `expired`; it cannot unblock the lost HTTP connection (documented). Durable answer-resume is a pending-interactions/mailbox concern (slice 007). |
| Should the in-memory resolver eventually be replaced by the durable interaction? | Deferred to slice 007 (mailbox/pending-interactions). This slice only shadows. |

## 17. Notes for the Implementation Agent

- Reuse the slice-002 `live_outbox` + replay route + web `liveEventsApi` ONLY if you keep the optional §4.8 nudges; do not add a second outbox and do not invent a parallel live mechanism. This slice is primarily a READ + FACADE seam — unlike slices 003/004/005, there is no high-frequency durable-write-door here.
- The chat is ALREADY a faithful render of JSONL and the transcript replay cursor (`seq`/`highWaterSeq`) ALREADY exists and is ALREADY separate from the outbox cursor — do NOT reinvent either. Surface them through the repository/service; keep responses byte-identical.
- Start with contracts (mirroring the exact wire) + the `FileTranscriptRepository` parity test before touching any route. The risk here is response-shape drift and send-facade behavior parity, NOT TypeScript surface area.
- The send facade wraps an already-durable repo + delivery helper; inject a `RuntimeTurnPort` (`getState`/`sendToPty`) so the service stays free of PTY classes. Keep `send-ack`/`send-queue-snapshot`/status codes identical.
- The `/api/ask` shadow is a SIDE write; do NOT touch the in-memory resolver, the `ask`/`ask-reply` envelopes, or the 10-minute timeout text. If adding the `pending_interactions` table, mirror the slice-002 migration test (fresh-DB apply) and watch the Drizzle ledger trap noted in MEMORY (a recorded-but-not-applied migration crashes fresh-DB boot).
- Do NOT touch `ProjectRuntime`, the PTY/`InteractiveSession`, the JSONL tailer, or the deferred slice-009 host-resume defect.
- Keep agent/subagent transcript endpoints + `agent-jsonl-event` + the `/api/subagent-transcript` path guard intact; convergence is read-contract-only and optional.
- Do not use `archive/` as evidence or a source for tests.
