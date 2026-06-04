# Rebuild Sequencing — FD-1..22 → one build order

**Date:** 2026-06-03
**Status:** working plan (supersedes ledger §5 "next action"; ledger §6 rows fold in here)
**Inputs:** `unified-process-supervision-2026-06-02.md` (Steps 1–8) ·
`consolidation-ledger-2026-06-02.md` (§6 Phase-0 rows) · `Sub-Systems/_Foundation-Decisions.md` (FD-1..22)
**Rule:** fix the live issue on the one path, migrate slowly, no big bang. Every wave independently shippable.

---

## How to read this

Two tracks run in parallel — they touch different code:

- **Track P (Process):** who owns processes, who decides "done." The north-star Steps.
- **Track M (Model):** what the data means — contracts, step model, store split, ask doors.

Product surface work (Track S) hangs off whichever track unblocks it.

---

## Status snapshot (what's already true)

| Done | Evidence |
|---|---|
| Step 1 — one terminal authority + run-keyed waiter (the stall fix) | commits `0022872d`, `40c2a91f`; live acceptance green |
| Workflow v2 cuts: bash/script steps deleted, deliverable = done, unified review | `refactor/auto-pathway` branch |
| Step 7 Supervisor — ✅ SHIPPED + live-verified dev AND packaged 2026-06-04 | commits `e39fbcbc` `ec7159f4` `43f03b16`; scope doc + `Sub-Systems/5-supervisor-ops/supervisor.md` |
| Dispatch-payload audit — **running** | background agent, 2026-06-03 |

---

## Track P — Process ownership (north-star Steps, FD-amended)

| Wave | Work | Why this order | FDs |
|---|---|---|---|
| P1 ✅ | **Step 2 — one reconciler, all states. DONE 2026-06-03.** `agent-run-reconciler.ts`; boot = first tick; legacy bulk-fail + boot-reconcile path DELETED; HOLD structural; paused-survives = law (guard-tested); live acceptance green. Scope: `step2-reconciler-scope-2026-06-03.md`. | Everything later assumes one loop. FD-14's "paused always survives" lands here as law. | FD-14 |
| P2 ✅ | **In-process fork DELETE. DONE 2026-06-03** (60ac149f, −288 lines). `constructAndStart` + `defaultAgentRunFactory` + `activeRunHandleForAgentRun` deleted; no hostClient = typed `host-unavailable`; banned-resurrection gate covers the three names. Test prereq was already satisfied (all factory tests host-fake). Live acceptance green. ⚠ Landing surfaced the Bash-git worktree-escape (🔴 in FD backlog). | Dead in prod; needs P1 + null-host tests moved to a host fake. | FD-12 (one spawn path) |
| P3 ✅ | **Step 7 — Supervisor. DONE 2026-06-04** (e39fbcbc). ONE RUNTIME: Electron main supervises api+host children (bundles) in dev AND packaged; ☠ dev-supervisor.mjs + startInProcessServer + one-shot host spawn; ONE-SUPERVISOR gate; host shutdown-never-exits fixed (ec7159f4); FD-15 receipt validator gap found+fixed live (43f03b16). Acceptance green both modes. | Independent; fixes packaged-host-never-respawns. | — |
| P4 ✅ | **Step 3 — Engine re-resolution + reattach. DONE 2026-06-04.** Mostly already shipped (Step 2 HOLD + `HostConnection` rediscovery); closed the 2 real gaps: graceful `/events` end = silent deafness (now restarts; test) + dup trunk-root hop-count broke every dev dispatch since Step 7 (→ `server-root.ts` + ONE-ROOT gate). Live: 2× mid-run host kills → auto-reconnect <10s, `host-lost` ~30s, visible fail + mailbox notify, next dispatch green; paused gate survived respawn; no claude.exe zombies (ConPTY). | Needs P3 (a respawn to test against). Hard prereq for P6. | — |
| P5 ✅ | **FD-2 spike — shared HTTP tools server. PASSED 6/6, 2026-06-03.** Shared-HTTP WINS: identity via per-session mcp.json headers (`extra.requestInfo`) · turn-1 race gone (`deferred_tools_delta`) · concurrency clean · restart recovery ~5s via 404/-32001. Harness `labs/fd2-shared-http-mcp/` (re-run on every FD-22 version bump). Adoption rides P6. Bonus: caught + fixed the `encodeCwdForClaude` dot-divergence stall bug. | MUST land before P6: if shared-HTTP wins, Engine sessions spawn without per-session messengers — deciding after the orchestrator migration means migrating twice. | FD-2 |
| P6 ✅ | **Step 4 — orchestrator → Engine. DONE 2026-06-04.** Slices 0–3 live-verified incl. packaged: FD-2 shared-HTTP adopted (Slice 0) · persistent-interactive policy (Slice 1) · THE SWAP, ☠ interactive-session.ts (Slice 2) · interrupt/alongside/sessions/packaged gauntlet + interrupt-wedge fix (Slice 3). Scope: `step4-orchestrator-engine-scope-2026-06-04.md`. | Needs P4. | FD-2, FD-18 |
| P7 ✅ | **Modals DELETE. DONE 2026-06-04** (with S2 same day — handoffs live-verified FIRST: workflow/agent/setup all green through chat). Deleted: 3 modal paths web+server, transient routes, ProjectRuntime transient block, draft store + `pc_save/read_workflow_draft` (53→51 tools), setup-wizard scaffold+template. Banned-resurrection set grew the names. Scope: `s2-authoring-handoffs-scope-2026-06-04.md`. | Deletion, not migration. | FD-21 |
| P8 ✅ | **Step 6 — converge the primitive. DONE 2026-06-04.** ☠ pty-session.ts whole (PtySession · `terminalBufferLooksReady` banner-regex · stop-marker/events `watchFile` pair · stripAnsi · SessionState) + `TimedBracketedPasteQueue` + dead `AgentRun.reattach` field/lifecycle + `registry.reattach()`. `JsonlReplayMeta`/`Source` rehomed to jsonl-tailer. ONE primitive: LowLevelSpawn+AgentRun · ReadyGate · JsonlTailer · echo-ack. Banned-resurrection grew the names. Live: chat e2e + worker dispatch completed on the converged code. (Bisect note: a smoke "stall" turned out to be the model skipping `pc_submit_deliverable` on a degenerate one-word task — pre-existing compliance edge, logged in FD backlog, NOT a regression.) | Needs P6 + P7 ✅. | FD-12 |
| P9 | **Step 8 — retire inference; FD-17 timeout ladder.** Idle-kill dies; silence escalates (badge → verify-alive → notify orchestrator → kill only on wall-clock/confirmed-dead). | Needs the one lifecycle (P8) so the ladder is built once. | FD-17 |

---

## Track M — Data model & store (parallel with Track P)

| Wave | Work | Why this order | FDs |
|---|---|---|---|
| M1 | **FD-3 — channel system demolition.** Delete the channel child, the `--dangerously-*` flag, auto-confirm regex, `channel-event` bypass, config filtering, `channel-send` route. | Pure deletion, no replacement needed (mailbox exists). De-risks every later spawn-path change; removes a whole claude-quirk surface. **Do early.** | FD-3 |
| M2 | **FD-12 — close the write-door bypasses + guard.** Two-step work-item writer → gateway form; structural no-bypass test. (`inbox-drain` raw SQL dies in M4.) | Cheap, independent; the guard prevents new debt while everything else moves. | FD-12 |
| M3 | **FD-13 — run diary becomes truth (slice-3).** `workflow_run_events` through gateway + `live_outbox`; run state projected from events; chat replay moves file → DB query. Decide in-flight-run cutover here. Also absorb the Step-3 refute gap: JSONL backfill is boot-only — events an Engine emitted before dying mid-session never reach the UI (run still settles; context invisible). | The store spine for FD-11; build the new engine semantics on it ONCE (don't retrofit). | FD-13, FD-11 |
| M4 | **FD-8 — mailbox lifecycle + dead-letter sweep.** sent → delivered → expecting-response → done; watchdog; re-delivery on orchestrator return. Refactor `inbox-drain.cjs` → mailbox; **drop `agent_inbox` tables** (ledger row 9). | Needs mailbox-stable; prereq for FD-6 (all asks ride the mailbox). | FD-8, FD-12 |
| M5 | **FD-5 — Work Contract migration.** Round-trip guard test FIRST (`$root.output` coupling), then: `expected_output`/`output_destination` off the pod → contract; deliverable result → contract; `body` back to brief-only. | Guard before move — the coupling is load-bearing. Prereq for FD-9 refs + FD-20. | FD-5 |
| M6 | **FD-9 + FD-10 — workflow step model v3.** Steps = Agent · Review · Move card · Loop (retry ceiling → Human Inbox); move-as-property dies; stage-entry triggers deleted. Built on the M3 diary. | The engine rebuild proper. Needs M3 (diary) + M5 (contract refs). | FD-9, FD-10, FD-11 |
| M7 | **FD-6 — one ask door.** `pc_ask_user` dies; agents ask the orchestrator via mailbox; exchanges visible in chat + kind-tag filter (FD-3 tagging requirement). Baseline-tools audit lands here. | Needs M4 (lifecycle watchdog catches unanswered asks). | FD-6 |
| M8 | **FD-7 — Human Inbox workstream.** Review packages, one approve/reject flow, global notifications; pick ONE pending table (absorbs AskShadow data); loop-ceiling hand-offs (FD-9) land here. | Needs M6 (loop ceiling) + M7 (ask routing). The last big piece. | FD-7 |

---

## Track S — Product surfaces (slot in when unblocked)

| Item | Needs | FDs |
|---|---|---|
| S1 **Areas first-class** — rename page, cards→modal, descriptions, orchestrator assigns + maintains | nothing — **ready now** | FD-19 |
| S2 ✅ **Authoring handoffs — DONE 2026-06-04** (lean per Emerson: banner + Open-chat link, NO prefill; manual paths stay incl. new disabled-skeleton workflow create). Orchestrator interviews + dispatches the reshaped worker pods; all three flows live-verified. Scope: `s2-authoring-handoffs-scope-2026-06-04.md` | — | FD-21, FD-11 (expert builder) |
| S3 **FD-22 version pin** — exact preflight check, pinned installer, auto-updater off for spawned sessions, warn-not-wall | nothing — **ready now**, small | FD-22 |
| S4 ✅ **FD-15 concurrency setting** shipped 2026-06-03 (87b33b27: live `set-config` push, Settings field, `/health` receipt) + **FD-16 two-tier tools** shipped 2026-06-03 (tier map + `pc_find_tool`/`pc_call_tool` door, on-demand-only dispatch, audited; orchestrator+caisson granted live) | nothing — small | FD-15, FD-16 |
| S5 **FD-14 "resume interrupted job"** affordance — incl. runs finalized `host-lost` (Step-3 refute: today they dead-end with no re-dispatch path) | P1 (one loop knows what's resumable) | FD-14 |
| S6 **FD-18 loading states** on agent views | mechanism exists; orchestrator surface rides P6 | FD-18 |
| S7 **FD-20 Patterns** — design pass, then build | M5 (contract = job spec) + S1 (areas) + dispatch-payload audit verdict | FD-20 |
| S8 Rails fixed-width fix · post-turn-summary read surface · legacy chat render path delete | nothing — small, anytime | — |

**Audits (anytime, read-only):** dispatch-payload (**running**) · knowledge-usage · agent-management toolkit · baseline tools (with M7).

---

## The near-term picture (what actually happens next)

**P6 ✅ + S2 ✅ + P7 ✅ + P8 ✅ all closed 2026-06-04.** Authoring flows through the orchestrator
chat; the modal subsystem is gone; the session primitive is ONE (LowLevelSpawn+AgentRun /
ReadyGate / JsonlTailer / echo-ack). **Track P remainder: P9 only** (Step 8 — FD-17 timeout
ladder; the ask-trips-watchdog + deliverable-skip findings both land there). Next candidates,
parallel-safe: M3 diary-as-truth · M4 mailbox/agent_inbox drop · sync-invoke DELETE · FD-20
Patterns design pass · P9.

Next up, parallel-safe, in value order:

1. ~~**M1 — FD-3 channel demolition**~~ ✅ shipped 2026-06-03 (14715cc8)
2. ~~**P1 — Step 2 one reconciler**~~ ✅ shipped 2026-06-03 (live acceptance green)
3. ~~**S1 — Areas** + **S3 — version pin**~~ ✅ shipped 2026-06-03 (52a3723f, bf9615db)
4. ~~**P5 — FD-2 spike**~~ ✅ PASSED 6/6 2026-06-03 — shared HTTP tools server wins; adoption rides P6
5. ~~**M2 — write-door guard**~~ ✅ shipped 2026-06-03 (1f57f560) — ONE gateway txn everywhere + structural import gate
6. ~~**P2 — in-process fork delete**~~ ✅ shipped 2026-06-03 (60ac149f) — host owns every spawn; typed failure when unwired

Gate check before each wave: does the live system still pass the acceptance loop
(synthetic-stall-check → card flow → human gate → completed)?

---

## What changed vs. the ledger's Phase-0 plan

- Row 7 "Step 5 modals→Engine" → **delete** (FD-21); needs S2 first.
- Rows 11–12 absorbed into M3/M5 with FD-5/FD-13 as the deciders.
- FD-2 spike inserted as a hard gate before Step 4 (was unscheduled).
- FD-3 demolition promoted to first M-wave (was implicit in "rebuild").
