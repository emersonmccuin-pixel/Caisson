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
| P9 ✅ | **Step 8 — FD-17 timeout ladder. DONE 2026-06-04.** Silence escalates, never executes: ☠ AgentRun idle-kill (5min) + firstTurn resume watchdog (90s, the S2 ask-killer) + the dead in-process liveness sweep (10min kill; dead code since P2). Ladder in THE reconciler: badge 3min (existed) → verify-alive + ONE `agent-stalled` orchestrator notify 5min (restart-proof idempotency). Event-driven deliverable-skip nudge: turn-end w/o deliverable → marked reminder into the run → 2nd strike ONE escalation (the marco class). Kills only wall-clock (workflow node `timeout` remapped idle→wallClock) or confirmed-dead (`unexpected-exit` ~2s, host-lost). Live: marco nudged→delivered ~10s · nudge steered a waiting agent into a clean `pc_ask_orchestrator` · answer→resume survived (no 90s kill) · mid-run claude.exe kill typed-failed instantly. Scope: `p9-timeout-ladder-scope-2026-06-04.md`. | Needs the one lifecycle (P8) so the ladder is built once. | FD-17 |

---

## Track M — Data model & store (parallel with Track P)

| Wave | Work | Why this order | FDs |
|---|---|---|---|
| M1 | **FD-3 — channel system demolition.** Delete the channel child, the `--dangerously-*` flag, auto-confirm regex, `channel-event` bypass, config filtering, `channel-send` route. | Pure deletion, no replacement needed (mailbox exists). De-risks every later spawn-path change; removes a whole claude-quirk surface. **Do early.** | FD-3 |
| M2 | **FD-12 — close the write-door bypasses + guard.** Two-step work-item writer → gateway form; structural no-bypass test. (`inbox-drain` raw SQL dies in M4.) | Cheap, independent; the guard prevents new debt while everything else moves. | FD-12 |
| M3 | **FD-13 — run diary becomes truth.** **M3a ✅ DONE 2026-06-04** (scope: `m3a-run-diary-scope-2026-06-04.md`): ONE diary door (`appendRunEvent` = event row + `workflow.run.event` outbox fact, one txn; DIARY-DOOR gate), lifecycle bookends written (started/cancelled/interrupted) + `agent_dispatched` cross-link (agentRunId in the diary), `pc_get_workflow_run` (52nd tool, on-demand) + UI Run-diary timeline, JSONL backfill any-tick (the Step-3 refute gap closed). Live: 12-line reject-loop story + tool over the signed MCP wire. **Remaining:** state projection from events → **M6** (deliberate — build step-model-v3 semantics on the spine once) · **M3b ✅ DONE 2026-06-04** (scope: `m3b-chat-replay-db-scope-2026-06-04.md`): chat replay = a `conversation_events` query — ONE writer (`OrchestratorHostSession` → DB row per wire event; G7 dedup floor from a query) · `DbTranscriptRepository` behind the slice-006 seam (byte-identical shapes) · ☠ `session-replay.ts` + `FileTranscriptRepository` (parser lives ONLY in the boot backfill) · boot import: 21,271 events / 313 sessions, 664 files renamed `*.imported`, sweep self-extinguishes · live: history + afterSeq served from DB, fresh chat round-trip persisted + replayed ("kumquat") · finding: NO cancel-run affordance exists (gateway.cancelRun caller-less; M6/FD-7 era — closed in M6-C). | The store spine for FD-11; build the new engine semantics on it ONCE (don't retrofit). | FD-13, FD-11 |
| M4 | **FD-8 — no message silently dies. M4a ✅ DONE 2026-06-04.** ☠ inbox-drain.cjs + repos/agent-inbox.ts + `agent_inbox`/`agent_delivery_audit` (migration 0041 archive — the tables were writer-less since 017; the hook drained an empty set every prompt). **FD-12 bypass #3 EXECUTED — all three done.** Worker: orchestrator-away → DEFER (parked, zero attempts, 60s recheck — was: dead-letter on FIRST pass; 93 live dead letters found, incl. every workflow worker's terminal envelope to its synthetic wf-* dispatcher id); pinned-but-nonexistent session → honest non-retryable dead-letter. deliverAgentEnvelope dispatcher-aware: synthetic-dispatcher asks → active-orchestrator fallback; synthetic terminal notices → skipped (engine+diary+run-failed own the signal). NO-INBOX-WRITE gate. **M4b ✅ DONE 2026-06-04** (scope: `m4b-lifecycle-failsafes-scope-2026-06-04.md`) — **FD-8 CLOSED.** Refute reshaped all three: ☠ `expires_at` deleted whole (migration 0046 — dead column, one NULL-writing site, zero readers; expiry CONTRADICTS FD-8) · dead letters mint a user-inbox `system-notice` card in the same tx (notice-not-requeue; recursion structurally impossible) · stale-ask watchdog (open ask >15min → ONE actionable `agent-ask-escalated` card w/ option buttons + free-text answer through the EXISTING doors; decided-anywhere clears it, resolve-by-source on ('agent', askId); FD-17 complement — the ladder deliberately excludes paused runs). A unified lifecycle state machine was REFUTED (would be a pending_interactions-style shadow of two truths). | Needs mailbox-stable; prereq for FD-6 (all asks ride the mailbox). | FD-8, FD-12 |
| M5 | **FD-5 — Work Contract migration. ✅ DONE 2026-06-04** (scope: `m5-work-contract-scope-2026-06-04.md`). Refute reshaped it: `expected_output` was ALREADY contract-authoritative (pod column survives as documented DEFAULT — FD-5 amendment, Emerson confirmed) · `output_destination` was a DEAD KNOB, zero runtime consumers → DELETED whole, not moved (migration 0042 — FD-5 amendment) · ☠ `store: work_item_body` → **body = brief-only LAW** (0 live defs used it; `$root.output` = the brief, its documented meaning; round-trip guard FIRST, amended deliberately in the same pass) · FD-5 **addendum delivered**: `pc_get_contract` (agent reads its own AC mid-run; + derive-AC-at-mint fix — the dispatch door minted AC-null contracts) + `pc_list_attachments`/`pc_get_attachment` (dispatch-payload audit 🔴 closed), all three in REQUIRED_AGENT_TOOLS (55 tools) · ledger rows 10 (sync-invoke) + 11 (wi.body) closed. Live-fire: agent read contract+AC, fetched the secret-word attachment, delivered, verification passed. | Guard before move — held. FD-9 refs + FD-20 UNBLOCKED. | FD-5 |
| M6 | **FD-9 + FD-10 + FD-11 — workflow step model v3. ✅ DONE 2026-06-04** (scope: `m6-step-model-scope-2026-06-04.md`; 4 slices, each live-verified). **A:** triggers DELETED whole (def `triggers` key rejected at save; ☠ dag/triggers.ts + moveAndFireV2 firing half + run trigger columns, migration 0043; fire route + `pc_fire_workflow` gained `workItemId` — run ON a card). **B:** FOUR drawn step kinds — NEW `move` (failed move fails the step) + NEW `loop` (review reject target; back_to/ceiling/carry; iteration-badged); ☠ move-as-property ×3 + RejectEdge + RetryPolicy (dead schema); boot def-migration rewrote stored defs (9 v1-era corpses honestly flipped invalid). **C:** ceiling PAUSES as escalated-human gate (☠ holdForHuman no-op) · cancel wired end-to-end w/ child-agent cascade (route/button/`pc_cancel_workflow_run`/soft-delete reroute; live-caught status-stomp race fixed at the write door) · resume-from-failed-step re-freezes the CURRENT def, compat-checked (`pc_resume_workflow_run` — the FD-11 repair loop, live-proven incl. interrupt→resume). **D:** ☠ v1 domain modules whole + contract `attempt`/`issued_by` (migration 0044) · spec-less ad-hoc dispatch consults pod/stock default chain · FD-13 GUARD: diary replay ≡ dagState (`deriveDagStateFromDiary` + guard tests). `$root.brief` rename deferred (cosmetic; scope doc). 57 tools. | The engine rebuild proper — delivered on the M3 diary + M5 contract spine. | FD-9, FD-10, FD-11 |
| M7 | **FD-6 — one ask door. ✅ DONE 2026-06-04** (scope: `m7-ask-door-scope-2026-06-04.md`). ☠ `pc_ask_user` deleted whole (registry/tier/handler/route — `kind:'user'` typed-400 · `PendingAskKind`/event kinds/wire types narrowed · web rendering · 4 banned names); the two ask paths were ALREADY one machinery (same route/pause/answer/table) — the delete removed a label, not a pipe. `pc_ask_orchestrator` = THE door, **inherited multi-choice `options`**; prompts re-aimed (workers: "if only the human can decide, say so"; orchestrator: answer-or-relay triage). **Baseline-tools audit done: required set 7→6.** Boot sweep `agent-tools-scrub.ts` scrubs stored dead grants (stock reseed can't reach project copies/custom pods; audit reason avoids the system-reseed prefix so the user-edit drift-lock survives). AC derivation broadened to the surviving ask doors. Golden 57→56. Live: one-door ask w/ options → pause → answer accepted → respawn — **and the gauntlet CAUGHT a pre-existing resume bug (2/2): the answer send was eaten by the `--resume` replay repaint + the pre-pause process never exits (two claude.exe on one session). FIXED same session (cd92e784: kill pre-pause spawn · quiet-gated send · positive JSONL receipt w/ bounded re-sends → typed failure; 5 tests). Third fire end-to-end GREEN: ask→answer→resume→deliverable→completed, zero zombies.** | Needs M4 (lifecycle watchdog catches unanswered asks). | FD-6 |
| M8 | **FD-7 — Human Inbox workstream. ✅ DONE 2026-06-04** (scope: `m8-human-inbox-scope-2026-06-04.md`; 4 slices). **Trace verdict: pre-M8 EVERY formal human decision was invisible** (`requestReview` delivered only orchestrator flavor; the human-review tier promised an inbox that didn't exist; loop re-reviews dedupe-vanished — latent FD-8 bug). **A:** ☠ `pending_interactions` + AskShadow + PendingInteractionService + `pending-interaction.changed` + the never-set `interactionId` link (migration 0045 archive) — the ONE pending table is `pending_asks` (ask-state); **the mailbox `user-inbox` channel is THE durable Human Inbox** · ☠ v1 web approval corpse (ApprovalBubble → a route that never existed) · `actionable` = decision kinds (`ACTIONABLE_MAILBOX_KINDS`), was the always-empty interactionId set. **B:** every review flavor delivers (human/ceiling-escalated → user-inbox card w/ review-package payload; iteration-keyed idempotency so loop re-reviews deliver AGAIN); NEW `verification-review` kind from the terminal tail; decided-through-ANY-door actions the cards (resolve-by-source, snapshot-before-decide so the escalation card survives). **C:** Inbox decision cards (Approve / Reject-with-required-feedback on the existing doors) + cross-project **Inbox bell** (`GET /api/inbox`, actionable badge, project chips; live via all-projects signature over the Q12 background sockets); inbox-card verification rejects inherit the parent run's dispatcher. **Live gauntlet:** human gate→card→reject→i0 actioned + i1 card + `$carry.feedback` flowed→approve→completed · ceiling→escalated card→approve · human-review tier→card→approve→WI auto-advanced to done · the gauntlet CAUGHT the registry not forwarding the resolution seam (fixed live). | The last big M piece — DONE. Track M remainder: M3b · M4b. | FD-7, FD-8 |

---

## Track S — Product surfaces (slot in when unblocked)

| Item | Needs | FDs |
|---|---|---|
| S1 **Areas first-class** — rename page, cards→modal, descriptions, orchestrator assigns + maintains | nothing — **ready now** | FD-19 |
| S2 ✅ **Authoring handoffs — DONE 2026-06-04** (lean per Emerson: banner + Open-chat link, NO prefill; manual paths stay incl. new disabled-skeleton workflow create). Orchestrator interviews + dispatches the reshaped worker pods; all three flows live-verified. Scope: `s2-authoring-handoffs-scope-2026-06-04.md` | — | FD-21, FD-11 (expert builder) |
| S3 **FD-22 version pin** — exact preflight check, pinned installer, auto-updater off for spawned sessions, warn-not-wall | nothing — **ready now**, small | FD-22 |
| S4 ✅ **FD-15 concurrency setting** shipped 2026-06-03 (87b33b27: live `set-config` push, Settings field, `/health` receipt) + **FD-16 two-tier tools** shipped 2026-06-03 (tier map + `pc_find_tool`/`pc_call_tool` door, on-demand-only dispatch, audited; orchestrator+caisson granted live) | nothing — small | FD-15, FD-16 |
| S5 ✅ **FD-14 "resume interrupted job" — DONE 2026-06-04** (0b6c5f0c): `workflow-run-failed` card is ACTIONABLE (Resume button → existing resume route); resumed-through-ANY-door clears by-source; FD-8 fix — failure notice idempotency is INCIDENT-keyed (fail→resume→fail-again mints a fresh card; was silently dropped). Live gauntlet green. Ad-hoc runs: orchestrator owns recovery (`pc_continue_agent` + failure notice) — deliberately NO second human door. | — | FD-14 |
| S6 ✅ **FD-18 loading states — DONE 2026-06-04**: orchestrator surface already shipped with P6 (start/restart banner + queue-until-ready composer); agent views closed the gap — transcript modal + dispatch bubbles say "Claude is loading…"/"Claude is working…" (pulse) pre-output instead of "No transcript events yet". | — | FD-18 |
| S7 **FD-20 Patterns** — design pass, then build | M5 (contract = job spec) + S1 (areas) + dispatch-payload audit verdict | FD-20 |
| S8 ✅/parked 2026-06-04: **Rails fix DONE** (disabled separators — no drag affordance/collapse) · **legacy chat render path DELETED** (canonical is THE path; `caisson.chat.jsonlCanonical` flag + DevControls `canon` toggle gone, banned-resurrection) · **post-turn-summary read surface PARKED w/ finding**: table has ZERO rows — CC's emitter is gated internally (`tengu_slate_prism` + SDK `agentProgressSummaries` opt-in, print/SDK mode); PC's interactive `--agent` sessions never emit it. Writer+tailer stay; build the read surface only when rows exist. | — | — |

**Audits (anytime, read-only):** dispatch-payload (✅ done) · knowledge-usage · agent-management toolkit · baseline tools (✅ done with M7 — required set is 6; roster audit still open).

---

## The near-term picture (what actually happens next)

**TRACK P COMPLETE — Steps 1–8 ALL CLOSED (P9 shipped 2026-06-04).** Authoring flows through
the orchestrator chat; the modal subsystem is gone; the session primitive is ONE
(LowLevelSpawn+AgentRun / ReadyGate / JsonlTailer / echo-ack); silence escalates instead of
executing (FD-17 ladder; the ask-trips-watchdog + deliverable-skip findings both closed).
Next candidates, parallel-safe: M3 diary-as-truth · M4 mailbox/agent_inbox drop · sync-invoke
DELETE + wi.body re-scope · FD-20 Patterns design pass.

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
