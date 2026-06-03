# Agent Run Lifecycle & Reconciler

> **Role:** Engine · Brain (cross-cutting today; target = Engine owns processes, Brain owns reconciler)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `packages/runtime/src/agent-run.ts` · `agent-run-registry.ts`
> `apps/server/src/services/agent-run-factory.ts` · `agent-active-runs.ts` · `agent-run-terminal-effects.ts`
> `agent-host-reattach.ts` · `agent-run-boot-reconcile.ts` · `agent-run-server-boot.ts`
> `agent-run-liveness-sweep.ts` · `agent-run-idle.ts` · `agent-run-settle.ts`
> `agent-run-stall-warn.ts` · `agent-run-control.ts` · `agent-run-writer.ts`
> `host-connection.ts` · `agent-host-client.ts` · `process-control.ts`

---

## What it is (plain English)

Think of this subsystem as **air-traffic control for agent jobs.** When the orchestrator sends an agent to do a task, this machinery takes over: it gives the job a tracking number, queues it if the runway is busy, clears it for takeoff, watches the flight, and closes the record when it lands — whether cleanly (agent delivered its work), by timeout (nothing heard for too long), by crash (process exited unexpectedly), or by cancellation. It is also the system that answers, at any moment: "is that flight still in the air, and has it landed yet?"

Today the answer to "alive/done?" comes from **several independent checks** running in parallel, rather than one. That was the root of the stall bug. Step 1 fixed the race so they all write the same answer, even if multiple checks fire. Step 2 (remaining work) consolidates them into one loop.

---

## What it's supposed to do (intent)

Own the full life of one dispatched agent job: create it → queue it → spawn the process → watch it → finalize it when it ends → wake any caller that was waiting for the result. The single law: **exactly one correct answer to "alive/done?" at every moment.**

---

## The parts (every component, plain English)

### 1. The run object — the flight's tracking record

Every dispatched agent is represented as an **`AgentRun`** (`agent-run.ts`): a row in the database AND an in-memory wrapper while the server is running. Together they are the canonical record of the job.

The run moves through these states in order:

| State | Plain meaning |
|---|---|
| `queued` | Waiting for a concurrency slot to open up |
| `spawning` | Slot granted; process is starting |
| `running` | Process is live and doing work |
| `paused` | Waiting on a human to answer a question (`pc_ask_user`) |
| `completed` | Agent submitted its deliverable — clean landing |
| `failed` | Something went wrong (timeout, crash, no deliverable) |
| `cancelled` | Operator or system deliberately stopped it |

Transitions are enforced internally. `toTerminal()` is the single internal path to any of the three terminal states (line 572); `isTerminal()` blocks a second transition. A typed `AgentRunFailureCause` records *why* it failed (e.g. `idle-timeout`, `unexpected-exit`, `no-deliverable`).

### 2. The concurrency cap — the runway queue

`AgentRunRegistry` (`agent-run-registry.ts`) limits how many jobs run at the same time (default: 5, process-wide FIFO). When a new job arrives:

- If a slot is free: `admit()` grants a ticket and the job starts immediately.
- If all slots are busy: the job waits in line.
- On server restart, `reattach()` bypasses the queue for jobs already live on the agent host — they already have a slot; they don't need to re-queue.

When a job finishes (any terminal state), its ticket is released and the next queued job is admitted.

### 3. Dispatch — creating and launching a job

Two entry doors (`agent-run-factory.ts`):
- **`dispatchFreshAgent`** (line 273) — a brand new job for a pod + work item.
- **`dispatchContinueAgent`** (line 505) — resume a prior agent session.

Both doors do the same five things:
1. Validate the pod and work item.
2. Write an `agent_runs` DB row with `status: 'queued'`.
3. Register a **run-keyed settlement waiter** on `ActiveRunRegistry` *before* the job starts — so that when the job finishes, the waiter fires exactly once, no matter which check sees the finish first.
4. Hand the job to the **agent host** (the out-of-process process manager) via `HostConnection`. This is the only production path. (There is also a dead in-process branch used only by unit tests — see Known issues.)
5. Return `{ ok, done }` to the caller. The workflow engine `await`s `done`; the orchestrator ignores it.

> The dispatch does **NOT** attach a per-run event listener to the host — that was the rival that caused the stall race, and it was deleted. One persistent listener, wired at boot, handles all host events (see §7).

### 4. The done-signal — how a job says "I'm finished"

**The only correct "done" is a submitted deliverable.** The agent calls `pc_submit_deliverable` — "here is my finished work." That MCP tool call reaches `AgentRun.complete()` (agent-run.ts:308). Nothing else counts.

A turn ending in the JSONL transcript (the AI response stream) is **not** a completion signal (agent-run.ts:545–553). An agent that ends a turn without calling `pc_submit_deliverable` is still running — or it will eventually hit a timeout.

A run that exits without ever submitting is caught by the idle timer or spawn-exit handler and lands as `failed / no-deliverable` (`gateTerminalForDeliverable`, agent-run-settle.ts:43).

### 5. The one terminal authority — the single place "finished" is written

`applyAgentRunTerminalEffects` (`agent-run-terminal-effects.ts:103`) is **the one place in the codebase that officially closes a run.** Every mechanism that decides a run is done (timers, host events, sweeps — all of them) routes through here. The steps in order:

1. Check the DB row — if already terminal, fire the run-keyed waiter from the durable row and return. (Idempotent: the second caller is a no-op.) Line 115.
2. Run `gateTerminalForDeliverable` — downgrades a premature `completed` to `failed/no-deliverable` if the agent never actually submitted work.
3. Write the terminal row to the DB (and the live-event outbox, in one transaction).
4. Unregister from `ActiveRunRegistry` (releases the concurrency slot).
5. Capture the deliverable on the contract record.
6. In an async tail: run verification, then call `activeRunRegistry.settle(runId, ...)` (line 386) — this resolves the `done` promise for whoever is waiting. Then send the result envelope to the orchestrator's mailbox.

This is the **Step-1 fix**. Before Step 1, two competing listeners could race. Now: whichever fires first writes the terminal state; every later caller finds the row already terminal, skips re-applying effects, and still fires the waiter — which is idempotent (the second settle is a no-op).

### 6. The run-keyed settlement waiter — waking the caller

`ActiveRunRegistry.onSettled` / `settle` (`agent-active-runs.ts:305,312`) are the wake-up mechanism. The waiter is registered before `start()` (step 3 of dispatch). It fires at most once per run ID. This is what resolves the `done` promise the workflow engine is awaiting. The old per-call `onSettled` callback and the `resolveDone` race are gone.

### 7. Per-run timers — the timeouts that catch stuck jobs

Built into each `AgentRun`, these are the typed-failure backstops. They are not sweeps — they are guards on the run's own process:

| Timer | What triggers it | Default |
|---|---|---|
| `spawnStuck` | Process didn't finish starting | 2 min |
| `idle` | No JSONL output for this long | 5 min (resettable per event) |
| `wallClock` | Total run time | 2 h |
| `firstTurn` | No first turn on resume | 90 s |
| `cancelGrace` | Cancel requested; process hasn't exited | 5 s |

All fire through `toTerminal()` with their typed cause. These are correct and survive into the target architecture.

The **spawn-exit handler** (`onSpawnExit`, agent-run.ts:555) is the sibling to these timers: if the process exits without the run being terminal (and not cancelling/paused), it fires `toTerminal('failed', 'unexpected-exit')`.

### 8. Boot reconcile — what happens when the server restarts mid-run

When the server starts, `reattachAgentRunsDuringServerBoot` (`agent-run-server-boot.ts:35`) runs once and sweeps all non-terminal DB rows to decide their fate:

- **Host mode** (production): asks the agent host which runs are still live. Runs the host still has → re-attach them (bypass the queue). Runs the host reports as terminal → apply terminal effects. Runs missing from the host → mark `host-lost` after confirmation. Paused runs with an open question are left paused.
- **Legacy mode** (no host client — dead in production, still reached by some tests): bulk-fails ALL non-terminal rows, including paused ones. ⚠️ This is a correctness gap: paused runs with a valid open question shouldn't be failed. The Step-2 one-loop merge will close it.

### 9. Liveness sweep — the ongoing in-process watcher

`sweepAgentRunLiveness` (`agent-run-liveness-sweep.ts:65`) runs on an interval (non-host mode). It reads all non-terminal DB rows, checks whether the OS process is alive (pid check) and whether the JSONL file has recent activity (mtime). Finalizes dead runs via `applyAgentRunTerminalEffects`. Merging into the one loop is Step-2 work.

### 10. Host-reconcile sweep — the ongoing host-vs-DB checker

`reconcileAgentRunsAgainstHost` (`agent-host-reattach.ts:217`) runs on an interval post-boot (host mode). It asks the host for its current list of live runs and re-derives every non-terminal DB row from that snapshot:

- Host reports a run terminal → apply terminal effects.
- Host has never heard of a run (after N consecutive missing ticks) → `host-lost`.
- Run appeared on the host but not in DB → triggers an S3 envelope-replay safety net.

**The key discipline:** if `refreshRuns()` throws (the host was unreachable), the caller must NOT pass the `hostAuthoritativelyAbsent` signal. A failed host call must not trigger `host-lost` finalization — that would kill runs that are fine but temporarily invisible. Today this discipline lives entirely in the caller (`index.ts`), not structurally in the loop. Step 2 will bake it as a structural HOLD invariant.

### 11. Stall-warn sweep — the "something looks slow" badge

`sweepStallWarn` (`agent-run-stall-warn.ts:55`) runs independently and emits a `stalled` badge in the UI when a run passes the warn threshold (default 3 min) without completing. It **never kills** a run — it only feeds the UI. Mode-agnostic.

### 12. The persistent host event listener — live terminal signals

Wired at boot in `reattachAgentRunsOnBoot` (`agent-host-reattach.ts:165`): a single `hostClient.onEvent(applyAgentHostEvent)` listener handles all host events for all runs. When the host sends a `run-terminal` event, it reaches `applyHostTerminalSnapshot` → `applyAgentRunTerminalEffects` (the one authority). After the Step-1 fix, `applyHostTerminalSnapshot` no longer short-circuits on already-terminal rows — it always falls through to the authority, which handles the idempotent case and still fires the waiter. (`agent-host-reattach.ts:424–426` comment.)

### Where the mechanisms overlap (and why that's OK now)

Mechanisms 7 (timers), 8 (boot reconcile), 9 (liveness sweep), 10 (host-reconcile sweep), and 12 (persistent listener) can all independently decide a run is done. Before Step 1, this was a race that produced two different outcomes. Now: all of them route through `applyAgentRunTerminalEffects`, which is idempotent — the first one to fire wins; the rest are no-ops that still safely settle the waiter.

Step 2 removes mechanisms 8, 9, and 10 as separate processes and folds them into one loop with a structural HOLD guard.

### 13. State broadcasting — how the UI sees run changes

All state transitions go through `announceAgentRunChange` (`agent-run-writer.ts:46`) → `AgentRunMutationGateway` → writes a `live_outbox` row in the same transaction → the live-relay drains it to UI subscribers. Hand-broadcasting is gone (removed in Slice 015b).

### 14. Host connection — the wire to the agent process manager

`HostConnection` (`host-connection.ts`) wraps the HTTP client behind a single long-lived conduit that re-discovers the host from its lock file on reconnect. `listRuns()` returns the last cached snapshot; `refreshRuns()` pulls fresh. The heartbeat publishes `HostHealth` for the UI status pill.

---

## How it connects

- **Depends on:** `@pc/runtime` (the run object, registry, PTY spawning, JSONL tailer) · `@pc/db` (`agent_runs`, `live_outbox`, `agent_contracts`, `pending_asks`) · `@pc/app-services` (contract service, mutation gateway) · `host-connection.ts` / `agent-host-client.ts` (the host wire) · `process-control.ts` (OS-level pid / kill) · `pod-spawn.ts` (renders the agent's files before launch).
- **Used by:** HTTP routes (`/invoke`, `/continue`) · workflow engine (`dag-run-service.ts`, awaits `done`) · MCP tools (`pc_submit_deliverable` → `run.complete()`, `pc_ask_user` → `markPaused()`, `pc_answer_pending_ask` → `resumeWithAnswer()`) · `agent-run-control.ts` (operator kill/inspect) · `index.ts` (boot + sweep wiring).
- **Contracts / events crossed:** `agent_runs` (DB source of truth for status) · `live_outbox` (live-relay truth) · `agent_contracts` (deliverable home) · `pending_asks` (human-gate questions) · `AgentHostCommand / Response / Event` (host wire protocol) · `AgentRun` internal events: `'terminal'`, `'state'`, `'jsonl-event'`, `'paused'`.

---

## Target shape (per north star + Foundation Decisions)

Per `refactor plan/unified-process-supervision-2026-06-02.md` §5–6 and the consolidation ledger:

**Already done (Step 1, commits `40c2a91f` + `0022872d`):**
- ONE terminal authority — `applyAgentRunTerminalEffects` is the single chokepoint; the per-run factory `onEvent` listener is deleted; `applyHostTerminalSnapshot` routes through without short-circuiting.
- ONE run-keyed waiter — `ActiveRunRegistry.settle(runId)` resolves `done` fire-exactly-once; the `resolveDone` race is gone. Live acceptance GREEN.

**Step 2 (next, open):** Fold boot reconcile + liveness sweep + host-reconcile sweep into ONE mode-agnostic loop with a structural HOLD-on-unreachable-Engine guard (never finalize when the Engine didn't answer). Add the ONE-RECONCILER guard test (one `setInterval` owner). Ledger §0 + §4: Step 1 CLOSED; Step 2 is current open work.

**Step 3:** Brain re-discovers the Engine endpoint after respawn (re-resolution, not a cached boot URL). Prerequisite for Steps 4–5.

**Steps 4–5:** Move the orchestrator and modals onto the Engine. Not yet started.

**Step 6 (final cleanup):** Delete `PtySession`, `InteractiveSession`, banner-regex ready-detection, the dead `reattach` field and `reattachLifecycle()` method on `AgentRun` (no production caller; `reattachAgentRunsOnBoot` the module is a different thing and stays). ☠ sentenced.

---

## Known issues / scar tissue

**The stall bug — root cause, fixed in Step 1.** An agent on the host would deliver its work but the workflow `done` promise never resolved, so the card never moved. Root cause: two listeners both subscribed to the host's terminal event for the same run — the per-run factory listener (called `resolveDone` directly, a per-call callback) AND the persistent boot listener. Whichever fired second found no waiter and silently dropped the settlement. The workflow step waited forever. Fix: deleted the per-run listener entirely (~108 lines); settlement moved to `ActiveRunRegistry.settle(runId)`, a run-keyed fire-exactly-once mechanism registered before `start()`. Lesson: *any* "done" handling added outside the one terminal authority will strand runs again.

**Idle timeout fires on legitimate long jobs.** The in-process timer default is 5 min (`agent-run.ts:169`); the liveness sweep uses 10 min (`agent-run-idle.ts:23`). A deep-thinking agent can hit the per-run timer as a false failure. The two thresholds are independent and unsynchronised. Per-dispatch `idleMs` override exists but isn't always set.

**Sweeps don't structurally hold on unreachable host.** The "only finalize `host-lost` when the host was reachable AND returned an empty list" discipline lives entirely in the caller (`index.ts`), not in the sweep itself. A caller bug could kill fine-but-invisible runs. Step 2 bakes this as a structural invariant.

**Legacy boot path fails paused runs incorrectly.** Legacy mode (no host client) bulk-fails ALL non-terminal rows on restart, including paused runs with a valid open human question. The host-mode path has the paused-run exception; legacy does not. Closes in the Step-2 one-loop merge.

**In-process dispatch branch is dead in production but alive in tests.** `startDispatchedRun` has an `else` branch (`constructAndStart`, no-host-client) that is never reached in a real server but IS reached by unit tests. Both paths must stay in sync until tests move to a host-fake. (Ledger: DELETE in-process branch.)

**JSONL path divergence — the historical root of the stall class.** If the server and the host compute the JSONL file path differently, the server-side watcher reads a file the agent never writes, gets no events, and fires the idle timer at 5 min as a false failure. Fixed for host dispatches in `factory.ts:855`: the server computes the authoritative path and sends it to the host; the host must not recompute it.

**`reattach` field / `reattachLifecycle()` are dead.** `AgentRunInput.reattach` and `AgentRun.reattachLifecycle()` (agent-run.ts:120, 499) have no production callers. They will be deleted in the Step-6 pass. (`reattachAgentRunsOnBoot` the module is a completely different thing and is very much alive — the naming is confusing.)

---

## Decisions & open questions

**For Emerson (product calls):**

1. **What should happen to a running job if the server restarts?** Today it is failed with reason `interrupted-on-boot`, visibly. Should the system try to re-attach automatically? (Host-mode already does this for jobs the host still has. The open question is: what does the user see, and should there be a "resume interrupted job" button?)
2. **Paused jobs across restarts** — today a paused-for-human-answer job survives a restart in host mode. In legacy mode (not production, but reached by some paths) it would be failed. When the one-loop Step-2 work lands, this becomes consistent. Worth confirming: do you want paused jobs to always survive a restart, or is it acceptable to fail them?
3. **Idle timeout** — a deep-thinking agent can be killed after 5 min of silence as a false failure. Should there be a way to mark a workflow step as "this agent needs more time"? Or should the default just be longer?

**Technical:**

- **Step-2 loop shape:** one shared interval or separate cadences for in-process vs host mode? The `agent-run-idle.ts` shared thresholds suggest one, but the two sweep callers in `index.ts` currently run at different rates.
- **Guard tests:** the ONE-TERMINAL-AUTHORITY and ONE-RECONCILER tests called for in ledger §3 are not written yet. They should gate the Step-2 PR.
- **Host re-resolution (Step 3):** `HostConnection` re-reads the lock file on reconnect (comment: "kills T1-A") — but integration-level test coverage doesn't exist yet. Needed before Steps 4–5 can safely proceed.
- **`constructAndStart` branch:** when unit tests move to a host-fake, delete the in-process branch and add a compile-time guard that `startDispatchedRun` has only one path.
