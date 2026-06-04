# Agent Run Lifecycle & Reconciler

> **Role:** Engine · Brain (cross-cutting today; target = Engine owns processes, Brain owns reconciler)
> **Status:** as-built snapshot — 2026-06-04 (P9 ✅: FD-17 ladder; idle-kill dead)
> **Code anchors:**
> `packages/runtime/src/agent-run.ts` · `agent-run-registry.ts`
> `apps/server/src/services/agent-run-factory.ts` · `agent-active-runs.ts` · `agent-run-terminal-effects.ts`
> `agent-run-reconciler.ts` · `agent-host-reattach.ts` (☠ Step 2 2026-06-03: `agent-run-boot-reconcile.ts` + `agent-run-server-boot.ts` deleted — boot is the loop's first tick; ☠ P9 2026-06-04: `agent-run-liveness-sweep.ts` deleted — dead since P2)
> `agent-run-idle.ts` · `agent-run-settle.ts` · `agent-run-deliverable-nudge.ts`
> `agent-run-stall-warn.ts` · `agent-run-control.ts` · `agent-run-writer.ts`
> `host-connection.ts` · `agent-host-client.ts` · `process-control.ts`

---

## What it is (plain English)

Think of this subsystem as **air-traffic control for agent jobs.** When the orchestrator sends an agent to do a task, this machinery takes over: it gives the job a tracking number, queues it if the runway is busy, clears it for takeoff, watches the flight, and closes the record when it lands — whether cleanly (agent delivered its work), by crash (process exited unexpectedly), by hitting the hard time ceiling, or by cancellation. **Radio silence alone never downs a flight (FD-17, P9):** a quiet agent gets a badge, then the orchestrator gets told — the kill switch only exists for the 2-hour ceiling and confirmed-dead processes. It is also the system that answers, at any moment: "is that flight still in the air, and has it landed yet?"

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
| `paused` | Waiting on an answer to a question (`pc_ask_orchestrator` / `pc_request_approval` — ☠ FD-6/M7 `pc_ask_user`) |
| `completed` | Agent submitted its deliverable — clean landing |
| `failed` | Something went wrong (timeout, crash, no deliverable) |
| `cancelled` | Operator or system deliberately stopped it |

Transitions are enforced internally. `toTerminal()` is the single internal path to any of the three terminal states (line 572); `isTerminal()` blocks a second transition. A typed `AgentRunFailureCause` records *why* it failed (e.g. `idle-timeout`, `unexpected-exit`, `no-deliverable`).

### 2. The concurrency cap — the runway queue

`AgentRunRegistry` (`agent-run-registry.ts`) limits how many jobs run at the same time (default: 5, process-wide FIFO). 🟢 *FD-15: becomes a visible app setting in the rebuild.* When a new job arrives:

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

### 7. Per-run timers — what's left after FD-17 (P9 ✅ 2026-06-04)

**Silence never executes a run anymore.** ☠ The `idle` timer (5 min kill) and the `firstTurn`
resume watchdog (90 s kill — the S2 ask-roundtrip killer) are DELETED from `AgentRun`
(banned-resurrection: `armIdleTimer` / `resetIdleTimer` / `armFirstTurnWatchdog`). Quiet runs are
the reconciler ladder's business (§11). What remains, all positive-receipt or sanctioned:

| Timer | What triggers it | Default |
|---|---|---|
| `spawnStuck` | Process didn't finish starting | 2 min |
| `wallClock` | Total run time (the ONE sanctioned timer kill; a workflow node's `timeout` maps here now — "this step may not run longer than X") | 2 h |
| `cancelGrace` | Cancel requested; process hasn't exited | 5 s |

All fire through `toTerminal()` with their typed cause. (`idle-timeout` survives in the
failure-cause union for pre-P9 rows only — no live writer.)

The **spawn-exit handler** (`onSpawnExit`) is the reason deleting the idle-kill was safe: a
process that DIES is typed `unexpected-exit` immediately, timers or not (live-verified ~2 s).
Only alive-but-quiet remained, and that's the ladder's job.

### 8. THE one reconciler — `agent-run-reconciler.ts` (Step 2 ✅ 2026-06-03)

`createAgentRunReconciler` owns every "what state is this run actually in?" answer. **Boot is the
loop's first tick** — no boot-only code path exists (☠ `agent-run-boot-reconcile.ts` +
`agent-run-server-boot.ts` deleted; the DB bulk-fail helpers that killed paused rows deleted with
them). Per tick (15 s, the ONLY liveness interval — guard-tested):

- **Host mode** (production): refresh the host's run list, then re-derive every non-terminal DB
  row. Terminal snapshot → the one authority. Status drift → update + announce. Host-owned run
  with no registry entry → register a live handle (self-healing reattach, any tick — not just
  boot). Missing rows → consecutive-tick counters: `running` fails `host-lost` after 2 ticks,
  `queued`/`spawning` after 8 (closes the old stuck-forever gap), `paused` **NEVER** (FD-14 law).
- **HOLD invariant (structural now):** a `refreshRuns()` that throws, or a disconnected host,
  withholds the absence signal, the counters, AND handle registration — nothing can finalize on
  no-information, boot included. Verified live 2026-06-03: a dead host held three seeded rows
  untouched for 5+ minutes; reconnect converged them correctly.
- ☠ **In-process mode DELETED (P9 2026-06-04):** it had been dead code since P2 removed the
  in-process spawn path (index.ts only ever constructed `'host'`). `agent-run-liveness-sweep.ts`
  (pid-check + 10 min idle-kill + queued-orphan) deleted whole; host mode's spawn-lost counter
  (8 ticks) already owns the queued-orphan case. One path.

Guards in `apps/server/test/agent-run-reconciler.test.ts`: ONE-RECONCILER (deleted paths stay
deleted — boot-reconcile AND liveness-sweep; index.ts can't import raw sweeps; one interval
owner) · HOLD. PAUSED-SURVIVES + spawn-threshold + self-heal cases in
`agent-host-reattach.test.ts`.

### 9–10. The sweeps — subroutines of the loop, not processes

`reconcileAgentRunsAgainstHost` and `sweepStallWarn` still exist as functions but are callable
ONLY from the reconciler (guard-tested). They have no intervals of their own.

### 11. The stall ladder — FD-17 (P9 ✅ 2026-06-04): silence escalates, never executes

`sweepStallWarn` (`agent-run-stall-warn.ts`) is the ladder, run every reconciler tick:

- **Rung 1 (3 min quiet, `PC_AGENT_STALL_WARN_MS`):** `stalled` badge in the UI. Emit-once per
  episode; clears on any sign of life.
- **Rung 2 (5 min quiet, `PC_AGENT_STALL_NOTIFY_MS` — the old kill moment):** verify-alive read
  (last transcript action via the shared `lastJsonlAction`) + ONE durable `agent-stalled` mailbox
  to the active orchestrator (wait / `pc_inspect_agent_run` / `pc_kill_agent_run`). Idempotency
  key embeds the episode's last-activity floor — an API restart can't double-notify; new activity
  starts a fresh episode that may notify again.
- **No rung kills.** Paused runs (waiting on an ask) are excluded — legitimately idle.

**Sibling, event-driven: the deliverable-skip nudge** (`agent-run-deliverable-nudge.ts`, wired in
the reconciler's host-event subscription). A live `jsonl-turn-end` on a contract-first run still
`running` with nothing delivered → strike 1 injects a marked reminder
(`[pc:system kind=deliverable-nudge] … call pc_submit_deliverable now / pc_ask_orchestrator if
blocked`); strike 2 → ONE `agent-stalled` escalation; then the orchestrator owns it. Live-proof
(2026-06-04): the "marco" degenerate task nudged → delivered in ~10 s (was: silent 300 s death);
a waiting-on-background-job agent was nudged into a clean `pc_ask_orchestrator` pause.

### 12. The persistent host event listener — live terminal signals

Subscribed ONCE by the reconciler's `boot()` (rides `HostConnection`'s multiplexed emitter, so it
survives host respawns): a single `onEvent(applyAgentHostEvent)` listener handles all host events
for all runs. A `run-terminal` event reaches `applyHostTerminalSnapshot` →
`applyAgentRunTerminalEffects` (the one authority). After the Step-1 fix, the snapshot apply never
short-circuits on already-terminal rows — the authority handles the idempotent case and still
fires the waiter. Events are the **latency** path; the reconciler tick is the **correctness** path
that converges anything the stream drops.

### Where the mechanisms overlap (and why that's OK now)

Per-run timers (7), the reconciler tick (8), and the persistent listener (12) can all decide a run
is done. All routes converge on `applyAgentRunTerminalEffects` — idempotent; first to fire wins,
the rest are no-ops that still safely settle the waiter. Steps 1 + 2 are DONE: one authority, one
loop, boot = first tick.

### 13. State broadcasting — how the UI sees run changes

All state transitions go through `announceAgentRunChange` (`agent-run-writer.ts:46`) → `AgentRunMutationGateway` → writes a `live_outbox` row in the same transaction → the live-relay drains it to UI subscribers. Hand-broadcasting is gone (removed in Slice 015b).

### 14. Host connection — the wire to the agent process manager

`HostConnection` (`host-connection.ts`) wraps the HTTP client behind a single long-lived conduit that re-discovers the host from its lock file on reconnect. `listRuns()` returns the last cached snapshot; `refreshRuns()` pulls fresh. The heartbeat publishes `HostHealth` for the UI status pill.

---

## How it connects

- **Depends on:** `@pc/runtime` (the run object, registry, PTY spawning, JSONL tailer) · `@pc/db` (`agent_runs`, `live_outbox`, `agent_contracts`, `pending_asks`) · `@pc/app-services` (contract service, mutation gateway) · `host-connection.ts` / `agent-host-client.ts` (the host wire) · `process-control.ts` (OS-level pid / kill) · `pod-spawn.ts` (renders the agent's files before launch).
- **Used by:** HTTP routes (`/invoke`, `/continue`) · workflow engine (`dag-run-service.ts`, awaits `done`) · MCP tools (`pc_submit_deliverable` → `run.complete()`, `pc_ask_orchestrator` → `markPaused()`, `pc_answer_pending_ask` → `resumeWithAnswer()`) · `agent-run-control.ts` (operator kill/inspect) · `index.ts` (boot + sweep wiring).
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

~~**Idle timeout fires on legitimate long jobs.**~~ ✅ **RESOLVED — P9 2026-06-04 (FD-17).** There
is no idle kill anywhere anymore. The 5 min per-run timer, the 90 s resume watchdog, and the
10 min in-process sweep kill are all deleted; quiet runs badge at 3 min and notify the
orchestrator once at 5 min (§11). A workflow node's `timeout` now means a wall-clock ceiling.
Live-proof: a worker silent for 6+ minutes on a background job survived to a clean pause/resume.

**Sweeps don't structurally hold on unreachable host.** The "only finalize `host-lost` when the host was reachable AND returned an empty list" discipline lives entirely in the caller (`index.ts`), not in the sweep itself. A caller bug could kill fine-but-invisible runs. Step 2 bakes this as a structural invariant.

**Legacy boot path fails paused runs incorrectly.** Legacy mode (no host client) bulk-fails ALL non-terminal rows on restart, including paused runs with a valid open human question. The host-mode path has the paused-run exception; legacy does not. Closes in the Step-2 one-loop merge.

~~**In-process dispatch branch is dead in production but alive in tests.**~~ ✅ deleted in P2
(2026-06-03); the reconciler's in-process MODE + liveness sweep followed in P9 (2026-06-04).

**JSONL path divergence — the historical root of the stall class.** If the server and the host compute the JSONL file path differently, the server-side watcher reads a file the agent never writes, gets no events, and fires the idle timer at 5 min as a false failure. Fixed for host dispatches in `factory.ts:855`: the server computes the authoritative path and sends it to the host; the host must not recompute it.

**`reattach` field / `reattachLifecycle()` are dead.** `AgentRunInput.reattach` and `AgentRun.reattachLifecycle()` (agent-run.ts:120, 499) have no production callers. They will be deleted in the Step-6 pass. (`reattachAgentRunsOnBoot` the module is a completely different thing and is very much alive — the naming is confusing.)

---

## Decisions & open questions

**For Emerson (product calls):**

*(All three resolved 2026-06-03 → Foundation Decisions:)*
1. ~~Running job when the server restarts?~~ 🟢 **FD-14:** interrupted runs are **resumable** —
   the transcript survives on disk, the continuation machinery exists; the product gets a
   "resume interrupted job" affordance, not just a visible failure.
2. ~~Paused jobs across restarts?~~ 🟢 **FD-14:** paused runs **always** survive a restart; the
   legacy bulk-fail path is wrong and dies in the Step-2 merge.
3. ~~Idle timeout kills deep-thinking agents?~~ 🟢 **FD-17:** timeouts **escalate before they
   execute** — badge → verify alive → notify orchestrator → kill only on wall-clock ceiling or
   confirmed-dead process. No agent killed while demonstrably alive and working.

**Also locked:** 🟢 **FD-15** — the concurrency cap (§2, hard-coded 5) becomes a visible app setting.

**Technical:**

- **Step-2 loop shape:** one shared interval or separate cadences for in-process vs host mode? The `agent-run-idle.ts` shared thresholds suggest one, but the two sweep callers in `index.ts` currently run at different rates.
- **Guard tests:** the ONE-TERMINAL-AUTHORITY and ONE-RECONCILER tests called for in ledger §3 are not written yet. They should gate the Step-2 PR.
- **Host re-resolution (Step 3):** `HostConnection` re-reads the lock file on reconnect (comment: "kills T1-A") — but integration-level test coverage doesn't exist yet. Needed before Steps 4–5 can safely proceed.
- **`constructAndStart` branch:** when unit tests move to a host-fake, delete the in-process branch and add a compile-time guard that `startDispatchedRun` has only one path.
