# Consolidation Ledger — as-built → unified

**Date:** 2026-06-02
**Status:** working ledger (drives the consolidation toward `unified-process-supervision-2026-06-02.md`)
**Method:** audit by CONCERN, not by file. Each row: a site, a verdict, a reason, a confidence, and a
single-path guard. When no `MERGE`/`DELETE` rows remain unresolved, the app is unified.

**How to read a verdict:** `KEEP` (the one true home) · `MERGE→X` (fold into keeper X) · `DELETE`
(dead/legacy/duplicate) · `CREATE` (missing piece the target needs).
**Confidence:** `HIGH` (agreed across sweeps + cited) · `VERIFY` (sweeps disagreed or unconfirmed —
**do not act until resolved**, see §1).

---

## 1. Verification queue — RESOLVED (2026-06-02)

All seven checked. The sweeps **disagreed on three** and two memory notes were **stale** — verifying
caught both, which is the whole point.

| # | Question | Resolution | Affects ledger |
|---|----------|-----------|----------------|
| V1 | orchestrator + modals owner | **CONFIRMED:** orchestrator = `InteractiveSession` (`project-runtime.ts:104,501`); the 3 modals = `PtySession` (`:109,:114,:117`). Both LIVE. Sweep C's "PtySession is dead / no callers" was **WRONG**. | PtySession → KEEP-then-migrate (Step 5), NOT a free delete. |
| V2 | is in-process dispatch reachable? | **CONFIRMED dead in any real server:** `index.ts:279,304` always creates a `hostConnection` and wires `getHostClient → it`, so `hostClient` is never null in the running server → the in-process `else` branch is never taken. It IS exercised by **unit tests** (fake spawn, no hostClient). | in-process branch → DELETE-able, but **move the tests to a host-fake first**. Not a behavior change in prod. |
| V3 | MCP tool-catalog drift | **RESOLVED already (Slice 016).** `PC_RIG_TOOL_REGISTRY` (`tool-registry.ts:52`) is the sole source; `TOOLS` + `PC_RIG_TOOL_NAMES` (`mcp/server.ts:47,58`) and the catalog (`tool-catalog.ts:104`) all `.map()` off it; build-time parity check. **Memory note is stale.** | NOT a consolidation target. Drop from §"Sources of truth". |
| V4 | web `STOCK_POD_NAMES` mirror | **GONE** — no match in `apps/web/src`. **Memory note is stale.** | NOT a target. Drop. |
| V5 | `workflow_run_events` table | **NOT confirmed to exist.** `dag_state` JSON is the current workflow store. The append-only "run log = truth" is the **unshipped** piece (workflow-redesign slice 3), not built yet. | "events = truth" is aspirational; today dag_state IS the store. Mark as CREATE (slice 3), not an existing source to migrate. |
| V6 | v1 `workflow.ts` / `jsonl-tailer.ts` live? | **`jsonl-tailer.ts` is FOUNDATIONAL, not legacy** — it exports the base `JsonlEvent` type + the `JsonlTailer` used by `low-level-spawn.ts`, `pty-session.ts`, `interactive-session.ts`, `agent-run.ts`. Sweep C's "delete v1 tailer" was **WRONG**. v1 `workflow.ts`: no live importers found (likely dead; confirm domain barrel before delete). | jsonl-tailer.ts → **KEEP** (base layer). v2 `agent-run-jsonl-tailer` is the agent-run *layer* on top, not a replacement. |
| V7 | `field_schemas` / `orchestrator_sessions` | **Both real tables** (`repos/field-schemas.ts`, `repos/orchestrator-sessions.ts`). KEEP-as-truth. | source-of-truth map complete. |

**Takeaway:** two of the three sweeps' DELETE calls (PtySession, v1 jsonl-tailer) were wrong — both are
live/foundational. The genuinely-dead in-process branch is gated behind a test refactor. Two
"drift target" memory notes are stale (already fixed). Rows below are corrected accordingly.

---

## 2. Ledger by concern

### Spawning & ownership (target: Supervisor + Engine own all processes)
| Site | Verdict | Conf | Notes |
|------|---------|------|-------|
| `LowLevelSpawn.start` → `pty.spawn` (low-level-spawn.ts) | **KEEP** | HIGH | The one PTY spawn primitive. All claude.exe go through it. |
| `dispatchFreshAgent` / `dispatchContinueAgent` (agent-run-factory.ts) | **KEEP** | HIGH | The dispatch door (workflow + orchestrator both use it). |
| `startDispatchedRun` host-vs-in-process fork (agent-run-factory.ts:~703) | **DELETE in-process branch** | HIGH (V2) | Dead in any real server (host always wired, `index.ts:279,304`); only unit tests hit it. Move those tests to a host-fake, then cut. |
| `spawnPackagedAgentHostProcess` (desktop/agent-host-process.ts) | **KEEP→fold into Supervisor** | HIGH | Becomes part of the one supervisor (Step 7). Packaged host respawn is the gap. |
| `dev-supervisor.mjs` (spawns API+host, respawns) | **KEEP→fold into Supervisor** | HIGH | The dev half of the one supervisor. |
| `ProjectRuntime` spawning orchestrator (`InteractiveSession`) + modals (`PtySession`) | **MERGE→Engine** | HIGH (V1) | Steps 4–5 move these to the Engine. Confirmed: orchestrator=InteractiveSession, modals=PtySession. |
| ChannelServer per-project stdio children (index.ts:~321) | **KEEP** (re-evaluate) | VERIFY | Orchestrator bridge; confirm it's still needed after Engine absorbs orchestrator. |

### Lifecycle primitive (target: ONE state machine + policy flags)
| Site | Verdict | Conf | Notes |
|------|---------|------|-------|
| `AgentRunState` (agent-run.ts) | **KEEP** (the one primitive) | HIGH | Add policy flags (persistent/one-shot/ephemeral, awaited, interactive, pausable). |
| `SpawnState` (low-level-spawn.ts) | **KEEP-internal** | HIGH | Stays internal to LowLevelSpawn; not a public FSM. |
| `InteractiveSessionState` (interactive-session.ts) | **MERGE→AgentRun** | HIGH (V1) | LIVE — the orchestrator (`project-runtime.ts:104,501`). Becomes a `persistent,interactive` policy on the one primitive. |
| `SessionState`/`PtySession` (pty-session.ts) | **DELETE** (after Step 5) | HIGH (V1) | LIVE today — the 3 modals (`project-runtime.ts:109,114,117`). Migrate to the Engine first, THEN delete. Not a free delete. |
| reattach path: `AgentRun.reattach` field + `reattachLifecycle()` (agent-run.ts:120,499) | **DELETE** | HIGH | Dead — no caller sets `reattach`; references a non-existent `HostClient.attachSpawn`. |

### Ready detection (target: ONE)
| `ReadyGate` (ready-gate.ts) | **KEEP** | HIGH | Signal-based; the keeper. |
| `terminalBufferLooksReady` banner regex (pty-session.ts) | **DELETE** (after Step 5) | HIGH (V1) | Duplicate of ReadyGate's init-complete check; dies with PtySession. |

### Transcript reading (target: ONE)
| `agent-run-jsonl-tailer.ts` (v2) | **KEEP** | HIGH | The agent-run *layer* (typed events). |
| `jsonl-tailer.ts` (v1) | **KEEP** | HIGH (V6) | NOT legacy — it's the BASE layer: exports `JsonlEvent` + `JsonlTailer` used by low-level-spawn, pty-session, interactive-session, agent-run. v2 sits on top; not a replacement. |
| PtySession file-watching (stop-marker + events file) | **DELETE** (after Step 5) | HIGH (V1) | Dies when modals migrate to the Engine. PtySession IS live today (3 modals) — migrate, then delete. |

### Completion detection (target: positive receipt + typed-failure backstops)
| Deliverable receipt: `pc_submit_deliverable` → `run.complete()` / `complete-run` + `gateTerminalForDeliverable` (agent-run-settle.ts) | **KEEP** (sole "good done") | HIGH | The positive signal. |
| JSONL turn-end as a *completion* trigger | **DELETE-as-completion** (keep as activity) | HIGH | Already decoupled; must never close a run. |
| process-exit / idle / wall-clock / spawn-stuck / ready timeouts | **KEEP-as-typed-failure** | HIGH | Backstops only — always produce a reason, never silent hang or fake success. |

### Terminal application + done-resolution (target: ONE authority + run-keyed waiter) — **STEP 1**
| `applyAgentRunTerminalEffects` (agent-run-terminal-effects.ts) | **KEEP** (the one terminal authority) | HIGH | Already funnels DB-flip + gate + verify + envelope + `onSettled`. |
| `applyHostTerminalSnapshot` (agent-host-reattach.ts:419) | **MERGE→applyAgentRunTerminalEffects** | HIGH | Its early-return on already-terminal SKIPS `onSettled` — the starve. Route the host path so the one authority always settles. |
| per-run factory `onEvent` listener (agent-run-factory.ts:~746) | **DELETE** (redundant 2nd listener) | HIGH | The race's loser; replaced by the run-keyed waiter. |
| boot/reconcile PERSISTENT listener (agent-host-reattach.ts:170) | **MERGE→the one reconciler** | HIGH | The race's winner; folds into the single control loop. |
| `resolveDone`/`onSettled`/`settleDone` (agent-run-factory.ts) | **KEEP→move to run-keyed registry** | HIGH | The waiter; store it keyed by runId so any terminal path resolves it (no listener race). |

### Reconcilers / sweeps / registries (target: ONE control loop, all states) — **STEP 2**
| boot reconcile (agent-run-boot-reconcile.ts) | **MERGE→one loop** | HIGH | Becomes "the loop at boot." |
| reconcile-against-host sweep (agent-host-reattach.ts:222) | **MERGE→one loop** | HIGH | The continuous loop. Fix: never act on unreachable/empty host. |
| in-process liveness sweep (agent-run-liveness-sweep.ts) | **MERGE→one loop** | HIGH | Mode-agnostic loop subsumes it. |
| per-run timers (agent-run.ts) | **KEEP** | HIGH | Local timeout enforcement feeding typed-failure; not a sweep. |
| envelope replay (agent-run-terminal-effects.ts:replay…) | **KEEP-as-subroutine** | HIGH | Idempotent notify safety net. |
| workflow boot reconcile | **CREATE / confirm** | VERIFY(V5) | Sweeps disagree it exists (`reconcileWorkflowRunsOnBoot` referenced from index but unverified). |
| `ActiveRunRegistry` (agent-active-runs.ts) | **KEEP** | HIGH | Live-run lookup + the run-keyed waiter's home. |
| `AgentRunRegistry` cap/queue (runtime) | **KEEP** | HIGH | Concurrency control (the Engine's pool). |
| host `runs`/`ccSessionIndex` maps · `HostConnection.lastRuns` · `hostMissingTicks` | **KEEP-as-projection** | HIGH | Caches of the DB truth; not authoritative. |

### Notification / delivery (target: one door each)
| dispatch `done` promise | **KEEP** (awaited-caller door) | HIGH | Resolved via the run-keyed waiter. |
| mailbox / `deliverAgentEnvelope` | **KEEP** (durable notify door) | HIGH | The one human/orchestrator door. |
| live-relay (`live_outbox` → WS) | **KEEP** (the one live fanout) | HIGH | Post-commit drain. |
| raw WS `broadcast` / `agent.run.changed` | **MERGE→live-relay** | HIGH | Legacy direct fanout; route everything through announce→outbox→relay. |
| AgentRun EventEmitter events | **KEEP-internal** | HIGH | Object-internal; not an external door. |

### Sources of truth (target: append-only log = truth, rest = projection)
| `agent_runs` table | **KEEP-as-truth** (runs) | HIGH | Registry/caches are projections. |
| `live_outbox` | **KEEP-as-truth** (live events) | HIGH | Append-only; relay cursor is a projection. |
| `work_items.history` | **KEEP-as-truth** (WI transitions) | HIGH | Denormalized position/status are projections. |
| `agent_contracts.deliverable` vs legacy `work_items.body` mirror | **KEEP contract; DELETE wi.body mirror** | HIGH | The "Slice 014" cleanup; contract is canonical. |
| `workflow_runs_v2.dag_state` (today's store) → `workflow_run_events` (target truth) | **CREATE events log; dag_state→projection** | HIGH (V5) | No events table today; dag_state JSON IS the store. The append-only log is the unshipped workflow-redesign slice 3. |
| `PC_RIG_TOOL_REGISTRY` → `TOOLS`/`PC_RIG_TOOL_NAMES`/catalog | **DONE — single source** | HIGH (V3) | Already unified (Slice 016): all `.map()` off the registry + parity check. Not a target. |
| web `STOCK_POD_NAMES` mirror | **N/A — already gone** | HIGH (V4) | No mirror in `apps/web/src`. Not a target. |
| `field_schemas`, `orchestrator_sessions` tables | **KEEP-as-truth** | HIGH (V7) | Real repo'd tables. |

### Dead / legacy (DELETE after their V-row clears)
| `agent_inbox` / `agent_delivery_audit` tables + `repos/agent-inbox.ts` | **DELETE** (post mailbox-stable) | HIGH | Superseded by mailbox; never written now. Archive old rows first. |
| `PcInvokeAgentResultSync` + `PcInvokeAgentInput.wait` (agent-comms.ts) | **DELETE** | HIGH | Sync invoke mode never implemented. |
| forked workflow-subagent dispatch | **DELETED** ✓ | HIGH | Already removed (slice 8b). |

---

## 3. Single-path guards (so it can't regress)

For each consolidated concern, add a guard that fails CI if a second path reappears (the pattern
already used for the tool-catalog drift test):
- **One terminal authority:** a test asserting `applyHostTerminalSnapshot` does not finalize without
  routing through `applyAgentRunTerminalEffects` (no second `markTerminal` site).
- **One reconciler:** a grep-test that there is exactly one interval owner for run liveness.
- **One spawn owner:** a test that no `claude.exe` spawn happens outside the Engine once Steps 4–6 land.
- **One transcript reader / ready detector:** delete the v1 modules so a second can't be imported.
- **Source-of-truth guards:** drift tests for every derived list (extend the Slice-016 pattern).

---

## 4. Mapping to migration steps (from the design doc)

- **Step 1 (stall fix):** the "Terminal application + done-resolution" block — one authority + run-keyed
  waiter; delete the redundant listener. All HIGH confidence; ready to scope now.
- **Step 2:** the "Reconcilers/sweeps" block → one control loop.
- **Steps 4–6:** the "Lifecycle / ready / transcript / spawning" blocks — V-rows now CLEARED; the
  shape is: migrate orchestrator (InteractiveSession) + modals (PtySession) onto the Engine, THEN
  delete PtySession + its banner-regex + file-watching. Keep `jsonl-tailer.ts` (base) + ReadyGate.
- **Step 7:** fold `dev-supervisor.mjs` + `spawnPackagedAgentHostProcess` into one Supervisor.
- **Ongoing cleanup:** "Dead/legacy" block (reattach path, sync-invoke type, agent_inbox post-stable,
  in-process branch after test-refactor). Catalog/web "drift" rows are already done — dropped.

---

## 5. Next action

Verification queue is **cleared** (§1). **Step 1 is fully unblocked** — entirely HIGH-confidence, no
open dependency. Scope it concretely (the run-keyed waiter + the listener/sweep collapse) and build.
