# Transcript Tailers & Replay

> **Role:** Engine / cross-cutting (chat rendering + historical replay)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> - `packages/runtime/src/jsonl-tailer.ts` — v1 base layer (used by PtySession, InteractiveSession, LowLevelSpawn)
> - `packages/runtime/src/agent-run-jsonl-tailer.ts` — v2 agent-run layer (used by AgentRun + server-side drain callers)
> - `packages/runtime/src/path-resolver.ts` — single source for all JSONL paths
> - `apps/server/src/services/jsonl-sweep.ts` — retention cleanup
> - `apps/server/src/services/session-replay.ts` — one-shot replay loader
> - `apps/server/src/services/conversation-replay.ts` — HTTP service wrapper over session-replay

---

## What it is (plain English)

When an agent runs, Claude Code writes everything it does — every message, tool call, and
system event — to a plain text file called a JSONL transcript (one JSON object per line).
This subsystem reads those files and turns the raw lines into typed events the app can
use: tool calls for the activity panel, assistant text for chat bubbles, usage numbers for
the token counter, system messages for the status line.

There are two distinct and legitimate reasons to read the transcript:
1. **Chat rendering** — show the user what the agent said and did (valid forever).
2. **Completion detection** — decide whether the run is finished (the anti-pattern the north star kills).

These two uses are separated in the current code, but not yet fully enforced. The biggest
ongoing risk is that a path-resolution failure silently severs the tailer and makes the idle
timer the only remaining "done" signal.

---

## What it's supposed to do (intent)

Provide a reliable, real-time stream of typed events from Claude Code's on-disk JSONL transcript
so the app can render chat faithfully. The tailer is the authoritative source for **what the
agent said**. It is NOT and must NOT be the source for **whether the run is done** — that signal
must come from a positive MCP receipt (`pc_submit_deliverable`).

---

## How it works today (as-built)

### The two tailer classes

**`JsonlTailer` (v1) — `packages/runtime/src/jsonl-tailer.ts`**

- Base layer. Polls the file every 200ms (`setInterval`; unref'd so it doesn't block process exit).
- On each tick: reads the whole file with `readFileSync`, splits on `\n`, skips the last
  partial line (mid-write guard), emits typed `JsonlEvent` objects for every new line past
  the cursor.
- Handles every CC entry type: `user`, `assistant`, `tool_use`/`tool_result`, `system`,
  `queue-operation`, `attachment` (queued_command), plus Section 31's metadata types
  (`ai-title`, `last-prompt`, `tool_progress`, `stream_event`, `session_state_changed`,
  `compact_boundary`, etc.).
- CC quirk handled: `attachment` with `attachment.type === 'queued_command'` carries the
  queued prompt body — synthesized into a `jsonl-user` envelope so the message appears in
  chat even though CC never writes a `type: 'user'` row for it.
- CC quirk handled: CC ≥2.1 logs `remove` instead of `dequeue` for turn-end-driven queue
  consumption — both collapsed to `jsonl-queue-dequeue` (line 329).
- Used by: `LowLevelSpawn` (agent workers), `PtySession` (orchestrator + modals today),
  `InteractiveSession` (orchestrator today).

**`AgentRunJsonlTailer` (v2) — `packages/runtime/src/agent-run-jsonl-tailer.ts`**

- Agent-run layer built on the same poll mechanism. Adds:
  - **Loop-state tracking** — resets `firedThisLoop` at each `user`/`queued_command` boundary
    so dedup works across multi-turn conversations.
  - **Interleaved-thinking fix** — Opus 4.7 can emit two `assistant` rows with
    `stop_reason: end_turn` in one logical turn (thinking-only first, text-bearing second).
    v1's "first end_turn = done" fired prematurely. v2 requires a non-empty text block on
    named happy-path stop reasons before emitting `jsonl-turn-end`; waits for the
    text-bearing row or a `stop_hook_summary` fallback (line 371–395).
  - **Pause detection** — state machine (`idle`→`armed`) watches for a `tool_use` stop
    reason followed by tool results with no subsequent assistant row, confirmed by
    `stop_hook_summary`. Emits `jsonl-pause-detected` before the turn-end fallback (line 404–419).
  - **`setImmediate`-deferred first emit** — initial drain deferred so listeners attached
    after `new AgentRunJsonlTailer(...)` but before the next tick still see events (guards
    the constructor-emit-before-listeners-wired bug class; line 175).
  - **`drainAvailable()`** — synchronous one-shot read, no polling. Used by server-side
    callers that need a snapshot without starting an ongoing poll.
- Used by: `AgentRun` (live agent workers), server-side drain in routes and terminal-effects.

### Path resolution

`packages/runtime/src/path-resolver.ts:jsonlPathFor(workspaceAbsPath, ccProviderSessionId)`
builds the canonical path:
`<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<session-uuid>.jsonl`

CWD encoding: every non-`[A-Za-z0-9._-]` character maps to `-`
(e.g. `E:\Projects\Caisson` → `E--Projects-Caisson`).

`CLAUDE_CONFIG_DIR` env var is honored (historically missed — Section 15 lesson). All callers
import from `path-resolver.ts`; hardcoding `homedir()` elsewhere is a lint error.

### Live tailing (agent workers)

`LowLevelSpawn.attachJsonlTailer()` (`low-level-spawn.ts:500`):
- Polls every 250ms for the file to appear (CC mints it lazily, ~1–2s after first turn).
- On resume: reads existing line count and sets `startLine` so prior turns don't replay as
  fresh events and race the completion path (line 509–519).
- Forwards all `jsonl-event` emissions up to `AgentRun.onJsonlEvent()`.

`AgentRun.onJsonlEvent()` (`agent-run.ts:528`):
- Resets the idle timer on every event.
- Captures last assistant text for the `result` field.
- Disarms the first-output watchdog when genuine activity arrives.
- **Does NOT close the run.** The comment at line 545 is explicit: "a turn-end is NO
  LONGER a completion signal. Completion comes solely from `complete()` (the agent's
  `pc_submit_deliverable` receipt)."

### Server-side drain uses (one-shot, no poll)

Several server routes and services create a tailer, call `drainAvailable()`, read all events,
then discard the tailer — no ongoing poll:

- `apps/server/src/features/agent-runs/routes.ts:183` — loads transcript for the agent card's
  inline JSONL display.
- `apps/server/src/services/agent-run-terminal-effects.ts:290` — verification gate reads tool
  calls from the transcript to confirm `pc_ask_user` was invoked before accepting a paused
  terminal state.
- `apps/server/src/services/agent-run-control.ts:214` — similar verification path.
- `apps/server/src/services/agent-host-reattach.ts:475` — backfill broadcasts JSONL events
  to the live WS stream when the host reports a run that wasn't tracked in-memory (reattach
  scenario).

### Replay (historical / reconnect)

`apps/server/src/services/session-replay.ts:loadSessionReplayCheckpoint()`:
- Reads `<sessionDataPath>/jsonl-events.jsonl` (PC's normalized event log written by
  `PtySession`'s tailer) as the primary source.
- Falls back to `events.jsonl` (legacy hook-written) for pre-Section 23 sessions.
- Returns a `SessionReplayCheckpoint`: sorted envelopes with stable `seq` numbers for
  ordered replay.

`apps/server/src/services/conversation-replay.ts` wraps `session-replay.ts` as a
`ConversationReplayService` for HTTP endpoints; delegates all reads to `loadSessionReplayCheckpoint`.

### Retention sweep

`apps/server/src/services/jsonl-sweep.ts:sweepStaleJsonl()`:
- Walks `~/.claude/projects/` at server boot, deletes `.jsonl` files whose `mtime` is older
  than the retention window (configurable; `'never'` is a no-op).
- Mtime-based (not creation time) — a resumed long-lived session survives.
- Non-fatal per-file errors counted as `skipped`, never abort the sweep.

### Chat rendering dedup

The web layer receives both hook-derived events and JSONL events on the same WS stream.
`apps/web/src/features/chat/normalizeJsonlEnvelope.ts:normalizeJsonlEnvelope()` converts
JSONL envelopes into hook-shape envelopes so the chat renderer has a single render path.
Dedup between hook and JSONL events is handled at the envelope level in the UI store
(the surviving JSONL envelope inherits the hook's index via a `replacedBy` map to avoid
remount flicker — referenced in memory as `[PC-PTY dual-stream render identity]`).

---

## Integrations (how it connects)

- **Depends on:** `path-resolver.ts` for all paths; the CC process having written a JSONL
  file to disk; `CLAUDE_CONFIG_DIR` env if overridden.
- **Used by:**
  - `LowLevelSpawn` → `AgentRun` (live activity + idle reset, NOT completion)
  - `PtySession` (orchestrator + modal sessions — live chat rendering)
  - `InteractiveSession` (orchestrator — live chat rendering, idle state tracking)
  - Server routes (one-shot drain for card display, verification gate, reattach backfill)
  - `session-replay.ts` / `conversation-replay.ts` (historical replay on reconnect)
  - `jsonl-sweep.ts` (retention cleanup at boot)
- **Contracts / events crossed:**
  - Emits `JsonlEvent` (v1) / `AgentRunJsonlEvent` (v2) — typed unions in the respective
    tailer files.
  - `AgentRun` consumes `'jsonl-event'` from `LowLevelSpawn`.
  - WS stream receives `{ type: 'jsonl', event: JsonlEvent }` envelopes from `PtySession`'s
    tailer write-through to `jsonl-events.jsonl`.
  - `SessionReplayCheckpoint` carries `ReplayEnvelope[]` across the HTTP replay seam.

---

## Target shape (per north star)

Ledger verdict (`consolidation-ledger-2026-06-02.md §2`, Transcript reading block):

- `jsonl-tailer.ts` (v1): **KEEP** — base layer; not legacy. `LowLevelSpawn`, `PtySession`,
  and `InteractiveSession` all import it.
- `agent-run-jsonl-tailer.ts` (v2): **KEEP** — the agent-run layer with loop-state tracking
  and interleaved-thinking fix.
- `PtySession` file-watching (stop-marker + events file): **DELETE** (after Step 5 — modals
  migrate to the Engine).

In the target architecture (Steps 4–6), every `claude.exe` lives in the Engine. The Engine
has **one transcript reader** — the tailer in `LowLevelSpawn` (used via `AgentRun`). There
is no second reader. `PtySession`'s tailer dies when modals migrate to the Engine (Step 5);
`InteractiveSession`'s tailer dies when the orchestrator migrates (Step 4). After Step 6,
v1 and v2 converge to one module or v1 is absorbed into v2.

What changes from today:
- **Keep:** tailing for chat rendering — valid and necessary forever.
- **Kill:** any remaining inference of completion from JSONL events. Step 8 makes
  timeouts the only typed-failure backstop; positive MCP receipt is the sole "done".
- **Kill:** the dual `PtySession`-owned tailer (orchestrator + modals) once they move to
  the Engine.
- **Guard test:** after Step 6, a single-path import test prevents a second transcript reader
  from re-emerging.

---

## Known issues / scar tissue

**The root cause of the agent stall** (documented in memory as `[Agent stall ROOT CAUSE]`):

Completion was previously inferred by tailing the JSONL and watching for a `turn-end` event.
If the path passed to the tailer diverged from where CC actually wrote the transcript — wrong
`CLAUDE_CONFIG_DIR`, stale `ccSessionId`, resume-mode `startLine` not set — the tailer never
fires. The run goes blind. It produces zero JSONL output as far as the server can see.
The only remaining signal is the idle timer (default 300,000ms / 5 minutes,
`agent-run.ts:138,168`). At exactly 300s of silence the run terminates as `idle-timeout`
— a typed failure, but one that destroys real work that completed successfully on disk.

The fix (already shipped): `complete()` on `AgentRun` is driven by `pc_submit_deliverable`
(a positive MCP receipt), not by a JSONL turn-end. The `onJsonlEvent` handler explicitly does
not close the run (`agent-run.ts:545`). JSONL events now drive only idle-reset and
last-assistant-text capture.

**Resume replay race** (resolved by `startLine` in `LowLevelSpawn.attachJsonlTailer`):

On resume, if the tailer starts at line 0, prior conversation's turn-ends replay as fresh
`jsonl-turn-end` events and race the completion path into prematurely completing the run.
Fixed: `startLine` is set to the file's current line count before the resume starts
(`low-level-spawn.ts:509–519`). If the `readFileSync` to count lines throws, it falls back
to 0 and the replay bug can recur — logged as best-effort only.

**Dual end_turn premature complete** (fixed in v2 tailer):

Opus 4.7 (interleaved thinking) emits two `assistant` rows with `stop_reason: end_turn` in
one logical turn — thinking-only first, text-bearing second. v1's "first end_turn = done"
logic was broken and could prematurely emit `jsonl-turn-end`. v2 waits for the text-bearing
assistant row (`agent-run-jsonl-tailer.ts:371–386`). This was also the completion-by-inference
path; decoupling completion from turn-end made this a rendering correctness issue only.

**PtySession still has its own tailer (two readers live today)**:

Steps 4–5 haven't landed. The orchestrator (`InteractiveSession`) and three modals
(`PtySession`) have their own v1 tailers. These are the second readers the target design
eliminates. They are live and correct today; the convergence is a migration item, not a
current bug.

**`formatSystemMessage` duplicated between v1 and v2**:

Both tailer files contain a copy of `formatSystemMessage`. The comment in
`agent-run-jsonl-tailer.ts:480` acknowledges the drift risk: "change here AND in v1's
`formatSystemMessage` to keep render parity until v1 retires." No guard test enforces this.

---

## Open questions

- **Step 6 convergence shape:** when v1 and v2 merge into one module, does v2 absorb v1's
  richer Section 31 event catalog (session-state, compaction, tool-progress, etc.) or do those
  only matter for the orchestrator/modal path? Decide before deleting `PtySession`.
- **`drainAvailable()` callers after Step 6:** the server-side drain uses (routes,
  terminal-effects, reattach backfill) don't depend on `PtySession` or `InteractiveSession` —
  they survive the migration unchanged. Confirm they still resolve the right JSONL path after
  the Engine absorbs those sessions (the path-resolver contract is the seam).
- **`startLine` fallback safety:** the resume-mode fallback to `startLine = 0` on a
  `readFileSync` error (`low-level-spawn.ts:518`) can silently reinstate the replay race.
  Should be a typed failure, not a silent best-effort.
- **`formatSystemMessage` drift test:** add a test that asserts v1 and v2 produce identical
  output for the same input before Step 6 deletes v1.
- **Stall warn + JSONL mtime** (`agent-run-stall-warn.ts`): the stall-warn sweep uses the
  JSONL file's mtime as a proxy for last agent activity. After the Engine absorbs all sessions,
  confirm this probe still resolves the right path for every session type, not just host-dispatched
  agent workers.
