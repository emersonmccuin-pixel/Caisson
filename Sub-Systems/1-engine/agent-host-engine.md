# Agent Host (Engine)

> **Role:** Engine
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `packages/agent-host/src/agent-host-service.ts` · `packages/agent-host/src/http-server.ts` · `packages/agent-host/src/cli.ts` · `packages/runtime/src/agent-host-protocol.ts` · `packages/runtime/src/agent-host-lock-file.ts` · `apps/server/src/services/host-connection.ts` · `apps/desktop/src/agent-host-process.ts`

---

## What it is (plain English)

The Engine is **the garage where every Claude process is parked and maintained — one mechanic owns all the cars.** It is a background process that runs separately from the main app server. When an agent needs to do a job, the server tells the Engine "start this one," and the Engine spawns the Claude process, keeps it alive, watches it, and streams back everything it does. If the server crashes or hot-reloads during development, the agents already running keep going — they're in the garage, not inside the server.

Today the Engine only manages **dispatched agents** (workers launched by a workflow or the orchestrator). The orchestrator's own conversation and three pop-up sessions (agent-designer, workflow-creator, setup-wizard) are still managed directly by the server — that's the gap the north-star rebuild closes.

---

## What it's supposed to do (intent)

Own every Claude process in the system so that no other part of the app needs to think about AI-process lifecycle. One place to start a process, one signal that it's ready, one signal that it's done, one stream of events. The separation from the server is the whole point — crash-isolation means a server restart or hot-reload during development doesn't kill agents mid-task.

---

## The parts (every component, plain English)

### 1. How the Engine starts up

The Engine starts as a separate process via `cli.ts`. It has two modes:

- **HTTP mode (production path):** started with a `--http-lock-file` flag. It opens an HTTP server on an available port and writes a small **lock file** — a JSON file at `<dataDir>/agent-host/host.lock.json` that says "I'm alive at this port, this PID, this time." Everything else in the system uses that file to find and talk to the Engine.
- **Stdio mode (test-only):** if no lock-file flag is present, it falls back to reading commands from standard input and writing events to standard output. This path exists for automated tests; the real app always uses HTTP.

### 2. The lock file — how the server finds the Engine

The lock file is the **only rendezvous point**. There is no hard-coded port. The server reads the file, checks that the process ID inside is actually running, and then connects to whatever port the file says.

Contents of the lock file (`agent-host-lock-file.ts`):

| Field | Plain meaning | Example |
|---|---|---|
| `pid` | Process ID — used to confirm the Engine is alive | `12345` |
| `hostId` | A unique ID minted each startup | (a UUID) |
| `port` | The HTTP port to send commands to | `49200` |
| `startedAt` | When it started | (ISO timestamp) |
| `protocolVersion` | Version of the command format — must match the server's expectation | `1` |

> ⚠️ **Drift twin.** The lock-file shape is defined in `packages/runtime/src/agent-host-lock-file.ts`, but the Electron main process (`apps/desktop/src/agent-host-process.ts`) can't import that package (it would drag in `node-pty`, a native module). So the desktop app **hand-copies the shape**. Any change to the lock file format must be mirrored by hand in both files — there's no compile-time check. A comment at `agent-host-lock-file.ts:1` explicitly warns about this.

### 3. The HTTP API — how the server talks to the Engine

Three endpoints:

| Endpoint | Plain purpose |
|---|---|
| `GET /health` | "Are you alive?" — returns the Engine's identity. Used by the heartbeat. |
| `POST /command` | "Do something" — accepts any command and returns a response. |
| `GET /events?after=<seq>` | A live stream of everything happening — replays buffered events, then streams new ones as they arrive. Sends a blank keepalive line every 15 seconds to hold the connection open. |

Commands the Engine understands (`agent-host-protocol.ts:76–90`):

`hello` · `list-runs` · `start-run` · `resume-run` · `send` · `mark-paused` · `answer-pending` · `cancel` · `complete-run` · `notify-mcp-handshake` · `shutdown`

> 🟢 **FD-16 (locked 2026-06-03):** these surface to the orchestrator two-tier — lifecycle ops
> (list / inspect / cancel / resume) as first-order tools it natively knows; diagnostics reachable
> on demand via a search-style tool, never dumped into the prompt.

### 4. The run tracker — what lives inside the Engine

`AgentHostService` (`agent-host-service.ts`) holds two in-memory lookup tables:

- **`runs`** — maps a run ID to its active `HostRunEntry` (one entry per live agent job).
- **`ccSessionIndex`** — maps the Claude process's own session ID back to the run ID (so when Claude signals something, the Engine can find which run it belongs to).

On `start-run` or `resume-run`, the Engine creates an `AgentRun` (from `@pc/runtime`), wires up four listeners (state changes, transcript events, raw text chunks, and terminal/done signals), and starts the Claude process.

### 5. How a job finishes (the done signal)

When an agent calls the `pc_submit_deliverable` tool — "here's my finished work" — the server's deliverable route tells the Engine `complete-run`. The Engine calls `run.complete(result)`, which triggers the `terminal` event. That event is the **only valid "done" signal.** There is no fallback path that guesses completion from log files; the old fallback was deleted in commit `40c2a91f`. The lesson is law: any "done" handling added outside this one path will strand runs again.

(`agent-host-service.ts:296–313`)

### 6. The event buffer — the Engine's memory

The Engine keeps the last 1,000 events in a ring buffer (an in-memory queue that discards oldest entries when full). When the server reconnects after a gap, it tells the Engine the last event sequence number it saw and gets a replay of everything since. 

> ⚠️ If the server is disconnected long enough that more than 1,000 events have passed, it misses the middle; it falls back to `list-runs` to get current state. This is not a data-loss bug (the database is the truth) but means the event stream is not a durable log on its own.

### 7. The server's connection to the Engine (`host-connection.ts`)

`HostConnection` is the server-side wrapper that manages the ongoing relationship with the Engine. Key behaviors:

- **Auto-rediscovers after a respawn.** If the Engine dies and restarts on a new port, the server re-reads the lock file and reconnects automatically — no server restart needed.
- **Watermark tracking.** Remembers the last event sequence number so reconnection picks up where it left off.
- **Heartbeat with backoff.** Checks in every 10–30 seconds and publishes a health status (`connected` / `reconnecting` / `down`) for the health indicator in the UI.
- **Protocol version mismatch = terminal.** If the lock file shows a different `protocolVersion` than expected, health goes to permanent `down` rather than keep retrying.

### 8. Packaged (installed) app mode (`apps/desktop/src/agent-host-process.ts`)

In the installed desktop app (Electron), the main process starts the Engine by running `agent-host.mjs --http-lock-file <path>` as a child process, using the Electron binary with a flag that makes it run as plain Node.

> 📌 **Known gap — packaged host never respawns.** If the Engine dies in the packaged app, Electron does not restart it. In development, a separate dev-supervisor script (`dev-supervisor.mjs`) handles respawning, which is why this gap only surfaces in the installed app. This is the direct motivation for **Step 7 (Supervisor)** in the rebuild plan.

---

## How it connects

- **Depends on:** `AgentRun`, `AgentRunRegistry`, and `LowLevelSpawn` from `@pc/runtime` — the actual PTY (terminal emulator) spawn and lifecycle primitives. `ReadyGate` (the signal that a Claude process is ready to receive input) lives inside `AgentRun`. The server passes in the `jsonlPath` (path to Claude's transcript file) rather than letting the Engine compute it independently, to avoid drift.
- **Used by:** the main server (`apps/server`) via `HostConnection` → `HttpAgentHostClient` → `POST /command`; the Electron main process (`apps/desktop`) for startup and shutdown.
- **Contracts / events crossed:**
  - Wire protocol types: `AgentHostCommand` / `AgentHostCommandResponse` / `AgentHostEvent` (all in `packages/runtime/src/agent-host-protocol.ts`).
  - Discovery: `AgentHostLockFile` at `<dataDir>/agent-host/host.lock.json`.
  - Events the server reacts to: `run-terminal` (the one good "done"), `run-state`, `run-jsonl`, `run-chunk`.
  - Server-side handler: `applyHostTerminalSnapshot` in `agent-host-reattach.ts` routes every terminal event through `applyAgentRunTerminalEffects` — the single terminal authority (Step 1, done).

---

## Target shape (per north star + Foundation Decisions)

**Ledger verdict: KEEP → grow.** The Engine is the right foundation; expand its scope, don't replace it.

Per `unified-process-supervision-2026-06-02.md` §9, Steps 3–6:

- **Step 3 (Brain re-resolution):** `HostConnection` can already rediscover after an Engine respawn. Remaining: the server must **hold** (not act on stale state) if the Engine is unreachable — it currently could act on an empty snapshot.
- **Step 4:** Engine absorbs the orchestrator session (`InteractiveSession`). Server stops owning the orchestrator's Claude process; hands it to the Engine as a policy run (`{ persistent, interactive, fire-and-watch }`).
- **Step 5:** Engine absorbs the three modal sessions (`PtySession`). Same move, policy `{ ephemeral, streaming }`.
- **Step 6:** With all sessions on the Engine, delete the duplicates: `PtySession`, `InteractiveSession`, the banner-regex ready detector (`terminalBufferLooksReady`), and PtySession's file-watching. `AgentRun` becomes the one session primitive, differentiated by policy flags. `jsonl-tailer.ts` (the base transcript reader) stays.

After Step 6: **one state machine, one ready detector (`ReadyGate`), one transcript reader (`agent-run-jsonl-tailer.ts`), one completion signal (`complete-run`).**

The current gap: today the Engine owns dispatched agents only. The orchestrator lives in `InteractiveSession` (server-owned) and the three modals live in `PtySession` (also server-owned). Steps 4–5 are high-confidence moves but require Step 3 as a prereq so an Engine respawn can't silently sever the orchestrator.

---

## Known issues / scar tissue

- **Packaged host never respawns.** See Part 8. Only visible in the installed app; development is covered by `dev-supervisor.mjs`. Supervisor (Step 7) is the fix.
- **Lock-file drift twin.** See Part 2. No compile-time safety net — a format change must be mirrored by hand.
- **Step 3 is incomplete.** The server can rediscover after an Engine respawn, but its reconciler does not yet hold on an unreachable Engine. It could act on stale state. This is Step 2/3 work.
- **Stdio path is a latent dual transport.** `cli.ts` still supports the JSON-line stdio mode. In any real run, the HTTP path is always taken. The stdio branch is only exercised by tests; it is not a behavior risk in production, but it is an untested surface.
- **Event buffer is lossy.** See Part 6. 1,000-event cap is not a correctness bug but means the stream is not a durable replay log.

---

## Decisions & open questions

**For Emerson (product calls):**
1. **Supervisor scope.** Step 7 builds a Supervisor that respawns the Engine if it dies in the packaged app. Does it also need to restart the main server if that dies? (The dev script already does both.)

**Technical:**
- What policy flags does `AgentRun` need for an orchestrator session (`persistent`, `interactive`, no idle-kill, streaming input)? The class was designed for one-shot dispatched jobs; these semantics need validation before Step 4.
- Do modal sessions need deterministic Claude session IDs threaded through `AgentHostStartRunRequest`? Prior bleed-through bugs (`b33e37b`) required deterministic session IDs. Confirm the mint path is safe before Step 5.
- ~~Does the server's `ChannelServer` child survive Step 4?~~ **Resolved — ☠ FD-3 (locked 2026-06-03):** nothing of the channel system survives the rebuild. Notifications reach the orchestrator only via the mailbox-injected turn.
- Should the event buffer be backed by the `live_outbox` table (once workflow events become the truth in slice 3) rather than an in-memory ring? If the server can always replay from the DB, the 1,000-event cap becomes irrelevant.
