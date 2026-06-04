# M6 — step model v3: Agent · Review · Move card · Loop (scope) — 2026-06-04

> **Progress:** Slice A ✅ SHIPPED + LIVE (80a09a3b — fire→deliver→gate→approve→completed through
> the trigger-less door; migration 0043 + boot def-sweep verified on the dev DB). Slice B ✅
> SHIPPED + LIVE (b2fdd67f — four kinds; live reject→loop→feedback-carried→approve gauntlet).
> Slice C ✅ SHIPPED (e6a24583 + race fix c7acfc28) — live proofs: cancel cascade (run cancelled +
> child worker cancelled + diary line; **live-caught race**: a cancel landing mid-layer used to be
> stomped to `failed` by the executor's persist — fixed at the write door + finalize) ·
> interrupt→resume (run_interrupted → run_resumed → completed, the FD-11 repair loop on a real
> boot-fail-closed run) · ceiling-pause (below). Migration note: the def-sweep honestly flipped 9
> v1-era corpse defs (bash/move-work-item kinds, dead since the first-principles redesign) from
> "active"-but-unrunnable to `invalid` — visible truth, not a regression.

Sequencing row M6 (FD-9 + FD-10 + FD-11 req 2+3). Prereqs ✅: M3a (diary spine) + M5 (contract
refs). M7 (ask door) and M8 (Human Inbox) build on this pass's loop-ceiling/review semantics.

## Trace (what the engine actually is today)

**Node kinds = 2.** `agent` + `review` only (workflow-v2.ts:31-35); executor hard-fails any other
kind in a run layer (dag-executor.ts:211). All v1 kinds (bash/script/approval/loop/http/…) are
dead types in workflow.ts — zero imports anywhere (refute-verified).

**Move = a property, three trigger points.** `WorkflowNodeBase.move` (workflow-v2.ts:161) fires
after agent completion (dag-executor.ts:234-241) and review approve (:304-311);
`reject.move` (:127) fires on kick-back (:317-324). Impl = dag-run-service.ts:357-375 via the M2
gateway (FD-12 clean). Save-time stage-collision check + `allow_stage_workflow_skip` opt-out
(validate.ts:237-262) exist only to keep moves from re-firing stage-entry triggers.

**Loop = already half-built, as the reject back-edge.** `ReviewNode.reject {back_to,
max_iterations default 3, carry, move}` (workflow-v2.ts:116-128). Reject bumps
`rejectIterations`, resets the loop subtree to pending, stashes feedback (step.ts:202-253) —
mechanically sound and live-proven (M3a's 12-line reject-loop story). **At ceiling:
`holdForHuman` is a NO-OP STUB** (dag-executor.ts:459) — the review node just fails the run.
"Sends to the Human Inbox" exists nowhere.

**Stage-entry triggers = one code path.** `selectStageEntryWorkflows` (triggers.ts:25-59) called
only from `ProjectRuntime.moveAndFireV2` (project-runtime.ts:341-365). Run rows record
`trigger/stage_id/trigger_context` (schema.ts:322-325). UI: trigger filter + labels in
WorkflowsList.tsx.

**Run lifecycle.** Statuses pending/running/paused/completed/failed/cancelled
(workflow-v2.ts:245-252). Resume exists ONLY for review-paused runs (`applyV2ReviewDecision`,
dag-run-service.ts:565-601, re-parses the frozen `workflowYamlSnapshot`). **Failed runs are
terminal forever** — no restart-at-step, no repair loop (FD-11 req 2+3 unbuilt). Boot fail-close
marks pending/running → failed `interrupted-on-boot` + `run_interrupted` diary line (M3a).

**Defs are frozen per run.** Snapshot at fire (dag-run-service.ts:526); edits never touch
in-flight runs; soft-delete blocked while runs in flight unless `?cancel=1`.

**Live data (dev DB, 2026-06-04):** 64 defs, overwhelmingly smoke/matrix debris. stage-on-entry
on 9 (incl. `build`, `ahead-pipeline`, `auto-research`); schedule/event on 2 matrix tests;
`move` property on ~14 (all test defs); reject back-edges on ~10. Runs: 32 completed + 16
failed, ZERO in-flight.

## Refute corrections (what the trace got wrong / what nobody knew)

1. **🔴 NEW FD-12 BYPASS FOUND: workflow soft-delete `?cancel=1`** (index.ts:911-927) writes
   `cancelled` via `writeRunStatus` directly — skips `gateway.cancelRun`, so NO
   `workflow_cancelled` diary line. The gateway's cancelRun (run-gateway.ts:245-262) remains
   caller-less in production. Fix rides slice C.
2. **`RetryPolicy` is dead schema, not "defined but unwired."** `{max_attempts, on, delay_ms}`
   validated at save, referenced by the workflow-builder prompt — the executor implements NONE
   of it. Authors can write a retry that silently never happens (positive-receipt violation).
   → DELETE (FD-9's Loop is the one retry construct).
3. **`schedule` + `event` trigger kinds are vapor.** Accepted by validation, zero runtime
   machinery. Validation accepting what the runtime can't do = a lie at the save door. → DELETE
   with FD-10 (automation returns deliberately later, orchestrator-driven, per FD-10's own text).
4. **`isCancelled` is a defensive poll, not fully dead** — dag-run-service.ts:450 re-reads run
   status from the DB; it fires only if something else wrote `cancelled` mid-advance (today:
   only soft-delete). Wiring cancel (slice C) makes it real; keep it.
5. **v1 module `workflow.ts` + v1 `WorkflowRunStatus` ('in-progress'/'complete')**: zero
   importers. Pure legacy. → DELETE whole in slice D.

## Design

### Slice A — FD-10: triggers die (pure deletion, first — shrinks everything after)
- ☠ Definition-level `triggers` array DIES WHOLE (manual fire needs no declaration;
  `pc_fire_workflow` + Run-now are the two doors, both already trigger-free).
- ☠ `StageOnEntryTrigger`/`ScheduleTrigger`/`EventTrigger` types · `triggers.ts`
  (selectStageEntryWorkflows/firesOnStageEntry/isForwardStageMove) · the firing loop in
  `moveAndFireV2` (the move half stays — it's the one card-move door) · trigger validation
  (validate.ts:220-235) · stage-collision check + `allow_stage_workflow_skip` (:237-262 — its
  only reason to exist was stage-entry re-fire protection) · `also_fire_on_regression` ·
  WorkflowsList trigger filter/labels · workflow-builder prompt trigger docs.
- Run rows: `trigger` column becomes provenance-only `'manual'` (orchestrator fire IS manual-kind
  today); `stage_id` dies; `trigger_context` keeps the optional root work item. `$trigger.*`
  refs: keep `$trigger.work_item` semantics via fire-time `workItemId` param (already exists).
- Data migration: strip `triggers` from all 64 stored defs (yaml + parsed_definition rewrite,
  one script, 0042-style precedent). Banned names += the trigger fns.

### Slice B — FD-9: the four-kind vocabulary
- **NEW node kind `move`** `{kind:'move', stage}` — the only way a workflow moves the card,
  drawn in the graph. Executor: instant effect node (gateway moveCard + `card_moved` diary line
  + complete). ☠ `WorkflowNodeBase.move` + `reject.move` (on-reject move-back dies per FD-9 —
  card moves only on the forward path).
- **NEW node kind `loop`** — FD-9 says four VISIBLE step kinds; the reject edge's mechanics are
  proven, so the loop node OWNS them: `{kind:'loop', back_to, max_iterations default 3, carry}`.
  Review's `reject` field becomes a plain edge: `reject: <nodeId>` pointing at a loop node (or,
  for no-loop reviews, omitted = reject fails the node as today). Decision routing: reject →
  loop node evaluates: under ceiling → reset subtree from `back_to` (existing step.ts machinery,
  rehomed); at ceiling → **slice C behavior**. Graph shows: review —reject→ [Loop ×3] —→ agent.
- ☠ `RetryPolicy` whole (types + validation + prompt docs).
- Validator: NODE_KINDS → 4; loop rules (back_to upstream-only, must be reject-target of
  exactly one review); move rules (stage exists — feasibility check already does this).
- Surfaces in lockstep: validate.ts · workflow-v2.ts · serialize-v2 key order ·
  workflow-routes normaliseDef/feasibility · workflow-builder pod prompt (the FD-11 req-4
  "expert builder" doc rides here) · web visual editor node rendering + YAML tab docs ·
  pc_publish_workflow description.
- Data migration (same script as A or chained): `node.move` → insert `move` node after it on
  `next`; `reject{back_to,…}` → mint loop node; drop `reject.move`/`retry`. All flagged defs
  are test debris (live-data trace) — mechanical rewrite, invalid-after-migration defs flip to
  `status:'invalid'` honestly rather than silently limping.

### Slice C — FD-11 req 2+3: ceiling → human · cancel wired · restart-at-step
- **Ceiling-hit = PAUSE, not fail.** Loop node at ceiling → run pauses as a human gate (existing
  pending-review machinery, reviewer:'human', bundle = loop context: iterations + last feedback
  + agent output) + mailbox notify. M8 re-homes the surface; the semantics land here. ☠ the
  holdForHuman no-op seam — replaced by the real pause. (Plain-English: a workflow that keeps
  failing review now STOPS AND WAITS for Emerson instead of dying.)
- **Cancel a run, for real:** route `POST /api/projects/:pid/workflow-v2/runs/:runId/cancel` →
  `gateway.cancelRun` (diary + fact, exists) + cancel in-flight child agent runs via the
  registry cancel path (P9 cancel-grace) · Cancel button on the run row · on-demand tier tool
  `pc_cancel_workflow_run`. Soft-delete `?cancel=1` reroutes through the gateway (kills refute
  bug 1). isCancelled poll now has a real setter.
- **Restart-at-step (the repair loop):** route + on-demand tool `pc_resume_workflow_run`
  (failed runs only): reset failed/downstream nodes to pending (settled work KEPT — dagState +
  child WIs survive), **re-freeze the CURRENT def as the new snapshot** after a compatibility
  check (every settled node id must still exist with same kind; incompatible → typed refusal
  naming the missing node), status failed→running, diary `run_resumed {fromNode, defChanged}`,
  re-advance. This IS FD-11 req 3: broken run → edit the def → resume from the failed step →
  green = locked in. Resolves the editing-def-vs-in-flight-runs open Q: edits NEVER touch live
  runs except this one explicit door.
- Boot fail-close: interrupted runs land `failed` → now resumable via the same door ("resume
  interrupted job" = FD-14's button, workflow flavor).

### Slice D — riding cleanups ✅ DELIVERED (as amended)
- ✅ ☠ v1 domain modules WHOLE: `workflow.ts` + `workflow-run.ts` + `workflow-edges.ts` (zero
  importers, refute 5 + slice-D trace).
- ✅ ☠ contract dead fields `attempt`/`issuedBy` (M5 finding): migration 0044, DTO + repo + the
  never-true UI badge.
- ✅ Ad-hoc `pc_invoke_agent` w/o expected_output: contract mint consults pod row → stock default
  (same precedence as templated dispatch; deps-seamed; defaulted repo specs inherit worktree
  isolation — the 2026-06-03 wrong-directory class).
- ⚪ `$root.output` → `$root.brief` rename **DEFERRED (slice-D amendment, decided in-pass):** two
  ref grammars (refs.ts + when.ts atoms) + 3 prompt surfaces + registry descriptions + ANOTHER
  live-defs migration, for a purely cosmetic gain — the SEMANTIC fix (body=brief, guaranteed)
  shipped in M5. Standalone pass if wanted; not rot-bearing.
- ✅ **FD-13 projection guard:** `deriveDagStateFromDiary` (dag/replay.ts) replays
  `workflow_run_events` through the SAME pure transitions; guard tests assert derived states ≡
  executor dagState across a reject-loop story AND a ceiling-escalation story. dagState stays the
  operational cache; the diary is provably the truth.
- ✅ Banned names += RejectEdge · RetryPolicy · holdForHuman.

## Open questions (bring to Emerson mid-pass, plain-English)
- **Child-cards-per-step visibility** — agent steps mint child work items; should they show on
  the board / under the parent / hidden? (UI call, not blocking slices A-C.)
- **Loop node UX in the visual editor** — box-with-counter is the FD-9 reading (built that way);
  confirm it reads right once visible.
- Where the ceiling-pause surfaces pre-M8 (review inbox is the interim — confirm acceptable).

## Verification plan
- Per slice: unit + structural gates (banned names; DIARY-DOOR already guards C's diary lines).
- Live gauntlet at C: fire `file-then-review` → reject ×3 → ceiling PAUSES + mailbox → approve
  at the gate → completed. Cancel a mid-run workflow → child agent run cancelled + diary line.
  Break a def → run fails → edit def → resume-from-step → completes (the repair loop, live).
- Data migration dry-run against the dev DB copy first (64 defs).
