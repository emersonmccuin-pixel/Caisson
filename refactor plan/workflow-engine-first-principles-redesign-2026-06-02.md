# Workflow Engine — First-Principles Redesign

_2026-06-02. Supersedes the v2 DAG model (6 node kinds, forked dispatch, completion-by-inference)._

## Why this exists

The live AHEAD test (card `ahead-17`, 2026-06-02) fired the pipeline, the `jira-story`
agent created a real Jira story (AHEAD-29) **and delivered its output**, but the card
never advanced. The workflow run froze at `dag_state={"nodes":{}}`, rev 1 — parked on
`await result.done`, a promise that never resolved even though the agent's terminal was
applied to the DB. Completion was detected; it just wasn't handed back to the engine.

Root cause is the documented one (`project_agent_stall_root_cause`): **completion is
inferred, not signalled.** The door-unification wired the happy path but the terminal
path that actually fired (host/reconcile) bypassed the settle callback.

Rather than patch the handoff, reset to first principles. The system does exactly two
things: **string agents together until the work is done, and move cards where they need
to go.** Everything else is removable.

## The model in one breath

A card rides through a line of **steps**. Each step has a **worker** that reads the
outputs before it and **delivers** its own output; delivering *is* finishing. After each
step a **transition** moves the card and picks the next step — looping or stopping based
on what was delivered. Every event is written to a **run log** you can replay.

Three concepts: **step**, **transition**, **run log**. That's the whole engine.

---

## 1. Step

A step is one unit of work. It always has the same shape:

> **Input → the worker does the job → Output delivered.**

A step is **not done until it has delivered an output.** Done and output are the *same
event*. There is no "done but empty" state — that state was the bug.

### 1.1 Worker (who does the job)

| Worker | Runs how | "Done" event | Output |
|---|---|---|---|
| **agent** | spawns + runs autonomously (the dispatch door) | `pc_submit_deliverable` | the typed deliverable |
| **orchestrator** | item lands in the orchestrator's inbox; run pauses | a decision returned | `{ decision: approve\|reject, notes }` |
| **human** | item lands in the user's inbox; run pauses | a decision returned | `{ decision: approve\|reject, notes }` |

`orchestrator` and `human` are the **review** workers. They are not a different machine —
they are a step whose worker waits in an inbox instead of running a process. Same contract,
same "completion = output delivery," same branching transitions on the output.

### 1.2 Contract (input + output shape)

Every step declares:

- **`input`** — a named map of references to outputs that already exist upstream, plus the
  card itself (`$root`). The worker's task/prompt is rendered from these.
- **`output`** — the shape it must produce. For an **agent** this is its existing contract
  `expected_output` (`{kind: answer}` = free text, or `{kind: fields, fields:[…]}` =
  named fields). For a **review** the output shape is fixed: `{decision, notes}`.

References use the existing form: `$root.body`, `$root.fields.epic`, `$<stepId>.output`,
`$<stepId>.output.<field>`.

### 1.3 Lifecycle (the foolproof spine)

Every step, every worker, runs the identical lifecycle:

1. **enter** — write `step.entered` to the log. (The instant a step starts, it is logged.
   No more "running but nothing persisted.")
2. **resolve input** — gather the referenced outputs + card fields; render the task. A
   missing reference fails fast with a typed error output. (Save-time validation should make
   this impossible — see §4.)
3. **work**
   - agent → dispatch through the **one door**; the run is registered; it runs.
   - review → write the inbox item; **pause the run** (durable).
4. **settle = deliver output** — exactly one of:
   - **success**: agent submitted its deliverable / reviewer returned a decision → typed
     success output.
   - **failure**: agent exited without submitting, errored, or was lost / reviewer rejected
     → typed **failure output** with a reason.
   Either branch produces a present, typed output. Write `step.delivered` (or `step.failed`).
5. **route** — evaluate outgoing transitions against the output; write `transition.taken`.
6. **move + persist** — apply the card move; persist run state. Every settle persists.

> **Completion = delivery.** The agent calling `pc_submit_deliverable` is the *only*
> agent-done signal. No JSONL tailing, no process-exit inference, no reconcile guess. If the
> process dies without a deliverable, that is a **failure with a reason**, not a hang. This
> is the fix for the AHEAD stall: the same event that means "done" carries the output that
> becomes the next step's input.

---

## 2. Transition

After a step delivers, a transition does two things: **moves the card** and **picks the
next step**. A transition may be **conditional on the delivering step's output**.

- **Unconditional** (linear flow): `→ move <stage>, then <stepId>`.
- **Conditional** (branch / loop): `when <output matches> → move <stage>, then <stepId>`.
- **Loop**: a transition whose `then` points at an earlier step. Carries data forward as
  that step's input (e.g. reviewer notes → `feedback`). Bounded by `max_iterations`
  (default 3); exceeding it fails the run with a logged reason.
- **Terminal**: a step with no satisfied outgoing transition (or whose move lands the card
  in a stage with no further step) **ends the run**. The card simply waits there. Human
  Review is exactly this: a review step that, on approve, moves forward; with no auto-step
  out, the human moving the card later is the next trigger.

The **card move is an effect of the transition**, not a separate node. (Recommended — see
§6 decision 1.) This removes the alternating `agent / move-work-item` node pairs from the
current YAML.

### Branching review sugar

A review step's output is `{decision, notes}`. Rather than hand-write `when decision ==
approve`, the authoring form exposes:

- `on_approve: → move <stage>, then <stepId>`
- `on_reject:  → then <stepId>, carry { <name>: $self.output.notes }, max_iterations: N`

These desugar to conditional transitions on `decision`.

---

## 3. Run log (the black-box recorder)

Append-only. **Nothing happens in a run unless it is written to the log first**; run state
is a projection of the log. Replaying the log reproduces the run exactly.

Each entry: `{ seq, ts, type, stepId?, data }`. Event types:

| type | data |
|---|---|
| `run.started` | trigger, root card, workflow snapshot id, worktree |
| `step.entered` | stepId, worker type |
| `step.input.resolved` | the resolved input values (the exact bytes the worker got) |
| `worker.dispatched` | agent: runId, contractId, agent name, worktree |
| `agent.activity` | pointer to the agent run's transcript (not duplicated inline) |
| `review.requested` | reviewer (human/orchestrator), inbox message id, prompt |
| `review.waiting` | since-ts |
| `review.decided` | decision, notes, decided-by |
| `step.delivered` | the output (success) |
| `step.failed` | the failure output + reason |
| `transition.taken` | from-step → to-step, the condition that matched |
| `card.moved` | from-stage → to-stage |
| `run.paused` / `run.resumed` | reason |
| `run.done` / `run.failed` / `run.cancelled` | final reason |

A frozen run is never a mystery: the log says `step.delivered story output=AHEAD-29` then
`waiting on human review since 14:32` — or it says nothing after `story`, and you know the
handoff after `story` is where it died.

---

## 4. Consistency — checked at save time ("Saved ⇒ runnable")

The input/output match is enforced **before a run ever starts**, extending the existing
feasibility gate:

1. Every `input` reference must point to an output a **strictly earlier** step (or `$root`)
   actually produces. Can't read `$story.output.jira_key` before `story` runs.
2. Every step has a known output shape (agent contract / review `{decision,notes}`), so the
   field a downstream step reads is **type-checked to exist**. `$story.output.jira_key` only
   validates if `story`'s contract is `{kind: fields, fields:[jira_key, …]}`.
3. Every transition's `then` and `move` must name a real step / real stage.
4. Every loop transition must declare `max_iterations`.

If any check fails, the workflow won't save. The chain cannot be wired wrong.

---

## 5. Run states & durability

- `running` — a step is executing.
- `waiting-review` — paused on a review step; durable across restarts; **never times out,
  never auto-advances**.
- `done` — terminal reached.
- `failed` — a step failed with no handling transition (or loop ceiling hit).
- `cancelled` — operator-cancelled.

**Restart behaviour:**
- `waiting-review` runs stay waiting; the inbox item persists; delivering a decision resumes.
- A `running` agent step reattaches to the live host run if present; if the run was lost,
  the step settles as **failed (lost)** with a reason — never an indefinite hang.

---

## 6. Decisions to lock

1. **Card move = transition effect, not a node.** _Recommended._ Halves the step count and
   keeps "where the card goes" in one place (the transition). The alternative (an explicit
   move step) is more verbose with no gain. → **lock: transition effect.**
2. **Agent output kinds: keep both `answer` and `fields`.** Field-shaped output is what
   makes downstream references type-checkable (§4.2); free-text `answer` stays for steps
   whose result is prose a human/orchestrator reads. Steps that feed another step's named
   input should use `fields`. → **lock: both, prefer `fields` for machine handoffs.**
3. **Reject-loop carry naming is explicit per transition** (`carry: { feedback:
   $self.output.notes }`), not a magic global. Replaces the old ad-hoc `$carry.*`. → **lock.**
4. **Reattach-or-fail, never hang** (§5). → **lock.**

---

## 7. What gets deleted

- **bash node, script node** — an agent runs commands and reports. Two fewer code paths.
- **separate `move-work-item` node** — folded into transitions (decision 1).
- **separate `human-review` / `orchestrator-review` node kinds** — unified into the one
  **review step** (worker = human | orchestrator).
- **completion-by-inference** (JSONL tailer as the done-signal) — replaced by
  `pc_submit_deliverable` as the sole agent-done event.
- **the forked workflow dispatch** (`subagent-spawner.ts`, host `start-workflow-subagent`,
  `workflow-subagent-handshake.ts`, the mcp-bridge workflow-subagent route) — all agent
  dispatch goes through the one door, which now reliably settles `done` (or the step fails).
- **`$carry.*` ad-hoc substitution** — replaced by explicit per-transition `carry`.
- **legacy review/hold envelopes** — subsumed by the review step + run log.

---

## 8. AHEAD pipeline in this model

```yaml
trigger: { kind: stage-on-entry, stage: story }
steps:
  - id: story
    worker: { agent: jira-story }
    input:  { prd: $root.body, epic: $root.fields.epic }
    output: { kind: fields, fields: [jira_key, jira_id] }
    → move: test-design, then: test_design

  - id: test_design
    worker: { agent: zephyr-create }
    input:  { jira_key: $story.output.jira_key, jira_id: $story.output.jira_id }
    output: { kind: fields, fields: [zephyr_key] }
    → move: plan, then: plan

  - id: plan
    worker: { agent: planner }
    input:  { prd: $root.body, jira_key: $story.output.jira_key }
    output: { kind: answer }
    → move: build, then: build

  - id: build
    worker: { agent: coder }
    input:  { plan: $plan.output, jira_key: $story.output.jira_key, feedback: $carry.feedback? }
    output: { kind: fields, fields: [branch] }
    → move: dev-pr, then: dev_pr

  - id: dev_pr
    worker: { agent: pr-opener }   # target=dev, auto-merge, await deploy
    input:  { jira_key: $story.output.jira_key, branch: $build.output.branch }
    output: { kind: fields, fields: [dev_pr_url] }
    → move: qa, then: qa

  - id: qa
    worker: { agent: ahead-qa }
    input:  { zephyr_key: $test_design.output.zephyr_key, jira_key: $story.output.jira_key }
    output: { kind: fields, fields: [qa_status, qa_execution_key] }
    → then: qa_gate                # no card move; gate decides

  - id: qa_gate
    worker: { review: orchestrator }
    input:  { qa: $qa.output, dev_pr: $dev_pr.output }
    prompt: "Approve to cut the master PR, or reject with what needs fixing."
    on_approve: → then: master_pr
    on_reject:  → move: build, then: build, carry: { feedback: $self.output.notes }, max_iterations: 3

  - id: master_pr
    worker: { agent: pr-opener }   # target=master, do NOT merge
    input:  { jira_key: $story.output.jira_key }
    output: { kind: fields, fields: [master_pr_url] }
    → move: human-review, then: release_gate

  - id: release_gate
    worker: { review: human }
    input:  { master_pr_url: $master_pr.output.master_pr_url }
    prompt: "Review the master PR and approve to release."
    on_approve: (terminal — run ends; you merge)
    on_reject:  → move: build, then: build, carry: { feedback: $self.output.notes }, max_iterations: 3
```

Two human/orchestrator touchpoints (QA gate, release gate), both **inbox-parked until
addressed**; everything else strings agents together and moves the card. Exactly the design.

---

## 9. Build order (suggested)

1. **Schema + save-time validation** (§1.2, §4) — the step/transition/contract types and the
   "Saved ⇒ runnable" gate.
2. **Run log** (§3) — append-only store + state-as-projection.
3. **Executor** over the new model: enter → resolve → work → settle → route → move, driven by
   the door for agent steps, with `pc_submit_deliverable` as the sole settle signal.
4. **Review steps** (§1.1, §5) — inbox write, durable pause, resume-on-decision.
5. **Delete** the dropped paths (§7).
6. **Re-fire AHEAD** end-to-end as the acceptance test.
```
