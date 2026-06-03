# Asks, Deliverables & Review (Human-in-the-Loop)

> **Role:** Brain (control plane) — cross-cutting
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `apps/server/src/services/pause-resume.ts` · `agent-delivery.ts` · `apply-deliverable-store.ts` · `agent-verification.ts` · `agent-verification-review.ts` · `auto-advance-done.ts` · `ask-shadow.ts` · `failure-policy.ts` · `packages/db/src/repos/pending-asks.ts` · `pending-interactions.ts` · `agent-inbox.ts` · `failed-run-dismissals.ts` · `packages/contracts/src/pending-asks.ts` · `pending-interactions.ts` · `runtime-hook-ask.ts` · `packages/domain/src/subagent-failure.ts`

---

## What it is (plain English)

An agent's work life has exactly three explicit moments where something decisive happens: it **asks a question and waits**, it **hands in its finished work**, or someone **reviews that work and approves or sends it back**. This subsystem owns all three. Nothing else is allowed to declare an agent "done" — any run that ends without a hand-in is a typed failure with a stated reason, not a silent disappearance.

---

## What it's supposed to do (intent)

Own every **positive receipt** in the agent lifecycle. Three laws:

1. **Pause on ask** — when an agent asks a question (to a human or the orchestrator), the system durably parks the run and waits; it resumes exactly once when an answer arrives, on the same run.
2. **Deliver to complete** — calling `pc_submit_deliverable` is the **only** good "done." The result is stored where the contract says it should go, then verification runs.
3. **Review gates completion** — if the work needs a human or orchestrator sign-off, it parks at a review. Approve → the card moves; reject → the feedback goes back to the agent for a retry.

Nothing else can end a run as "complete."

---

## The parts (every component, plain English)

### 1. Asking a question and waiting (pending asks)

When an agent calls `pc_ask_user`, `pc_ask_orchestrator`, or `pc_request_approval`, the system:

- Looks up the run in the **ActiveRunRegistry** (the in-memory list of live runs). (`pause-resume.ts:133`)
- Reads the run's real status from the **database row**, not from memory — this prevents a race where the row still shows `queued` on an agent that asks a question the instant it spawns. If the row is behind, the system does a live read from the host to catch up before deciding. (`pause-resume.ts:147–160`, `152–158`)
- Writes the question durably and flips the run to `paused` — all in one atomic write. The run's "paused" fact is also written to the live-event log, so the UI and orchestrator hear about it immediately. (`pause-resume.ts:174–192`)
- Waits for the host to acknowledge the pause before the MCP tool call returns. This prevents the host from reading a "run ended" signal before the pause has landed. (`pause-resume.ts:198`)
- Delivers the question to the orchestrator's mailbox (the durable inbox) — one door, no fallback. (`pause-resume.ts:218–235`, `agent-delivery.ts:86–117`)

**The stored question** (`pending_asks_v2` table, `pending-asks.ts:35–55`) has a kind (`orchestrator`, `user`, or `approval`), the run it belongs to, the CC session ID, the question text, and an optional list of choices.

**Answering** (`pause-resume.ts:280`):
- Rejects if the question is already answered or cancelled. (`pause-resume.ts:295–308`)
- Checks the DB row is still `paused` before doing anything. (`pause-resume.ts:326–333`)
- Flips `open → answered`, records the answer, and marks the run `spawning` (about to resume) — one atomic write. (`pause-resume.ts:345–356`)
- The `WHERE status='open'` guard makes re-delivered events (JSONL replay) a no-op — the same answer can arrive twice safely. (`pending-asks.ts:125–137`)
- Tells the runtime handle to resume with the answer. If the host says "I don't have this run paused," the run is failed rather than left stranded. (`pause-resume.ts:376–414`)

**Cancelling** (`pause-resume.ts:443`): flips `open → cancelled` and fails the run in one write — works even if no registry handle exists (e.g. a run that was paused before a restart). (`pause-resume.ts:469–479`)

**Continuation** (`pause-resume.ts:547`): a distinct concept called by `pc_continue_agent`. When a parent run has *finished* and you want to re-engage the same agent with follow-up, this mints a new run (with a `continues:<parentRunId>` link) after confirming the parent is terminal, its on-disk conversation file still exists, and no sibling continuation is already running. (`pause-resume.ts:551–635`)

---

### 2. The orchestrator's own questions (ask-shadow, separate path)

The orchestrator has its own blocking "ask" mechanism — the `/api/ask` route — that is completely separate from the agent pending-asks above. `AskShadow` (`ask-shadow.ts`) writes a mirrored record to `pending_interactions` (kind = `runtime-hook-ask`) as a durable inspection trail. The in-memory resolver remains the authority; this shadow is best-effort and never interrupts the blocking path. (`ask-shadow.ts:35–92`)

On boot, any `open` interaction rows from a previous process are expired. (`ask-shadow.ts:89–91`)

---

### 3. Handing in finished work (deliverable submission)

When an agent calls `pc_submit_deliverable`, the work goes through the **terminal-effects pipeline** (`agent-run-terminal-effects.ts`) — the single authority for anything that happens when a run ends. Store-writing and verification both run inside it.

**Where the result lands** (`apply-deliverable-store.ts:56`) is determined by the contract's `expectedOutput.store` setting:

| Store directive | Where it goes | Notes |
|---|---|---|
| `contract` | Stays on the contract row | The result is accessible to anything that reads the contract |
| `work_item_body` | Written to `work_items.body` | ⚠️ This column is also read by the workflow engine as `$root.output` — don't break this write without a guard test |
| `attachment` | Creates a new attachment row | Default when a work item is linked |
| `repo_file` | Written to a file in the agent's worktree | Path-containment guard: no `..` escapes allowed |

> **Tie-in:** the `store` directive is part of the **Work Contract** — the record that defines an agent's assignment and expected output. Where deliverables live is tracked as an open decision in the Foundation Decisions backlog (see §"Decisions & open questions").

Only prose-typed contracts with non-empty text trigger a write. Failures come back as typed errors (`store-target-missing`, `store-path-invalid`, `store-write-failed`) — the agent gets a real error, not a silent drop. (`apply-deliverable-store.ts:29–42`, `143–148`, `186–189`)

---

### 4. Automatic acceptance check (tier-1 verification)

After the deliverable is stored, `runVerificationOnTerminal` (`agent-verification.ts:124`) runs acceptance criteria against it. Think of it as a quality gate that runs automatically before a human ever sees the work.

Rules:
- No contract linked → skip. (`agent-verification.ts:128`)
- Run failed → reject the contract immediately, no criteria eval. (`agent-verification.ts:147–163`)
- Run cancelled → no automatic update; the orchestrator decides next. (`agent-verification.ts:165–167`)
- Review tier (`orchestrator-review` or `human-review`) → park the contract at `pending`, wait for a human/orchestrator decision (tier 2/3 below). (`agent-verification.ts:171–187`)
- Auto tier, no criteria, but the output kind requires proof (e.g. "wrote a file", "external action") → escalate to review rather than auto-pass. Fail-closed: evidence-requiring work can't pass with no evidence. (`agent-verification.ts:194–215`)
- Auto tier, no criteria, no evidence required → accept directly. (`agent-verification.ts:219–220`)
- Auto tier with criteria → evaluate the predicates. Pass → accept; fail → persist which predicates failed. (`agent-verification.ts:257–290`)

**When accepted** (`acceptContract`, `agent-verification.ts:296`): the contract flips to `passed`, the work item moves to `complete`, and `autoAdvanceToDoneStage` moves the card to the project's "done" column if one exists and the card isn't already there. (`auto-advance-done.ts:22–35`)

**Predicate kinds** (all sandboxed to the agent's worktree): `fileSize` check, `runBash` (30-second hard kill), `hasGitDiff`. (`agent-verification.ts:347`)

---

### 5. Human / orchestrator review (tier-2 and tier-3)

When the automatic check parks the contract for review, a human or the orchestrator sees it in their inbox and makes a decision.

**Shared guard:** before approve or reject, the system reads the work item and finds the newest contract with `status='verifying'`. If it can't find one, it refuses the operation. (`agent-verification-review.ts:225–241`)

**Approve** (`agent-verification-review.ts:78`):
- Flips the contract to `passed`.
- Marks the work item `complete` and moves the card.
- No new agent is dispatched — the original run already finished.

**Reject** (`agent-verification-review.ts:157`):
- Requires non-empty feedback text — refuses with `feedback-required` if absent.
- Requires the contract to have a linked agent run — refuses with `no-assigned-run` if absent.
- Flips the contract to `failed`, records the feedback.
- Rolls the work item back to `in-progress`.
- Builds a continuation prompt: "Reviewer rejected. Address the feedback, then re-submit via `pc_submit_deliverable`." (`agent-verification-review.ts:199`)
- Dispatches a `--resume` continuation with the feedback as the first message in the conversation.

---

### 6. Dismissing failed-run notices

A small table (`run_id` PK + `dismissed_at`) keyed by workflow run ID. Drives the Activity Panel's "Failed recently" region — when a user dismisses a row it disappears and won't come back. Writes are idempotent. (`failed-run-dismissals.ts:38–50`)

The table's foreign key was updated from the old v1 workflow runs table to `workflow_runs_v2` in migration 0025.

---

### 7. Error classification (failure policy)

`failure-policy.ts` classifies thrown errors as `transient` (database busy, host blip, network) or `terminal`. Cold-load routes use this to reply `503 + Retry-After` instead of a blanket 500.

This is **not** the agent-run failure taxonomy. That lives in `packages/domain/src/subagent-failure.ts` and names the specific causes: `agent-self-failed`, `agent-returned-without-closing`, `dispatch-error`, `timeout`.

---

### 8. Legacy ask path — gated for deletion ☠

`packages/db/src/repos/agent-inbox.ts` and the `agent_inbox` / `agent_delivery_audit` tables are the pre-mailbox delivery system. The TypeScript code has zero live callers. The old Channel transport was deleted in slice 017 Phase C; the mailbox is now the one delivery door. (`agent-delivery.ts:1–11`)

These tables cannot be dropped yet because `templates/.claude/hooks/inbox-drain.cjs` still reads and writes them via raw SQL on every `UserPromptSubmit` (`lines 66/74/77`). Deleting the tables without migrating that hook will break orchestrator delivery.

Ledger verdict: migrate hook → mailbox first, then archive rows, then drop tables. (`consolidation-ledger-2026-06-02.md §2 Dead/legacy`)

---

## How it connects

**Depends on:**
- `agent-run-terminal-effects.ts` — the one terminal authority; calls `applyDeliverableStore`, `runVerificationOnTerminal`, and mailbox delivery inside the terminal pipeline.
- `ActiveRunRegistry` (`agent-active-runs.ts`) — run identity lookup + the run-keyed settlement waiter that fires on deliverable submit.
- `MailboxService` (`@pc/app-services`) — the durable delivery door for all agent→orchestrator envelopes (asks, completions, failures). No fallback.
- `ContractService` (`@pc/app-services`) — reads and writes the contract row for verification status and notes.
- `@pc/db` — `pending_asks_v2`, `pending_interactions`, `agent_inbox` (legacy), `agent_runs_v2`, `agent_contracts`, `work_items`, `live_outbox`.

**Used by:**
- MCP tool implementations (`pc_ask_user`, `pc_ask_orchestrator`, `pc_request_approval`, `pc_submit_deliverable`, `pc_answer_pending`, `pc_resolve_work_item`).
- HTTP routes (approve / reject / answer endpoints).
- `agent-run-terminal-effects.ts` — calls `applyDeliverableStore` and `runVerificationOnTerminal` from inside the terminal handler.

**Live events at the boundary:**
- `agent.run.changed (reason:'paused' | 'resumed')` — written to `live_outbox` in the gateway transaction.
- `pending-interaction.changed` — written on every status flip.
- Mailbox messages (kinds: `agent-question`, `agent-approval`, `agent-terminal`) — durable orchestrator inbox.
- Contracts: `PendingAskDto` / `PendingInteractionDto` / `MailboxMessageKind` from `@pc/contracts`.

---

## Target shape (per north star + Foundation Decisions)

The positive-signal model here **is** the north star. The three state transitions in §4 of `unified-process-supervision-2026-06-02.md` map exactly onto this subsystem:

| Transition | What triggers it | This subsystem's role |
|---|---|---|
| `working → waiting` | `pc_ask_*` | `recordExplicitPause` — KEEP |
| `working → done(completed)` | `pc_submit_deliverable` | deliverable receipt → verification → advance — KEEP |
| `* → done(failed: reason)` | process exit / timeout | typed-failure path in `agent-run-terminal-effects`; the `failed` verification branch lives here |

**Keep as-is:** `pause-resume.ts`, `apply-deliverable-store.ts`, `agent-verification.ts`, `agent-verification-review.ts`, `auto-advance-done.ts` — these are the positive signals. `pending_asks_v2` table + repo — pause/resume state is correctly DB-authoritative. Mailbox-only delivery in `agent-delivery.ts` — the old Channel fallback was correctly deleted.

**Changes needed:**
- Once the Step 2 one-reconciler keeps the DB row continuously current, the early-ask workaround (on-demand host round-trip at `pause-resume.ts:152–158`) can be retired.
- `agent_inbox` tables + `inbox-drain.cjs` hook must be migrated to the mailbox and deleted (ledger item 9, `consolidation-ledger §6`). Only blocker: the hook script.
- Workflow review steps (`pending_interactions` rows of kind `workflow-orchestrator-review`, `workflow-human-review`) are the durable inbox for the new engine's review nodes. Same contract, same completion=delivery rule.
- `SubagentFailureCause` / `SubagentFailureSignal` in `packages/domain/src/subagent-failure.ts` reference old v1 vocabulary (`pc_node_failed`, `pc_complete_node`, `subagent:` node field) from before the first-principles redesign. Retire when the new executor lands.

---

## Known issues / scar tissue

**1. Deliverable fix landed on the wrong path (2026-06-02) — the lesson is law.**
The original stall fix wired `complete-run` only on the in-process dispatch path. The host-backed terminal path went through `applyHostTerminalSnapshot`, which short-circuited on already-terminal runs and never called the settlement callback — so the workflow's `done` promise never resolved. Fix: `applyHostTerminalSnapshot` now always routes through `applyAgentRunTerminalEffects` (the one terminal authority). **Any new "done" handling added outside that one authority will strand runs again.** Commit `0022872d`. (`consolidation-ledger-2026-06-02.md §2 Terminal application`)

**2. Double-subscribe race (fixed in `40c2a91f`).**
Two listeners were racing to settle the same run: a per-run `onEvent` factory listener and the persistent boot-reconcile listener. Whichever won, the other's settle was silently dropped. Fix: deleted the per-run factory listener (~108 lines), collapsed to one terminal authority + a run-ID-keyed settlement waiter in `ActiveRunRegistry` (registered before start, fires exactly once). (`consolidation-ledger-2026-06-02.md §0`)

**3. Early-ask race (active workaround).**
An agent that calls `pc_ask_*` immediately after spawn may find its DB row still at `queued/spawning` — the first reconciler tick hasn't run yet. Current fix: on-demand host round-trip to get a fresh state. This is a workaround; the reconciler should keep the row current continuously (Step 2). (`pause-resume.ts:152–158`)

**4. Agent-inbox tables still alive despite no TypeScript callers.**
`packages/db/src/repos/agent-inbox.ts` has zero live TS callers, but raw SQL in `templates/.claude/hooks/inbox-drain.cjs:66,74,77` still reads/writes `agent_inbox` on every `UserPromptSubmit`. Dropping the tables without migrating that hook breaks orchestrator delivery. (`consolidation-ledger-2026-06-02.md §2 Dead/legacy`)

**5. `work_items.body` does double duty.**
`applyDeliverableStore` writes prose deliverables to `work_items.body` when `store: work_item_body`. That same column is read by `dag-run-service.ts:173` to resolve `$root.output` workflow refs. Deleting or repurposing this write silently breaks workflow variable resolution. Ledger verdict: KEEP + add a round-trip guard test. (`consolidation-ledger-2026-06-02.md §2 Sources of truth`)

**6. `SubagentFailureSignal` vocabulary is pre-redesign. (unverified)**
`packages/domain/src/subagent-failure.ts` references `pc_node_failed`, `pc_complete_node`, and the `subagent:` node field — concepts deleted in the first-principles redesign. The v2 executor doesn't call this shape, but it's unclear whether any live path still emits or consumes it.

---

## Decisions & open questions

**For Emerson (product calls):**
1. **Where does a deliverable live?** Today the default is `work_items.body`, but the right answer — a dedicated result field on the Work Contract — is an open Foundation Decisions item. This affects what agents, workflows, and humans see when they look up a finished piece of work.
2. **Two overlapping "open question" tables.** `pending_asks_v2` (agent pauses) and `pending_interactions` (richer general-purpose asks) serve related but slightly different jobs. The workflow engine's review steps will need one of these as their durable inbox. Does this become one surface, or do they stay separate with `pending_interactions` as the canonical home? This is a product-visible question: it affects where human review tasks appear in the UI.
3. **Verification tiers in the workflow editor.** The review step in a workflow (human or orchestrator sign-off) pauses via the inbox. The contract's `verifying` hold is a different mechanism today. Before the new executor ships, decide: do these merge into one approval flow, or stay as two separate things?

**Technical:**
- Once the Step 2 reconciler lands, confirm whether the early-ask on-demand round-trip (`pause-resume.ts:152–158`) can be removed outright, or whether a first-ask latency window still needs it.
- Inbox-drain hook migration: the hook injects pending messages as the first user turn; the mailbox delivers via an orchestrator turn. Confirm ordering and timing are identical before cutting over.
- `SubagentFailureSignal` live callers: confirm no production path still emits or consumes this shape before deleting it in the redesign cleanup pass.
