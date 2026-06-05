# Asks, Deliverables & Review (Human-in-the-Loop)

> **Role:** Brain (control plane) — cross-cutting
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `apps/server/src/services/pause-resume.ts` · `agent-delivery.ts` · `apply-deliverable-store.ts` · `agent-verification.ts` · `agent-verification-review.ts` · `auto-advance-done.ts` · `failure-policy.ts` · `packages/db/src/repos/pending-asks.ts` · `failed-run-dismissals.ts` · `packages/contracts/src/pending-asks.ts` · `runtime-hook-ask.ts` · `packages/domain/src/subagent-failure.ts` *(☠ M8/FD-7: `ask-shadow.ts` · `pending-interactions.ts` ×2 · ☠ M4a: `agent-inbox.ts`)*

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

When an agent calls `pc_ask_orchestrator` or `pc_request_approval`, the system:
*(✅ FD-6 executed M7 2026-06-04: ☠ `pc_ask_user` — ONE ask door; the orchestrator answers from
context or takes the question to the human in chat. `pc_ask_orchestrator` inherited `options`.)*

- Looks up the run in the **ActiveRunRegistry** (the in-memory list of live runs). (`pause-resume.ts:133`)
- Reads the run's real status from the **database row**, not from memory — this prevents a race where the row still shows `queued` on an agent that asks a question the instant it spawns. If the row is behind, the system does a live read from the host to catch up before deciding. (`pause-resume.ts:147–160`, `152–158`)
- Writes the question durably and flips the run to `paused` — all in one atomic write. The run's "paused" fact is also written to the live-event log, so the UI and orchestrator hear about it immediately. (`pause-resume.ts:174–192`)
- Waits for the host to acknowledge the pause before the MCP tool call returns. This prevents the host from reading a "run ended" signal before the pause has landed. (`pause-resume.ts:198`)
- Delivers the question to the orchestrator's mailbox (the durable inbox) — one door, no fallback. (`pause-resume.ts:218–235`, `agent-delivery.ts:86–117`)

**The stored question** (`pending_asks_v2` table, `pending-asks.ts:35–55`) has a kind (`orchestrator` or `approval` — ☠ M7 `user`; historical rows read-tolerated), the run it belongs to, the CC session ID, the question text, and an optional list of choices.

**Answering** (`pause-resume.ts:280`):
- Rejects if the question is already answered or cancelled. (`pause-resume.ts:295–308`)
- Checks the DB row is still `paused` before doing anything. (`pause-resume.ts:326–333`)
- Flips `open → answered`, records the answer, and marks the run `spawning` (about to resume) — one atomic write. (`pause-resume.ts:345–356`)
- The `WHERE status='open'` guard makes re-delivered events (JSONL replay) a no-op — the same answer can arrive twice safely. (`pending-asks.ts:125–137`)
- Tells the runtime handle to resume with the answer. If the host says "I don't have this run paused," the run is failed rather than left stranded. (`pause-resume.ts:376–414`)

**Cancelling** (`pause-resume.ts:443`): flips `open → cancelled` and fails the run in one write — works even if no registry handle exists (e.g. a run that was paused before a restart). (`pause-resume.ts:469–479`)

**Continuation** (`pause-resume.ts:547`): a distinct concept called by `pc_continue_agent`. When a parent run has *finished* and you want to re-engage the same agent with follow-up, this mints a new run (with a `continues:<parentRunId>` link) after confirming the parent is terminal, its on-disk conversation file still exists, and no sibling continuation is already running. (`pause-resume.ts:551–635`)

---

### 2. The runtime's own blocking ask (`/api/ask`) — ✅ shadow DELETED (M8/FD-7, 2026-06-04)

The hook-script blocking "ask" mechanism — the `/api/ask` route — is separate from the agent
pending-asks above. The in-memory resolver is, and always was, the ONE authority (10-minute
timeout, AskCard in chat). ☠ `AskShadow` + the `pending_interactions` side-table (migration 0045
archive): the "durable inspection trail" was write-only — no reader, no UI, boot-expired its own
rows. FD-7 picked the mailbox `user-inbox` channel as the one durable Human Inbox instead.

---

### 3. Handing in finished work (deliverable submission)

When an agent calls `pc_submit_deliverable`, the work goes through the **terminal-effects pipeline** (`agent-run-terminal-effects.ts`) — the single authority for anything that happens when a run ends. Store-writing and verification both run inside it.

**Where the result lands** (`apply-deliverable-store.ts:56`) is determined by the contract's `expectedOutput.store` setting:

| Store directive | Where it goes | Notes |
|---|---|---|
| `contract` | Stays on the contract row | **The DEFAULT since M5 (FD-5)** — the Work Contract is the result's home |
| ~~`work_item_body`~~ | ☠ **DELETED in M5 (2026-06-04)** | Body = the human brief only; `$root.output` reads it as the brief. Guard: `m5-root-output-round-trip.test.ts` + banned name |
| `attachment` | Creates a new attachment row | Explicit placement (requires a linked work item) |
| `repo_file` | Written to a file in the agent's worktree | Path-containment guard: no `..` escapes allowed |

> **Tie-in:** the `store` directive is part of the **Work Contract** — the record that defines an agent's assignment and expected output. FD-5 delivered (M5): the contract IS where deliverables live.

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

When the automatic check parks the contract for review, a human or the orchestrator sees it and
makes a decision. **M8 (FD-7): the human-review tier now REALLY reaches the human** — the
terminal-effects tail enqueues a `verification-review` user-inbox card (subject, plain-English
body, payload with contract/WI/run ids); the Inbox decision card's Approve/Reject call the routes
below, and a decision through ANY door auto-clears the card (resolve-by-source on
`agent-contract:<contractId>`). Pre-M8 the orchestrator prompt promised a "Human Review inbox"
that didn't exist. orchestrator-review stays envelope-only (the orchestrator's to handle).

**Shared guard:** before approve or reject, the system reads the work item and finds the newest contract with `status='verifying'`. If it can't find one, it refuses the operation. (`agent-verification-review.ts:225–241`)

**Approve** (`agent-verification-review.ts:78`):
- Flips the contract to `passed`.
- Marks the work item `complete` and moves the card.
- No new agent is dispatched — the original run already finished.

**Reject** (`agent-verification-review.ts:157`):
- Requires non-empty feedback text — refuses with `feedback-required` if absent.
- Requires the contract to have a linked agent run — refuses with `no-assigned-run` if absent.
- M8: a reject from the Inbox card carries no PC session — the continuation inherits the PARENT
  run's `dispatcher_session_id` (the original owner keeps getting the envelopes).
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

### 8. Legacy ask path — ✅ DELETED (M4a 2026-06-04)

`repos/agent-inbox.ts` + the `agent_inbox` / `agent_delivery_audit` tables + the
`inbox-drain.cjs` hook are GONE (migration 0041 archive-renames the tables; NO-INBOX-WRITE
gate). The "will break orchestrator delivery" fear was an illusion — the hook only READ rows
nothing had written since slice 017. The mailbox is the one delivery door, now with M4a's
defer-not-dead worker (an orchestrator-less delivery parks and waits instead of dead-lettering)
and dispatcher-aware addressing (workflow-worker asks fall back to the active orchestrator).

---

## How it connects

**Depends on:**
- `agent-run-terminal-effects.ts` — the one terminal authority; calls `applyDeliverableStore`, `runVerificationOnTerminal`, and mailbox delivery inside the terminal pipeline.
- `ActiveRunRegistry` (`agent-active-runs.ts`) — run identity lookup + the run-keyed settlement waiter that fires on deliverable submit.
- `MailboxService` (`@pc/app-services`) — the durable delivery door for all agent→orchestrator envelopes (asks, completions, failures). No fallback.
- `ContractService` (`@pc/app-services`) — reads and writes the contract row for verification status and notes.
- `@pc/db` — `pending_asks` (TS name pending_asks_v2), `agent_runs`, `agent_contracts`, `work_items`, `mailbox_*`, `live_outbox`. *(☠ M8 `pending_interactions` · ☠ M4a `agent_inbox` — both archive-renamed.)*

**Used by:**
- MCP tool implementations (`pc_ask_orchestrator`, `pc_request_approval`, `pc_submit_deliverable`, `pc_answer_pending`, `pc_resolve_work_item` — ☠ FD-6/M7 `pc_ask_user`).
- HTTP routes (approve / reject / answer endpoints).
- `agent-run-terminal-effects.ts` — calls `applyDeliverableStore` and `runVerificationOnTerminal` from inside the terminal handler.

**Live events at the boundary:**
- `agent.run.changed (reason:'paused' | 'resumed')` — written to `live_outbox` in the gateway transaction.
- `mailbox.message.changed` — every inbox state flip (incl. M8's decide-from-card resolution).
- Mailbox messages: `agent-question` / `agent-approval` / `agent-terminal` (orchestrator-bound) ·
  `workflow-review` (human flavor) / `verification-review` (human-bound decision cards, M8).
- Contracts: `PendingAskDto` / `MailboxMessageKind` / `ACTIONABLE_MAILBOX_KINDS` from `@pc/contracts`.
  *(☠ M8 `pending-interaction.changed` + `PendingInteractionDto`.)*

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
- ~~`agent_inbox` tables + `inbox-drain.cjs` hook~~ ✅ deleted in M4a (2026-06-04, ledger item 9) — no migration was needed (writer-less since 017).
- ~~Workflow review steps land in `pending_interactions`~~ ✅ resolved differently in M8 (FD-7):
  the **mailbox** is the one durable inbox — review gates enqueue iteration-keyed
  `workflow-review` messages (orchestrator-turn or user-inbox by flavor); those reserved
  pending-interaction kinds were never written and died with the table.
- `SubagentFailureCause` / `SubagentFailureSignal` in `packages/domain/src/subagent-failure.ts` reference old v1 vocabulary (`pc_node_failed`, `pc_complete_node`, `subagent:` node field) from before the first-principles redesign. Retire when the new executor lands.

---

## Known issues / scar tissue

**1. Deliverable fix landed on the wrong path (2026-06-02) — the lesson is law.**
The original stall fix wired `complete-run` only on the in-process dispatch path. The host-backed terminal path went through `applyHostTerminalSnapshot`, which short-circuited on already-terminal runs and never called the settlement callback — so the workflow's `done` promise never resolved. Fix: `applyHostTerminalSnapshot` now always routes through `applyAgentRunTerminalEffects` (the one terminal authority). **Any new "done" handling added outside that one authority will strand runs again.** Commit `0022872d`. (`consolidation-ledger-2026-06-02.md §2 Terminal application`)

**2. Double-subscribe race (fixed in `40c2a91f`).**
Two listeners were racing to settle the same run: a per-run `onEvent` factory listener and the persistent boot-reconcile listener. Whichever won, the other's settle was silently dropped. Fix: deleted the per-run factory listener (~108 lines), collapsed to one terminal authority + a run-ID-keyed settlement waiter in `ActiveRunRegistry` (registered before start, fires exactly once). (`consolidation-ledger-2026-06-02.md §0`)

**3. Early-ask race (active workaround).**
An agent that calls `pc_ask_*` immediately after spawn may find its DB row still at `queued/spawning` — the first reconciler tick hasn't run yet. Current fix: on-demand host round-trip to get a fresh state. This is a workaround; the reconciler should keep the row current continuously (Step 2). (`pause-resume.ts:152–158`)

**4.** ~~Agent-inbox tables still alive despite no TypeScript callers.~~ ✅ M4a (2026-06-04):
the "breaks orchestrator delivery" fear was wrong — the hook only read rows nothing wrote.
Hook + repo + tables deleted (0041 archive); NO-INBOX-WRITE gate.

**5.** ~~`work_items.body` does double duty.~~ ✅ M5 (2026-06-04): ☠ `store: work_item_body` —
the body is the brief only; `$root.output` reads it as exactly that (refute: 0 live defs ever
used the store). Round-trip guard written FIRST, amended deliberately
(`m5-root-output-round-trip.test.ts`); `work_item_body` in the banned-resurrection set.

**6. `SubagentFailureSignal` vocabulary is pre-redesign. (unverified)**
`packages/domain/src/subagent-failure.ts` references `pc_node_failed`, `pc_complete_node`, and the `subagent:` node field — concepts deleted in the first-principles redesign. The v2 executor doesn't call this shape, but it's unclear whether any live path still emits or consumes it.

---

## Decisions & open questions

**For Emerson (product calls):**

*(All three resolved 2026-06-03 → Foundation Decisions:)*
1. ~~Where does a deliverable live?~~ 🟢 **FD-5 ✅ DELIVERED in M5 (2026-06-04, as amended):** the
   result lives on the **Work Contract**; `work_items.body` is human-description-only;
   `output_destination` was a dead knob → deleted (not moved); pod `expected_output` survives as a
   documented default (contract row = per-run authority). Agents read their job via
   `pc_get_contract` + attachment read tools.
2. ~~Two overlapping "open question" tables.~~ 🟢 **FD-7:** the **Human Inbox System workstream**
   picks ONE canonical durable inbox surface — this question is absorbed there.
3. ~~Verification tiers merge?~~ 🟢 **FD-7:** also absorbed by the Human Inbox workstream (one
   consistent review process everywhere is its mandate).

**✅ Executed (FD-6, M7 2026-06-04):** agents only ask the **orchestrator** — ☠ `pc_ask_user`; the
orchestrator triages and surfaces to the human when needed. Exchanges visible in chat by default,
filterable. `pc_ask_orchestrator` inherited the multi-choice `options`.

**Technical:**
- Once the Step 2 reconciler lands, confirm whether the early-ask on-demand round-trip (`pause-resume.ts:152–158`) can be removed outright, or whether a first-ask latency window still needs it.
- Inbox-drain hook migration: the hook injects pending messages as the first user turn; the mailbox delivers via an orchestrator turn. Confirm ordering and timing are identical before cutting over.
- `SubagentFailureSignal` live callers: confirm no production path still emits or consumes this shape before deleting it in the redesign cleanup pass.
