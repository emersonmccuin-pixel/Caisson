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

## 0. Phase-0 re-verification (2026-06-03) — multi-agent trace + adversarial refute

25 rows re-traced, each then attacked by an independent skeptic, then synthesized. Deltas:

**Step 1 is DONE in code** (`40c2a91f` + `0022872d`). These rows are CLOSED — only guard tests remain:
`applyHostTerminalSnapshot` merge, per-run `onEvent` listener delete, boot-reconcile-listener merge,
`resolveDone`→run-keyed registry, turn-end-as-completion delete. So real open work starts at **Step 2**.

**Three rows the trace got WRONG — skeptic won (verified):**
1. ~~`agent_inbox` tables — NOT a free delete~~ **✅ M4a 2026-06-04: it WAS a free delete** —
   refute-of-the-refute: the hook only ever READ rows that slice 017 stopped writing (drained an
   eternally-empty pending set every prompt for weeks). Hook + repo + tables deleted whole
   (migration 0041 archive; NO-INBOX-WRITE gate).
2. `work_items.body` mirror — DO NOT delete: `dag-run-service.ts:173` reads it live to resolve
   `$root.output` workflow refs. Re-scoped to KEEP + document dual purpose.
3. ~~`workflow_run_events` — dead observability writes~~ **✅ M3a 2026-06-04: every diary line
   through `WorkflowRunMutationGateway.appendRunEvent` (event row + `workflow.run.event` outbox
   fact, one txn; DIARY-DOOR gate); UI renders the timeline; `pc_get_workflow_run` reads it.
   State PROJECTION stays with M6 (dag_state remains the execution store — by design).**

**One refute OVERREACHED (trace stands):** `reattach-path` — the `AgentRunInput.reattach` field +
`reattachLifecycle()` method ARE dead (no caller sets `reattach`); the skeptic confused them with the
live `reattachAgentRunsOnBoot` module (different thing). Delete field+method in the Step 6 pass.

**Stale VERIFY rows resolved:** V5 workflow-boot-reconcile EXISTS + live (`index.ts:487`, `38fb3436`).
raw-WS-broadcast → live-relay merge already DONE.

**Build order + near-term anchor:** see §6 (Phase-0 ordered plan). Anchor = **Step 7 Supervisor** (ready
now, independent, fixes packaged-host-never-respawns).

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
| `startDispatchedRun` host-vs-in-process fork (agent-run-factory.ts:~703) | **DELETE in-process branch** ✅ executed 2026-06-03 (60ac149f) | HIGH (V2) | Deleted; banned-resurrection gate holds. |
| `spawnPackagedAgentHostProcess` (desktop/agent-host-process.ts) | **KEEP→fold into Supervisor** ✅ executed 2026-06-04 (☠ deleted; host = supervised child) | HIGH | Step 7 shipped; ONE-SUPERVISOR gate bans resurrection. |
| `dev-supervisor.mjs` (spawns API+host, respawns) | **KEEP→fold into Supervisor** ✅ executed 2026-06-04 (☠ deleted; logic ported to `@pc/supervisor`) | HIGH | Step 7 shipped. |
| `ProjectRuntime` spawning orchestrator (`InteractiveSession`) + modals (`PtySession`) | **orchestrator MERGE→Engine · modals ☠ DELETE (FD-21)** | HIGH (V1) | Step 4 moves the orchestrator to the Engine; the modals are deleted outright per FD-21 (orchestrator-led authoring), not migrated. |
| ChannelServer per-project stdio children (index.ts:~321) | **KEEP** (re-evaluate) | VERIFY | Orchestrator bridge; confirm it's still needed after Engine absorbs orchestrator. |

### Lifecycle primitive (target: ONE state machine + policy flags)
| Site | Verdict | Conf | Notes |
|------|---------|------|-------|
| `AgentRunState` (agent-run.ts) | **KEEP** (the one primitive) | HIGH | Add policy flags (persistent/one-shot/ephemeral, awaited, interactive, pausable). |
| `SpawnState` (low-level-spawn.ts) | **KEEP-internal** | HIGH | Stays internal to LowLevelSpawn; not a public FSM. |
| `InteractiveSessionState` (interactive-session.ts) | **MERGE→AgentRun** | HIGH (V1) | LIVE — the orchestrator (`project-runtime.ts:104,501`). Becomes a `persistent,interactive` policy on the one primitive. |
| `SessionState`/`PtySession` (pty-session.ts) | ☠ **DELETED 2026-06-04 (P8)** | HIGH (V1) | Modals died in P7 → file deleted whole. |
| reattach path: `AgentRun.reattach` field + `reattachLifecycle()` | ☠ **DELETED 2026-06-04 (P8)** | HIGH | Field+method+`registry.reattach()` all cut. The LIVE `reattachAgentRunsOnBoot` module untouched. |

### Ready detection (target: ONE)
| `ReadyGate` (ready-gate.ts) | **KEEP** | HIGH | Signal-based; the keeper. |
| `terminalBufferLooksReady` banner regex (pty-session.ts) | ☠ **DELETED 2026-06-04 (P8)** | HIGH (V1) | ReadyGate is the one detector. |

### Transcript reading (target: ONE)
| `agent-run-jsonl-tailer.ts` (v2) | **KEEP** | HIGH | The agent-run *layer* (typed events). |
| `jsonl-tailer.ts` (v1) | **KEEP** | HIGH (V6) | NOT legacy — it's the BASE layer: exports `JsonlEvent` + `JsonlTailer` (+ `JsonlReplayMeta`/`Source` since P8) used by low-level-spawn + agent-run. v2 sits on top; not a replacement. |
| PtySession file-watching (stop-marker + events file) | ☠ **DELETED 2026-06-04 (P8)** | HIGH (V1) | Died with pty-session.ts. |

### Completion detection (target: positive receipt + typed-failure backstops)
| Deliverable receipt: `pc_submit_deliverable` → `run.complete()` / `complete-run` + `gateTerminalForDeliverable` (agent-run-settle.ts) | **KEEP** (sole "good done") | HIGH | The positive signal. |
| JSONL turn-end as a *completion* trigger | **DELETE-as-completion** (keep as activity) | HIGH | Already decoupled; must never close a run. |
| process-exit / idle / wall-clock / spawn-stuck / ready timeouts | **KEEP-as-typed-failure** | HIGH | Backstops only — always produce a reason, never silent hang or fake success. |

### Terminal application + done-resolution (target: ONE authority + run-keyed waiter) — **STEP 1 ✅ DONE (40c2a91f + 0022872d) — guard tests only remain**
| `applyAgentRunTerminalEffects` (agent-run-terminal-effects.ts) | **KEEP** (the one terminal authority) | HIGH | Funnels DB-flip + gate + verify + envelope + `settle`. ✅ live. |
| `applyHostTerminalSnapshot` (agent-host-reattach.ts) | **✅ MERGED** — KEEP the fn (live wrapper, 4 callers) | HIGH | Already-terminal short-circuit removed; always routes through the one authority → settles. Do NOT delete the wrapper. |
| per-run factory `onEvent` listener | **✅ DELETED** (40c2a91f, ~108 lines) | HIGH | Gone. Factory has 0 `hostClient.onEvent`. Add ONE-TERMINAL-AUTHORITY guard. |
| boot/reconcile PERSISTENT listener (agent-host-reattach.ts:165) | **✅ routes through one authority** | HIGH | Listener-merge done; loop unification is separate Step 2 work. |
| `resolveDone`/`onSettled`/`settleDone` → `ActiveRunRegistry` | **✅ MOVED to run-keyed registry** (agent-active-runs.ts) | HIGH | Registered before start (factory.ts:465,635); fires by runId. Fire-exactly-once test green. |

### Reconcilers / sweeps / registries (target: ONE control loop, all states) — **STEP 2 ✅ DONE (2026-06-03) — `agent-run-reconciler.ts`, live acceptance green**
| boot reconcile (agent-run-boot-reconcile.ts) | **✅ DELETED** (+ `agent-run-server-boot.ts` + db bulk-fail fns) | HIGH | Boot IS the loop's first tick. The bulk-fail killed paused rows (FD-14) + bypassed the terminal authority — gone. |
| reconcile-against-host sweep (agent-host-reattach.ts) | **✅ MERGED — loop subroutine** | HIGH | Only the reconciler may call it (guard). HOLD structural; self-healing handle registration any tick; queued/spawning host-lost after 8 ticks (stuck-forever gap closed); paused NEVER. |
| in-process liveness sweep (agent-run-liveness-sweep.ts) | **☠ DELETED (P9 2026-06-04)** | HIGH | Was dead code since P2 (only `'host'` mode ever constructed). Host-mode spawn-lost counter owns queued-orphans; the 10min idle-kill died with FD-17. |
| per-run timers (agent-run.ts) | **✅ CUT DOWN (P9/FD-17 2026-06-04)** | HIGH | ☠ idle-kill (5min) + firstTurn resume watchdog (90s). KEEP: spawn-stuck · wall-clock (node `timeout` maps here now) · cancel-grace · onSpawnExit. Silence = reconciler stall ladder (badge → verify-alive → ONE `agent-stalled` notify), never a kill. |
| envelope replay (agent-run-terminal-effects.ts:replay…) | **KEEP-as-subroutine** | HIGH | Idempotent notify safety net; rides every tick. |
| workflow boot reconcile | **✅ CONFIRMED exists** (index.ts; paused skipped) | HIGH | Fail-closed for running/pending stays until M3/S5 (resumable runs). |
| `ActiveRunRegistry` (agent-active-runs.ts) | **KEEP** | HIGH | Live-run lookup + the run-keyed waiter's home. |
| `AgentRunRegistry` cap/queue (runtime) | **KEEP** | HIGH | Concurrency control (the Engine's pool). |
| host `runs`/`ccSessionIndex` maps · `HostConnection.lastRuns` · loop-owned tick counters | **KEEP-as-projection** | HIGH | Caches of the DB truth; not authoritative. |
| **Guards** | ONE-RECONCILER · HOLD · PAUSED-SURVIVES · queued-orphan (`agent-run-reconciler.test.ts`) + spawn-threshold/self-heal (`agent-host-reattach.test.ts`) | — | Live acceptance 2026-06-03: restart mid-run → reattach+complete · paused gates survive restart · dead-host HOLD 5min → reconnect converges · spawning ghost → host-lost ≈2min. |

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
| `agent_contracts.deliverable` vs legacy `work_items.body` mirror | **KEEP contract; KEEP wi.body — DO NOT delete** | HIGH (re-scoped 06-03) | ⚠️ wi.body is read LIVE by `dag-run-service.ts:173` to resolve `$root.output` workflow refs. Dual purpose (deliverable store + workflow-ref store). Add round-trip guard, do not remove. |
| `workflow_runs_v2.dag_state` (today's store) → `workflow_run_events` (target truth) | **✅ M3a 2026-06-04: diary truth-GRADE (one door + complete + readable + visible). dag_state→projection deferred to M6 (build the new step-model semantics on the spine once).** | HIGH (re-scoped 06-03) | appendRunEvent = event row + outbox fact in one txn (DIARY-DOOR gate); lifecycle bookends + `agent_dispatched` cross-link added; pc_get_workflow_run + UI timeline read it. M3b (chat-replay file→DB) split out — own pass. |
| `PC_RIG_TOOL_REGISTRY` → `TOOLS`/`PC_RIG_TOOL_NAMES`/catalog | **DONE — single source** | HIGH (V3) | Already unified (Slice 016): all `.map()` off the registry + parity check. Not a target. |
| web `STOCK_POD_NAMES` mirror | **N/A — already gone** | HIGH (V4) | No mirror in `apps/web/src`. Not a target. |
| `field_schemas`, `orchestrator_sessions` tables | **KEEP-as-truth** | HIGH (V7) | Real repo'd tables. |

### Dead / legacy (DELETE after their V-row clears)
| `agent_inbox` / `agent_delivery_audit` tables + `repos/agent-inbox.ts` | **✅ DELETED (M4a 2026-06-04)** | HIGH | No refactor was needed: the hook only READ rows nothing wrote since 017 Phase C. Hook + settings entry + repo + domain types deleted; migration 0041 archive-renames the tables; NO-INBOX-WRITE gate. legacy-runtime-cleanup keeps the hook NAME (scrubs old installs). |
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
  shape (updated by ☠ FD-21, 2026-06-03): migrate the orchestrator (InteractiveSession) onto the
  Engine (Step 4), **delete the 3 modals outright** (Step 5 collapses — FD-21 replaces them with
  orchestrator-led authoring), THEN delete PtySession + its banner-regex + file-watching.
  Keep `jsonl-tailer.ts` (base) + ReadyGate.
- **Step 7:** fold `dev-supervisor.mjs` + `spawnPackagedAgentHostProcess` into one Supervisor.
- **Ongoing cleanup:** "Dead/legacy" block (reattach path, sync-invoke type, agent_inbox post-stable,
  in-process branch after test-refactor). Catalog/web "drift" rows are already done — dropped.

---

## 5. Next action

Step 1 is **done in code** (§0). Supervisor (Step 7) **✅ shipped + live-verified 2026-06-04** —
scope: `supervisor-build-scope-2026-06-03.md`; as-built: `Sub-Systems/5-supervisor-ops/supervisor.md`.

> **Sequencing superseded (2026-06-03):** the full FD-1..22-reconciled build order now lives in
> **`rebuild-sequencing-2026-06-03.md`** — it absorbs §6's rows into two parallel tracks
> (Process / Model) + product surfaces. This ledger stays as the verdict record.

---

## 6. Phase-0 ordered plan (2026-06-03)

Each row independently shippable. Risky moves after prereqs. `✅` = code already landed.

| # | Concern | Action | Prereq | Guard | Risk |
|---|---------|--------|--------|-------|------|
| 1 | Step 1 close-out | ✅ code done; add guards + close rows | — | ONE-TERMINAL-AUTHORITY | low |
| 2 | Step 2 one reconciler | **✅ DONE 2026-06-03** — `agent-run-reconciler.ts`; boot = first tick; old path deleted; live acceptance green (scope: `step2-reconciler-scope-2026-06-03.md`) | 1 | ONE-RECONCILER + HOLD + PAUSED-SURVIVES ✅ | med |
| 3 | in-process fork DELETE | **✅ DONE 2026-06-03** (60ac149f, −288 lines; banned-resurrection gate; live green) | 2 + move null-host tests to host-fake | ONE-SPAWN-OWNER (partial) ✅ | low |
| 4 | Step 7 Supervisor | **✅ DONE 2026-06-04** — ONE RUNTIME: Electron main supervises api+host bundle-children both modes (e39fbcbc); ☠ dev-supervisor + startInProcessServer + one-shot host spawn; host shutdown-hang fixed (ec7159f4); live acceptance green dev AND packaged | — (parallel w/ 2) | ONE-SUPERVISOR ✅ | med |
| 5 | Step 3 Engine re-resolution | **✅ DONE 2026-06-04** — trace+refute found most of it already shipped (Step 2 HOLD + lock-rediscovery/hostId/lastSeq w/ tests); built the 2 real gaps: graceful `/events` end left the server silently deaf (now restarts via the S4 debounce; regression test) + a SECOND trunk-root hop-count in `claude-runtime-bundle.ts` broke EVERY dev agent dispatch since Step 7 (→ `server-root.ts`, the one derivation). Live: 2× mid-run host kills → respawn, auto-reconnect <10s, run `host-lost` ~30s + visible workflow fail + mailbox notify, next dispatch green; paused-gate survived respawn (FD-14); claude.exe dies with the host (ConPTY, no zombies). Deferred: host-lost resume → S5/FD-14 · JSONL backfill boot-only → M3 · pid-recycle accepted | 4 (need a respawn to test) | RECONNECT (host-connection suite) + ONE-ROOT ✅ | med |
| 6 | Step 4 orchestrator→Engine | **✅ DONE 2026-06-04** — Slices 0–3 all live-verified incl. packaged (scope: `step4-orchestrator-engine-scope-2026-06-04.md`); ☠ interactive-session.ts; FD-2 shared-HTTP adopted (Slice 0) | 5 | ONE-TOOL-TRANSPORT + banned `InteractiveSession` ✅ | high |
| 7 | ~~Step 5 modals→Engine~~ ☠ FD-21 | **✅ DELETED 2026-06-04** — S2 handoffs live-verified first (workflow/agent/setup all green through chat; scope: `s2-authoring-handoffs-scope-2026-06-04.md`), then the 3 modal paths + transient routes + draft store/tools + setup-wizard scaffold deleted outright; banned-resurrection set grew the transient names | 6 ✅ | banned-resurrection ✅ | med↓ |
| 8 | Step 6 converge primitive | **✅ DONE 2026-06-04** — ☠ pty-session.ts (PtySession, terminalBufferLooksReady banner-regex, watchFile pair, stripAnsi, SessionState) + TimedBracketedPasteQueue + dead AgentRun reattach field/lifecycle + registry.reattach(); JsonlReplayMeta/Source rehomed to jsonl-tailer; banned-resurrection grew the names. ONE primitive: LowLevelSpawn+AgentRun / ReadyGate / JsonlTailer / echo-ack. Live: chat e2e + worker dispatch green on the converged code | 6,7 ✅ | banned-resurrection (PtySession et al) ✅ | med↓ |
| 9 | agent-inbox tables DELETE | **✅ M4a 2026-06-04** — hook+repo+tables deleted (0041 archive); no refactor needed (writer-less since 017); + FD-8 defer-not-dead in the worker | mailbox-stable ✅ | NO-INBOX-WRITE ✅ | med |
| 10 | sync-invoke types DELETE | **✅ M5 2026-06-04** — `PcInvokeAgentResultSync` + `wait` + audit 'sync' branch deleted; banned-resurrection += the name | — | self-guarding (compile) ✅ | low |
| 11 | wi.body re-scope | **✅ M5 2026-06-04 — RE-SCOPED AGAIN, then EXECUTED**: refute showed `$root.output` is load-bearing for the BRIEF, not the result (0 live defs used `store: work_item_body`; 2 contracts ever). ☠ the work_item_body store → body = brief-only LAW; `$root.output` keeps reading body (now guaranteed-brief). Round-trip guard test FIRST (slice A), amended deliberately in slice B | — | $root.output round-trip ✅ + banned `work_item_body` | low |
| 12 | workflow events = truth | **✅ M3a 2026-06-04** — appendRunEvent door + DIARY-DOOR gate + tool + UI timeline; projection → M6 | slice 3 | DIARY-DOOR ✅ | high |

**ALL 12 ROWS CLOSED 2026-06-04** (rows 10–11 landed in M5 — scope:
`m5-work-contract-scope-2026-06-04.md`). (Rows 1–8 ✅ AND Step 8/P9
timeout-ladder ✅ 2026-06-04 — **the whole north-star process track, Steps 1–8, is CLOSED**.
P9: ☠ idle-kill + firstTurn watchdog + liveness-sweep; ladder in the reconciler; deliverable
nudge; live gauntlet green incl. marco-nudge + ask-resume + instant unexpected-exit.)
