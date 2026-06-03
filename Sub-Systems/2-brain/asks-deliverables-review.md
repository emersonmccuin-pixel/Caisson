# Asks, Deliverables & Review (Human-in-the-Loop)

> **Role:** Brain (control plane) — cross-cutting
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `apps/server/src/services/pause-resume.ts`,
> `apps/server/src/services/agent-delivery.ts`,
> `apps/server/src/services/apply-deliverable-store.ts`,
> `apps/server/src/services/agent-verification.ts`,
> `apps/server/src/services/agent-verification-review.ts`,
> `apps/server/src/services/auto-advance-done.ts`,
> `apps/server/src/services/ask-shadow.ts`,
> `apps/server/src/services/failure-policy.ts`,
> `packages/db/src/repos/pending-asks.ts`,
> `packages/db/src/repos/pending-interactions.ts`,
> `packages/db/src/repos/agent-inbox.ts`,
> `packages/db/src/repos/failed-run-dismissals.ts`,
> `packages/contracts/src/pending-asks.ts`,
> `packages/contracts/src/pending-interactions.ts`,
> `packages/contracts/src/runtime-hook-ask.ts`,
> `packages/domain/src/subagent-failure.ts`

## What it is (plain English)

This subsystem is how an agent asks a question and waits for an answer, how it signals "I'm done"
by handing over a result, and how that result gets approved or rejected before the work item
advances. It is the explicit-signal layer — the three edges where the agent pauses (waiting on a
human or orchestrator), completes (by delivering something), or gets reviewed (approved/rejected
with an optional retry loop).

## What it's supposed to do (intent)

Own every **positive receipt** in the agent lifecycle. Specifically:

1. **Pending asks** — when an agent calls `pc_ask_user` / `pc_ask_orchestrator` / `pc_request_approval`,
   pause the run durably, write the question, and resume (same run ID) exactly once when an answer
   arrives.
2. **Deliverable submission** — when an agent calls `pc_submit_deliverable`, accept the output, write
   it to the declared store, and mark that run as the sole "good done" signal.
3. **Verification & review** — run acceptance criteria (tier-1 auto-pass/fail) or park the contract
   for a human/orchestrator to approve or reject; on approve, advance the work item to complete; on
   reject, spawn a continuation with the feedback.

Nothing else in the system is allowed to declare an agent "done." Any ending that isn't
`pc_submit_deliverable` is a typed failure with a reason.

## How it works today (as-built)

### 1. Pending-ask flow

**Entry point:** MCP tool `pc_ask_user` / `pc_ask_orchestrator` / `pc_request_approval` fires on the
agent's MCP child process → routes to `recordExplicitPause` in `pause-resume.ts`.

**Steps:**

- Looks up the agent run in `ActiveRunRegistry` (identity + metadata only).
  `pause-resume.ts:133`
- State decision uses the **reconciled DB row** (`agent_runs_v2.status`), not the in-memory handle,
  to avoid the early-ask race where the row still reads `queued/spawning`.
  `pause-resume.ts:147–160`
- If the DB row is still pre-running and a `hostRunState` reader is wired, does an on-demand host
  round-trip to get a fresh state before rejecting.
  `pause-resume.ts:152–158`
- Calls `pauseAgentRun` (gateway transaction): writes the `pending_asks_v2` row (status=`open`),
  flips `agent_runs_v2` to `paused`, and writes the durable `agent.run.changed (reason:'paused')`
  fact to `live_outbox` — all in one transaction.
  `pause-resume.ts:174–192`
- **Awaits** `entry.run.markPaused(pendingAskId)` on the runtime handle. The await is critical:
  for host-backed runs it blocks until the host applies `paused` before the MCP tool call returns.
  Without it, the host could tail the turn-end and close the run before the pause landed.
  `pause-resume.ts:198`
- Delivers the `agent-asks-*` envelope to the dispatcher's orchestrator session via the mailbox
  (`deliverAgentEnvelope`). The mailbox is the durable, single delivery door — there is no Channel
  fallback.
  `pause-resume.ts:218–235`, `agent-delivery.ts:86–117`

**State stored:** `pending_asks_v2` row (status=`open`), `pending-asks.ts:35–55`.
Kinds: `orchestrator` | `user` | `approval`. The ask row carries `agentRunId`, `ccSessionId`,
`promptBody`, optional `options[]`.

**Resume path** (`answerPendingAsk`, `pause-resume.ts:280`):

- Reads the ask row; rejects if already `answered` or `cancelled`. `pause-resume.ts:295–308`
- Gates on the DB row being `paused` (same reconciled-row pattern).
  `pause-resume.ts:326–333`
- Calls `answerAndResumeAgentRun` (gateway tx): atomic `open→answered` flip + persist `spawning` +
  pod-revision drift fields + `agent.run.changed (reason:'resumed')` fact, in one transaction.
  `pause-resume.ts:345–356`
- The `WHERE status='open'` guard makes replayed JSONL re-delivery a no-op.
  `pending-asks.ts:125–137`
- Calls `entry.run.resumeWithAnswer(answer)` on the runtime handle. A `not-resumable` reply
  (host didn't have the run paused) finalises the run as `failed` rather than leaving it stranded.
  `pause-resume.ts:376–414`

**Cancel path** (`cancelPendingAsk`, `pause-resume.ts:443`): atomic `open→cancelled` + finalises
the run `cancelled` in one gateway transaction, even when no registry handle exists (phantom
paused run). `pause-resume.ts:469–479`

**Continuation path** (`continueAgent`, `pause-resume.ts:547`): a distinct primitive (called by
`pc_continue_agent`). Validates the parent run is terminal, that its on-disk JSONL still exists
(session-expiry guard), that no sibling continuation is already in flight, then mints a new
`agent_runs_v2` row with `continues:<parentId>`. The caller constructs and registers the new
`AgentRun`. `pause-resume.ts:551–635`

### 2. Ask-shadow (runtime-hook asks, separate path)

`AskShadow` in `ask-shadow.ts` is a **side-write** around the unmodified `/api/ask` blocking route
(orchestrator hook). It writes `pending_interactions` rows (kind=`runtime-hook-ask`) as durable
inspection records. This is NOT the agent `pending_asks` path — it tracks the orchestrator's own
blocking hook asks. The in-memory resolver in `chat-bridges/routes.ts` remains the authority; the
shadow is best-effort and never breaks the blocking path. `ask-shadow.ts:35–92`

Boot sweep: `sweepOrphanedPendingInteractions` expires any `open` interaction rows that survived a
process restart. `ask-shadow.ts:89–91`

### 3. Deliverable submission

**Entry point:** agent calls `pc_submit_deliverable` → MCP child → server. The terminal-effects
pipeline (`agent-run-terminal-effects.ts`) is the authoritative one-stop handler; deliverable
application runs inside it before verification.

**Store application** (`applyDeliverableStore`, `apply-deliverable-store.ts:56`):

- Only prose-typed contracts with non-empty `text` trigger a write.
- `store` directive (from the contract's `expectedOutput.store`) resolves to one of:
  `contract` (text stays on the contract row), `work_item_body` (writes `work_items.body`),
  `attachment` (creates an attachment row), `repo_file` (writes to disk inside the worktree).
- Default: `work_item_body` when a work item is linked, else `attachment`.
  `apply-deliverable-store.ts:143–148`
- Path-containment guard on `repo_file`: uses `path.relative` + rejects `..` escapes.
  `apply-deliverable-store.ts:186–189`
- Returns a typed `StoreApplyResult` — failures are `store-target-missing`,
  `store-path-invalid`, `store-write-failed`; all surfaced in-band so the agent gets a real
  error. `apply-deliverable-store.ts:29–42`

### 4. Verification (tier-1 auto)

`runVerificationOnTerminal` in `agent-verification.ts:124`.

- No `contractId` → returns null (no-op). `agent-verification.ts:128`
- `terminalStatus==='failed'` → immediately rejects the contract (no predicate eval).
  `agent-verification.ts:147–163`
- `terminalStatus==='cancelled'` → no automatic contract update; orchestrator owns next move.
  `agent-verification.ts:165–167`
- Tier `orchestrator-review` or `human-review` → parks contract at `verificationStatus='pending'`
  (a tier-2/3 hold). `agent-verification.ts:171–187`
- Tier `auto`, no criteria, evidence-requiring output kind (action/external/repo) → escalates to
  review instead of passing open (fail-closed). `agent-verification.ts:194–215`
- Tier `auto`, no criteria, not evidence-requiring → accepts directly.
  `agent-verification.ts:219–220`
- Tier `auto` with criteria → evaluates predicates via `evaluateAcceptance`. Pass calls
  `acceptContract`; fail persists the per-predicate failure list as JSON.
  `agent-verification.ts:257–290`

**On accept** (`acceptContract`, `agent-verification.ts:296`): flips contract to `passed`, then (if
a work item is linked) calls `applyRunOutcome(wiId, 'complete', ...)` and
`autoAdvanceToDoneStage`. Auto-advance moves the card to the project's `isDone` stage if one
exists and the card isn't already there. `auto-advance-done.ts:22–35`

**Predicate executors** (`createWorktreeExecutors`, `agent-verification.ts:347`): `fileSize`
(worktree-scoped, same path-containment guard), `runBash` (30s SIGKILL cap, exit 124 on timeout,
127 on error), `hasGitDiff` (porcelain status). All sandboxed to the worktree.

### 5. Verification review (tier-2/3 approve/reject)

`approveAgentWorkItem` and `rejectAgentWorkItem` in `agent-verification-review.ts`.

**Shared guard** (`loadVerifyingContract`): reads the work item, finds the newest contract with
`status='verifying'`, throws `VerificationReviewError` on any miss.
`agent-verification-review.ts:225–241`

**Approve** (`agent-verification-review.ts:78`):
- Flips contract to `verificationStatus='passed'`.
- Roll-up: `applyRunOutcome(wiId, 'complete')` + `autoAdvanceToDoneStage`.
- No new dispatch; the producer run is already terminal.

**Reject** (`agent-verification-review.ts:157`):
- Requires non-empty `feedback`; throws `feedback-required` otherwise.
- Requires `contract.agentRunId`; throws `no-assigned-run` if absent.
- Flips contract to `verificationStatus='failed'`, notes=feedback.
- Rolls the work item back to `in-progress`.
- Builds a continuation input: `"Reviewer rejected … Address the feedback, then re-submit via
  pc_submit_deliverable"`. `agent-verification-review.ts:199`
- Calls `dispatchContinueAgent` to spawn a `--resume` continuation with the feedback as the
  first user turn.

### 6. Failed-run dismissals

`failed-run-dismissals.ts`: tiny table (`run_id` PK + `dismissed_at`), keyed by `workflow_runs_v2`
ID. Drives the Activity Panel's "Failed recently" region — user can dismiss a row and it won't
re-appear. Idempotent insert (existing rows are not updated).
`failed-run-dismissals.ts:38–50`

The table FK was re-pointed from the v1 workflow runs table to `workflow_runs_v2` in migration
0025.

### 7. Failure policy

`failure-policy.ts`: classifies thrown errors as `transient` (db-busy, host-blip, network) or
`terminal`. Used by cold-load routes to answer `503 + Retry-After` instead of a blanket 500.
Not the agent-run failure taxonomy — that lives in `packages/domain/src/subagent-failure.ts`
(`SubagentFailureCause`: `agent-self-failed`, `agent-returned-without-closing`, `dispatch-error`,
`timeout`).

### 8. Agent-inbox (legacy path — gated for deletion)

`packages/db/src/repos/agent-inbox.ts` and the `agent_inbox` / `agent_delivery_audit` tables are
the **pre-mailbox** delivery system. The TS repo has zero live callers in the server. The legacy
Channel transport was deleted in slice 017 Phase C; `deliverAgentEnvelope` now writes only to the
mailbox. `agent-delivery.ts:1–11`

The tables are NOT yet deleted because `templates/.claude/hooks/inbox-drain.cjs` still reads/writes
them via raw SQL on `UserPromptSubmit` (lines 66/74/77). Ledger verdict: refactor that hook to the
mailbox, archive rows, then drop the tables.
`consolidation-ledger-2026-06-02.md §2 Dead/legacy`

## Integrations (how it connects)

**Depends on:**
- `agent-run-terminal-effects.ts` — the one terminal authority; calls `applyDeliverableStore`,
  `runVerificationOnTerminal`, and the mailbox delivery inside the terminal pipeline.
- `ActiveRunRegistry` (`agent-active-runs.ts`) — run identity lookup + the run-keyed waiter
  that fires on deliverable submit.
- `MailboxService` (`@pc/app-services`) — the durable delivery door for all agent→orchestrator
  envelopes (asks, completions, failures).
- `ContractService` (`@pc/app-services`) — reads + writes the contract row for verification
  status/notes.
- `@pc/db` — `pending_asks_v2`, `pending_interactions`, `agent_inbox` (legacy), `agent_runs_v2`,
  `agent_contracts`, `work_items`, `live_outbox`.

**Used by:**
- MCP tool implementations (`pc_ask_user`, `pc_ask_orchestrator`, `pc_request_approval`,
  `pc_submit_deliverable`, `pc_answer_pending`, `pc_resolve_work_item`) — all route through this
  subsystem's service functions.
- HTTP routes (approve/reject/answer endpoints) — call `approveAgentWorkItem`,
  `rejectAgentWorkItem`, `answerPendingAsk`.
- `agent-run-terminal-effects.ts` — calls `applyDeliverableStore` and `runVerificationOnTerminal`
  from inside the terminal handler.

**Contracts / events at edges:**
- `pending_asks_v2` table (kinds: `orchestrator | user | approval`, statuses: `open | answered | cancelled`)
- `pending_interactions` table (kinds include `runtime-hook-ask`; statuses: `open | answered | cancelled | expired | failed`)
- `agent.run.changed (reason:'paused' | 'resumed')` live event — written to `live_outbox` in the
  gateway transaction, drained to WS by the relay.
- `pending-interaction.changed` live event — written on every status flip.
- Mailbox messages (kinds: `agent-question`, `agent-approval`, `agent-terminal`) — the durable
  orchestrator-session inbox.
- `MailboxMessageKind` / `PendingAskDto` / `PendingInteractionDto` from `@pc/contracts`.

## Target shape (per north star)

The positive-signal model here **is** the north star. The three transitions in §4 of
`unified-process-supervision-2026-06-02.md` map exactly onto this subsystem:

| Transition | Driver | This subsystem's role |
|---|---|---|
| `working → waiting` | `pc_ask_*` | `recordExplicitPause` — KEEP |
| `working → done(completed)` | `pc_submit_deliverable` | deliverable receipt → verification → advance — KEEP |
| `* → done(failed: reason)` | process exit / timeout | typed-failure path already in `agent-run-terminal-effects`; this subsystem handles the `failed` verification branch |

**Keep as-is:**
- `pause-resume.ts`, `apply-deliverable-store.ts`, `agent-verification.ts`,
  `agent-verification-review.ts`, `auto-advance-done.ts` — these ARE the positive signals.
- `pending_asks_v2` table + repo — the pause/resume state is correctly DB-authoritative.
- Mailbox-only delivery in `agent-delivery.ts` — the old Channel fallback was correctly deleted.

**Changes needed:**
- In the Step 2 / one-reconciler world, `recordExplicitPause`'s early-ask workaround (the
  on-demand host round-trip at `pause-resume.ts:152–158`) can be retired once the reconciler keeps
  the DB row in sync continuously.
- The agent_inbox tables + `inbox-drain.cjs` hook must be migrated to the mailbox and deleted
  (ledger item 9, `consolidation-ledger §6`). Currently the only blocker is the hook script.
- Workflow-engine redesign (`workflow-engine-first-principles-redesign-2026-06-02.md §1.1`): the
  "review step" (human | orchestrator worker) maps onto a durable inbox pause — same contract,
  same completion=delivery rule. Today's `pending_interactions` table (kind `workflow-orchestrator-review`,
  `workflow-human-review`) is the home for this when the new engine ships.
- `SubagentFailureCause` / `SubagentFailureSignal` in `packages/domain/src/subagent-failure.ts`
  reference the old v1 workflow node vocabulary (`pc_node_failed`, `pc_complete_node`, `subagent:`
  node field). These are legacy shapes from before the first-principles redesign and should be
  retired when the new workflow executor lands.

## Known issues / scar tissue

**1. Deliverable-completion fix landed on the wrong path (2026-06-02).**
The original stall fix for the AHEAD card (before commit `0022872d`) wired `complete-run` only on
the in-process dispatch path. The host-backed terminal path went through `applyHostTerminalSnapshot`
which short-circuited on already-terminal runs and never called the settle callback — so the
workflow's `done` promise never resolved. The fix: `applyHostTerminalSnapshot` now always routes
through `applyAgentRunTerminalEffects` (the one terminal authority), which calls the run-keyed
waiter. Lesson: any new "done" handling must go through the one authority, not a parallel path.
`consolidation-ledger-2026-06-02.md §2 Terminal application`, commit `0022872d`.

**2. Double-subscribe race (fixed in `40c2a91f`).**
Before Step 1, there were two listeners racing to settle the same run: a per-run `onEvent` factory
listener and the boot-reconcile persistent listener. Whichever won, the other's settle was silently
dropped. The workflow's waiter wasn't run-keyed so it could only be resolved once. Fix: deleted
the per-run factory listener (~108 lines), collapsed to one terminal authority + a run-ID-keyed
`ActiveRunRegistry` settlement waiter (registered before start, fires exactly once).
`consolidation-ledger-2026-06-02.md §0`, commits `40c2a91f` + `0022872d`.

**3. Early-ask race (active workaround in pause-resume.ts).**
An agent calling `pc_ask_*` immediately after spawn may find its DB row still at `queued/spawning`
(the first reconcile sweep hasn't ticked yet). The current fix is an on-demand host round-trip
(`hostRunState`) to get a fresh state. This is a code smell — the reconciler should keep the DB
row current continuously (Step 2 work). `pause-resume.ts:152–158`.

**4. Agent-inbox tables still alive despite no TS callers.**
`packages/db/src/repos/agent-inbox.ts` has no live TS callers, but the raw SQL in
`templates/.claude/hooks/inbox-drain.cjs:66,74,77` still reads/writes `agent_inbox` on every
`UserPromptSubmit`. Deleting the tables without refactoring that hook will break orchestrator
delivery. The ledger flags this as a prerequisite: refactor hook → mailbox first.
`consolidation-ledger-2026-06-02.md §2 Dead/legacy`.

**5. `work_items.body` dual-purpose write.**
`applyDeliverableStore` writes prose deliverables to `work_items.body` when the contract declares
`store: work_item_body`. The same column is read live by `dag-run-service.ts:173` to resolve
`$root.output` workflow refs. Deleting or repurposing this write would silently break workflow
variable resolution. Ledger: KEEP + add round-trip guard.
`consolidation-ledger-2026-06-02.md §2 Sources of truth`.

**6. SubagentFailureSignal vocabulary is pre-redesign.**
`packages/domain/src/subagent-failure.ts` references `pc_node_failed`, `pc_complete_node`, and
the `subagent:` node field — old v1 workflow node concepts deleted in the first-principles
redesign. The shape is not currently called from any live workflow path (the v2 executor doesn't
use it), but it sits in the domain package as a potential confusion point (unverified whether any
live caller remains).

## Open questions

- **Step 2 reconciler:** once the one-loop reconciler is keeping DB rows live, can the early-ask
  workaround (`hostRunState` on-demand round-trip) in `pause-resume.ts:152–158` be removed
  outright, or is an on-demand read still the right design for the first-ask latency window?
- **Inbox-drain hook migration:** what is the full replacement shape? The hook currently injects
  pending inbox messages as the first user turn; the mailbox path delivers via an orchestrator
  turn. Confirm the orchestrator-turn delivery produces identical timing/ordering before cutting.
- **`SubagentFailureSignal` live callers:** confirm whether any production code path still emits
  or consumes this shape before deleting it in the redesign cleanup pass. (The v2 executor uses
  `pc_submit_deliverable` as the sole done signal; `pc_node_failed` is gone.)
- **`pending_interactions` vs `pending_asks_v2` consolidation:** two separate tables track
  open questions. `pending_asks_v2` is the authoritative agent-pause state. `pending_interactions`
  is a richer general-purpose "open ask" surface. The workflow redesign's review steps will need
  one of these as the durable inbox. Should they converge, or stay separate with
  `pending_interactions` becoming the canonical surface?
- **Verification tier surfacing in the workflow engine:** the new workflow engine's "review step"
  (human | orchestrator worker) pauses in an inbox. Today's tier-2/3 verification hold (contract
  parked at `verifying`) is a different mechanism. Decide whether these merge or coexist before
  the executor ships.
