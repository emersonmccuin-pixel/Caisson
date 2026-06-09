# Hardened build → ship pipeline — design

**Status:** design agreed in chat 2026-06-08 (Emerson + orchestrator). Not yet built.
**Area:** Dev Flow & Release Integrity.
**Gating prerequisite:** pc-pty-chat-273 (structural contract + isolation).

This captures the architecture we converged on for moving a change from "captured" to
"shipped" **without relying on documentation or the orchestrator remembering**. The
companion `docs/dev-workflow.md` describes the current (partly hand-driven) reality;
this is the target.

---

## The core problem

The current loop has three layers with very different trust levels:

1. **Build workflow** (in-app) — real, machine-driven: plan → code-in-worktree → QA →
   gates. Trustworthy.
2. **Git (merge to `dev`, push, dev→main PR, tag)** — PROSE in gate prompts telling the
   orchestrator to run git by hand. **Not trustworthy** — approving a gate runs zero
   git (pc-pty-chat-270), and it dies if the session is closed/interrupted/unavailable.
3. **CI + release** (GitHub Actions) — real automation outside the app. Trustworthy.

Layer 2 is the fragility. The fix is **not** "a merge node that instructs the
orchestrator to merge" — that just relocates the honor-system prose into a node.

## Key insight — decouple "git needs judgment" from "git needs a live orchestrator"

The 270 framing conflated two things:

- "git sometimes needs judgment" → TRUE, but only on **conflict** (rare).
- "git always needs a live orchestrator" → FALSE, and it's what makes this brittle.

**Decouple them.** A clean merge is deterministic: `git merge`, verify the commit
landed, push, verify origin. The server has a real shell — no brain needed. Only a
**conflict** (or a rejected push) needs judgment.

> **Git becomes a real, engine-executed, VERIFIED step — not prose. It runs the merge
> and asserts the result (commit on `dev` / pushed to origin) before the run advances.
> The orchestrator/human is pulled in ONLY on the exception path — a conflict — and
> that exception is a DURABLE gate, not a live-session dependency.**

"Orchestrator owns git" really meant "orchestrator owns **conflict resolution**" — not
"orchestrator types `git merge` every time." ~90% of merges never touch a human.

## How this answers the failure scenarios

- **Interrupted mid-merge** → the git step is idempotent + reconciled. On resume the
  engine reads actual git state (merge in progress? commit present? pushed?) and either
  completes or restarts — the same "DB is truth, reconcile on boot" pattern the engine
  already uses. No guessing.
- **Session closed / orchestrator unavailable while it runs** → the git action is NOT
  tied to a live chat session. The engine runs the deterministic case directly; the
  conflict exception parks durably (see below) for any future session to drain. The
  current bug is precisely that the side-effect is trapped in a gate approval inside one
  session.
- **Positive receipt** → the run NEVER advances on an unperformed side-effect. No commit
  on `dev` = the step fails loudly, not "approved → moved on."

## The conflict exception path — stage + inbox

When a merge to `dev` conflicts (or a push is rejected):

- **Stage = durable truth.** The card lands on a **Needs Merge** stage. That is the
  persistent, board-visible fact that this change is stuck on a conflict. It survives
  any number of closed sessions until the conflict is actually resolved.
- **Inbox = the live pointer.** An inbox item notifies a human / the next orchestrator
  session that a conflict is waiting, linking straight to the card. It's the nudge, not
  the state.
- **The rule that prevents drift:** the stage is the source of truth; the inbox item is
  DERIVED from it. The card leaves Needs Merge **only** when the merge actually lands and
  is verified (commit on `dev`) — and that same event clears the inbox. You can never
  have a cleared inbox + an unmerged card, or vice versa.

Covers both availability cases: orchestrator session open → it picks the conflict up
and resolves in a real shell (pulling in the user if hairy); no session open → it waits,
visible on the board + flagged in the inbox, until someone acts. Nothing lost, nothing
auto-does-something-dumb.

## Stages as the pipeline's durable truth

Encode the pipeline as **stages** so the board IS the answer to "where is every change
right now" — with zero live sessions and every workflow finished. Proposed pipeline
stages (names TBD against the existing board):

`Refine → Build → On Dev → Needs Merge (conflict) → On Staging → Released`

**Fields carry state between phases** (so a later phase knows what an earlier one did):
`branch`, `merged_commit`, `release_version`, `pr_url`, `release_tag`. The dev→main
release op needs to know which cards/commits are in the batch — fields thread that.

## No magic stage-entry triggers — durable gates instead

Stage-entry triggers were deliberately removed from this engine (runaway / fan-out
risk). Do **not** reintroduce them. Resolve the "don't rely on Claude remembering"
worry differently:

- **Within a phase:** full engine automation — the workflow drives every step
  deterministically, no remembering.
- **Between phases:** a **durable gate** (a human/orchestrator decision parked on a
  stage), NOT a trigger and NOT a memory. The decision sits visibly on the board until
  acted on — it can't be forgotten (it's a card on a stage) and it can't auto-fire
  something dumb. The deliberate decision IS the control point — the one place you
  actually want a human.

## Three workflows, split by phase AND cadence

| Workflow | Cadence | Does |
|---|---|---|
| **Build** (exists) | per-card | refined card → plan/code/test → **verified** merge to `dev` → human sign-off → parks in **On Dev** |
| **Promote to Staging** (new) | per-batch | takes what's on `dev`, deploys to the staging env (`dev:staging` exists), runs the fuller e2e/Playwright pass → parks in **On Staging** |
| **Release** (new) | per-batch | opens `dev`→`main` PR (CI + branch protection gate it), bumps version, tags → `release.yml` builds/signs/ships |

Key point: Promote and Release operate on a **release (a set of cards)**, not a single
card — so they're fired once per release, not per card. Splitting keeps each workflow
small, single-purpose, independently testable/fixable; each phase boundary is a stage +
a durable gate.

---

## CI hardening (shipped 2026-06-08, independent of the above)

- `ci.yml`: added Playwright e2e smoke + web build smoke to the existing typecheck +
  unit/component gate. Runs on push to `dev` and PRs into `dev`/`main`.
- **Follow-up:** the e2e step currently runs only the self-contained specs; the
  server-dependent specs (app-load, onboarding) skip without a server. Add a served-app
  e2e job (vite preview + API) so those run in CI.
- **Pending (needs Emerson):** branch protection on `main` via `gh api` — require the CI
  check + a PR before merge. This is the machine floor that makes "can't ship red" real
  rather than convention.

---

## Build sequence (proposed)

1. **pc-pty-chat-273** — structural contract + isolation (gating prerequisite).
2. **pc-pty-chat-270 (reframed)** — git as verified engine action + durable conflict
   gate (Needs Merge stage + inbox, stage-is-truth, idempotent reconcile).
3. **Pipeline stages + fields** — encode the pipeline on the board; add carrying fields.
4. **Promote-to-Staging workflow** (per-batch).
5. **Release workflow** (per-batch: dev→main PR + version bump + tag).
6. **CI: branch protection on `main`** + served-app e2e job.
