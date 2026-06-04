# Conversations & Chat

> **Role:** Store (conversation persistence) · UI (chat rendering) · cross-cutting (send, replay, dual-stream dedup)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `apps/server/src/services/conversation-send.ts` · `conversation-replay.ts` · `session-replay.ts` · `session-title-writer.ts` · `ask-shadow.ts`
> `apps/server/src/features/chat-bridges/routes.ts`
> `packages/runtime/src/chat-policy.ts` · `packages/contracts/src/conversations.ts` · `runtime-transcript.ts`
> `packages/db/src/repos/orchestrator-sessions.ts` · `post-turn-summaries.ts`
> `apps/web/src/hooks/chat-session-reducer.ts` · `apps/web/src/features/chat/useChatRenderItems.ts` · `normalizeJsonlEnvelope.ts` · `toolGrouping.ts` · `ChatSurface.tsx` · `chatRendererFlag.ts`

---

## What it is (plain English)

**The chat panel is just a window onto a file.** Every conversation is written to disk by Claude Code as a JSONL file (a text log, one event per line). The database records where that file lives and how far through it we've read. The screen renders whatever is in that file — nothing more.

When you reload the page, the whole conversation replays from the file. When the orchestrator is typing, new lines stream in live over WebSocket. Either way, the screen is showing the same thing: the contents of the log file, rendered as a chat.

---

## What it's supposed to do (intent)

Own the **durable conversation record** (a database row pointing to the JSONL file) and render it as a faithful chat view. The chat panel must show the same history after a reload as it did live — no events disappear, no duplicates appear, no ordering changes. The screen owns nothing; the log file is the truth.

---

## The parts (every component, plain English)

### 1. Where conversations live (the database row)

Every conversation has one row in the `orchestrator_sessions` table (`packages/db/src/repos/orchestrator-sessions.ts`). One row per project, always.

| Field | Plain English | Notes |
|---|---|---|
| `providerSessionId` | The unique ID of the Claude session — minted by PC before the process starts | So the row exists before the first event fires |
| `jsonlPath` | Where the JSONL log file lives on disk | Discovered by the tailer and written here |
| `jsonlLineCursor` | How far through the file we've read | Saved every ~1 second; on restart, replay picks up from here |
| `title` | The name shown in the left sidebar | Written via `session-title-writer.ts` |
| `status` | Whether the session is active or ended | `active` / `ended` |
| `endedReason` | Why it ended | Set when the session closes |

When you click a past session in the sidebar, `reactivateOrchestratorSession` flips it back to `active` — the same row is reused, so the full Claude history is preserved.

### 2. Sending a message

Sending a message goes through `conversation-send.ts`, which builds a `ConversationSendService`. The service:
- checks that a session is actually running
- queues the message if the PTY (the Claude process's terminal) is currently busy
- broadcasts queue snapshots to the browser over WebSocket, so you see the "waiting" state
- returns a `send-ack` to confirm the message was accepted

Route: `POST /api/projects/:id/sessions/send`

The service only ever sees a narrow port interface into the PTY — no internals cross the package boundary.

### 3. Replaying history (loading a conversation)

When you open a chat — or reconnect after losing the browser tab — the full history loads in two steps:

1. **Server side** (`session-replay.ts:loadSessionReplayCheckpoint()`): reads the normalized event log (`jsonl-events.jsonl`) and returns all events in sequence order, plus a "high water mark" (the latest sequence number seen). Falls back to the older `events.jsonl` format for conversations that predate Section 23.

2. **Client side** (`chat-session-reducer.ts:applySnapshot()`): receives the events and rebuilds the timeline in sequence order. Live events arriving after the replay are inserted at their correct position in that sequence — never blindly appended. If a reconnect happens mid-session, only the events since the high water mark are fetched (`?afterSeq=` cursor), not the whole history again.

> ⚠️ **Gap:** the replay reads a file on disk (`readFileSync` on `jsonl-events.jsonl`). This works today but there's a race window between the tailer writing the file and the replay reading it. The target is to move to a DB query instead — see Target shape.

### 4. The dual-stream merge (why two streams exist, and how they're deduplicated)

There are two sources of chat events arriving at the browser:

- **The JSONL tailer** — reads Claude Code's log file line-by-line and streams those events over WebSocket as `type:'jsonl'` frames. This is the canonical, rich source: it contains every tool call, every assistant message, every token usage stat.
- **Hook scripts** — small scripts that fire at specific moments (before a tool runs, after a turn) and POST events to the server. These arrive as `type:'event'` frames.

**Why both exist:** the hooks arrive faster (sub-second) while the JSONL tailer has to discover and read the file. Historically the legacy render path used both sources together, which caused duplicate messages and a "remount flicker" bug where the whole chat would re-render mid-conversation. (This burned us twice — see Known issues.)

**The fix:** the canonical render path (`buildCanonicalChatEnvelopes`, on by default since 2026-06-03) **only accepts `jsonl` and `ask` envelopes** — it ignores hook events entirely. No two sources, no dedup problem. The legacy path is frozen as a fallback/baseline but is otherwise dead weight waiting to be deleted.

The sequence number (`seq`) on each event is what keeps everything in order. The reducer slots each event into its correct position by `seq`, never by arrival time.

### 5. The chat rendering pipeline (how events become bubbles on screen)

Events flow through five stages to become the chat you see:

1. **Reducer** (`chat-session-reducer.ts`) — sorts everything by sequence number. Splits into "sequenced" events (have a seq and a session ID) and "unsequenced" (ask prompts, send confirmations). Deduplicates: if a seq already exists, the existing entry is updated in place — no double-counting of token usage.

2. **`buildCanonicalChatEnvelopes`** (`useChatRenderItems.ts`) — the canonical path. Keeps only `jsonl` and `ask` envelopes. Filters hidden rows via `rowPolicy()`. Adds pending-prompt placeholders while the orchestrator is typing.

3. **`rowPolicy()`** (`chat-policy.ts`) — a pure function (no side effects) that classifies every event as `shown`, `collapsed`, or `hidden`, and assigns it a display lane. Internal tool calls (`Agent`, `Task`, `TodoWrite`, etc.) are hidden by default. Hidden rows are never discarded — a debug toggle in `ChatSurface.tsx` reveals them.

4. **`synthesizeRenderItems`** (`toolGrouping.ts`) — groups related events into richer display items: consecutive tool-start/tool-end pairs become a single tool group; file edits become standalone edit items; sub-agent steps collapse into a sidechain group; workflow and agent-dispatch events are hoisted out of the message text into dedicated cards.

5. **`useChatTimelineRenderer`** — renders each item to a React node. Handles ask prompts inline, tool groups, edit bubbles, agent-dispatch cards, workflow run cards, sidechain groups, and standard message bubbles.

### 6. Session titles

`session-title-writer.ts:announceSessionTitle()` writes a title-changed record to the `live_outbox` table inside a database transaction. The live relay picks it up after the transaction commits and pushes it to every browser watching that project. The title bar updates without any refetch.

### 7. Chat-about-a-card bridge

When the orchestrator mentions a work item as a rich link, clicking it opens the full card inline without leaving the chat. This is wired through `ChatWorkItemModalMount.tsx`, which listens to the `useChatWorkItemModal` store. When the store gets a non-null `workItemId`, it lazily fetches the project's card list and opens the detail modal. Supports both callsign references (like `example-project-4`) and full ID matches. The open card live-refreshes via `useLiveEntitySignature`.

### 8. Ask prompts (when the orchestrator needs your answer)

When the orchestrator calls an ask tool, a hook script POSTs to `POST /api/ask`. The server broadcasts an `ask` frame to the browser (you see an inline prompt card) and then **blocks** on an in-memory resolver waiting for your answer or a 10-minute timeout.

`AskShadow` (`ask-shadow.ts`) is a side-write for durability: it creates an `open` row in `pending_interactions` (via the live outbox, so it fans correctly), and closes it when you answer or the timeout fires. The in-memory resolver is still the authority for unblocking the orchestrator — the shadow is only for inspection. **Nothing in the UI reads the shadow rows today** — it's a write-only safety receipt. Its visible surface arrives with the Human Inbox workstream (FD-7).

> 🟢 **Ask layering (FD-6 addendum, 2026-06-03):** the **orchestrator itself has no ask tool** —
> verified: its toolset contains no `pc_ask_*`; it only answers agent questions via
> `pc_answer_pending`. The ask doors, deliberately: **agents → orchestrator** (mailbox, FD-6) ·
> **orchestrator → human in plain chat** (no mechanism needed) · **formal reviews → Human Inbox**
> (FD-7). The inline-ask path described above is what *dispatched agents'* questions ride today —
> and FD-6 reroutes those to the orchestrator in the rebuild.

### 9. Post-turn summaries

After every completed turn, a `jsonl-post-turn-summary` event causes a row to be appended to `post_turn_summaries` (`post-turn-summaries.ts`). Rows are keyed by `summarizesUuid` so replaying a session never creates duplicates. **No UI reads these yet** — useful metadata is accumulating invisibly.

> 📌 **Gap:** the post-turn summary read surface is deferred. What it should show (in-session context window usage? a collapsible summary?) is an open product question.

---

## How it connects

- **Depends on:** `ProjectRuntime` / `InteractiveSession` (the PTY's send surface) · the JSONL tailer in `transcript-tailers.md` (writes `jsonl-events.jsonl`) · `live_outbox` / live-relay (for title and ask-shadow state changes) · `@pc/app-services` (`ConversationReplayService`, `ConversationSendService`, `PendingInteractionService`) · `pending_interactions` table · `post_turn_summaries` table.
- **Used by:** `Orchestrator.tsx` / `ChatSurface.tsx` (primary consumer) · `AgentDesignerChat` (transient modal sessions also render through `ChatSurface`) · agent run cards (inline JSONL transcript via `GET /api/subagent-transcript`) · WS reconnect path (`use-project-ws.ts` uses the after-seq cursor).
- **Contracts / events crossed:** `ConversationSessionDto`, `TranscriptEventDto`, `TranscriptReplayResponse` (`contracts/conversations.ts`, `runtime-transcript.ts`) · WS envelope types: `session-replay`, `session-changed`, `ask`, `jsonl`, `event`, `send-ack`, `send-queue-snapshot` · `live_outbox` rows: `session.title.changed`, `pending-interaction.changed`.

---

## Target shape (per north star + Foundation Decisions)

The north star (`unified-process-supervision-2026-06-02.md §2`): **chat is a pure view over a durable append-only event log; the UI shell owns nothing and reattaches to the Brain.**

**What stays:** the `orchestrator_sessions` table (source of truth for conversation identity and JSONL cursor) · the `live_outbox`-driven title and ask-shadow flow (already correct) · `rowPolicy` / `chat-policy.ts` as the single suppression table · the canonical JSONL-only renderer path (`buildCanonicalChatEnvelopes`) · the seq-ordered timeline in `chat-session-reducer`.

**What changes:**
- **Replay source moves to the DB — now named M3b.** Today `session-replay.ts` reads a file (`jsonl-events.jsonl`) written by the Brain's tailer. In the target, events are the append-only event log in SQLite; replay is a DB query. Split out of M3 in the M3a pass (2026-06-04 — the workflow diary shipped; this shares zero code with it): own pass, scope at `refactor plan/m3a-run-diary-scope-2026-06-04.md` §Scope-split.
- **Send path re-routes.** `ConversationSendService` today reaches into `ProjectRuntime` → `InteractiveSession`. After Steps 4–5, the orchestrator session moves to the Engine, and the send path adapts: the Brain routes the send to the Engine rather than into its own PTY.
- **Post-turn summaries get a read surface.** Write path stays; UI to be built in the slow migration.
- **Legacy render path deleted.** The `type:'event'` dual-source path in `useChatRenderItems.ts` is frozen as A/B baseline. Once the canonical path has enough production time, the legacy branch is deleted (one-path rule).

☠ `POST /api/projects/:projectId/channel-send` — proxies a test message to the channel server. **Sentenced FD-3** (removed along with the channel server).

---

## Known issues / scar tissue

**Dual-stream render identity (the "chat eaten up" bug — legacy path, historical).** The legacy render path combined hook `event` envelopes AND JSONL envelopes for the same turn. To avoid remount flicker, JSONL envelopes had to inherit the hook's array index via a `replacedBy` map. Getting the keying wrong caused the whole chat to visually swallow itself mid-render. Burned twice. The canonical path eliminates this entirely by accepting only `jsonl` and `ask` — no hook content, no dedup problem. `replacedBy` is deleted from live code. (Memory: `[PC-PTY dual-stream render identity]`.)

**Legacy render path is a one-path violation.** The canonical path is the one path. The legacy `type:'event'` branch is frozen in `useChatRenderItems.ts` as an A/B baseline but has not been deleted yet. Every day it stays is a day the two paths can diverge. Delete when the acceptance gate is decided (see Decisions below).

**Replay source is a file, not a DB query.** `session-replay.ts` does `readFileSync` on `jsonl-events.jsonl`. There's a race window between the tailer writing the file and the replay reading it — a partial checkpoint is possible. Target: DB query removes this. (Slice-3.)

**CC ≥2.1 queue protocol shift.** CC uses `remove` (not `dequeue`) on queue consume; queued commands appear as `type:"attachment"` with `attachment.type === "queued_command"`, not plain user rows. `normalizeJsonlEnvelope` routes `jsonl-queue-enqueue` / `jsonl-queue-dequeue` kinds — confirm the tailer's parsing matches CC's current emit shape. (Memory: `[CC ≥2.1 queue protocol shift]`.)

**`post_turn_summaries` is write-only.** Useful per-turn metadata accumulates invisibly — no UI reads it.

**Pre-Section-23 sessions render in degraded form.** The `events.jsonl` fallback for old sessions lacks the full canonical JSONL types. No migration path exists.

**`SUPPRESSED_TOOLS` duplicated in two places.** `toolGrouping.ts:20` and `chat-policy.ts:36` both define the same set. Stage 3 of the redesign deletes `toolGrouping`'s copy. Until then, they can silently diverge.

---

## Decisions & open questions

**For Emerson (product calls):**

1. **What should post-turn summaries show?** The data is there after every turn — context window usage, a short summary, something else? Needs a product decision before the read surface is built.
2. **What is the acceptance gate for deleting the legacy render path?** The canonical path is on by default. Once we're confident there are no regressions (how long? which sessions?), the old branch should be removed. The one-path rule demands it.
3. **Should old sessions (pre-Section 23) ever be migrated to the canonical format?** Today they render in degraded shape forever.

**Technical:**

- After-seq fetch on reconnect: `use-project-ws.ts` fetches `seq > highWaterSeq` on reconnect. If `highWaterSeq` is stale from a prior session that was then resumed, there may be a missed-events window before the replay lands. (Unverified — inspect the reconnect sequence.)
- `rowPolicy` vs `normalizeJsonlEnvelope` sync: `useChatRenderItems.ts` notes their hidden sets are "proven equal" by `chat-policy.test.ts`. Confirm that test runs in CI.
- Replay source migration (file → DB query) sequencing: the tailer writes the file; once the Engine owns the tailer (Steps 4–6), the write path changes and the Brain's replay route must follow. What order?
