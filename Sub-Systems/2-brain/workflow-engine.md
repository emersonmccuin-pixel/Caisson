# Workflow Engine

> **Role:** Brain (control plane)
> **Status:** as-built snapshot — 2026-06-03 · active first-principles rebuild on `refactor/auto-pathway`
> **Spec:** `refactor plan/workflow-engine-first-principles-redesign-2026-06-02.md`
> **Code anchors:** `packages/domain/src/workflow-v2.ts` (types) · `packages/workflows/src/dag/` (the pure logic: step/refs/topo/validate/when/triggers) · `registry-v2.ts`, `serialize-v2.ts` (YAML) · `apps/server/src/services/dag-executor.ts` (the loop) · `dag-run-service.ts` (live wiring) · `workflow-run-writer.ts` (the write door) · `workflow-import.ts` (boot import) · `routes/workflow-routes.ts` (HTTP) · `project-runtime.ts` (stage trigger + review resume) · `packages/app-services/src/workflows/` (gateway + boot reconcile)

---

## What it is (plain English)

**A workflow is an assembly line for a card.** A card arrives at a station (a stage on your board), the line starts, each worker (an agent) does a job and hands its output to the next worker, quality control (a review) checks the work, and the card moves along the board as the line progresses. The workflow engine is the machinery that runs that line: it starts it, hands out the jobs, passes work between steps, pauses for approvals, and deals with breakdowns.

---

## What it's supposed to do (intent)

Own the full life of a multi-step automated run: start on a trigger → give each step's job to an agent → receive the finished work → move the card → continue to the next step or wait at a quality gate → finish (or fail with a clear reason). Two laws: **a step is only "done" when the agent explicitly hands in its work** (never guessed), and **every state change is written down durably** so nothing depends on a process staying alive.

---

## The parts (every component, plain English)

### 1. Building workflows (AI or UI)

Two doors, one result:
- **Talk it into existence** — the workflow-builder agent interviews you and publishes the workflow (opened from Workflows tab → + New workflow; see [built-in-agents.md](built-in-agents.md)).
- **Edit it directly** — the UI; raw YAML is a tab, never the default.

Under the hood a workflow is stored in the database as the definition of record. (There's also a one-time boot importer that slurps any `workflows/*.yaml` files on disk into the DB and then retires them — `workflow-import.ts`.)

> 📌 **Rebuild requirement (Emerson):** the graphical representation must be robust, good, and *editable* — today visual editing is the weakest part of authoring.

### 2. Starting a run (what starts the line)

**☠ FD-10 EXECUTED (M6 slice A, 2026-06-04): workflows declare NO triggers.** The definition has no
`triggers:` key (the validator rejects one); the stage-watching machinery (`dag/triggers.ts`, the
firing half of the old `moveAndFireV2` — now `moveWorkItemV2`), the schedule/event vapor kinds, and
the run row's trigger columns (migration 0043) are all deleted. A boot-time sweep stripped the key
from every stored definition.

Exactly two ways a run starts, both landing on the ONE fire route (`POST /api/workflows/:id/fire`):
- **Manually** — the "Run now" button. (`workflow-routes.ts`)
- **The orchestrator fires it** with `pc_fire_workflow`.

Either can target an existing card: the fire carries an optional `workItemId` and that card becomes
the run root (`$root.output` = its body) — the capability stage-entry used to provide, now through
the one deliberate door.

### 3. The steps (nodes)

Exactly **two kinds of step**, on purpose — everything else was deleted to keep one door:

- **Agent step** — hand a job to an agent. The step names the agent (pod), the task text, and its inputs. Dispatch goes through the same single door as every other agent spawn in the app. The engine waits for the agent's handed-in work.
- **Review step** — a quality gate. The reviewer is either the **orchestrator** or a **human** (one step kind, a `reviewer:` switch). The run *pauses durably* until a decision:
  - **Approve** → the step completes; the card can move; the line continues.
  - **Reject** → the work goes *back* to an earlier step **with the reviewer's notes attached** (the kicked-back step can read them as `$carry.feedback`). There's a retry ceiling (3 by default); hitting it fails the run and flags a human.

Not steps today (both decided for the rebuild — see FD-9):
- **Move card** — today this is a **property on a step**, not a step of its own: "when this agent finishes, move the card to X" / "when this review approves, move to Y" (and optionally "on reject, move back to Z"). 🟢 **FD-9 (locked 2026-06-03):** becomes a **visible step** in the rebuild; the property mechanism dies, including on-reject move-back.
- **Loops** — **not built.** The only loop today is the review-reject kickback. 🟢 **FD-9 (locked 2026-06-03):** the rebuild gets a real **Loop step** — review rejects loop back to the agent with feedback, retry ceiling (default 3), ceiling hit → Human Inbox (FD-7).

> 🟢 **FD-9 target step model: Agent · Review · Move card · Loop** — four visible kinds, each one
> thing. Consciously reverses the shipped card-move-as-effect decision; the rebuild deletes the
> property path.

### 4. Passing work down the line (data flow)

Each step produces exactly **one output: its deliverable** (the work the agent handed in). A later step declares what it needs:

- `input: { draft: $step2.output }` — "my `draft` input is step 2's output" — then the task text says `{{draft}}`.
- `$step2.output.field` reaches into a structured output's named field; `$root.output` reads the card the run started from — **the human brief, guaranteed since M5** (☠ `store: work_item_body`; deliverables never overwrite a card body).
- All wiring is **validated when you save**: every reference must point at a strictly *earlier* step, and every `{{name}}` must match a declared input. You can't save a broken line.
- A step that delivered nothing yields an **empty** input downstream — never the task text by accident.

(Resolution reads the agent's *contract deliverable*, not the child card's body — `dag-run-service.ts:194`.)

### 5. Knowing a step is done (the done-signal)

The agent calls `pc_submit_deliverable` — "here's my finished work." That positive receipt is the **only** good "done." No guessing from logs, ever. (This is the law that killed the stall bug; the engine waits on a run-keyed waiter resolved by the one terminal authority.)

### 6. Pause / resume

- **Pause at a review** — built and durable. The run survives restarts while parked; the inbox item persists; a decision resumes it exactly where it stopped.
- **Pause on failure + a user-facing "fix it and resume" button** — **not built.** Today a failed step fails the run (downstream steps are skipped) and you get notified.

> 🟢 **FD-11 (locked 2026-06-03):** "went wrong → fix it → resume" is a core capability — restart at
> a specific step after repair, repair-loop until the workflow is reliable, run diary readable by the
> orchestrator.

### 7. When things go wrong (failure policy)

- A failed step → run fails with a typed reason → **notification to your inbox + the orchestrator's mailbox** (`dag-run-service.ts:427`).
- Reject-kickback (above) is the built-in "try again with feedback" mechanism.
- **Server restart mid-run:** runs that were actively executing are failed with reason `interrupted-on-boot` (the work isn't silently lost — it's visibly failed). Runs paused at a review are left exactly as they were. Re-dispatching automatically is deliberately not attempted yet. (`boot-reconcile.ts`)

### 8. The run's story (the diary) — ✅ truth-grade since M3a (2026-06-04)

Every run keeps a step-by-step diary — *started · agent dispatched (with the inspectable
agentRunId) · step completed · review rejected · retried · completed/cancelled/interrupted* — so a
stuck or dead run is **never a mystery**, and a live run can be watched line by line.

As built (M3a): every line flows through ONE gateway door (`appendRunEvent` — the
`workflow_run_events` row + its `workflow.run.event` live fact in one transaction; the DIARY-DOOR
gate keeps direct writes dead). The orchestrator reads the story via `pc_get_workflow_run`; the
Workflows run panel shows the live timeline. The run's EXECUTION state still lives in `dag_state`
on the run row — projecting state from the diary is the M6 step-model-v3 leg (deliberate: build
the new semantics on the spine once).

### 9. Saving safely (validation + publishing)

- **"Saved ⇒ runnable."** Saving validates everything: step kinds, unique names, wiring points backward only, placeholders bind, no cycles (except reject back-edges), and a leftover `triggers:` key is rejected outright (☠ FD-10). Invalid files land visibly as `invalid`, never silently. (`dag/validate.ts`)
- Definitions are versionless today — editing a definition doesn't touch in-flight runs (each run froze its own snapshot of the workflow at start). ⚠️ No decided rule yet for "what should editing do to runs in flight?"

### 10. Watching and stopping a run

- **Watching:** run status changes fan to the UI live (every state write also writes a live-event row in the same transaction — structurally impossible to "forget to announce"). ✅ M3a: step-by-step watching is real — every diary line fans as `workflow.run.event`.
- **Stopping:** ⚠️ M3a finding — `gateway.cancelRun` exists (and writes the `workflow_cancelled` diary line) but has **no production caller**: no cancel-a-run button or tool exists anywhere; the executor polls `isCancelled` for a setter that never fires. The affordance lands M6/FD-7 era.

---

## How it connects

- **Depends on:** the one agent-dispatch door (`dispatchFreshAgent`) · the Work Contract service (reads deliverables for `$step.output`) · the run gateway (all writes = row + live-event in one transaction) · the mailbox (reviews + failure notices) · card moves (`moveWorkItemStage`) · optional git worktrees per run.
- **Used by:** the HTTP routes (the one fire door), boot reconciliation, the orchestrator (fire tool + reviews via mailbox), the human inbox (reviews via UI).
- **Crossing the boundary:** `workflow.run.changed` / `workflow.run.event` (M3a — one fact per diary line) / `workflow.review.changed` / `workflow.definition.changed` live events; the `workflow_runs_v2` table (run + state blob + frozen workflow snapshot); the `workflow_run_events` diary table (read by `pc_get_workflow_run` + the run panel).

---

## Target shape (per north star + Foundation Decisions)

The first-principles spec reduces the engine to three concepts: **step → transition → run log.**

**Already done on this branch:** two step kinds only (old bash/script/move/split-review steps deleted) · done = deliverable receipt (stall fixed; one terminal authority) · card-move as a property · declared input ports validated at save · unified review with reject-carry feedback · failed-run notifications · boot reconciliation · "Saved ⇒ runnable" validation.

**Locked 2026-06-03 (Foundation Decisions):** step model becomes Agent · Review · Move card · Loop — move-as-property dies (FD-9) · stage-entry triggers die (FD-10) · run diary becomes the truth + restart-at-step + repair-until-reliable + expert builder agent (FD-11).

**✅ FD-10 EXECUTED (M6 slice A, 2026-06-04):** triggers deleted whole — see §2. Fire route gained the optional `workItemId` card target.

**Remaining:** FD-9 four-kind step model (M6 slice B) · FD-11 ceiling→human + cancel wired + restart-at-step (M6 slice C) · user-facing resume (#6) · re-attach instead of fail-closed on boot (the one-reconciler work, Step 2).

---

## Known issues / scar tissue

- **The stall (FIXED).** A finished agent didn't advance its workflow — two competing listeners raced for the terminal signal and the waiting promise never resolved. Fixed by collapsing to one terminal authority + a run-keyed waiter (commits `40c2a91f`, `0022872d`). The lesson is law: *any* "done" handling added outside the one authority will strand runs again.
- **The diary is write-only.** See #8 — biggest gap, ties to the store decision.
- ~~**The root card's `body` does double duty**~~ ✅ M5 (2026-06-04): the body is the brief ONLY (☠ `store: work_item_body`); `$root.output` = the brief, with the round-trip guard pinning it (`m5-root-output-round-trip.test.ts`).
- **Empty deliverable = empty downstream input.** A step that delivers nothing hands `''` onward (the step itself is marked failed, blocking downstream — but the *reason* may not surface clearly in the UI).
- **A workflow can name an agent that isn't usable** — the "pod must be project-scoped" check happens at run time, not save time. A workflow can save cleanly and then fail at dispatch. (Open: add the check to save-time validation.)

---

## Decisions & open questions

**For Emerson (product calls):**
1. **What does editing a definition do to runs already in flight?** (Today: nothing — they finish on their frozen snapshot.) — still open.

*(Resolved 2026-06-03 → Foundation Decisions: move-card is a step (FD-9) · loops are a real step (FD-9) · pause-on-failure/resume + run-diary-as-truth + repair loop are core (FD-11) · stage-entry triggers die (FD-10).)*

**Technical:**
- Pod-existence/scope check at save time?
- Boot reconcile: when does "re-attach to a live run if present" replace fail-closed?
- The fire-and-forget `done` promise in the HTTP route — guard-test coverage for a deep executor crash is unclear.
