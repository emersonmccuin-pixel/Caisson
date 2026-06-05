# Transcript Tailers & Replay

> **Role:** Engine / cross-cutting (chat rendering + historical replay)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `packages/runtime/src/jsonl-tailer.ts` · `packages/runtime/src/agent-run-jsonl-tailer.ts` · `packages/runtime/src/path-resolver.ts` · `apps/server/src/services/jsonl-sweep.ts` · `apps/server/src/services/conversation-replay.ts` · `conversation-backfill.ts` *(☠ M3b: `session-replay.ts`)*

---

## What it is (plain English)

**Claude writes everything it says and does to a file on disk.** Every message, every tool call, every system event lands in a plain-text log called a JSONL transcript — one line per event, appended as the agent runs. "Tailing" that file means reading it as it grows, line by line, the same way `tail -f` works in a terminal.

This subsystem does the tailing. It turns the raw lines into typed events — chat bubbles, tool calls, token counts, status messages — so the app can show you what the agent is doing in real time, and reload that history when you reconnect.

**The line this subsystem must never cross:** in the past, the app also used the transcript to *guess* whether the agent had finished. That was wrong, caused the stall bug, and is now gone. Today the transcript is read for two legitimate reasons only: **showing you the chat** and **loading history on reconnect**. Whether a run is done comes from the agent explicitly saying so (`pc_submit_deliverable`), not from reading a log file.

---

## What it's supposed to do (intent)

Stream typed events from Claude's on-disk transcript to the app so chat renders faithfully. Be the authoritative source for **what the agent said**. Never be the source for **whether the run is done** — that must always come from a positive, explicit signal.

---

## The parts (every component, plain English)

### 1. Where Claude writes — the transcript file

When Claude starts, it creates a JSONL file on disk in its own config directory. The path is built from:
- A base directory (`CLAUDE_CONFIG_DIR`, or the default `~/.claude/` if not overridden)
- A folder named after the working directory (special characters replaced with `-`)
- A file named after the session UUID

Example: `~/.claude/projects/E--Projects-Caisson/<session-uuid>.jsonl`

**All path construction goes through one place:** `packages/runtime/src/path-resolver.ts`. Nothing in the codebase should hardcode this path or guess it. (This was a past source of bugs — a wrong path means a silently severed tailer.)

---

### 2. The base tailer — the reading engine

**`packages/runtime/src/jsonl-tailer.ts`** (v1)

This is the core reading loop. Every 200ms it reads the transcript file, finds any new lines since the last read, and turns each one into a typed event. The last partial line (still being written by Claude) is always skipped.

It knows how to handle every kind of line Claude writes:

| Line type | What it is |
|---|---|
| `user` | Something the user or system sent to Claude |
| `assistant` | Claude's response text |
| `tool_use` / `tool_result` | Claude calling a tool, and the result that came back |
| `system` | Internal system messages |
| `queue-operation` / `attachment` | A command queued up to be sent on the next turn |
| `ai-title`, `compact_boundary`, etc. | Session-state metadata (Section 31 additions) |

**Two CC quirks handled here:**

- **Queue protocol (CC ≥2.1):** When Claude finishes a turn and consumes a queued command, it logs `remove` instead of `dequeue`. Both are collapsed to the same `jsonl-queue-dequeue` event. Also: queued commands arrive as `attachment` lines with `attachment.type === 'queued_command'`, not as `user` lines — the tailer synthesizes them into a `jsonl-user` envelope so they appear in chat. (`jsonl-tailer.ts:329`)
- **No guard test exists** that both quirk handlers stay in sync across v1 and v2.

Used by: `LowLevelSpawn` (agent workers), `PtySession` (orchestrator + modals today), `InteractiveSession` (orchestrator today).

---

### 3. The agent-run tailer — the layer built for workers

**`packages/runtime/src/agent-run-jsonl-tailer.ts`** (v2)

Built on the same poll loop as v1, but adds several things that matter for dispatched agent workers:

**Interleaved-thinking fix (Opus 4.7 quirk):** Opus 4.7 can emit *two* `assistant` messages in one logical turn — a thinking-only message first, then the real text. v1's logic said "first `end_turn` = done" and fired prematurely on the thinking-only message. v2 requires a non-empty text block before it emits `jsonl-turn-end`; it waits for the text-bearing message or a `stop_hook_summary` fallback. (`agent-run-jsonl-tailer.ts:371–395`)

**Pause detection:** A state machine watches for Claude stopping mid-turn at a tool call (waiting for a result), confirmed by a `stop_hook_summary` event. Emits `jsonl-pause-detected` so the app can show the agent is waiting, not hung. (`agent-run-jsonl-tailer.ts:404–419`)

**Loop-state tracking:** Resets dedup state at each new user turn so multi-turn conversations don't bleed events across turns.

**Deferred first emit:** The very first drain is deferred with `setImmediate` so that code that wires up listeners immediately after `new AgentRunJsonlTailer(...)` doesn't miss events. (Guards the "constructor emits before listeners are wired" bug class.) (`agent-run-jsonl-tailer.ts:175`)

**`drainAvailable()`:** A one-shot synchronous read — no ongoing poll. Server-side callers that just need a snapshot use this and discard the tailer immediately after.

Used by: `AgentRun` (live agent workers), several server-side routes for snapshot reads.

---

### 4. Live tailing (agent workers in real time)

When an agent worker starts (`LowLevelSpawn.attachJsonlTailer()`), the tailer doesn't begin immediately — Claude mints its transcript file lazily, about 1–2 seconds after the first turn. The attachment logic polls every 250ms until the file appears, then starts.

**On resume:** if an agent is resuming a prior session, the tailer reads the current line count first and sets `startLine` to that number. This means prior turns don't replay as fresh events. If the `readFileSync` to count lines fails, it falls back to 0 — which can silently reinstate the replay race (see Known issues).

Every event flows up to `AgentRun.onJsonlEvent()` (`agent-run.ts:528`), which:
- Resets the idle timer (so the run doesn't time out while the agent is working)
- Captures the last assistant text for the `result` field
- Disarms the first-output watchdog

**What `onJsonlEvent` explicitly does NOT do:** close the run. The comment at line 545 is clear: *"a turn-end is NO LONGER a completion signal. Completion comes solely from `complete()` (the agent's `pc_submit_deliverable` receipt)."*

---

### 5. One-shot reads (server-side snapshots)

Several parts of the server create a tailer, call `drainAvailable()` to read all events at that moment, then throw the tailer away — no ongoing poll. These are read-only snapshots:

| Caller | What it reads the transcript for |
|---|---|
| `agent-runs/routes.ts:183` | Load the inline JSONL transcript for display on the agent card |
| `agent-run-terminal-effects.ts:290` | Verify that an ask tool (`pc_ask_orchestrator` — ☠ FD-6/M7 `pc_ask_user`) was actually called before accepting a paused state |
| `agent-run-control.ts:214` | Same verification path, different call site |
| `agent-host-reattach.ts:475` | Backfill WS stream when the host reports a run that wasn't tracked in memory |

---

### 6. Replay — loading history when you reconnect

When the UI reconnects to a session (or loads the transcript view), it needs the full conversation history.

**✅ M3b (2026-06-04): replay is a database query.** The orchestrator chat's normalized events
live in the `conversation_events` table (one row per event; `OrchestratorHostSession` writes them
as the host stream flows). `conversation-replay.ts` composes the app-services
`DbTranscriptRepository` and serves every replay surface — sorted envelopes with stable `seq`
numbers, `?afterSeq=` cursor reads, stable high-water.

*(☠ M3b: `session-replay.ts` — the `jsonl-events.jsonl` / legacy `events.jsonl` file reader. The
on-disk logs were imported once at boot by `conversation-backfill.ts` and renamed `*.imported`;
the parser survives only inside that importer.)*

---

### 7. Cleanup — the retention sweep

**`apps/server/src/services/jsonl-sweep.ts`** (`sweepStaleJsonl`):
- Runs at server boot
- Walks `~/.claude/projects/` and deletes `.jsonl` files whose last-modified time is older than the configured retention window (`'never'` = no cleanup)
- Uses last-modified time, not creation time — a resumed long-lived session survives
- Per-file errors are counted as `skipped` and never abort the sweep

---

### 8. Chat dedup — merging two event streams

The web layer receives events from two sources on the same connection: the hook stream and the JSONL stream. Both describe the same agent activity; showing both would duplicate messages.

`apps/web/src/features/chat/normalizeJsonlEnvelope.ts` converts JSONL envelopes into the same shape as hook envelopes so the chat renderer has one path. Dedup happens at the envelope level in the UI store: the surviving JSONL envelope inherits the hook's index via a `replacedBy` map to prevent remount flicker — keying off the JSONL envelope's own index would cause the chat to visibly rebuild.

---

## How it connects

- **Depends on:** `path-resolver.ts` for every transcript path · the CC process having written a JSONL file to disk · `CLAUDE_CONFIG_DIR` env var if overridden
- **Used by:**
  - `LowLevelSpawn` → `AgentRun` — live activity stream + idle reset (not completion)
  - `PtySession` — live chat rendering for orchestrator + modals today
  - `InteractiveSession` — live chat rendering for orchestrator today
  - Server routes — one-shot drain for card display, verification gate, reattach backfill
  - `conversation-replay.ts` — historical replay on reconnect (a `conversation_events` query — M3b)
  - `jsonl-sweep.ts` — retention cleanup at boot
- **Events emitted:** `JsonlEvent` (v1) · `AgentRunJsonlEvent` (v2) · `jsonl-turn-end` · `jsonl-pause-detected`
- **Events consumed:** `AgentRun` listens on `'jsonl-event'` from `LowLevelSpawn`; the WS stream receives `{ type: 'jsonl', event }` envelopes written through by `PtySession`

---

## Target shape (per north star + Foundation Decisions)

Ledger verdict (`consolidation-ledger-2026-06-02.md §2`):

- `jsonl-tailer.ts` (v1): **KEEP** — base layer, not legacy. Three callers today.
- `agent-run-jsonl-tailer.ts` (v2): **KEEP** — agent-run layer with loop-state tracking and the interleaved-thinking fix.
- `PtySession` file-watching (stop-marker + events file): ☠ **DELETE** — after Step 5, when modals migrate to the Engine.

In the target architecture (Steps 4–6), every `claude.exe` lives in the Engine. The Engine has **one transcript reader** — the tailer in `LowLevelSpawn` via `AgentRun`. There is no second reader. `PtySession`'s tailer dies when modals migrate (Step 5); `InteractiveSession`'s tailer dies when the orchestrator migrates (Step 4). After Step 6, v1 and v2 converge to one module or v1 is absorbed into v2.

**What survives unchanged:** tailing for chat rendering — valid and necessary forever. The one-shot server-side drain callers don't depend on `PtySession` or `InteractiveSession` and survive the migration unchanged.

**What gets killed:** any inference of completion from JSONL events (already killed on the live branch) · the dual `PtySession`-owned tailer once it migrates.

**Post-Step 6 guard:** a single-path import test prevents a second transcript reader from re-emerging.

---

## Known issues / scar tissue

**The stall (root cause, FIXED):** Completion was previously inferred by watching for a `turn-end` in the JSONL stream. If the path passed to the tailer was wrong — wrong `CLAUDE_CONFIG_DIR`, stale session ID, resume-mode `startLine` not set — the tailer never fired. The run went blind. With zero events arriving, the only remaining "done" signal was the idle timer (300,000ms / 5 minutes, `agent-run.ts:138,168`). At exactly 300s the run terminated as `idle-timeout` — a typed failure, but one that destroyed real work that had already completed on disk. Fix shipped: `complete()` on `AgentRun` is driven exclusively by `pc_submit_deliverable` (positive MCP receipt). `onJsonlEvent` explicitly does not close the run (`agent-run.ts:545`). JSONL events now drive only idle-reset and last-assistant-text capture.

**Resume replay race (resolved, fragile):** On resume without `startLine` set, prior turn-end events replay as fresh `jsonl-turn-end` events and can race the completion path. Fixed by setting `startLine` to the current line count before the resume starts (`low-level-spawn.ts:509–519`). The fallback when that `readFileSync` throws is `startLine = 0`, which silently reinstates the race.

**Dual `end_turn` premature complete (fixed in v2):** Opus 4.7 emits two `assistant` rows with `stop_reason: end_turn` in one logical turn. v1's "first `end_turn` = done" fired on the thinking-only first row. Now a rendering correctness issue only (completion no longer comes from turn-end), but v2 still handles it correctly for accurate chat display (`agent-run-jsonl-tailer.ts:371–386`).

**Two readers alive today:** Steps 4–5 haven't landed. The orchestrator (`InteractiveSession`) and three modals (`PtySession`) have their own v1 tailers running in parallel with the Engine's reader. They are correct and live today; convergence is a migration item, not a current bug.

**`formatSystemMessage` duplicated:** Both tailer files contain a copy of `formatSystemMessage`. The comment in `agent-run-jsonl-tailer.ts:480` acknowledges the drift risk. No guard test enforces parity.

---

## Decisions & open questions

**For Emerson (product calls):**
- No product decisions are open here — the core question (transcript = display only, done-signal = explicit receipt) is settled and shipped.

**Technical:**
- **Step 6 convergence shape:** when v1 and v2 merge, does v2 absorb v1's richer event catalog (`session-state`, `compaction`, `tool-progress`, etc.) or do those only matter for the orchestrator/modal path? Decide before deleting `PtySession`.
- **`startLine` fallback safety:** the fallback to `startLine = 0` on a `readFileSync` error (`low-level-spawn.ts:518`) can silently reinstate the resume replay race. Should be a typed failure, not a silent best-effort.
- **`formatSystemMessage` drift test:** add a test that asserts v1 and v2 produce identical output for the same input before Step 6 deletes v1.
- **One-shot drain callers after Step 6:** confirm server-side drain callers (routes, terminal-effects, reattach backfill) still resolve the right JSONL path after the Engine absorbs `PtySession` and `InteractiveSession` — the path-resolver contract is the seam.
- **Stall-warn JSONL mtime probe** (`agent-run-stall-warn.ts`): uses the JSONL file's mtime as a proxy for last agent activity. After the Engine absorbs all sessions, confirm this probe resolves the right path for every session type, not just host-dispatched workers.
