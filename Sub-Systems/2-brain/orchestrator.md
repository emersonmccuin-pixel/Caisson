# Orchestrator

> **Role:** Brain (today) → Engine (target, Step 4)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `apps/server/src/services/project-runtime.ts` · `orchestrator-pod-content.ts` · `orchestrator-pod-seed.ts` · `orchestrator-runtime-health.ts` · `orchestrator-runtime-snapshot.ts` · `orchestrator-send-queue-delivery.ts` · `packages/db/src/repos/orchestrator-sessions.ts` · `packages/db/src/repos/orchestrator-send-queue.ts` · `packages/domain/src/orchestrator.ts` · `apps/web/src/components/Orchestrator.tsx` · `OrchestratorLauncher.tsx`

---

## What it is (plain English)

The orchestrator **is the chat you talk to.** It's a persistent AI process — the project's PM — that holds your conversation across sessions, takes your instructions, dispatches worker agents to do the substantive work, and brings results back to you. It's the only Claude process that ever talks to a human directly; every other agent in the system is a worker it hired.

It runs as a `claude.exe` process that starts the first time you open a project chat and **resumes the same conversation** on every subsequent open, picking up right where it left off.

---

## What it's supposed to do (intent)

One job: be the PM. Hold the conversation, translate your intent into actions (creating cards, dispatching agents, running workflows), answer questions about project state, and route results from worker agents back to you. Everything else — writing, research, analysis — gets delegated.

---

## The parts (every component, plain English)

### 1. How it's born (and how it picks back up)

When you open a project and send your first message, the server needs to decide: is this a **new conversation** or a **continuing one**?

- Every project keeps one active **session record** in the database (`orchestrator_sessions` table). This record stores the conversation's identity — a unique ID and the path to the transcript file Claude writes — so the server can find it again after a restart.
- **Resuming** (the normal case): the transcript file exists on disk → the server launches Claude with `--resume <id>`, and you pick up mid-conversation.
- **Starting fresh**: no transcript yet → the server launches Claude with `--session-id <id>`, minting the conversation at a stable known ID. The same stable ID ensures the transcript file is always found in the same place and never bleeds into another session.
- Clicking "Start Chat" (or sending a message) is what actually launches the process. Nothing spawns at boot — this prevents multiple simultaneous launch attempts when the UI opens.

(`project-runtime.ts:449`, `project-runtime.ts:1074`)

### 2. Its job description (the pod)

Like every agent in Caisson, the orchestrator's personality and capabilities come from a **pod** — a saved definition stored in the database. This one is called `orchestrator`, scope `global`, and it re-seeds itself automatically on every server boot (the seed is smart: if you've never edited it, code improvements are applied silently on upgrade; if you have, it leaves yours alone and just flags it as "Customized").

What's in the pod:
- **The prompt** — dispatching rules, inbox protocol, how to link to cards (`pc://` links), style rules, and the live roster of available agents. The roster (`{{AVAILABLE_AGENTS}}`) is filled in at spawn time so the orchestrator always knows what workers it can hire. (`orchestrator-pod-content.ts:61`, rendered via `pod-variable-renderers.ts`)
- **The tool set** — a deliberate subset. Local file ops (`Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash`) plus a curated list of coordination tools (`pc_*`). Worker-only, authoring, and pod-management tools are intentionally absent. (`orchestrator-pod-content.ts:315–353`)
- **Model:** `opus`. **Max turns:** none (it's a long-running conversation by design).

The prompt is passed via `--agent orchestrator`, which **replaces** Claude's default coding-assistant system prompt entirely — not appended to it.

### 3. The message queue (how your messages reach it, surviving restarts)

Every message you send goes through a **durable queue** in the database (`orchestrator_send_queue` table) before it ever touches the live process. This means your messages survive server restarts and are never silently dropped.

Life of a single message:

| Stage | What it means |
|---|---|
| `queued_busy` / `queued_spawning` / `queued_backlog` | Message accepted, orchestrator not ready to receive yet |
| `delivering` | Being sent to the process |
| `delivered_to_pty` | Sent successfully; waiting for confirmation |
| `observed_in_jsonl` | Claude's transcript confirms it was received — done |
| `failed` | Send failed; queue advances to the next message |
| `cancelled` | Abandoned (e.g. session ended) |

A per-session guard ensures only one message is in-flight at a time — they always arrive in order. (`orchestrator-send-queue-delivery.ts:73`, `orchestrator-send-queue.ts:83`)

**Confirmation:** the queue watches Claude's transcript file for your message's text to appear. When it does, the row advances to `observed_in_jsonl` and the next message drains. (See scar tissue below for the echo-timeout self-heal.)

### 4. Health and status tracking

The server continuously tracks how the orchestrator is doing, with two layers:

**Health** — what state is the process in right now? Seven states:

| Health state | Plain English |
|---|---|
| `not_spawned` | Never started for this session |
| `spawning` | Starting up |
| `ready` | Alive and waiting for your next message |
| `busy` | Processing (thinking or working) |
| `exited` | The process ended |
| `respawning` | Crashed and being restarted |
| `failed_resume` | Resume failed — conversation may need to restart |
| `provider_missing` | Transcript file missing on disk |

**Wait point** — what is the UI waiting for before it can accept your next message? (`orchestrator-runtime-health.ts:66`) The composer placeholder text in the UI is driven by this.

This health data is **in-memory only** (`orchestrator-runtime-snapshot.ts`). It's rebuilt from events as the process runs. It's not in the database — if the server restarts, health starts from scratch and fills in as the process comes back up.

### 5. The UI pieces

**Before chat starts** — `OrchestratorLauncher.tsx` shows a list of past sessions and the "Start Chat" button. Nothing launches until you click; this prevents a cascade of spawn attempts when the app opens.

**During chat** — `Orchestrator.tsx` is the live chat view. It reads health + wait point + queue depth to decide how to render the composer:
- `live` — send immediately
- `queueing` — process is busy; your message will queue
- `reconnecting` — process temporarily unreachable
- `inaccessible` — something is wrong; messages blocked

The full status of the conversation (health, session info, queue items) is broadcast to the UI over WebSocket as a `runtime-state` envelope whenever anything changes.

---

## How it connects

- **Depends on:** `InteractiveSession` (the wrapper that owns the `claude.exe` process) · `preparePodSpawn` (turns the pod into the files Claude needs at launch) · `orchestrator_sessions` + `orchestrator_send_queue` DB repos · `OrchestratorRuntimeSnapshots` in-memory tracker.
- **Used by:** `ProjectRuntime` (owns the session) · `ProjectRegistry` (one runtime per active project) · HTTP/WS route handlers · the two UI components above.
- **Events / contracts crossing the boundary:** `runtime-state` WS envelope (`PublicRuntimeSnapshot`) · `send-queue-snapshot` WS envelope · agent inbox results (worker completions arrive as queue turns delivered into the PTY).

---

## Target shape (per north star + Foundation Decisions)

Per `unified-process-supervision-2026-06-02.md §3–4` and **migration Step 4**:

- **Engine absorbs ownership.** `ProjectRuntime` (the Brain) stops owning the `claude.exe`. The Engine becomes the sole owner of every Claude process. The orchestrator becomes a session on the Engine with a policy of `{persistent, interactive, fire-and-watch}`.
- **One primitive.** `AgentRunState` gains policy flags. `InteractiveSession` / `InteractiveSessionState` merge into the unified primitive and are deleted. (Consolidation ledger: `MERGE→AgentRun`.)
- **One ready detector.** The `terminalBufferLooksReady` banner regex inside `PtySession` dies when `PtySession` is retired (Step 5). `ReadyGate` is the single keeper.
- **One transcript reader.** `jsonl-tailer.ts` + `agent-run-jsonl-tailer.ts` remain; the orchestrator-specific JSONL path inside `InteractiveSession` merges into the same stack.
- **Send queue stays.** The durable queue pattern is correct and survives the migration. The Engine drains it.
- **Step 3 is a required prereq** before Step 4: the Brain must be able to re-discover the Engine's endpoint after a respawn, or an Engine restart would silently sever the orchestrator from its tool servers.
- **`ProjectRuntime` shed.** After Step 5 (modals also migrated), `ProjectRuntime` is no longer an owner of any `claude.exe`. Its remaining jobs (worktrees, work-item service, workflow firing) survive or consolidate separately.

☠ **`loadDevChannels` is sentenced.** The `loadDevChannels: true` flag passed at spawn (`project-runtime.ts:531`) and the `--dangerously-load-development-channels` auto-confirm mechanism are removed by FD-3. No migration path; they are deleted.

---

## Known issues / scar tissue

- **Send-on-ready race.** `InteractiveSession.state: 'ready'` fires when Claude's welcome banner renders (under 1 second). The MCP tool servers that the orchestrator depends on take 1–3 seconds longer to register. A message delivered at banner-ready arrives before tools exist — turn 1 sees only built-ins. Fix today: `requireMcpHandshake: true` on fresh spawns gates delivery until after the handshake fires. Resume skips this gate (`requireMcpHandshake: !session.resume` at `project-runtime.ts:531`) — accepted as-is (tools are bound by turn 2). See memory: `[PtySession 'ready' is banner-only, not MCP-ready]`.

- **Resume quiet-window.** `claude.exe --resume` only reliably accepts input after its output has been quiet for ≥ 1500 ms after the banner. PC sends on `state: 'ready'`, which is too early. Isolated in `labs/agent-resume-repro`. The real fix is the ready-ping protocol (Section 24, locked decision) — not a timing workaround. See memory: `[--resume needs a quiet window]`.

- **Ready-ping (Section 24) — locked direction, not yet built.** The orchestrator deposits a prompt into the queue; the agent's first tool call returns the queued prompt as a positive receipt — no banner-timing guesswork. What tool the orchestrator calls and whether a new MCP tool is needed are the remaining open questions. See memory: `[Agent ready-ping direction]`.

- **Echo-timeout causes text diverge in the send queue.** When PTY's echo-timeout fires (body glues onto the next send without `\r`), Claude's transcript text diverges from the stored row text. The exact-match confirmation misses — but the FIFO fallback in `markNextDeliveredOrchestratorSendObservedInJsonl` (`orchestrator-send-queue.ts:262`) self-heals by advancing the oldest `delivered_to_pty` row. (Previously this caused a permanent wedge — the fallback was added to fix it.)

- **Four state machines, two ready detectors.** Today the orchestrator owns its own `InteractiveSession` lifecycle separately from `AgentRunState`. This is the structural root of the dual-path problem the consolidation targets.

- **Packaged-host respawn gap.** In the packaged Electron app, if the agent host process dies, the server does NOT respawn it — the orchestrator's MCP tools go dark until the user restarts the app. The Supervisor (Step 7) fixes this. See ledger §Phase-0 row 4.

- ☠ **`ChannelServer` per-project stdio children — SENTENCED (FD-3, locked 2026-06-03).** The orchestrator still runs a per-project channel child today (`index.ts:~321`), but **no piece of it survives the rebuild** — not the child, not the `--dangerously-load-development-channels` flag and auto-confirm, not the channel pushes. The only way to notify the orchestrator going forward: mailbox → injected PTY turn, clearly labeled as a system message and tagged so the chat UI can filter it. (Supersedes the ledger VERIFY row, §Spawning row 7.)

---

## Decisions & open questions

**For Emerson (product calls):**

1. **What does "Start Chat" feel like at the start of a project?** Today the launcher lists past sessions; should a brand-new project skip the launcher and open straight into chat?
2. **If an agent run fails mid-workflow while the orchestrator is busy, does it interrupt?** The failure goes into the orchestrator's inbox today; the UX of that interruption isn't designed.

**Technical:**

- **Ready-ping protocol (Section 24):** Direction locked — "orchestrator deposits prompt; agent's first tool call returns it." What MCP tool does this use? New tool on `pc-rig`, or an existing one?
- ~~ChannelServer children after Step 4?~~ **Resolved by FD-3 (2026-06-03):** removed entirely; mailbox-injected turn is the only notification path.
- **Send queue ownership under Step 4:** The drain runs today in Brain-side route handlers. After the Engine absorbs the session, does the drain move to the Engine, or does the Brain stay as a "depositor" with the Engine as the drainer?
- **`OrchestratorRuntimeSnapshots` in-memory registry:** Lost on Brain restart. Under the target, the Engine is the authoritative reporter; this layer may become redundant. Confirm before building it deeper.
- **Policy flag validation:** The north star requires the `{persistent, interactive, fire-and-watch}` policy model to be validated on the orchestrator before `InteractiveSession` is deleted. What test harness demonstrates correct behavior under restart and resume?
