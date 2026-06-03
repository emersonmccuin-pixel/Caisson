# Runtime — PTY & Session Primitives

> **Role:** Engine (target) — cross-cutting today (Brain + Engine both own sessions)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `packages/runtime/src/low-level-spawn.ts`,
> `packages/runtime/src/pty-session.ts`,
> `packages/runtime/src/interactive-session.ts`,
> `packages/runtime/src/ready-gate.ts`,
> `packages/runtime/src/send-protocol.ts`,
> `packages/runtime/src/jsonl-tailer.ts`,
> `packages/runtime/src/ansi.ts`,
> `packages/runtime/src/env-scrub.ts`,
> `packages/runtime/src/claude-resolver.ts`,
> `packages/runtime/src/path-resolver.ts`,
> `packages/runtime/src/node-launcher.ts`,
> `packages/runtime/src/chat-policy.ts`,
> `packages/runtime/src/worktree.ts`

---

## What it is (plain English)

This subsystem is the low-level machinery that starts a `claude.exe` process, waits until it is genuinely ready to accept input, sends messages into it, and reads its output back as structured events. Think of it as the driver between the rest of the app and the underlying Claude Code binary. Every `claude.exe` spawned by the app goes through one of the three session wrappers in this package: dispatched agent workers use `LowLevelSpawn` (via `InteractiveSession`), the main orchestrator chat uses `InteractiveSession` (wrapping `LowLevelSpawn`), and the three transient modals (agent-designer, workflow-builder, setup-wizard) use the older `PtySession` class.

---

## What it's supposed to do (intent)

Own the complete lifecycle of a single `claude.exe` child process: spawn it with the right arguments, scrub the environment so it doesn't inherit VS Code's IDE-integration markers, detect when the Claude UI is ready to receive input, send text through the terminal, tail the per-session JSONL file for structured turn events, and expose a clean event stream to the layer above. Anything that touches a PTY belongs here.

---

## How it works today (as-built)

### The three session wrappers

**`LowLevelSpawn`** (`low-level-spawn.ts`) — the new foundation primitive for the agent system rebuild. One instance = one `claude.exe` child. Construction does nothing; `start()` actually spawns via `node-pty`. Every spawn goes through here for dispatched agent workers and the orchestrator.

Key steps:
1. Resolves the claude binary via `requireClaudeBinary` (see below).
2. Builds the arg list: `--dangerously-skip-permissions`, `--agent <name>`, `--mcp-config`, `--strict-mcp-config`, `--session-id <uuid>` (fresh) or `--resume <uuid>` (resume), optionally `--dangerously-load-development-channels`.
3. Scrubs IDE env via `scrubIdeEnv` and spawns via `pty.spawn`.
4. Feeds raw stdout through `ReadyGate` until all configured signals fire.
5. Defers JSONL tailer attach to `setImmediate` (constructor emit race prevention).
6. Exposes `awaitReady()` (a Promise), `send(body)` (bracketed-paste + echo-ack), `writeRaw`, `interrupt`, `resize`, `kill`.

**`InteractiveSession`** (`interactive-session.ts`) — the lifecycle wrapper used by the orchestrator. Delegates spawn work to `LowLevelSpawn`, adds retry-with-backoff (configurable `maxSpawnAttempts`, `retryBackoffMs`), a spawn timeout, and the `stopped → spawning → ready → busy → exited | failed` state machine. Proxies `jsonl-event`, `chunk`, `raw`, `ready`, `exit` from the inner spawn. Cycles `ready ↔ busy` on every turn: `send()` → `busy`; `jsonl-turn-end` → `ready`.

- Caller: `project-runtime.ts:501` — `this.pty = new InteractiveSession(...)`. This is the orchestrator's session.
- Persists events to a `replayEventsPath` (PC-owned normalized log at `sessions/<id>/jsonl-events.jsonl`) before emitting.

**`PtySession`** (`pty-session.ts`) — the older class, still live. Used exclusively for the three transient modals:
- `project-runtime.ts:792` — agent-designer
- `project-runtime.ts:934` — workflow-builder
- `project-runtime.ts:1016` — setup-wizard

`PtySession` spawns directly with `node-pty` (no `LowLevelSpawn` underneath), uses `watchFile` polling on a stop-marker file and an events file for turn detection, and detects readiness via `terminalBufferLooksReady` (banner regex on raw stdout). This is the older approach — no `ReadyGate`, no echo-ack send, uses `TimedBracketedPasteQueue` (500ms fixed timeout before submitting Enter).

---

### Ready detection — `ReadyGate` (`ready-gate.ts`)

Used by `LowLevelSpawn` only (not `PtySession`). Pure logic: no PTY, no HTTP, no fs.

Three configurable signals, all must fire before the gate opens:
1. **MCP handshake** — the pc-rig MCP child POSTs `/api/internal/mcp-handshake` → caller calls `notifyHandshake()`. Skippable via `requireHandshake: false`.
2. **Bracketed-paste-mode-on** — raw stdout contains `\x1b[?2004h`. This is the ANSI sequence CC emits when the terminal composer is ready.
3. **Init-complete** — a stable marker in raw stdout: `/remote-control is active`, the Claude footer text, or the Welcome/Tips/What's-new banner. Skippable via `requireInitComplete: false`.

Subagents skip init-complete (signals 1+2 only). Orchestrator requires all three when `remoteControl` is on.

Gate emits `ready` event with three timestamps (`handshakeAt`, `composerReadyAt`, `initCompleteAt`). `LowLevelSpawn` resolves its `awaitReady()` promise on this event.

---

### Send protocol — `send-protocol.ts`

**`sendBracketedPaste`** (used by `LowLevelSpawn`):
1. Write `\x1b[200~<body>\x1b[201~` to the PTY.
2. Poll raw stdout every 25ms for up to 5s looking for an echo of the body's first 12 chars (or a word quorum from the first 160 chars, or CC's `[Pasted text #N]` placeholder for long pastes).
3. Once echo confirmed, write `\r`.
4. On timeout: send double-Escape to clear the composer (single Escape is not enough — CC uses a double-press within 800ms). Return `'echo-timeout'` — never submit unverified text.

**`TimedBracketedPasteQueue`** (used by `PtySession`):
- Wraps the older 500ms fixed-timeout approach. Serializes messages so rapid sends don't merge in CC's composer.
- Labeled explicitly as "legacy" in the source (`send-protocol.ts:77`).

---

### Transcript reading — `JsonlTailer` (`jsonl-tailer.ts`)

Polls CC's per-session JSONL file every 200ms (default). Emits typed `JsonlEvent` events for: user turns, tool calls, tool results, turn-ends, usage, thinking blocks, system messages, queue ops, compaction boundaries, session-state changes, and more. The source cursor (line number) rides along as `JsonlEventMeta` so callers can persist a resume point.

`JsonlEvent` is a discriminated union with 26+ variants. `chat-policy.ts` classifies each variant into `shown | collapsed | hidden` and `chat | tools | system | internal` lanes — the single policy table for what the user sees.

---

### Supporting utilities

**`env-scrub.ts` / `scrubIdeEnv`** — strips 20 VS Code / parent-claude.exe env vars before every spawn (`VSCODE_*`, `CLAUDE_CODE_*`, `GIT_ASKPASS`, etc.). Prevents the child from trying to attach to a non-existent IDE IPC channel and silently eating the first prompt.

**`claude-resolver.ts` / `requireClaudeBinary`** — resolves `claude.exe` path via a 7-step priority chain: per-call override → configured (`GlobalSettings.claudeExe`) → `CLAUDE_EXE` env → bundled CLI in app resources → PATH → `~/.local/bin`. Throws a clear error on not-found instead of silent ENOENT.

**`path-resolver.ts`** — canonical source for CC JSONL paths. Honors `CLAUDE_CONFIG_DIR` (historically ignored, causing Section 15's chat-goes-blank bug). CWD encoding: every non-`[A-Za-z0-9._-]` byte → `-`. `jsonlPathFor(workspacePath, sessionUuid)` is the authoritative formula.

**`ansi.ts`** — two normalization functions. `collapseAnsiToWhitespace` maps `CSI N C` (cursor-right) to spaces before stripping other ANSI, then collapses whitespace runs. Used by `ReadyGate` for signal matching. `stripAnsiPreserveSpacing` preserves cursor-right as spaces but keeps the rest — used for chunk text emitted to xterm surfaces.

**`node-launcher.ts` / `resolveNodeLauncher`** — resolves how to launch Node.js scripts in the current process: `node` under dev, `process.execPath + { ELECTRON_RUN_AS_NODE: '1' }` in a packaged Electron app. Used when scaffolding `.mcp.json` so MCP child processes don't fail inside the packaged binary.

**`worktree.ts`** — thin `git worktree` wrapper: `createWorktree`, `listWorktrees`, `destroyWorktree`, `attachWorktree`, `pruneWorktrees`. Shells out to git from a workspace cwd. Used by the server's worktree-lifecycle service to isolate per-agent work.

---

### State machines (today)

| Wrapper | States | Ready signal | Send mechanism |
|---|---|---|---|
| `LowLevelSpawn` | `spawning → ready → running → exited` | `ReadyGate` (3 signals) | echo-ack bracketed paste |
| `InteractiveSession` | `stopped → spawning → ready ↔ busy → exited | failed` | delegates to `LowLevelSpawn` | delegates to `LowLevelSpawn` |
| `PtySession` | `spawning → ready → thinking → exited` | banner regex (`terminalBufferLooksReady`) | `TimedBracketedPasteQueue` (500ms fixed) |

---

## Integrations (how it connects)

**Depends on:**
- `node-pty` — the actual PTY spawn (Windows ConPTY on Windows).
- `CLAUDE_CONFIG_DIR` / `~/.claude/projects/` — CC's JSONL output location.
- `/api/internal/mcp-handshake` HTTP route — the MCP child posts here; the server calls `notifyMcpHandshake()` on the spawn to unblock the ready gate.

**Used by:**
- `apps/server/src/services/project-runtime.ts` — `ProjectRuntime` creates `InteractiveSession` (orchestrator, line 501) and three `PtySession`s (modals, lines 792/934/1016).
- `packages/host/` — the out-of-process agent host uses `LowLevelSpawn` directly (with `suppressJsonlTailer: true` — the API server tails the JSONL; a second tailer on the same file would be redundant).

**Contracts / events crossed:**
- `LowLevelSpawn` / `InteractiveSession` emit: `jsonl-event (JsonlEvent)`, `ready (ReadyTimestamps)`, `chunk`, `raw`, `exit`, `state`, `jsonl-cursor-tick`.
- `PtySession` emits the same plus legacy `turn-end` and `event` (from the hook-driven events file watcher).
- `jsonl-cursor-tick` carries the JSONL source cursor so callers can persist a resume point to the DB.

---

## Target shape (per north star)

Per `unified-process-supervision-2026-06-02.md §4 + §6` and `consolidation-ledger-2026-06-02.md`:

The goal is **one session primitive** (currently `AgentRun` with policy flags) that replaces all three wrappers. The migration is ordered:

- **Keep** `LowLevelSpawn` — it is the one PTY spawn primitive (ledger: KEEP).
- **Keep** `ReadyGate` — the one ready detector (ledger: KEEP).
- **Keep** `JsonlTailer` — foundational base layer; not legacy (ledger: KEEP, V6 re-confirmed).
- **Merge `InteractiveSession` → `AgentRun`** (Step 4) — the orchestrator becomes a `persistent, interactive, fire-and-watch` policy on the one primitive. Prereqs: Steps 3+5 (Engine re-resolution).
- **Delete `PtySession`** (Step 5+6) — after the three modals migrate to the Engine with policy `ephemeral, streaming`. Not a free delete — confirmed live at `project-runtime.ts:792/934/1016`. Also deletes: `terminalBufferLooksReady` banner regex, `watchFile`-based stop-marker + events-file watching (ledger: DELETE after Step 5).
- `TimedBracketedPasteQueue` goes with `PtySession`.
- `chat-policy.ts` stays (view-layer policy table, not a lifecycle concern).
- `worktree.ts`, `env-scrub.ts`, `claude-resolver.ts`, `path-resolver.ts`, `ansi.ts`, `node-launcher.ts` all stay as shared utilities.

**Step 6 convergence** (`unified-process-supervision §9`): once every `claude.exe` is on the Engine, delete the duplicate state machines and the duplicate ready detector. One FSM, one gate, one tailer layer. `AgentRun` becomes the sole lifecycle primitive.

---

## Known issues / scar tissue

**Banner cursor-right escapes (BURNED)**
CC v2+ renders banner words with `\x1b[1C` cursor-right escapes instead of literal spaces. `stripAnsi(buf)` collapses them, making "Welcome back" become "Welcomeback". All ready-signal patterns use `\s*` to match both forms. See `ansi.ts` and `ready-gate.ts:31`. Burn record in memory file `reference_claude_exe_banner_rendering.md`.

**`ready` fires on banner, NOT on MCP-ready (confirmed design gap)**
`ReadyGate` in `LowLevelSpawn` uses the MCP handshake + banner signals. But `PtySession`'s `terminalBufferLooksReady` returns true as soon as the welcome banner appears — CC's MCP children take an additional 1–3s to register their tools. Sending a user prompt at `state: 'ready'` on `PtySession` makes turn 1 see only built-in tools. Memory file `reference_pty_ready_is_banner_not_mcp.md`. `LowLevelSpawn` (used by agent workers) fixes this via the explicit MCP handshake signal; `PtySession` (used by modals) does not.

**Resume quiet-window (documented, not fixed for `PtySession`)**
`--resume` on `PtySession` accepts PTY input but only after stdout has been quiet ≥1500ms post-banner. `PtySession` sends on `state: 'ready'` (too early). Isolated in `labs/agent-resume-repro`. `LowLevelSpawn` avoids this by gating on `awaitReady()`. Memory file `reference_resume_needs_quiet_window.md`.

**JSONL discovery scan mtime race (`PtySession`)**
When `jsonlPath` is not supplied, `PtySession` does a directory scan (`startJsonlDiscovery`) polling for a `.jsonl` file whose mtime is at/after spawn time (with a 1s grace). A clock skew or slow CC mint can latch onto an old session's JSONL. Fixed for the orchestrator path by always passing `jsonlPath`; still present on the directory-scan fallback for `PtySession` subagent use. `excludeJsonlPaths` mitigates but doesn't eliminate the race.

**JSONL path discovery requires `CLAUDE_CONFIG_DIR` awareness (`PtySession`)**
`PtySession` derives `claudeProjectsDir` from `claudeProjectsRoot()` (which now honors `CLAUDE_CONFIG_DIR`), but the pre-Section 15 hardcoded `homedir()` version of this bug caused empty chat panels whenever `CLAUDE_CONFIG_DIR` was set. `path-resolver.ts` is now the canonical source; any caller that hardcodes `~/.claude` directly is a bug.

**Constructor emit race (Section 15 lesson)**
Tailer attach is deferred to `setImmediate` in both `LowLevelSpawn:254` and `PtySession:510` so the constructor's caller can wire listeners before historical events fire. `ReadyGate:137` also defers its `ready` emit for the same reason. Pattern: any emit during or immediately after construction loses events.

**`PtySession` uses `watchFile` polling (fragile on Windows)**
Stop-marker and events-file watching via `watchFile(..., { interval: 250 })` (`pty-session.ts:459,476`). This is a kernel-notify fallback with a 250ms poll. On Windows it relies on stat calls and is known to occasionally miss rapid writes. The `JsonlTailer` (used by `LowLevelSpawn`) also polls but uses `setInterval` with a 200ms cycle and processes the whole tail at once — more reliable than per-file `watchFile`.

**Dual env-scrub constants**
`pty-session.ts:35` defines its own `IDE_INTEGRATION_ENV_KEYS` constant inline (does NOT import `env-scrub.ts`). `low-level-spawn.ts` imports `scrubIdeEnv` from `env-scrub.ts`. Both sets are identical today, but they are two declarations that can drift. Source comment in `env-scrub.ts:6` acknowledges this: "Mirrors labs/agent-system/support/env-scrub.mjs + the production pty-session.ts:33 set."

**`TimedBracketedPasteQueue` is timing-heuristic, not positive-receipt**
`PtySession` submits Enter 500ms after pasting, unconditionally. The `send-protocol.ts:7` comment explicitly calls this "conservative" and notes it violates the lab anti-criteria (D7). Echo-ack (`sendBracketedPaste`) replaced this for `LowLevelSpawn` agents. The 500ms heuristic remains for all three modals.

---

## Open questions

1. **Sequencing for modal migration (Steps 5–6):** the three `PtySession` modals (`project-runtime.ts:792/934/1016`) need deterministic session IDs and live chat streaming before they can move to the Engine. What is the minimal Engine API they need (vs. the full `AgentRun` FSM)?

2. **`InteractiveSession` retry semantics vs. Engine restart:** `InteractiveSession` supports `maxSpawnAttempts` + `retryBackoffMs`. Once the orchestrator moves to the Engine, does the Engine provide equivalent retry, or is that purely the Supervisor's job?

3. **`suppressJsonlTailer` flag on `LowLevelSpawn`:** the out-of-process host sets this to avoid a second `fs.watch` on the JSONL. After Step 6, is the tailer always on the API-server side, or does the Engine keep its own? Needs to be a single, clearly-owned tailer per session.

4. **`PtySession.terminalBufferLooksReady` duplication:** the function exists in `pty-session.ts:79` AND `ready-gate.ts:34` (`looksInitComplete`) with slightly different pattern sets. These need to reconcile before deletion. The ledger calls `terminalBufferLooksReady` a DELETE target; `looksInitComplete` in `ReadyGate` is the KEEP.

5. **`chat-policy.ts` placement:** currently in `packages/runtime` but its input is a `JsonlEvent` and its output is a view-layer classification. Should it live closer to the rendering layer, or stay here as a shared policy table?
