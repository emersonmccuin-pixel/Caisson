# One Dispatch Path — codebase review + implementation plan

**Status:** ✅ IMPLEMENTED on dev, 2026-06-12 — all phases (0–5). Commits: 885606ae (docs/Phase 0),
ee52373b (Phase 1 isolation), 93beceda (Phase 2 seal), 7696888e (Phase 3 landing), f07eee9f
(Phase 4 abandon/stranded), + Phase 5 (transparency/guards/docs). Riding dev; reaches the
packaged daily driver at the next release. **Tracking:** pc-pty-chat-415.
**Relation to other work:** absorbs the remainder of pc-pty-chat-270 (merge node + integration
branch + sweep already landed on dev, slices 0fbe0109..4c808b1f); feeds pc-pty-chat-352.

---

## Verdict on the PRD

Most of the PRD is **already built and guard-tested**. The codebase has one dispatch choke point,
contracts as a hard precondition, a positive done-signal, retry-on-same-path with the workspace
retained, an engine-executed verified merge, and a worktree sweep. The PRD is right about the
remaining liability, and the review found its likely root cause:

> **`code-writer` defaults to `isolation: 'in_place'`** (`packages/domain/src/pod-defaults.ts:47`)
> — code work runs in the live working copy unless the orchestrator remembers to override it
> per dispatch. That is exactly the "person chooses the path each time" failure the PRD describes.

Four real gaps. Everything else is hardening or already done.

| Gap | PRD reqs | One line |
|---|---|---|
| **G1** Isolation is opt-in for code work | R3, R9 | `in_place` exists; code-writer defaults to it. Kill it: `kind: repo` ⇒ worktree, structurally. |
| **G2** Work isn't sealed before judging | R4 | No commit-before-verify. A dirty worktree escalates to "inconclusive" instead of being refused. |
| **G3** "Accepted" doesn't land | R5 | Acceptance flips statuses only. Merge-to-integration exists but ONLY as a workflow node — ad-hoc accepted code never lands. |
| **G4** Terminal-but-unlanded worktrees leak | R12, R14 | Sweep reaps only *merged* branches. Cancelled/failed/abandoned unmerged work accumulates forever, with no abandon-with-record flow. |

## Requirement scorecard (evidence in code)

| Req | Status | Evidence |
|---|---|---|
| R1 one path | ✅ Built | All entries (MCP invoke, workflow node, continue, reject-retry) converge on `dispatchFreshAgent` (`apps/server/src/services/agent-run-factory.ts:260`); host-backed spawn only, no in-process fallback. Guard tests: `dispatch-invariant.test.ts`, `no-bypass-gate.test.ts`. |
| R2 tracked commitment | ✅ Built | Contract required before row insert; refusal = `contract-required`, zero rows, zero events (factory lines 298–308). |
| R3 code always isolated | ❌ **G1** | Isolation honors the declared setting; `in_place` legal on repo kind (`contract.ts:65`); code-writer defaults in_place. |
| R4 finalize before judge | ❌ **G2** | `agent-verification.ts:296–319` detects dirty worktree → escalates to pending. Nothing seals the slice. |
| R5 accepted = landed | ❌ **G3** | `agent-verification.ts:392–455` accept = status flips + WI roll-up. Merge machinery (`dag-run-service.ts:568` `mergeToIntegration`, positive receipts, `__dev-merge` worktree) reachable only via workflow `merge` node. |
| R6 stages compose | ⚠️ Decision | Workflow run = ONE shared worktree/branch (`wf-<suffix>`); phases are sequential commits on it; one merge at the end. See Decision D3. |
| R7 retry same path | ✅ Built | Reject → `dispatchContinueAgent` with feedback, same contract, same worktree (`pause-resume.ts:669–670`). |
| R8 variation = config | ✅ Built | Kind / tier / isolation / timeouts are dispatch inputs into the one factory; no branching paths. |
| R9 new agents inherit | ⚠️ G1 fixes | Pod-default spec resolution at the route closed pc-pty-chat-353; but a default of `in_place` inherits the WRONG behavior. Falls out of G1. |
| R10 transparency | ✅ Mostly | Run status + run diary + mailbox + `git_merged` events. Minor: surface "where on the path" in UI (Phase 5). |
| R11 reclaimed workspaces | ✅ Built | Sweep at boot + 30 min (`worktree-sweep-runner.ts`); merged-equivalence via ancestry + `git cherry`; husk cleanup. (On dev, NOT yet in the packaged app.) |
| R12 teardown only after safe | ⚠️ **G4** | `teardownAfterMerge` guarded by `branchMergedInto` ✅; but no abandon flow — "explicitly abandoned/recorded" path doesn't exist. |
| R13 workspace survives retry | ✅ Built | Continuation carries `parent.worktreeDir` forward. |
| R14 crashed/abandoned cleaned | ⚠️ **G4** | Boot reconciliation re-drives interrupted merges ✅; but unmerged branches (esp. with missing dirs) are never reclaimed and never surfaced. |
| R15 record outlives workspace | ✅ Mostly | Worktree row (destroyed status), contract deliverable, run diary, JSONL transcript all survive. Add: merge-commit SHA receipt on the contract (Phase 3). |

## PRD open decisions — recommendations

- **D1 Where accepted code lands:** the project's **integration branch** (`dev`), automatically,
  via the existing verified merge machinery. Human gates stay at the phase boundaries
  (Promote-to-Staging / Release, per `docs/build-ship-pipeline-design-2026-06-08.md`) — not per
  merge. ~90% of merges are deterministic; conflicts park on a durable gate.
- **D2 Isolation exceptions:** **none for agents.** Anything that genuinely must touch the live
  checkout (deploy/restart, push) is an engine-executed verified action — never agent code work.
  Version bumps are ordinary repo-kind work: worktree → seal → verify → merge.
- **D3 Per-phase landing (R6):** phases land on the **run branch** (sealed commits), the run lands
  on integration **once**, after end-to-end acceptance. Landing every phase on trunk would put
  unverified composite work on `dev`. Each phase still gets: own contract, sealed slice, per-slice
  verification, durable receipt. Revisit only if a real workflow needs mid-run trunk landings.

---

## Build plan

### Phase 0 — Verify live state (small, first)
- Confirm the live Build workflow definition (DB) uses the `merge` node, not prose gate prompts.
  If not: rewire it. (This is the actual remainder of pc-pty-chat-270's "honor-system" problem.)
- Refresh AGENTS.md: the "270 NOT YET BUILT" guardrail note is stale — merge node + integration
  branch + sweep landed 2026-06-11.

### Phase 1 — Structural isolation for code work (G1 → R3, R9)
The highest-value, smallest change. One path only ⇒ delete the option, don't validate around it.
- `packages/domain/src/contract.ts`: remove `'in_place'` from the repo-kind isolation union;
  isolation is **derived from kind** (`repo` ⇒ worktree). Keep reading legacy stored values
  (treat stored `in_place` as `worktree` with a warn), one-time migration strips it from pod rows.
- `packages/domain/src/pod-defaults.ts:47`: code-writer default → worktree.
- Dispatch route (`agent-runs/routes.ts:497–542`): provision decision keys off effective
  **kind**, not a spec field a caller can unset.
- `ac-derivation.ts:116` + `ac-evaluator.ts` `cwd: 'project'` arms: delete with the same sweep.
- Guard test: extend `dispatch-invariant.test.ts` — a repo-kind dispatch with NO isolation stated
  anywhere still provisions a worktree; `in_place` is unrepresentable.
- Audit live DB pod rows for stored `in_place` defaults (migration covers it).

### Phase 2 — Seal before verify (G2 → R4)
- Deliverable POST (`agent-runs/routes.ts:800–905`), repo-kind contracts: if the worktree is
  dirty, **refuse with a typed, retryable error** ("commit your work, then resubmit") instead of
  accepting and letting verification go inconclusive. Positive receipt over inference; the agent
  authors its own commit messages.
- Record the sealed commit SHA on the contract at delivery. Verification (`agent-verification.ts`)
  runs against that committed state; the flush barrier becomes an assertion, not an escalation.
- Close the known evidence gap: `bash_exit_zero` failures capture stdout/stderr tails
  (verification-soundness decision, Principle 2).
- Tests: dirty-tree delivery refused; sealed SHA recorded; verify-after-seal sees committed state.

### Phase 3 — Accept ⇒ land, via ONE landing path (G3 → R5; finishes 270)
- Extract the merge machinery (`dag-run-service.ts:568–725` + `worktree.ts` merge/push state
  machine) into a single **landing service**: merge run branch → integration in `__dev-merge`,
  positive receipt (ancestry), push, positive receipt (origin equal), diary event, teardown.
- Wire it as a terminal effect of **contract acceptance** for repo-kind worktree runs — same
  behavior whether the dispatch came from a workflow, the orchestrator, or a retry. The workflow
  `merge` node becomes a thin call into the same service (or is deleted if acceptance-triggered
  landing makes it redundant — decide during build; do not keep both as parallel paths).
- Durable conflict gate (design doc): conflict/push-reject parks the card on a **Needs Merge**
  stage (stage = truth) + derived inbox item (pointer). Card leaves the stage only when the merge
  verifiably lands; same event clears the inbox.
- Receipt (R15): merge-commit SHA + target branch recorded on the contract.
- Tests: accept on ad-hoc dispatch lands + receipts; conflict parks durably + survives restart;
  no second merge path remains (no-bypass-gate extension).

### Phase 4 — Lifecycle completion (G4 → R12, R14)
- **Explicit abandon:** a first-class action on a terminal-unaccepted run — record outcome +
  preserve the branch ref in the durable record, then tear down the worktree. Today cancellation
  just strands the worktree.
- **Stranded-work surfacing:** sweep gains a report lane — unmerged branches whose runs are
  terminal (or whose dirs vanished) get surfaced (inbox/board), never silently deleted, never
  silently kept forever. Human (or orchestrator) chooses: land / abandon.
- Tests: cancel → worktree survives until abandoned; abandon → record first, reclaim second;
  sweep never deletes unmerged work.

### Phase 5 — Transparency + closeout (R10 + metrics)
- Surface dispatch position ("provisioned / working / sealing / verifying / landing / landed @
  <sha>") on the run UI from existing diary/status data.
- Success metrics as guard tests where possible: zero in-place repo dispatches (Phase 1 test),
  zero accepted-but-unlanded repo contracts (Phase 3 invariant), bounded worktree count (sweep
  test exists).
- Update AGENTS.md guardrails section to describe the finished pipeline.

### Sequencing + risk
- Order is dependency order: 1 (isolation) is independent and urgent; 2 (seal) before 3 (land)
  because landing wants a sealed SHA; 4 and 5 ride on 3's landing service.
- **Riskiest step:** Phase 3 push-to-origin is irreversible — hold for a working session (same
  caution AGENTS.md already attaches to 270).
- **Migration risk:** stored contracts/pod rows containing `in_place` (Phase 1) — read-compat +
  migration, verified against the live DB before release.
- All of this rides on dev; the packaged app (daily driver) gets it at the next release, which is
  already a TOP PRIORITIES step.
