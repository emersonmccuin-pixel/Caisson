# Agent Host (Engine)

> **Role:** Engine
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `packages/agent-host/src/agent-host-service.ts`, `packages/agent-host/src/http-server.ts`, `packages/agent-host/src/cli.ts`, `packages/runtime/src/agent-host-protocol.ts`, `packages/runtime/src/agent-host-lock-file.ts`, `apps/server/src/services/host-connection.ts`, `apps/desktop/src/agent-host-process.ts`

## What it is (plain English)

The Agent Host is a separate background process that owns and runs dispatched `claude.exe` agent workers. The main server (the Brain) sends it commands over HTTP to start, pause, answer, cancel, or complete a run. The host actually spawns the `claude.exe` processes, watches them, and streams their events back. It is crash-isolated from the Brain: if the server hot-reloads or crashes, the agent workers survive.

Today it only owns **dispatched agents** (workflow steps and orchestrator-triggered workers). The orchestrator conversation and the three modal sessions (`agent-designer`, `workflow-creator`, `setup-wizard`) are still owned by the Brain directly — that is the gap the north star closes.

## What it's supposed to do (intent)

Own every `claude.exe` process so that no other component needs to manage AI-process lifecycle. One home for spawning, one ready signal, one completion signal, one transcript stream. The crash-isolation property is the whole reason it exists as a separate process.

## How it works today (as-built)

**Startup — two transport modes**

- `cli.ts` starts the host. If `--http-lock-file` (or `PC_AGENT_HOST_LOCK_FILE`) is set, it starts an HTTP server and writes a lock file (`agent-host/host.lock.json`) containing `{ pid, hostId, port, startedAt, protocolVersion }`. This is the production path.
- If no lock-file flag is present, it falls back to a stdio JSON-line protocol (newline-delimited commands in / events out). This path exists for tests and is not used by the running app.

**Lock file and discovery**

- The Brain discovers the host by reading the lock file via `discoverAgentHostEndpoint` (`agent-host-lock-file.ts`). It checks the PID is alive before trusting the port.
- The lock file is the ONLY rendezvous — there is no registration call, no fixed port.
- `agent-host-lock-file.ts` and `apps/desktop/src/agent-host-process.ts` are **drift twins**: the Electron main process cannot import `@pc/runtime` (it would pull in `node-pty`), so it hand-copies the lock-file shape. Any change to the shape or `protocolVersion` must be mirrored manually (`agent-host-lock-file.ts:1–6`).

**HTTP API (three endpoints)**

| Endpoint | Purpose |
|---|---|
| `GET /health` | Returns identity. Used by heartbeat. |
| `POST /command` | Accepts any `AgentHostCommand` JSON; returns `AgentHostCommandResponse`. |
| `GET /events?after=<seq>` | NDJSON stream — replays buffered events, then streams live ones. 15s newline keepalive. |

**Commands the host understands** (`agent-host-protocol.ts:76–90`)

`hello` · `list-runs` · `start-run` · `resume-run` · `send` · `mark-paused` · `answer-pending` · `cancel` · `complete-run` · `notify-mcp-handshake` · `shutdown`

**Run lifecycle inside the host**

- `AgentHostService` (`agent-host-service.ts`) holds two in-memory maps: `runs` (runId → `HostRunEntry`) and `ccSessionIndex` (ccSessionId → runId).
- On `start-run` or `resume-run`, it creates an `AgentRun` (from `@pc/runtime`), wires four event listeners (`state`, `jsonl-event`, `chunk`, `terminal`), then calls `run.start()`.
- On `terminal`, it appends a `run-terminal` event to the buffer and removes the cc session from the index.
- The event buffer holds up to 1,000 events (configurable). The `/events` stream replays anything after the caller's `seq` watermark and then goes live.

**Completion path** (`agent-host-service.ts:296–313`)

The Brain's deliverable route calls `complete-run` on the host when an agent submits `pc_submit_deliverable`. The host calls `run.complete(result)`, which transitions the `AgentRun` to `completed` and fires the `terminal` event. That event is the sole "good done" signal — there is no in-process fallback path (it was deleted in slice Step 1, commit `40c2a91f`).

**Brain-side connection** (`host-connection.ts`)

`HostConnection` wraps an `HttpAgentHostClient` behind a single long-lived conduit. Key behaviors:
- Re-discovers the host from the lock file on any connection failure (survives host respawn on a new port without requiring a Brain restart).
- Tracks a `lastSeq` watermark so reconnection resubscribes from the right event offset.
- Backoff-gated heartbeat (10s–30s) publishes `HostHealth` (`connected` / `reconnecting` / `down`) for the UI health pill.
- If the lock file's `protocolVersion` doesn't match, health transitions to terminal `down` (not `reconnecting`).

**Packaged mode** (`apps/desktop/src/agent-host-process.ts`)

Electron main calls `spawnPackagedAgentHostProcess`, which runs `agent-host.mjs --http-lock-file <path>` as a child process using the Electron binary with `ELECTRON_RUN_AS_NODE=1`. **Packaged Electron does NOT respawn the host if it dies** — this is the known gap that Step 7 (Supervisor) fixes.

## Integrations (how it connects)

- **Depends on:** `AgentRun` + `AgentRunRegistry` + `LowLevelSpawn` from `@pc/runtime` (the actual PTY spawn and lifecycle primitives). `ReadyGate` lives inside `AgentRun`. The Brain passes `jsonlPath` (server-computed) to avoid the host recomputing it from a divergent env.
- **Used by:** the Brain (`apps/server`) via `HostConnection` → `HttpAgentHostClient` → `POST /command`; Electron main (`apps/desktop`) for spawning and shutdown.
- **Contracts / events crossed:**
  - Wire protocol: `AgentHostCommand` / `AgentHostCommandResponse` / `AgentHostEvent` (all defined in `packages/runtime/src/agent-host-protocol.ts`).
  - Discovery: `AgentHostLockFile` at `<dataDir>/agent-host/host.lock.json`.
  - Events the Brain reacts to: `run-terminal` (the one terminal authority), `run-state`, `run-jsonl`, `run-chunk`.
  - Brain-side handlers: `applyHostTerminalSnapshot` in `agent-host-reattach.ts` routes every terminal event through `applyAgentRunTerminalEffects` (the single terminal authority, Step 1 done).

## Target shape (per north star)

**Ledger verdict:** `KEEP → grow` (it IS the Engine; expand its scope, don't replace it).

Per `unified-process-supervision-2026-06-02.md` §9 Steps 3–6:

- **Step 3 (Brain re-resolution):** already mostly works via `HostConnection`'s lock-file re-discovery. Needs a guard: the Brain must HOLD (not finalize) if the Engine is unreachable, not act on an empty snapshot.
- **Step 4:** Engine absorbs the orchestrator session (`InteractiveSession`). Brain stops owning orchestrator `claude.exe`; passes it to the Engine as a `{ persistent, interactive, fire-and-watch }` policy run.
- **Step 5:** Engine absorbs the three modals (`PtySession`). Same move, policy `{ ephemeral, streaming }`.
- **Step 6:** With everything on the Engine, delete the duplicates: `PtySession`, `InteractiveSession`, the banner-regex ready detector (`terminalBufferLooksReady`), PtySession's file-watching. `AgentRun` becomes the single session primitive with policy flags. `jsonl-tailer.ts` (base layer) stays.

After Step 6, the Engine owns every `claude.exe` in the tree: one state machine, one ready detector (`ReadyGate`), one transcript reader (`agent-run-jsonl-tailer.ts`), one completion signal (`complete-run`).

The current gap: the host owns **dispatched agents only**. The orchestrator lives in `InteractiveSession` (Brain-owned) and the three modals live in `PtySession` (also Brain-owned). Steps 4–5 are `HIGH` confidence but require Step 3 as a prereq (so an Engine respawn doesn't silently sever the orchestrator).

## Known issues / scar tissue

- **Packaged host never respawns.** Electron main spawns the host once and does not restart it on death. This is the direct motivation for Step 7 (Supervisor). In dev, `dev-supervisor.mjs` does respawn it, which is why the gap is only visible in the packaged app.
- **Lock-file drift twin.** `agent-host-lock-file.ts` and `apps/desktop/src/agent-host-process.ts` must be kept in sync by hand — there is no compile-time check. Comment at `agent-host-lock-file.ts:1` explicitly warns about this.
- **Step 3 is incomplete.** `HostConnection` can re-discover after a respawn, but the Brain's reconciler does not yet HOLD on an unreachable Engine — it could act on stale state. This is Step 2/3 work.
- **Stdio path is a latent dual transport.** `cli.ts` still supports the JSON-line stdio protocol. In any real server run, the HTTP path is always taken (`index.ts:279,304` always wires a `hostConnection`). The stdio branch is only exercised by tests that don't start a real host. Not a behavior risk in production, but it is an untested surface in prod.
- **Event buffer is lossy.** The in-memory ring buffer caps at 1,000 events. If the Brain disconnects long enough to miss more than 1,000 events, it will not be able to reconstruct intermediate run states from the replay buffer alone — it must fall back to `list-runs`. This is not a correctness bug (the DB is truth) but means the event stream is not a durable log.

## Open questions

- What policy flags are needed for the orchestrator (`persistent, interactive, fire-and-watch`) to actually work on the Engine's `AgentRun` primitive? The `AgentRun` class was designed for one-shot dispatched runs; `interactive` and `persistent` semantics (no wall-clock, no idle-kill, streaming input) need to be validated before Step 4.
- Do modals need deterministic `ccSessionId`s threaded through `AgentHostStartRunRequest`? Prior bleed-through bugs (`b33e37b`) required deterministic session ids. Confirm the mint path is safe before Step 5.
- After the Engine absorbs the orchestrator (Step 4), does the Brain's `ChannelServer` per-project stdio child still need to exist? The ledger marks this `VERIFY` — confirm it's the orchestrator's MCP bridge and what survives after Step 4.
- Should the event buffer be backed by the `live_outbox` table (once workflow events become truth in slice 3) rather than an in-memory ring? If the Brain can always replay from the DB, the in-memory cap becomes irrelevant.
