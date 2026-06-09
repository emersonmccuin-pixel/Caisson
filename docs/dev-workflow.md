# Dev workflow — how a change moves from "captured" to "shipped"

This is the runbook we follow every session. It describes **the path every change
takes**, and — honestly — which steps are **enforced by the machine** vs **driven by
hand** (the orchestrator following this doc) today. Hand-driven steps are being made
structural; until then they are marked ⚠️ and must not be trusted as automatic.

> Companion: `docs/build-ship-pipeline-design-2026-06-08.md` is the TARGET design for
> hardening the hand-driven steps. This file is the CURRENT reality.

---

## Branch model

- **`dev`** = integration trunk. Daily work lands here. CI runs on every push.
- **`main`** = always-shippable / release. Reached only via a PR from `dev`. Releases
  are tagged here.
- Agent code runs in its own **git worktree branch** (provisioned by the runtime),
  never directly on `dev`/`main`.

---

## Fresh-session opener (run this FIRST, every session)

1. **`git status`** — is the tree clean? Anything stranded uncommitted/unmerged from
   last session?
2. **`git log --oneline origin/main..dev`** — what's on `dev` that isn't on `main` yet
   (i.e. is a release owed)?
3. **CI state** — did the last `dev` push pass CI, or is something red waiting?
   (`gh run list --branch dev --limit 5`)
4. **Read the board** — in-focus cards + the TOP PRIORITIES area. What are we doing
   today.
5. Then start capturing / dispatching.

---

## The path every change takes

```
capture → fix in a worktree → verify → merge to dev (CI signal)
        → batch up → PR dev→main (CI gate) → tag → release → lands in the app
```

### 1. Capture (machine)
Hit a bug or rough edge while using the app → create a work item, file it in the right
area. Nothing moves until it's a card.

### 2. Fix in a worktree (machine — when isolation is declared)
Dispatch a coding agent with a `repo` contract + `isolation: worktree`, OR fire the
**Build** workflow on the card. The agent works in an isolated worktree branch off
`dev`; a path-guard hook denies any edit outside it. Tiny/trivial edits the
orchestrator may make directly.

> ⚠️ **Isolation is opt-in today.** A dispatch that does NOT declare
> `isolation: worktree` is not path-gated and edits the live repo. Making isolation
> structural (enforced in code, no bypass) is **pc-pty-chat-273** — the gating
> prerequisite for trusting this loop unattended.

### 3. Verify the work (machine)
The agent's contract is checked — auto predicates (tier-1), or orchestrator review
(tier-2), or human review (tier-3). A green deliverable means the fix is good **in its
branch**. Nothing has touched `dev` yet.

### 4. Merge to `dev` (⚠️ HAND-DRIVEN today)
The orchestrator merges the worktree branch into local `dev`, resolves any conflict,
and pushes `dev` to origin.

> ⚠️ This is the honor-system step. The Build workflow's merge/push gates are PROSE
> telling the orchestrator to run git — approving them runs **zero git**
> (**pc-pty-chat-270**). Until that's rebuilt into a verified engine action, **do not
> assume a green workflow merged or pushed anything** — verify by hand
> (`git log --oneline -3 dev`, `git branch --contains <commit>`).

On the `dev` push → **CI runs** (typecheck + unit/component + Playwright smoke + web
build). This is your integration signal. Red = the fix broke something; fix before
moving on.

### 5. Card → Done (machine)
Once integrated green on `dev`, the card rolls up to done.

### 6. Ship: PR `dev` → `main` (machine gate, once branch protection is on)
Open a PR from `dev` to `main`. **CI runs on the PR and — with branch protection —
cannot merge while red.** This is the hard floor: nothing reaches `main` red. Merge the
PR.

> ⚠️ **Branch protection on `main` is not yet enabled** (pending setup — `gh api`).
> Until it is, the "can't merge red" guarantee is convention, not enforcement.

### 7. Tag `main` → release (machine)
Bump version, push a `vX.Y.Z` tag on `main`. The **release** workflow
(`.github/workflows/release.yml`) re-runs the test gate, then builds + signs +
publishes macOS & Windows to GitHub Releases. Auto-update delivers it to the running
app.

### 8. Loop closes
The fix is in the daily driver. Back to step 1.

---

## Hard rules (from AGENTS.md — repeated here because they bite in this loop)

- **Don't restart the dev stack unasked** — only a sanctioned testing-time restart via
  the `restart-stack` skill.
- **Commit completed work before stopping**; keep `git status --short` clean at handoff.
- **Positive receipt over inference** — never assume a side-effect happened (merge,
  push, deploy); verify it.
- **One path only** — a fix deletes the old path; surface dual paths before fixing.

---

## What's machine-enforced vs hand-driven (summary)

| Step | Today |
|---|---|
| Capture, dispatch, contract verification | **machine** |
| Worktree isolation | **machine when declared** — opt-in until pc-pty-chat-273 |
| Merge to `dev` + push | ⚠️ **hand-driven** until pc-pty-chat-270 rebuild |
| `dev` push CI / PR CI / release | **machine** (GitHub Actions) |
| `main` red-merge block | ⚠️ **convention** until branch protection is enabled |
| Build + sign + publish on tag | **machine** (release.yml) |

The direction of travel: every ⚠️ becomes machine-enforced. See the design doc.
