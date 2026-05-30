> **DEPRECATED (2026-05-30).** The Workflow-driven orchestration described in this file is retired. The refactor now runs live in the working session: Claude dispatches subagents for plan/build and posts a per-slice in-app test checklist; the human does the per-slice browser review. See `refactor plan/definitive-session-pathway.md` → "How We Run This". Kept for history only — do not drive the refactor with the Workflow tool or `refactor-pipeline.workflow.js`.

# Refactor Orchestration Handoff

You (a fresh session) are the orchestrator for the rest of the refactor. This file is your operating
contract. Read it fully before doing anything. Then drive the pathway with the workflow described below.

The pathway, gates, and hard rules already exist in `AGENTS.md` and
`refactor plan/definitive-session-pathway.md`. This file does **not** redesign them. It tells you how to
*run* them with a workflow, autonomously, while stopping cleanly for the human at the right moments.

---

## 1. Paste this into the new session

Copy the block below verbatim as the new session's first message.

```text
You are taking over refactor orchestration for this repo.

Read these, in order, before doing anything:
1. refactor plan/orchestration/handoff.md   <- your operating contract; read it fully first
2. AGENTS.md
3. refactor plan/definitive-session-pathway.md
4. refactor plan/refactor-session-tracker.md  <- the FIRST unchecked row is your current session

Then follow handoff.md exactly. In short:
- Run `git status --short`. If dirty, STOP and report the dirty files. Do not proceed.
- Create/switch to the run branch off dev: `git switch -c refactor/auto-pathway` (reuse it if it
  already exists). NEVER run the refactor on dev or main.
- Drive the pathway by running the workflow:
    Workflow({ scriptPath: "refactor plan/orchestration/refactor-pipeline.workflow.js" })
- The workflow advances through pathway sessions under the AGENTS.md gates, commits each completed
  session, tags each verified slice, updates the trackers, and runs to the END of the pathway. It
  stops early ONLY on a hard blocker: an automated gate fails, a build slice's plan is missing, or
  the repo is dirty / on the wrong branch. Product/design choices are decided with rationale and
  recorded, not stopped on.
- Human verification happens ONCE, at the very end: I browser-test each completed section on the branch.
- When it stops or finishes, show me: (a) what advanced (with per-slice tags), (b) the slices to
  browser-test, (c) recorded decisions/open questions, (d) any hard blocker. Never advance past a
  failed gate.

Hard rules (non-negotiable):
- Never restart or kill dev processes (Vite, tsx, Electron, Caisson, Node) and never call restart
  endpoints. The dev stack and other sessions are live.
- Never read, search, or cite anything under archive/.
- Keep every change inside the named slice scope. No adjacent-subsystem work.
- Do not push to main. Do not merge anything. I test on the branch; we fold it in together.
```

That is the whole kickoff. Everything below is the detail that prompt relies on.

---

## 2. Where we are

- Pathway is a fixed state machine in `refactor plan/definitive-session-pathway.md` (Sessions 10-40,
  11 build slices).
- Sessions 1-12 are done and committed. **The next unchecked session is Session 13 (verify/close slice
  002).** Always re-read `refactor plan/refactor-session-tracker.md` to confirm the real next row —
  never trust this number, trust the tracker.
- Remaining work is 9 more build slices covering the core of the app: work-items (003), workflow
  service (004), agent-run service (005), conversation/send/replay (006), mailbox (007), Channel
  cutover (008), runtime-host split (009), MCP typed client (010), cleanup (011).

## 3. The loop the workflow runs

Each cycle:

1. **Orient** — one agent runs `git status --short`, reads `AGENTS.md`, the pathway, and both trackers,
   confirms the run branch, and returns the next unchecked session (number, type, verbatim prompt,
   slice, whether the slice plan is ready).
2. **Run the session** by type:
   - **plan** — one agent runs the plan prompt. Docs only. Creates/updates the matching
     `refactor plan/build-slices/00X-*.md`, marks it `planned`, updates trackers, commits docs.
   - **build** — one focused agent implements only the named slice, runs the slice's automated gates
     (focused tests + package typechecks + in-process two-client test), updates trackers with
     evidence, commits code + docs.
   - **verify/close** — fan-out: read-only lens agents (scope, gates-evidence, regression) analyze the
     committed slice diff against its slice plan; one synthesis agent runs the gates, fixes only
     in-scope defects, marks the slice implemented, updates trackers, commits.
3. **Gate** — advance only if the session committed and its automated gates passed. Otherwise STOP.

The workflow is the durable artifact at
`refactor plan/orchestration/refactor-pipeline.workflow.js`. It encodes all of this.

## 4. Advance policy (read this carefully)

- **Run end-to-end.** The workflow drives the whole remaining pathway (Session 13 -> 40) in one go,
  advancing each session on its automated gates: focused tests, package typechecks, and the in-process
  two-client test, with the work committed.
- **One human checkpoint, at the very end.** Per `AGENTS.md`, agents must not restart the dev stack, so
  they cannot run real two-client browser checks. The workflow runs the in-process equivalent, records
  each slice as `awaiting human browser test`, and keeps going. The human browser-tests every section
  once, after the run completes, on the branch.
- **Decide, don't stall.** Product/design choices are made with rationale and recorded as open
  questions, not stopped on. The run only halts early on a hard blocker (see section 5).
- **Commit per session, tag per verified slice.** Each session is its own commit; each verified slice
  gets a `slice-00X-verified` tag so the human can back up to and test any section independently.
- **Accepted risk:** building slice N+1 on a slice N that is automated-verified but not yet
  browser-verified can let a UI/propagation defect ride forward. Automated regression coverage is the
  guard; anything browser-only surfaces at the end. Safe because everything lands on
  `refactor/auto-pathway`, never main.

## 5. When the workflow stops early

It runs to the end of the pathway unless it hits a hard blocker, then returns a structured report. Hard
blockers:

- **Failed automated gate** — record the blocker in `refactor plan/refactor-tracker.md`, add a
  fix-and-reverify session for the *same* slice in `refactor plan/refactor-session-tracker.md`
  (per the pathway Failure Path), commit safe work, end clean. Do **not** start the next numbered
  session.
- **Build blocked** — the matching slice plan is missing or not marked ready.
- **Dirty repo or wrong branch** — refuses to run.
- **Safety cap reached** — at most `args.maxSessions` sessions per invocation (default 40, enough for
  the whole remaining pathway).

Product/design questions do NOT stop the run; they are decided with rationale and surfaced at the end.

Present to the human: what advanced (with per-slice tags), the slices to browser-test, recorded
decisions/open questions, any hard blocker, and the exact next step.

## 6. Resuming

After the human tests on the branch and confirms (or after a fix-and-reverify session lands), simply
run the workflow again:

```text
Workflow({ scriptPath: "refactor plan/orchestration/refactor-pipeline.workflow.js" })
```

It re-orients from the trackers and continues from the next unchecked row. The trackers are the only
state; the workflow holds none between runs.

## 7. Constraints that are easy to forget

- **Branch, not main.** All refactor work lands on `refactor/auto-pathway`. Never push main; never
  merge. The human folds the branch in after testing.
- **Do not use this repo's own engine to drive the refactor.** This repo *is* an agent/workflow
  orchestrator. Driving the refactor with the thing being refactored is circular. Use the external
  Workflow tool only.
- **One slice at a time, in scope.** No convenient adjacent work. Broader work becomes a new planned
  slice.
- **Source of truth = the trackers**, re-read every cycle. Never hardcode the session number.
- **Clean repo at start and end of every session.** Commit completed work; never hand off uncommitted
  work.
```
