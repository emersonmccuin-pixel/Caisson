# Conversations & Chat

> **Role:** Store (conversation persistence) · UI (chat rendering) · cross-cutting (send, replay, dual-stream dedup)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> - `apps/server/src/services/conversation-replay.ts`
> - `apps/server/src/services/conversation-send.ts`
> - `apps/server/src/services/session-replay.ts`
> - `apps/server/src/services/session-title-writer.ts`
> - `apps/server/src/services/ask-shadow.ts`
> - `apps/server/src/features/chat-bridges/routes.ts`
> - `packages/runtime/src/chat-policy.ts`
> - `packages/contracts/src/conversations.ts`
> - `packages/contracts/src/runtime-transcript.ts`
> - `packages/db/src/repos/orchestrator-sessions.ts`
> - `packages/db/src/repos/post-turn-summaries.ts`
> - `apps/web/src/hooks/chat-session-reducer.ts`
> - `apps/web/src/features/chat/useChatRenderItems.ts`
> - `apps/web/src/features/chat/normalizeJsonlEnvelope.ts`
> - `apps/web/src/features/chat/toolGrouping.ts`
> - `apps/web/src/features/chat/ChatSurface.tsx`
> - `apps/web/src/features/chat/chatRendererFlag.ts`

---

## What it is (plain English)

Every conversation between the user and the orchestrator is stored in SQLite as an `orchestrator_sessions` row, with the full transcript living in a CC-written JSONL file on disk. The chat panel the user sees is a live projection of that transcript — events stream in over WebSocket as the orchestrator types, and on page load the whole session replays from disk so nothing is lost between refreshes. A separate "chat about a work item" bridge lets the orchestrator open a work-item detail modal inline when it mentions one.

---

## What it's supposed to do (intent)

Own the **durable conversation record** (the session row + the on-disk JSONL) and render it as a chat UI that is a pure view over those stored events. The chat panel must show the same history after a reload as it did live — no events disappear, no duplicates appear, no ordering changes.

---

## How it works today (as-built)

### Storage

- `orchestrator_sessions` table (SQLite, `packages/db/src/repos/orchestrator-sessions.ts`):
  - One active row per project (DB-enforced unique index).
  - Key fields: `providerSessionId` (the CC session UUID, minted by PC and passed via `--session-id`), `jsonlPath` (the CC JSONL file once discovered), `jsonlLineCursor` (line offset written debounced ~1s, so restart + `--resume` skips already-processed lines), `title`, `status` (`active`/`ended`), `endedReason`.
  - `reactivateOrchestratorSession` flips an ended session back to active so clicking a past session in the left rail resumes it without minting a new row (preserving CC history).
  - `providerSessionId` is minted by PC before spawn (`createOrchestratorSession`) so the row exists before any hook fires.

- `post_turn_summaries` table (`packages/db/src/repos/post-turn-summaries.ts`):
  - Append-only rows keyed by `summarizesUuid` (idempotent — CC replay won't create duplicates).
  - Written on every `jsonl-post-turn-summary` event; read surface is deferred (no UI yet).

### Send flow

`apps/server/src/services/conversation-send.ts` builds a `ConversationSendService` (from `@pc/app-services`) per call, injecting the project runtime's `RuntimeTurnPort` (the PTY's `getState`/`send` surface). The service owns: validation that a session is active, queueing when the PTY is busy, broadcasting queue snapshots over WS, and the `send-ack` response. No PTY class crosses the package boundary — the service only sees the port interface.

- Route: `POST /api/projects/:id/sessions/send`
- The composer calls `onSend`, which calls `runtimeApi.send`, which hits this route.
- The PTY's send queue (`orchestrator-send-queue-delivery.ts`, not detailed here) delivers to the live PTY and emits `send-queue-snapshot` WS frames the reducer tracks.

### Replay (loading history)

Two layers:

1. **Server side** — `apps/server/src/services/session-replay.ts:loadSessionReplayCheckpoint()`:
   - Reads `<sessionDataPath>/jsonl-events.jsonl` (the PC-written normalized event log from the JSONL tailer). Primary source since Section 23.
   - Falls back to `events.jsonl` (legacy hook-written file) for sessions predating Section 23.
   - Returns a `SessionReplayCheckpoint`: seq-sorted `ReplayEnvelope[]` + `highWaterSeq`.
   - The route wrapping this (`GET /api/projects/:id/sessions/:sessionId/events`) also supports an `?afterSeq=` cursor (`packages/contracts/src/runtime-transcript.ts:parseTranscriptAfterSeqQuery`) for additive catch-up without re-fetching the full checkpoint.

2. **Client side** — `apps/web/src/hooks/chat-session-reducer.ts:applySnapshot()`:
   - A `session-replay` WS envelope (or the `session-transition` HTTP response) triggers a full re-seed of the `sequenced` entries (ordered by `seq`) and rebuilds the timeline.
   - Live `jsonl` deltas arriving after replay are inserted into the timeline at their correct `seq` position, never appended blindly by arrival order.
   - Dedup: if a seq-keyed entry already exists, the reducer updates the envelope in-place without re-folding it into aggregates (prevents double-counting `jsonl-usage` tokens).
   - `highWaterSeq` tracks the frontier; additive reconnects fetch only `seq > highWaterSeq`.

### Chat rendering pipeline

The event array flows through a five-stage pipeline in the client:

1. **Reducer** (`chat-session-reducer.ts`) — owns ordering. Splits events into `sequenced` (have a `seq` + `sessionId`) and `unsequenced` (ask prompts, runtime-state, send-ack). Materialises them into a flat `WsEnvelope[]` via `materializeChatSessionEvents`, sequenced entries first in seq order, terminal-raw appended last.

2. **`buildCanonicalChatEnvelopes`** (`useChatRenderItems.ts`) — the canonical path (on by default as of 2026-06-03, flag `isJsonlCanonicalChat()` in `chatRendererFlag.ts`). Keeps only `type:'jsonl'` and `type:'ask'` envelopes from the flat array. Filters hidden rows via `rowPolicy()` (`packages/runtime/src/chat-policy.ts`). Converts surviving `jsonl` envelopes to hook-shape via `normalizeJsonlEnvelope()`. Appends pending-prompt placeholders.
   - The legacy path (frozen as A/B baseline) passes all `type:'event'` envelopes through too — the dual-source that caused duplicates.

3. **`rowPolicy()`** (`packages/runtime/src/chat-policy.ts`) — pure function, classifies every `JsonlEvent` kind as `shown`/`collapsed`/`hidden` and assigns a `lane`. Suppression happens at the view; hidden rows are never discarded (a debug toggle in `ChatSurface` reveals them). Internal tools (`Agent`, `Task`, `TodoWrite`, etc.) are `hidden`. `INTERNAL_TOOLS` set here mirrors `SUPPRESSED_TOOLS` in `toolGrouping.ts` (Stage 3 will delete `toolGrouping`'s copy).

4. **`synthesizeRenderItems`** (`toolGrouping.ts`) — groups consecutive `tool-start`/`tool-end` pairs into `tool-group` items; promotes `Edit`/`Write`/`NotebookEdit` calls to standalone `edit` items; coalesces consecutive `sidechain` (sub-agent) steps into `sidechain-group` items; hoists workflow and agent-dispatch events from user-turn text into dedicated `workflow-run-group` / `agent-dispatch-group` items.

5. **`useChatTimelineRenderer`** (`useChatTimelineRenderer.tsx`) — renders each `RenderItem` to a React node. Handles `ask` envelopes (inline `AskCard`), tool groups, edit bubbles, agent-dispatch and workflow cards, sidechain groups, and standard `EventBubble` rows.

### Session title

`apps/server/src/services/session-title-writer.ts:announceSessionTitle()` writes a `session.title.changed` row to `live_outbox` inside a transaction. The live relay drains it post-commit and fans the frame to the project's WS subscribers — the chat title bar updates without a refetch.

### Ask / ask-shadow (`/api/ask`)

`apps/server/src/features/chat-bridges/routes.ts:registerChatBridgeRoutes()` registers:

- `POST /api/ask` — hook scripts POST here when the orchestrator calls an ask tool. The server broadcasts `{ type:'ask', toolUseId, ... }` to the project's WS subscribers, then blocks on an in-memory `InMemoryPendingAskStore` resolver until the user answers or a 10-minute timeout fires.
- The `AskShadow` service (`apps/server/src/services/ask-shadow.ts`) is a best-effort side-write: on ask it creates an `open` `pending_interactions` row (writing a `live_outbox` row inside the transaction so the relay fans it); on resolve/timeout it terminalises the row. The in-memory resolver is still the authoritative blocking path — the shadow is only inspectable.
- `GET /api/subagent-transcript` — reads a CC JSONL file from under `~/.claude/projects/` (path-containment checked) and returns parsed events for the inline agent-card transcript view.
- `POST /api/projects/:projectId/channel-send` — proxies a test message to the channel server at `/channel/<slug>/test`.

### Chat-about-work-item bridge

`apps/web/src/components/ChatWorkItemModalMount.tsx`: a shell-level mount driven by the `useChatWorkItemModal` store. When the store transitions to a non-null `workItemId` (set by clicking a rich-link in the chat timeline), it lazily fetches the project's work-item list and opens `WorkItemDetailModal`. Supports callsign-based references (`example-project-4`) as well as ULID matches. Live-refreshes the open item off the identity-keyed `useLiveEntitySignature` signature.

---

## Integrations (how it connects)

- **Depends on:**
  - `ProjectRuntime` / `InteractiveSession` — provides the `RuntimeTurnPort` the send service writes to; also the source of the JSONL tailer that writes `jsonl-events.jsonl` (see `transcript-tailers.md`).
  - `live_outbox` / live-relay — session title changes and ask-shadow state changes flow through the outbox drain, not direct broadcast.
  - `@pc/app-services` — `ConversationReplayService`, `ConversationSendService`, `PendingInteractionService` (the domain-layer wrappers the server adapters bind).
  - `pending_interactions` table — the ask-shadow's durable record.
  - `post_turn_summaries` table — written from the JSONL tailer when CC emits a `jsonl-post-turn-summary`.

- **Used by:**
  - `Orchestrator.tsx` / `ChatSurface.tsx` — the primary consumer of the chat event array.
  - `AgentDesignerChat` — transient modal sessions also render through `ChatSurface`.
  - Agent cards / inline JSONL transcript — `GET /api/subagent-transcript` feeds agent-run transcript cards in the workflow card view.
  - WS reconnect path — `use-project-ws.ts` issues an after-seq fetch on reconnect using `getSessionEventsAfter`.

- **Contracts / events crossed:**
  - `ConversationSessionDto`, `TranscriptEventDto`, `TranscriptReplayResponse` (`packages/contracts/src/conversations.ts`, `runtime-transcript.ts`) — browser-safe wire shapes.
  - `WsEnvelope` (type: `session-replay`, `session-changed`, `ask`, `jsonl`, `event`, `send-ack`, `send-queue-snapshot`) — the WS message shapes the reducer and chat pipeline consume.
  - `live_outbox` rows typed `session.title.changed` and `pending-interaction.changed` — relay-fanned to subscribers.

---

## Target shape (per north star)

Per `unified-process-supervision-2026-06-02.md §2` and the system thesis in `AGENTS.md`:

> Chat is a **pure view** over a durable **Store** (append-only event log). The UI shell owns nothing — it reattaches to the Brain.

**What stays:**
- The `orchestrator_sessions` table (KEEP — source of truth for conversation identity and the JSONL path cursor).
- The `live_outbox`-driven title and ask-shadow flow (already correct: write in txn, relay drains).
- `rowPolicy` / `chat-policy.ts` as the single suppression table (Stage 3 deletes `toolGrouping.ts`'s duplicate `SUPPRESSED_TOOLS` set).
- The canonical JSONL-only renderer path (`buildCanonicalChatEnvelopes`) — this is the target.
- The `chat-session-reducer` seq-ordered timeline — directly maps to the "event log projection" principle.

**What changes:**
- Today the replay source is an on-disk `jsonl-events.jsonl` file written by `PtySession`'s tailer (Brain-side, file-based). In the target, the **Store** is the append-only event log in SQLite; replay becomes a query over that log, not a file read. The `session-replay` WS envelope becomes a query result rather than a file scan.
- The `ConversationSendService`'s `RuntimeTurnPort` today reaches into `ProjectRuntime`→`InteractiveSession`. After Steps 4–5 (`unified-process-supervision §9`), the orchestrator session moves to the Engine, so the send path adapts: the Brain routes the send to the Engine rather than calling into a Brain-owned `PtySession` directly.
- `post_turn_summaries` — write path stays; the missing read surface (no UI) gets built as part of the slow migration.
- The legacy render path (frozen `type:'event'` dual-source) gets deleted once Stage 5/6 of the chat-canonical redesign validates the canonical path. No behavioral change — the canonical path is default-on.

**Consolidation-ledger verdict (`consolidation-ledger-2026-06-02.md`):**
- No explicit row for conversation/chat in the ledger's "Sources of truth" section, but `orchestrator_sessions` is listed as KEEP-as-truth (§ Sources of truth, V7). The chat rendering subsystem itself is UI-layer and falls under "pure view" — nothing to consolidate, only the file-based replay source to migrate to the DB event log (Slice-3 work, same row as `workflow_run_events`).

---

## Known issues / scar tissue

### Dual-stream render identity (legacy path — historical)
The legacy path accumulated both `type:'event'` hook envelopes AND `type:'jsonl'` JSONL envelopes for the same turn. To avoid remount flicker, the surviving JSONL envelope had to inherit the hook envelope's array index via a `replacedBy` map. Getting the keying wrong caused the chat to "eat up" (remount flicker / lost messages). Burned twice (memory: `[PC-PTY dual-stream render identity]`). The canonical path (`buildCanonicalChatEnvelopes`) eliminates this entirely by accepting only `jsonl` and `ask` — no hook `event` content, no dedup problem. `replacedBy` is deleted from the live code.

### CC queue protocol shift (tailer)
CC ≥2.1 uses `remove` (not just `dequeue`) on queue-consume; queued commands persist as `type:"attachment"` with `attachment.type === "queued_command"`, not as plain user rows. The JSONL tailer must handle both halves or the send-queue UX silently breaks (memory: `[CC ≥2.1 queue protocol shift]`). The `normalizeJsonlEnvelope` already routes `jsonl-queue-enqueue` / `jsonl-queue-dequeue` kinds — confirm the tailer's parsing matches CC's current emit shape.

### Replay source is a file, not a DB query
`session-replay.ts` does synchronous `readFileSync` on `jsonl-events.jsonl`. This works today but is fragile: path discovery happens in the brain, the file is written by the Engine's tailer, and the coupling relies on the file being present and complete. Any race between the tailer write and the replay read can yield a partial checkpoint. The target (DB event log as truth) removes this.

### Legacy `events.jsonl` fallback
For sessions created before Section 23, replay falls back to `events.jsonl` (the hook-written file). These sessions render in "some shape" but not with the full canonical JSONL types. There is no migration path — once a session predates 23.1, it stays on the legacy format.

### Session title announced outside txn (historical — fixed)
The old path called a direct WS broadcast for `session-title-updated` inside or adjacent to the DB write. The current `session-title-writer.ts` correctly writes to `live_outbox` inside the transaction and relies on the relay to fan it post-commit. The comment in the file notes the prior anti-pattern explicitly.

### `post_turn_summaries` — write-only today
The table is populated on every `jsonl-post-turn-summary` event. No UI surface reads it yet (deferred per buildout note in `post-turn-summaries.ts:1`). Useful metadata is accumulating invisibly.

---

## Open questions

1. **When does the canonical render path become the only path?** The legacy path is "frozen as A/B baseline" in `useChatRenderItems.ts:126`. Once the canonical path has enough production time, the legacy branch should be deleted (one-path rule). What is the acceptance gate?

2. **After-seq fetch on reconnect** — the WS handler issues `getSessionEventsAfter(projectId, sessionId, highWaterSeq)`. What happens if `highWaterSeq` is stale from a prior session that was resumed? The reducer resets `highWaterSeq` to 0 on `new-session` but not on `resume`. Potential for a missed-events window if the reconnect fires before the replay lands. (Unverified — inspect `use-project-ws.ts` reconnect sequence.)

3. **`rowPolicy` vs `normalizeJsonlEnvelope` sync** — the comment in `useChatRenderItems.ts:78` says their hidden sets are "proven equal" by `chat-policy.test.ts`. That test is the guard; confirm it runs in CI.

4. **`SUPPRESSED_TOOLS` duplication** — `toolGrouping.ts:20` and `chat-policy.ts:36` both define the same set. Stage 3 of the redesign deletes `toolGrouping`'s copy. Track so it doesn't silently diverge first.

5. **Replay source migration** — moving from file-based `jsonl-events.jsonl` to a DB query is Slice-3 work (`workflow_run_events` row in the ledger). What is the sequencing relative to Step 6 (converge lifecycle primitive) and the Engine absorbing the tailer? The tailer writes the file; once the Engine owns it, the write path changes, and the Brain's replay route must follow.
