# Orchestrator

> **Role:** Brain (today) → Engine (target)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `apps/server/src/services/project-runtime.ts`,
> `apps/server/src/services/orchestrator-pod-content.ts`,
> `apps/server/src/services/orchestrator-pod-seed.ts`,
> `apps/server/src/services/orchestrator-runtime-health.ts`,
> `apps/server/src/services/orchestrator-runtime-snapshot.ts`,
> `apps/server/src/services/orchestrator-send-queue-delivery.ts`,
> `packages/db/src/repos/orchestrator-sessions.ts`,
> `packages/db/src/repos/orchestrator-send-queue.ts`,
> `packages/domain/src/orchestrator.ts`,
> `apps/web/src/components/Orchestrator.tsx`,
> `apps/web/src/components/OrchestratorLauncher.tsx`

## What it is (plain English)

The Orchestrator is the persistent, conversational Claude process that the user talks to directly. It is the user's single point of contact for the whole app — it holds the chat, translates intent into action (creating work items, dispatching agents, running workflows), and surfaces results back to the user. It runs as a long-lived `claude.exe` process that is spawned on first chat open and resumed on subsequent opens, carrying the conversation forward across restarts.

## What it's supposed to do (intent)

One job: be the PM for the project. Hold the conversation, dispatch worker agents for substantive work, answer questions about project state, and route inbox messages (agent completions, paused approvals, workflow events) to the user. It is the only Claude process that talks directly to the human; everything else is a worker the orchestrator hires.

## How it works today (as-built)

### Pod / prompt

- On server boot, `seedOrchestratorPodIfMissing()` (`orchestrator-pod-seed.ts:38`) inserts a global `agents` row keyed `name='orchestrator', scope='global', origin='stock'` from `ORCHESTRATOR_POD_CONTENT` (`orchestrator-pod-content.ts:287`).
- The seed is idempotent: no-op if the row exists and matches; auto-reseeds changed fields only if the user has never edited the row; skips + warns if user-edited.
- The prompt (`ORCHESTRATOR_PROMPT`, `orchestrator-pod-content.ts:61`) is passed via `--agent orchestrator`, which REPLACES CC's default coding-assistant system prompt entirely. It contains: dispatching rules, available-agents roster (rendered at spawn via `{{AVAILABLE_AGENTS}}`), inbox protocol, `pc://` entity-linking rules, tool reference, and style rules.
- Tool allowlist is an explicit curated subset — local file/shell ops (`Read/Glob/Grep/Edit/Write/Bash`) plus a specific list of `mcp__pc-rig__pc_*` coordination tools. Worker-only, authoring, and pod-management tools are deliberately absent. (`orchestrator-pod-content.ts:315–353`)
- Model is `opus`; `maxTurns` is null (long-running by design).

### Spawn flow (owned by `ProjectRuntime`)

`ProjectRuntime` (`project-runtime.ts:103`) holds the orchestrator as `private pty: InteractiveSession | null`.

1. The UI opens a WebSocket for a project → server calls `runtime.ensureActiveSession()` to create or retrieve the durable `orchestrator_sessions` DB row (`project-runtime.ts:624`). This step does NOT spawn `claude.exe`.
2. On first user message (or explicit Start Chat), `ensurePty()` is called (`project-runtime.ts:449`).
3. `resolveSessionForSpawn()` (`project-runtime.ts:1074`) checks the active `orchestrator_sessions` row:
   - If a row exists with a `providerSessionId` AND the corresponding JSONL file exists on disk → spawn with `--resume <uuid>` (continue the conversation).
   - If the JSONL is missing (phantom or first-ever spawn) → spawn with `--session-id <uuid>` (mint at the stored UUID).
   - If no row at all → `ensureActiveSession()` mints one first.
4. `preparePodSpawn()` materialises the pod: writes a session-local plugin dir (the prompt), `mcp.json`, settings files, hook scripts. The orchestrator's working directory is the project's folder path. (`project-runtime.ts:472`)
5. An `InteractiveSession` is constructed and `.start()`ed with:
   - `mode: 'resume' | 'fresh'`, `requireReadySignal: true`, `requireMcpHandshake: !session.resume`, `loadDevChannels: true`, `maxSpawnAttempts: 2`, `retryBackoffMs: 1500`.
   - `remoteControl: false` — writes go directly through the PTY.
   - Deterministic `jsonlPath` derived from the provider session UUID, avoiding directory-scan bleed-through. (`project-runtime.ts:455–462`)
6. On pod edit, `restartIfOrchestratorPod('orchestrator')` kills the `claude.exe` child (but preserves the DB row + JSONL); the next send triggers a `--resume` respawn. (`project-runtime.ts:726`)

### Send-queue (how messages reach the orchestrator)

All user messages go through a DB-backed FIFO queue (`orchestrator_send_queue` table). The lifecycle of one message:

1. Server enqueues the message row with a status of `queued_busy`, `queued_spawning`, or `queued_backlog` depending on PTY state. (`orchestrator-send-queue.ts:83`)
2. `deliverNextQueuedPrompt()` (`orchestrator-send-queue-delivery.ts:73`) runs when the PTY is `ready`. It checks a per-session in-flight guard (`sendQueueDeliveryInFlight`) so at most one delivery runs at a time.
3. The deliver loop (`deliverNextQueuedPromptOnce`, line 92) calls `live.send(text)`. On `'ok'` → marks row `delivered_to_pty` and returns, waiting for JSONL correlation. On failure → marks `failed` and continues to the next queued row (prevents one bad message from wedging the queue).
4. JSONL correlation: when the orchestrator's JSONL tailer sees a `jsonl-user` event with matching text, `maybeAdvanceSendQueueConfirmation()` (`orchestrator-send-queue-delivery.ts:148`) advances the row to `observed_in_jsonl` and triggers the next drain. Fallback: if text diverges (echo-timeout), the oldest `delivered_to_pty` row is advanced — a self-healing FIFO tiebreaker. (`orchestrator-send-queue.ts:262–308`)
5. Status lifecycle: `queued_*` → `delivering` → `delivered_to_pty` → `observed_in_jsonl` (terminal-success) or `failed` or `cancelled`.

### Runtime health and snapshot

`OrchestratorRuntimeSnapshots` (`orchestrator-runtime-snapshot.ts:101`) is an in-memory per-project registry that tracks activity timestamps, JSONL timestamps, exit codes, and failure reasons. It is NOT a DB table — it is lost on restart and rebuilt from PTY events.

`deriveRuntimeHealth()` (`orchestrator-runtime-health.ts:44`) maps `PtyLifecycleState` → `RuntimeHealth` (`not_spawned | spawning | ready | busy | exited | respawning | failed_resume | provider_missing`).

`deriveRuntimeWaitPoint()` (`orchestrator-runtime-health.ts:66`) maps health + queue depth + JSONL existence → `RuntimeWaitPoint` (`session | queue | spawn | jsonl | provider_resume | ready_state | none`). The UI uses `waitPoint` to decide whether a new message should be sent live or queued, and to set the composer placeholder.

`OrchestratorRuntimeSnapshots.payload()` (`orchestrator-runtime-snapshot.ts:148`) assembles the full `PublicRuntimeSnapshot` from: the active DB session row, in-memory lifecycle state, PTY state from `InteractiveSession`, file-system checks on the JSONL, and the send-queue snapshot.

### DB state

- `orchestrator_sessions` table: one `active` row per project (enforced by `orch_sessions_active_per_project_idx`). Tracks `providerSessionId` (the CC session UUID), `jsonlPath`, `jsonlLineCursor` (persisted debounced), status (`active/ended`), and end reason. (`packages/db/src/repos/orchestrator-sessions.ts`)
- `orchestrator_send_queue` table: durable FIFO. Survives restarts; rows are never deleted during a session (visible statuses include `failed` for the UI). (`packages/db/src/repos/orchestrator-send-queue.ts`)
- `OrchestratorSession` domain type: `packages/domain/src/orchestrator.ts`.

### UI

- `OrchestratorLauncher.tsx`: shown when no session is active. Lists past sessions from `runtimeApi.listSessions(projectId)`. "Start Chat" calls `onStartChat`; past-session rows call `onResumeSession`. Nothing spawns until one of these is clicked — prevents N spawn storms on boot.
- `Orchestrator.tsx`: the live chat view. Owns composer availability logic (`composerAvailabilityFor`) that reads `health`, `waitPoint`, and `queueDepth` to set mode (`live | queueing | reconnecting | inaccessible`) and composer placeholder. Wraps `ChatSurface` for the actual message rendering. Talks to the server via WebSocket.

## Integrations (how it connects)

- **Depends on:**
  - `InteractiveSession` (`@pc/runtime`) — the PTY wrapper that owns the `claude.exe` child process, ready detection, and JSONL tailer.
  - `PodSpawnPrep` / `preparePodSpawn` — materialises the pod row into session-local runtime files.
  - `orchestrator_sessions` / `orchestrator_send_queue` DB repos.
  - `OrchestratorRuntimeSnapshots` — in-memory lifecycle tracker fed by `InteractiveSession` events.
  - `seedOrchestratorPodIfMissing` — boot-time seed (called from `apps/server/src/index.ts`).
- **Used by:**
  - `ProjectRuntime` owns and manages the `InteractiveSession`.
  - `ProjectRegistry` holds one `ProjectRuntime` per active project.
  - HTTP/WS routes in `apps/server/src/index.ts` call `runtime.ensurePty()`, `runtime.ptySession()`, `runtime.ensureActiveSession()`, `deliverNextQueuedPrompt()`, `maybeAdvanceSendQueueConfirmation()`.
  - `Orchestrator.tsx` + `OrchestratorLauncher.tsx` consume `runtimeApi` (HTTP) + WebSocket events.
- **Contracts / events crossed:**
  - `runtime-state` WS envelope: `PublicRuntimeSnapshot` broadcast on every health change.
  - `send-queue-snapshot` WS envelope: `{type, sessionId, items[]}` broadcast after every queue transition.
  - `orchestrator_sessions` and `orchestrator_send_queue` DB tables.
  - Agent inbox: results from dispatched agents arrive as `jsonl-user` turns delivered into the PTY via the send queue.

## Target shape (per north star)

Per `unified-process-supervision-2026-06-02.md §3–4` and migration step 4:

- **Engine absorbs ownership.** Brain (`ProjectRuntime`) stops owning the `InteractiveSession`; the Engine becomes the sole owner of every `claude.exe`. The orchestrator becomes a session on the Engine with policy `{persistent, interactive, fire-and-watch}`.
- **One primitive.** `AgentRunState` gains policy flags; `InteractiveSession` / `InteractiveSessionState` merge into the unified primitive and are deleted. (Ledger §Lifecycle, `MERGE→AgentRun` verdict.)
- **One ready detector.** `terminalBufferLooksReady` banner regex inside `PtySession` dies when `PtySession` is retired (Step 5). `ReadyGate` is the one keeper.
- **One transcript reader.** `jsonl-tailer.ts` (base layer) + `agent-run-jsonl-tailer.ts` (agent-run layer) remain. The orchestrator-specific JSONL-tailer path inside `InteractiveSession` merges into the same stack.
- **Step 3 is a required prereq.** The Brain must re-discover the Engine's endpoint after a respawn before Step 4 can land safely — an Engine respawn would silently sever the orchestrator if the Brain cached the boot endpoint.
- **Send queue stays.** The durable `orchestrator_send_queue` pattern is correct; it survives under the new ownership. The Engine drains it.
- **`ProjectRuntime` shed.** After Step 5 (modals also migrated), `ProjectRuntime` is no longer an owner of any `claude.exe`. Its remaining jobs (worktrees, work-item service, workflow firing) can survive or consolidate separately.

## Known issues / scar tissue

- **Send-on-ready race.** `InteractiveSession.state: 'ready'` fires when CC's welcome banner renders (< 1 s). MCP children take 1–3 s longer. A message delivered at banner-ready arrives before MCP tools are registered — turn 1 sees only built-in tools. Fix: `requireMcpHandshake: true` on fresh spawns gates delivery until after the MCP handshake fires; resume skips this (`requireMcpHandshake: !session.resume` at `project-runtime.ts:531`). The gap for resume is accepted as-is (MCP bound by turn 2). See memory: `[PtySession 'ready' is banner-only, not MCP-ready]`.
- **Resume quiet-window.** `claude.exe --resume` accepts PTY input fine only after stdout has been quiet ≥ 1500 ms post-banner. PC sends on `state: 'ready'`, which is too early on resume. Isolated in `labs/agent-resume-repro`. The real fix is the ready-ping protocol (Section 24, locked decision), not a quiet-window workaround. See memory: `[--resume needs a quiet window]`.
- **Ready-ping direction (Section 24).** Decided: orchestrator deposits a prompt → agent's first tool call returns the queued prompt as a positive receipt, not a banner-timing guess. Not yet built. See memory: `[Agent ready-ping direction]`.
- **`InteractiveSession` is a separate state machine from `AgentRunState`.** Today there are 4 lifecycle state machines and 2 ready-detectors in the app. The orchestrator owns one of each independently. This is the structural root of the dual-path problem the consolidation targets.
- **Packaged-host respawn gap.** In the packaged Electron build, if the agent host process dies, the Brain (API) does NOT respawn it — this leaves the orchestrator's MCP tools inaccessible until the user restarts the app. The Supervisor (Step 7) fixes this. See ledger §Phase-0 row 4.
- **`ChannelServer` per-project stdio children.** The orchestrator uses a per-project channel server child (`index.ts:~321`) as its MCP bridge. After Step 4 moves orchestrator ownership to the Engine, it is unclear whether these children need to follow or if the Engine's existing host connection handles the same role. Marked VERIFY in the ledger. (`consolidation-ledger-2026-06-02.md §Spawning row 7`)
- **Echo-timeout causes text-diverge in send queue.** When PTY's echo-timeout fires (body glues onto the next send without `\r`), CC's JSONL `text` diverges from the stored row text. The primary exact-match misses, but the FIFO oldest-delivered fallback in `markNextDeliveredOrchestratorSendObservedInJsonl` (`orchestrator-send-queue.ts:262`) self-heals. Comment documents the prior permanent-wedge bug.

## Open questions

- **Ready-ping protocol (Section 24):** The locked direction is "orchestrator deposits prompt → agent's first tool call returns it." Implementation not yet built. What tool does the orchestrator call? Does it require a new MCP tool on the pc-rig server?
- **ChannelServer children after Step 4:** Once the Engine owns the orchestrator session, do the per-project `ChannelServer` stdio children follow to the Engine process, or does the Brain keep routing them? (Ledger VERIFY row.)
- **Policy flag validation:** The north star says validate the `{persistent, interactive, fire-and-watch}` policy model on the orchestrator before deleting `InteractiveSession`. What test harness demonstrates the policy holds correctly under restart + resume?
- **Send queue ownership under Step 4:** The `orchestrator_send_queue` drain runs today in Brain-side route handlers. After the Engine absorbs the session, does the drain move to the Engine or does it stay in the Brain as a "depositor" pattern with the Engine as the drainer?
- **`OrchestratorRuntimeSnapshots` in-memory registry:** Lost on Brain restart. Under the target, the Engine is the authoritative reporter; this in-memory layer may become redundant. Confirm before building it deeper.
