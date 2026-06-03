# Runtime — PTY & Session Primitives

> **Role:** Engine (target) — cross-cutting today (Brain + Engine both own sessions)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `packages/runtime/src/low-level-spawn.ts` · `packages/runtime/src/pty-session.ts` · `packages/runtime/src/interactive-session.ts` · `packages/runtime/src/ready-gate.ts` · `packages/runtime/src/send-protocol.ts` · `packages/runtime/src/jsonl-tailer.ts` · `packages/runtime/src/ansi.ts` · `packages/runtime/src/env-scrub.ts` · `packages/runtime/src/claude-resolver.ts` · `packages/runtime/src/path-resolver.ts` · `packages/runtime/src/node-launcher.ts` · `packages/runtime/src/chat-policy.ts` · `packages/runtime/src/worktree.ts`

---

## What it is (plain English)

Think of this as **the ignition system and steering wheel for every Claude process the app runs.** When any part of the app needs a Claude AI — whether it's a dispatched agent worker, the main orchestrator chat, or a popup modal — this subsystem is the thing that physically starts the `claude.exe` program, waits until Claude is genuinely ready to accept input (not just visually open), types messages into it, and reads structured responses back out. Without this layer, the rest of the app would have no way to talk to Claude at all.

---

## What it's supposed to do (intent)

Own the complete life of a single `claude.exe` child process: start it with the right settings, clean the environment so it doesn't accidentally inherit leftover IDE-integration markers, detect the precise moment Claude is ready (not just started), send messages safely, stream the output back as structured events, and clean up on exit. Any code that physically touches a Claude process lives here.

---

## The parts (every component, plain English)

### 1. The three session wrappers (who uses which)

There are three ways to hold a `claude.exe` process today — each is a "wrapper" that manages one process. They're at different stages of maturity.

**`LowLevelSpawn`** (`low-level-spawn.ts`) — the newest, most reliable wrapper. Think of it as the clean-sheet replacement for everything that came before. One instance = one Claude process. It does nothing until `.start()` is called (no surprise spawning in the constructor). Used by all **dispatched agent workers** and the orchestrator.

What it does step-by-step:
1. Finds the `claude.exe` binary (see Part 5).
2. Builds the startup arguments — including a new session ID (fresh start) or a `--resume` flag (picking up an existing conversation).
3. Scrubs inherited environment variables that would confuse Claude (see Part 6).
4. Spawns the process via the `node-pty` library (a terminal emulator layer).
5. Feeds all raw output through `ReadyGate` until Claude is confirmed ready (see Part 3).
6. Defers attaching the output reader by one tick so callers can wire their listeners first (see Scar Tissue — constructor emit race).

☠ **FD-3 tombstone:** the `--dangerously-load-development-channels` flag — a dev-only argument currently added to some spawns — is **sentenced for removal**. In the rebuild, no session passes it. (`low-level-spawn.ts` arg list)

**`InteractiveSession`** (`interactive-session.ts`) — a lifecycle manager wrapped around `LowLevelSpawn`. It adds automatic retry-with-backoff if the process crashes on start, a hard spawn timeout, and a **state machine** (the thing that tracks whether Claude is idle, busy, or broken). The orchestrator's session goes through here.

The states it cycles through:

| State | Plain meaning |
|---|---|
| `stopped` | Not started yet |
| `spawning` | Starting up |
| `ready` | Idle, waiting for input |
| `busy` | Processing a message |
| `exited` | Finished normally |
| `failed` | Something went wrong |

It flips `ready → busy` when a message is sent, and `busy → ready` when the response is complete (on `jsonl-turn-end`).

Caller: `project-runtime.ts:501` — this is where the orchestrator's session is created.

**`PtySession`** (`pty-session.ts`) — the older wrapper, still live but scheduled for deletion. Used exclusively for the **three transient popup modals**: agent-designer (`project-runtime.ts:792`), workflow-builder (`project-runtime.ts:934`), and setup-wizard (`project-runtime.ts:1016`). Unlike `LowLevelSpawn`, it spawns the process directly without any of the newer reliability machinery. Its ready detection and send mechanism are both weaker (see Scar Tissue for the full list of gaps). It is the rebuild's primary deletion target.

---

### 2. Reading the output (the JSONL tailer)

Claude writes every turn — messages, tool calls, thinking blocks, session state changes — into a log file as it runs. This log is a **JSONL file** (JSON Lines — one JSON object per line). The app reads it by "tailing" — polling for new lines every 200ms.

The `JsonlTailer` (`jsonl-tailer.ts`) handles this polling. It emits strongly-typed events for 26+ kinds of output: user turns, tool calls, tool results, turn-ends, usage stats, thinking blocks, system messages, and more. It also tracks exactly which line it's read up to (the "cursor"), so sessions can be resumed without re-reading from the start.

How the event classifications work: `chat-policy.ts` reads each JSONL event and labels it as `shown | collapsed | hidden` and assigns it to a lane (`chat | tools | system | internal`). This is the single policy table for what the user sees vs. what's hidden — nothing else decides that.

---

### 3. Knowing when Claude is truly ready (`ReadyGate`)

This is one of the most important — and most burn-scarred — pieces of the system. Claude may appear to "start" within a fraction of a second, but it takes additional time for its internal tools to become available. Sending a message too early means Claude's first response can't use any of the app tools.

`ReadyGate` (`ready-gate.ts`) solves this for `LowLevelSpawn` (not used by `PtySession`). It waits for **all three of** these signals before declaring Claude ready:

| Signal | What it means | Skippable? |
|---|---|---|
| **MCP handshake** | Claude's tool server started and checked in via `/api/internal/mcp-handshake` | Yes (for subagents) |
| **Bracketed-paste-mode on** | A specific ANSI escape sequence (`\x1b[?2004h`) that signals the text input area is open | No |
| **Init-complete** | The welcome banner or footer text appears, confirming Claude is fully initialized | Yes (for subagents) |

Subagents wait for signals 1 + 2 only. The orchestrator (with `remoteControl` on) requires all three.

Once all required signals fire, the gate emits a `ready` event with timestamps for each signal. `LowLevelSpawn` resolves its `awaitReady()` promise at that point.

> `PtySession` does NOT use `ReadyGate`. It declares ready as soon as the welcome banner appears — which is too early. This is a documented gap (see Scar Tissue).

---

### 4. Sending messages safely (the send protocol)

Sending text to a terminal-based program like Claude is trickier than it sounds. The app uses a technique called **"bracketed paste"** — a standard terminal protocol where the app wraps text in special escape sequences (`\x1b[200~` … `\x1b[201~`) to signal "this is a paste, not individual keystrokes." This prevents Claude from partially processing input mid-paste.

Two implementations exist, at different quality levels:

**`sendBracketedPaste`** (used by `LowLevelSpawn`) — the reliable one:
1. Writes the bracketed paste sequence.
2. Polls raw output every 25ms for up to 5 seconds, watching for Claude to echo the first 12 characters back (confirming it received the full text).
3. Once the echo is confirmed, sends Enter.
4. If the echo doesn't arrive in 5 seconds: sends double-Escape to clear Claude's input (a single Escape isn't enough — Claude needs two within 800ms), then returns `'echo-timeout'` instead of blindly submitting unverified text.

**`TimedBracketedPasteQueue`** (used by `PtySession`) — the old, weaker one:
- Waits a fixed 500ms after pasting, then sends Enter regardless of whether Claude received the text correctly. The source code explicitly labels this "legacy" (`send-protocol.ts:77`). It also serializes messages so rapid sends don't merge in Claude's input buffer — but the fixed timeout is a guess, not a confirmation.

---

### 5. Finding the Claude binary (`claude-resolver.ts`)

The app needs to know where `claude.exe` lives on disk. `requireClaudeBinary` tries seven locations in order:

1. A per-call override passed directly.
2. The configured setting (`GlobalSettings.claudeExe`).
3. The `CLAUDE_EXE` environment variable.
4. The bundled CLI packaged inside the app's resources.
5. The system `PATH`.
6. `~/.local/bin`.
7. If none found — throws a clear error with instructions. No silent `ENOENT`.

---

### 6. Cleaning the environment before launch (`env-scrub.ts`)

Before spawning any Claude process, the app strips roughly 20 environment variables that VS Code and the parent Claude session inject into their processes — things like `VSCODE_*`, `CLAUDE_CODE_*`, and `GIT_ASKPASS`. If these aren't removed, the child Claude tries to connect to an IDE integration channel that doesn't exist for it, which can silently swallow the first message.

`scrubIdeEnv` in `env-scrub.ts` is the canonical function that does this. `LowLevelSpawn` imports and uses it. `PtySession` has its own copy of the same list hardcoded inline — two declarations that can drift (see Scar Tissue).

---

### 7. Finding the JSONL output file (`path-resolver.ts`)

CC writes its conversation log to `~/.claude/projects/<encoded-path>/<session-id>.jsonl`. The path encoding turns any non-alphanumeric character in the workspace path into a `-`. `path-resolver.ts` is the **single canonical source** for computing this path — and critically, it now honors the `CLAUDE_CONFIG_DIR` environment variable. Any caller that hardcodes `~/.claude` directly is a bug (this was the cause of Section 15's "chat goes blank" bug).

---

### 8. Handling Claude's banner text (`ansi.ts`)

Claude's welcome banner uses ANSI escape sequences — specifically `\x1b[1C` cursor-right codes — to space out words, instead of literal spaces. After stripping ANSI, "Welcome back" would become "Welcomeback." This caused ready-detection failures until diagnosed.

`ansi.ts` provides two normalization functions:
- `collapseAnsiToWhitespace` — maps cursor-right escapes to spaces, then strips other ANSI. Used by `ReadyGate` for signal matching.
- `stripAnsiPreserveSpacing` — keeps cursor-right as spaces, passes the rest to terminal surfaces. Used for display output.

---

### 9. Launching Node.js MCP tool servers correctly (`node-launcher.ts`)

Claude's tool servers (the MCP layer) run as separate Node.js processes. The right way to launch Node.js differs between running in development (`node`) and running inside a packaged Electron app (`process.execPath + ELECTRON_RUN_AS_NODE=1`). `resolveNodeLauncher` picks the correct form so that tool server processes don't fail when the app is distributed to users.

---

### 10. Git worktrees for isolated agent work (`worktree.ts`)

A thin wrapper around git's `worktree` command — a feature that lets you check out the same repository into a separate folder. Each agent run can get its own folder to work in, so parallel agents don't overwrite each other's files. `createWorktree`, `destroyWorktree`, `listWorktrees`, `attachWorktree`, `pruneWorktrees` all shell out to git. Used by the server's worktree-lifecycle service.

---

### State machines at a glance

| Wrapper | States | Ready signal | How it sends |
|---|---|---|---|
| `LowLevelSpawn` | `spawning → ready → running → exited` | `ReadyGate` (3 signals, all confirmed) | Echo-ack bracketed paste |
| `InteractiveSession` | `stopped → spawning → ready ↔ busy → exited \| failed` | Delegates to `LowLevelSpawn` | Delegates to `LowLevelSpawn` |
| `PtySession` | `spawning → ready → thinking → exited` | Banner regex (too early — see Scar Tissue) | 500ms fixed-timeout paste (unconfirmed) |

---

## How it connects

- **Depends on:** `node-pty` (the actual terminal process layer, Windows ConPTY on Windows) · `CLAUDE_CONFIG_DIR` / `~/.claude/projects/` (where CC writes its JSONL logs) · `/api/internal/mcp-handshake` HTTP route (the MCP tool server checks in here; the server calls `notifyMcpHandshake()` on the spawn to unblock the ready gate).
- **Used by:** `apps/server/src/services/project-runtime.ts` — creates `InteractiveSession` for the orchestrator (line 501) and three `PtySession`s for the modals (lines 792/934/1016) · `packages/host/` — the out-of-process agent host uses `LowLevelSpawn` directly with `suppressJsonlTailer: true` (the API server tails the JSONL; a second tailer on the same file would be redundant).
- **Events emitted:** `LowLevelSpawn` / `InteractiveSession` emit `jsonl-event`, `ready`, `chunk`, `raw`, `exit`, `state`, `jsonl-cursor-tick` · `PtySession` adds legacy `turn-end` and `event` (from the hook-driven events-file watcher) · `jsonl-cursor-tick` carries the source cursor for persisting a resume point to the DB.

---

## Target shape (per north star + Foundation Decisions)

Per `unified-process-supervision-2026-06-02.md §4+§6` and `consolidation-ledger-2026-06-02.md`:

The goal is **one session primitive** (`AgentRun` with policy flags) replacing all three wrappers. The migration order:

- **Keep** `LowLevelSpawn` — the one PTY spawn primitive (ledger: KEEP).
- **Keep** `ReadyGate` — the one ready detector (ledger: KEEP).
- **Keep** `JsonlTailer` — foundational base layer, not legacy (ledger: KEEP, V6 re-confirmed).
- **Merge `InteractiveSession` → `AgentRun`** (Step 4) — the orchestrator becomes a `persistent, interactive, fire-and-watch` policy on the one primitive. Prereqs: Steps 3+5 (Engine re-resolution).
- ☠ **Delete `PtySession`** (Steps 5+6) — after the three modals migrate to the Engine with policy `ephemeral, streaming`. Not a free delete — confirmed live at `project-runtime.ts:792/934/1016`. Also deletes: `terminalBufferLooksReady` banner regex, `watchFile`-based stop-marker + events-file watching (ledger: DELETE after Step 5).
- `TimedBracketedPasteQueue` goes with `PtySession`.
- `chat-policy.ts`, `worktree.ts`, `env-scrub.ts`, `claude-resolver.ts`, `path-resolver.ts`, `ansi.ts`, `node-launcher.ts` all stay as shared utilities.

**Step 6 convergence** (`unified-process-supervision §9`): once every `claude.exe` is on the Engine, delete the duplicate state machines and the duplicate ready detector. One FSM, one gate, one tailer layer. `AgentRun` becomes the sole lifecycle primitive.

---

## Known issues / scar tissue

**Banner cursor-right escapes — BURNED**
Claude v2+ spaces out banner words using `\x1b[1C` cursor-right ANSI codes instead of literal spaces. After stripping ANSI, "Welcome back" became "Welcomeback" — breaking all ready-signal pattern matching. Fix: all banner patterns now use `\s*` to match either form. (`ansi.ts`, `ready-gate.ts:31`; memory: `reference_claude_exe_banner_rendering.md`)

**`ready` fires on banner, not on MCP-ready — confirmed design gap**
`PtySession`'s `terminalBufferLooksReady` returns true the moment the welcome banner appears. But Claude's MCP tool servers take an additional 1–3 seconds to register their tools. A message sent at that "ready" sees only built-in tools on turn 1; tools re-bind by turn 2. `LowLevelSpawn` fixes this with the explicit MCP handshake signal; `PtySession` (all three modals) does not. (`reference_pty_ready_is_banner_not_mcp.md`)

**Resume quiet-window — documented, not fixed for `PtySession`**
When Claude resumes a previous conversation (`--resume`), it only accepts input after its output has been quiet for ≥1500ms post-banner. `PtySession` sends on `state: 'ready'` — which is too early. Isolated in `labs/agent-resume-repro`. `LowLevelSpawn` avoids this by gating on `awaitReady()`. (`reference_resume_needs_quiet_window.md`)

**JSONL discovery scan mtime race (`PtySession`)**
When no `jsonlPath` is supplied, `PtySession` does a directory scan polling for a `.jsonl` file whose file-modification-time is at or after spawn time. A clock skew or slow CC session-ID mint can latch onto an *old* session's log file — meaning the modal reads someone else's transcript. Fixed for the orchestrator path by always passing an explicit `jsonlPath`. The directory-scan fallback still has the race. `excludeJsonlPaths` helps but doesn't eliminate it.

**`CLAUDE_CONFIG_DIR` — pre-Section 15 blank-chat bug**
Before `path-resolver.ts` became the canonical source, hardcoded `~/.claude` paths silently broke whenever `CLAUDE_CONFIG_DIR` was set to a different location. Chat panels went blank. Any caller that bypasses `path-resolver.ts` and writes `~/.claude` directly is reintroducing this bug.

**Constructor emit race — BURNED**
If a class emits events synchronously during construction (or immediately after), the caller hasn't wired listeners yet and those events are lost forever. Fix in place: tailer attach is deferred to `setImmediate` in both `LowLevelSpawn:254` and `PtySession:510`; `ReadyGate:137` also defers its `ready` emit. The pattern must be followed by anything that emits in or right after a constructor. (`reference_constructor_emit_before_listeners_wired.md`)

**`PtySession` uses `watchFile` polling (fragile on Windows)**
Stop-marker and events-file detection use `watchFile(..., { interval: 250 })` (`pty-session.ts:459,476`). This is a poll-based fallback, not a real filesystem event. On Windows it occasionally misses rapid writes. The `JsonlTailer` used by `LowLevelSpawn` also polls, but uses `setInterval` at 200ms and processes the entire tail at once — more reliable.

**Dual env-scrub constants**
`pty-session.ts:35` defines its own copy of the environment-variable exclusion list inline instead of importing `env-scrub.ts`. `low-level-spawn.ts` uses `scrubIdeEnv` from `env-scrub.ts`. The two lists are identical today, but they can drift. (`env-scrub.ts:6` acknowledges this.)

**`TimedBracketedPasteQueue` is a timing guess, not a confirmation**
`PtySession` submits Enter 500ms after pasting, unconditionally — regardless of whether Claude actually received the text. The source explicitly calls this "conservative" and notes it violates the positive-receipt principle (`send-protocol.ts:7`). Echo-ack replaced this for `LowLevelSpawn`; all three modals still use the 500ms guess.

---

## Decisions & open questions

**For Emerson (product calls):**

1. **The three modals (agent-designer, workflow-builder, setup-wizard) are running on the older, weaker machinery.** They're more likely to silently eat a first message or behave oddly on resume. This will fix itself when they migrate to the Engine — but that's non-trivial work. Is stability in those modals a near-term priority, or does it wait for the full Engine migration?

2. **Resume behavior in modals.** When you open the agent-designer or workflow-builder to continue a previous conversation, there's a quiet-window timing gap — if the system talks to Claude too quickly, the message may be silently dropped. Is "resume a previous modal conversation" something users should be able to do today, or is it fine to always start fresh until this is properly fixed?

**Technical:**

- **Sequencing for modal migration (Steps 5–6):** the three `PtySession` modals need deterministic session IDs and live chat streaming before they can move to the Engine. What is the minimal Engine API they need vs. the full `AgentRun` FSM?
- **`InteractiveSession` retry semantics vs. Engine restart:** `InteractiveSession` has `maxSpawnAttempts` + `retryBackoffMs`. Once the orchestrator moves to the Engine, does the Engine provide equivalent retry, or is that purely the Supervisor's job?
- **`suppressJsonlTailer` flag on `LowLevelSpawn`:** the out-of-process host sets this to avoid a second `fs.watch` on the JSONL. After Step 6, is the tailer always on the API-server side, or does the Engine keep its own? Needs to be a single, clearly-owned tailer per session.
- **`terminalBufferLooksReady` duplication:** the function exists in `pty-session.ts:79` AND `ready-gate.ts:34` (`looksInitComplete`) with slightly different pattern sets. These need to reconcile before deletion. The ledger calls `terminalBufferLooksReady` a DELETE target; `looksInitComplete` in `ReadyGate` is the KEEP.
- **`chat-policy.ts` placement:** its input is a `JsonlEvent` and its output is a view-layer classification. Should it live closer to the rendering layer, or stay in `packages/runtime` as a shared policy table?
