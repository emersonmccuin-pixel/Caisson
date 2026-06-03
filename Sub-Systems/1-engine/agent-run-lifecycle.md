# Agent Run Lifecycle & Reconciler

> **Role:** Engine · Brain (cross-cutting today; target = Engine owns processes, Brain owns reconciler)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `packages/runtime/src/agent-run.ts`,
> `packages/runtime/src/agent-run-registry.ts`,
> `apps/server/src/services/agent-run-factory.ts`,
> `apps/server/src/services/agent-active-runs.ts`,
> `apps/server/src/services/agent-run-terminal-effects.ts`,
> `apps/server/src/services/agent-host-reattach.ts`,
> `apps/server/src/services/agent-run-boot-reconcile.ts`,
> `apps/server/src/services/agent-run-server-boot.ts`,
> `apps/server/src/services/agent-run-liveness-sweep.ts`,
> `apps/server/src/services/agent-run-idle.ts`,
> `apps/server/src/services/agent-run-settle.ts`,
> `apps/server/src/services/agent-run-stall-warn.ts`,
> `apps/server/src/services/agent-run-control.ts`,
> `apps/server/src/services/agent-run-writer.ts`,
> `apps/server/src/services/host-connection.ts`,
> `apps/server/src/services/agent-host-client.ts`,
> `apps/server/src/services/agent-host-reattach.ts`,
> `apps/server/src/services/process-control.ts`

---

## What it is (plain English)

Every time the orchestrator dispatches an agent worker, a **run** is created: a DB row, an in-memory wrapper, and (eventually) a live `claude.exe` process on the agent host. This subsystem tracks that run from the moment it enters a queue to the moment it is finalized as completed, failed, or cancelled. It also contains all the code that answers "is this run still alive, and is it done?" — which today is answered by several independent mechanisms rather than one.

---

## What it's supposed to do (intent)

Own the full lifecycle of one dispatched agent worker: create it, admit it through a concurrency cap, spawn the process, keep an eye on it, finalize it when it ends (by success, timeout, crash, or cancel), and wake any caller waiting on its result. Exactly one answer to "alive/done?" at any moment.

---

## How it works today (as-built)

### State machine

`AgentRun` (`packages/runtime/src/agent-run.ts`) is the in-process lifecycle wrapper. States: `queued → spawning → running ⇌ paused → completed | failed | cancelled`. Transitions are enforced internally; `toTerminal()` is the single internal terminal path (line 572), idempotent via `isTerminal()` guard.

### Concurrency cap

`AgentRunRegistry` (`packages/runtime/src/agent-run-registry.ts`) holds a process-wide FIFO cap (default 5). `admit()` hands out a ticket; `reattach()` bypasses the queue for runs already live on the host after a server restart. Ticket is released on terminal, freeing a slot for the next queued run.

### Dispatch (creation)

`dispatchFreshAgent` / `dispatchContinueAgent` (`apps/server/src/services/agent-run-factory.ts:273,505`) are the two entry doors. Both:
1. Validate the pod and work item.
2. Insert an `agent_runs` DB row with `status: 'queued'`.
3. Create a `done` promise and register a **run-keyed settlement waiter** on `ActiveRunRegistry` *before* calling `start()` — line 465: `activeReg.onSettled(agentRunId, ...)`.
4. Call `startDispatchedRun`, which branches:
   - **Host-backed** (`deps.hostClient` present): sends a `start-run` / `resume-run` command to the out-of-process host via `HostConnection`. Does **not** attach a per-run `hostClient.onEvent` listener — that was the rival in the double-subscribe race (comment at factory.ts:739).
   - **In-process** (no host client, dead in production per V2): constructs an `AgentRun` directly via `constructAndStart`.
5. Return `{ ok, done }` to the caller. The workflow engine awaits `done`; the orchestrator ignores it.

### In-process run (the production path today)

`constructAndStart` builds `AgentRun` with `LowLevelSpawn` as the underlying PTY wrapper. The run's async lifecycle (`runLifecycle` → `runSpawnPhase`) drives: queue wait → spawning → `awaitReady()` → `running` → event-driven via JSONL and spawn-exit callbacks. Per-run timers enforce timeouts: `spawnStuck` (2 min), `idle` (5 min default, resettable per JSONL event), `wallClock` (2 h), `firstTurn` (90 s on resume), `cancelGrace` (5 s). All fire through the same `toTerminal()` path with a typed `AgentRunFailureCause`.

### The done-signal (the one correct path)

`AgentRun.complete()` (agent-run.ts:308) is called only from `pc_submit_deliverable` receipt. Turn-end in JSONL is **not** a completion signal (agent-run.ts:545–553). A run that exits without delivering is caught by the idle timer or `onSpawnExit` and lands as `failed / no-deliverable` via `gateTerminalForDeliverable` (agent-run-settle.ts:43).

### Terminal authority (one path, post-Step-1)

`applyAgentRunTerminalEffects` (`apps/server/src/services/agent-run-terminal-effects.ts:103`) is the **one terminal authority**: all paths that decide a run is finished call it. It:
1. Reads the DB row; if already terminal, fires the run-keyed waiter from the durable row (idempotent — line 115) and returns without re-applying effects.
2. Runs `gateTerminalForDeliverable` to downgrade a fake `completed` to `failed/no-deliverable`.
3. Commits the terminal row via `commitAgentRunTerminal` (gateway + `live_outbox` in one transaction).
4. Unregisters the run from `ActiveRunRegistry`.
5. Captures the deliverable on the contract (`captureDeliverable`).
6. In `finishTerminalEffects` (async tail): runs verification, then calls `activeRunRegistry.settle(runId, ...)` (line 386) to resolve the `done` promise, then emits the orchestrator envelope to the mailbox.

`applyHostTerminalSnapshot` (`agent-host-reattach.ts:414`) is the wrapper for host-reported terminal snapshots. After Step-1 fix: it no longer short-circuits on already-terminal rows — it always falls through to `applyAgentRunTerminalEffects`, which handles the idempotent case and still fires the waiter (agent-host-reattach.ts:424–426 comment).

### The six mechanisms answering "alive/done?" (the racing set)

Today, "is it still alive / done?" is answered by all of the following, which can fire in any order:

1. **Per-run `AgentRun` timers** — `idle`, `wallClock`, `spawnStuck`, `firstTurn` in `agent-run.ts`. Local to the in-process run wrapper; call `toTerminal()` directly. These are legitimate — they're the typed-failure backstops, not sweeps. They survive in the target.

2. **Spawn exit handler** — `onSpawnExit` (agent-run.ts:555): process exit → `toTerminal('failed', 'unexpected-exit')` unless terminal/cancelling/paused.

3. **In-process liveness sweep** — `sweepAgentRunLiveness` (`agent-run-liveness-sweep.ts:65`). Runs on an interval in non-host mode. Reads all non-terminal DB rows, checks pid liveness and JSONL mtime. Finalizes via `applyAgentRunTerminalEffects`. Merging into the one reconciler is Step-2 work.

4. **Stall-warn sweep** — `sweepStallWarn` (`agent-run-stall-warn.ts:55`). Non-terminal signal; emits a `stalled` badge past the warn threshold (default 3 min). Never kills. Mode-agnostic. Feeds the UI, not finalization.

5. **Boot reconcile** — `reconcileAgentRunsOnBoot` (`agent-run-boot-reconcile.ts:67`). On server start, sweeps non-terminal DB rows against the host's live snapshot (host mode) or bulk-fails all of them (legacy mode). Runs once. Merging into the one loop is Step-2 work.

6. **Continuous host-reconcile sweep** — `reconcileAgentRunsAgainstHost` (`agent-host-reattach.ts:217`). Post-boot interval sweep: re-derives every non-terminal DB row from the host's `list-runs`. Applies terminal effects when the host reports a run terminal or absent (`host-lost` after N consecutive missing ticks, T1.4). Also triggers the S3 envelope-replay safety net.

7. **Persistent host-event listener** — wired in `reattachAgentRunsOnBoot` (agent-host-reattach.ts:165): `hostClient.onEvent(applyAgentHostEvent)`. This is the live-stream path: `run-terminal` events call `applyHostTerminalSnapshot` → `applyAgentRunTerminalEffects`. This is the one persistent listener (not per-run); it routes through the one terminal authority. The **per-run** factory `onEvent` listener that used to race against it was deleted in commit `40c2a91f`.

Mechanisms 1, 2, 5, 6, 7 all call through `applyAgentRunTerminalEffects` (the one authority). The idempotent guard at the top of that function means whichever fires first wins; the rest are no-ops but still settle the waiter. This is the Step-1 fix — the race no longer produces two different outcomes; it produces one outcome and one or more no-ops.

### The run-keyed settlement waiter

`ActiveRunRegistry.onSettled` / `settle` (`agent-active-runs.ts:305,312`) implement the single wake-up. The waiter is registered before `start()`; it fires at most once per run id (the second `settle` call for the same id finds no waiter and no-ops). This replaces the old per-call `onSettled` callback and the `resolveDone` race.

### State live-relay

All state transitions go through `announceAgentRunChange` (`agent-run-writer.ts:46`) → `AgentRunMutationGateway` → writes a `live_outbox` row in-transaction → the live-relay drains it to subscribers. No hand-broadcast for run-changed events (removed in Slice 015b).

### Host connection

`HostConnection` (`host-connection.ts`) wraps `HttpAgentHostClient` behind a single long-lived conduit that re-discovers the host from the lock file on reconnect. `listRuns()` returns the last cached snapshot; `refreshRuns()` pulls fresh. The heartbeat publishes `HostHealth` for the UI pill.

### Boot sequence

`reattachAgentRunsDuringServerBoot` (`agent-run-server-boot.ts:35`) is the boot entry point. If a host client resolves: calls `reattachAgentRunsOnBoot` (reconcile + register live handles + wire the persistent event listener). Otherwise: legacy reconcile (bulk-fail all non-terminal rows).

---

## Integrations (how it connects)

- **Depends on:**
  - `@pc/runtime`: `AgentRun`, `AgentRunRegistry`, `LowLevelSpawn`, `ReadyGate`, `AgentRunJsonlTailer`, `jsonlPathFor` — the spawning and tailer primitives.
  - `@pc/db`: `agent_runs` table reads/writes, `live_outbox`, `agent_contracts`, `pending_asks`.
  - `@pc/app-services`: `ContractService`, `AgentRunMutationGateway`.
  - `agent-host-client.ts` / `host-connection.ts`: the out-of-process host wire.
  - `process-control.ts`: `isProcessAlive`, `killProcessTree` — OS-level pid operations.
  - `pod-spawn.ts`: pod materialisation (renders `.md`, writes `mcp.json`).

- **Used by:**
  - HTTP routes: `/api/projects/:projectId/agents/:name/invoke` and `/agent-runs/:runId/continue` call `dispatchFreshAgent` / `dispatchContinueAgent`.
  - Workflow engine (`dag-run-service.ts`): awaits the `done` promise returned from dispatch.
  - MCP tools: `pc_submit_deliverable` calls `run.complete()` via `ActiveRunRegistry`; `pc_ask_user` calls `handle.markPaused()`; `pc_answer_pending_ask` calls `handle.resumeWithAnswer()`.
  - `agent-run-control.ts`: operator hard-kill / inspect.
  - `index.ts` (server boot): wires the boot reconcile + sets up the sweep intervals.

- **Contracts / events crossed:**
  - DB: `agent_runs` (source of truth for run status), `live_outbox` (live-relay truth), `agent_contracts` (deliverable home), `pending_asks`.
  - Wire: `AgentHostCommand` / `AgentHostCommandResponse` / `AgentHostEvent` — the host protocol.
  - Internal events: `AgentRun` emits `'terminal'`, `'state'`, `'jsonl-event'`, `'paused'` (EventEmitter).

---

## Target shape (per north star)

Per `unified-process-supervision-2026-06-02.md` §5–6 and the ledger:

- **ONE reconciler** (§5): A single Brain-owned loop replaces the three separate sweeps (boot reconcile, liveness sweep, host reconcile). Every non-terminal run state passes through it. It never acts when the Engine is unreachable. Boot is just "the loop on first tick."
- **ONE run-keyed waiter** (§6): `ActiveRunRegistry.settle` — already built and live. The `done` promise resolves because *the run finished*, not because a particular listener won. This is done (Step 1, commit `40c2a91f` + `0022872d`).
- **ONE terminal authority**: `applyAgentRunTerminalEffects` — already the single chokepoint. The per-run factory `onEvent` listener is gone. `applyHostTerminalSnapshot` routes through it without short-circuiting. Done.
- **Step 2 (next)**: Fold `reconcileAgentRunsOnBoot`, `sweepAgentRunLiveness`, and `reconcileAgentRunsAgainstHost` into one mode-agnostic loop with a HOLD-on-unreachable-engine guard (never finalize when the Engine didn't answer). Add the ONE-RECONCILER guard test (one `setInterval` owner).
- **Step 3**: Brain re-discovers the Engine endpoint after respawn (re-resolution, not a cached boot URL). Prerequisite for Steps 4–5.
- **Steps 4–5**: Move the orchestrator (`InteractiveSession`) and modals (`PtySession`) onto the Engine. Not yet started; requires Step 3.
- **Step 6**: With everything on the Engine, delete `PtySession`, `InteractiveSession`, banner-regex ready-detection, the dead `reattach` field + `reattachLifecycle()` method on `AgentRun` (confirmed dead — no caller sets `AgentRunInput.reattach`; `reattachAgentRunsOnBoot` is a different thing and stays).

Ledger verdict (§0, §4): Step 1 CLOSED in code; guard tests remain. Step 2 is the current open work.

---

## Known issues / scar tissue

### The stall bug (root cause — fixed in Step 1)

Original form: an agent run dispatched to the host would complete (the host submitted a deliverable) but the workflow `done` promise never resolved, so the card never moved. Root cause: two listeners both subscribed to the host's terminal event for the same run — the per-run factory `onEvent` listener AND the persistent boot `onEvent` listener. The per-run listener called `resolveDone` directly (a per-call callback, not keyed by run id). Whichever listener fired SECOND found the `resolveDone` already called and had no waiter to fire, so the settlement was silently dropped. The workflow step waited forever.

Fix (commit `40c2a91f`): deleted the per-run factory `onEvent` listener entirely (~108 lines). Settlement moved to `ActiveRunRegistry.settle(runId)` — a run-keyed, fire-exactly-once mechanism registered before `start()`. The persistent listener routes through `applyAgentRunTerminalEffects` → `settle`. Confirmed in factory.ts:739 comment: "This dispatch does NOT subscribe a per-run host-event listener."

Also fixed (commit `0022872d`): the `complete-run` host relay — host-backed agent completes on delivery.

### False "no output" at 300 s (idle timeout too short)

The in-process `AgentRun.idleMs` default is 300,000 ms (5 min) in `agent-run.ts:169`. A legitimate long-running agent (deep thinking, complex tool chain) hits this and is failed as `idle-timeout` with no real stall. The liveness sweep uses a longer default (10 min via `agent-run-idle.ts:23`). These two thresholds are independent and unsynchronised. Per-dispatch `idleMs` override is supported but not always set.

### Sweeps don't hold on unreachable engine

`reconcileAgentRunsAgainstHost` (agent-host-reattach.ts:217) uses a conservative gate: it only finalizes `host-lost` when `hostAuthoritativelyAbsent === true` (caller must assert the host was reachable AND returned an empty list). A `refreshRuns()` that *threw* must not pass the signal — the caller must omit it. This is correct but fragile: the discipline lives entirely in the caller (`index.ts`), not structurally in the loop. The Step-2 loop will bake this as a HOLD invariant.

### Boot reconcile and liveness sweep are mode-split

`reattachAgentRunsDuringServerBoot` branches on whether a host client exists (`agent-run-server-boot.ts:46`). Legacy mode bulk-fails all non-terminal rows (even paused ones with a valid open ask — the paused-run exception is present in the host path but not the legacy path). This is a correctness gap for in-process paused runs after a restart. The Step-2 one-loop merge will close it.

### In-process dispatch branch is dead in production but alive in tests

`startDispatchedRun` still has an `else` branch (`constructAndStart` for no-host-client). This is never reached in a real server (`hostClient` is always wired via `index.ts:279,304`) but IS reached by unit tests that construct a fake spawn. The branch should be deleted after moving those tests to a host-fake. Until then, both paths exist and must stay in sync (ledger V2, row: DELETE in-process branch).

### JSONL path divergence (historical root of the stall class)

If `jsonlPathFor` is called with different base paths on the server vs the host, the server-side tailer reads a file the agent never writes — producing no events — and the idle timer fires at 300 s as a false "no output." Fixed for host dispatches in factory.ts:855: the server computes the authoritative JSONL path and sends it to the host; the host must not recompute it. The comment: "The host must NOT recompute this from its own env, or the two can diverge."

### `reattach` field / `reattachLifecycle()` are dead

`AgentRunInput.reattach` and `AgentRun.reattachLifecycle()` (agent-run.ts:120, 499) have no callers in production. The confusion: `reattachAgentRunsOnBoot` (agent-host-reattach.ts) is a completely different thing (a module-level function) and is very much alive. The dead field/method will be deleted in the Step-6 pass. (Ledger §0: skeptic confirmed the distinction.)

---

## Open questions

- **Step-2 loop shape**: what is the correct tick interval and should the in-process path and host path share one interval or two? The shared `agent-run-idle.ts` thresholds suggest one, but the two sweep callers are currently at different cadences in `index.ts`.
- **Paused-run boot handling**: legacy-mode boot reconcile does not have the paused-run exception (host mode does). Before merging into one loop, decide: keep paused-with-open-ask runs across a server restart in all modes, or fail them and let the human re-answer?
- **Guard tests**: the ONE-TERMINAL-AUTHORITY and ONE-RECONCILER guard tests called for in ledger §3 are not yet written. They should gate the Step-2 PR.
- **Host re-resolution (Step 3)**: currently the server caches the boot-time host endpoint. An in-place `dev-supervisor` respawn on a new port silently severs the connection. `HostConnection` already re-reads the lock file on reconnect (host-connection.ts comment: "kills T1-A") — but this needs a test at the integration level before Steps 4–5 can safely proceed.
- **`constructAndStart` in-process branch**: when test coverage moves to a host-fake, delete this branch and add a compile-time guard that `startDispatchedRun` only has one path. Until then it is a silent second spawn door.
