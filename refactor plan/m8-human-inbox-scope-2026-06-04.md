# M8 — FD-7 Human Inbox — scope (2026-06-04)

> Track M, last big piece. FD-7 (locked 2026-06-03): human review = a dedicated subsystem —
> review packages, one consistent approve/reject flow, global notifications. Absorbs:
> pending_asks-vs-pending_interactions (pick ONE) · verification-tiers-merge Q · loop-ceiling
> hand-off destination (FD-9/M6-C).

## Trace — every human-decision moment today (post-M7)

| # | Moment | State lives in | Delivered to human? | Decision door |
|---|--------|----------------|---------------------|---------------|
| 1 | Workflow review gate `reviewer:'human'` | DAG state `awaiting-review` (workflow_runs_v2) | **NO — nothing.** `requestReview` delivers ONLY `reviewer==='orchestrator'` (dag-run-service.ts:391). Human flavor = live fact + graph Eye badge only | POST `workflow-v2/review` (routes.ts:146) / `pc_complete_node` |
| 2 | Loop-ceiling escalation (M6-C re-posts review w/ reviewer:'human', escalated) | same | **NO — same hole.** Re-post goes through requestReview → human flavor → no delivery | same |
| 3 | Contract verification `human-review` tier | agent_contracts `verifying` | **NO.** Orchestrator pod prompt (orchestrator-pod-content.ts:242) promises "the Human Review inbox" — **that surface does not exist** | POST `work-items/:id/approve\|reject` (work-items/routes.ts:350/381) |
| 4 | Workflow run failed | mailbox `workflow-run-failed` | YES — user-inbox row, rendered in ActivityPanel's MailboxInbox | dismiss/read only |
| 5 | Agent asks/approvals (pc_ask_orchestrator) | pending_asks + run paused | Via orchestrator (FD-6 3-layer: agent→orch→human-in-chat). Correct, stays | `pc_answer_pending` / answer route |
| 6 | Runtime-hook ask (`/api/ask`, ask-intercept.cjs) | in-memory resolver (authority) + AskShadow side-write | YES — blocking AskCard in chat, 10-min timeout | WS answer |

**The FD-7 hole, confirmed live in code:** rows 1–3 — every formal "human must approve" moment
is invisible. M6-C's ceiling-pause was only approvable via raw HTTP in the live gauntlet.

## Refute pass (what the explore agents got wrong / what's dead)

- **v1 approval corpse (dead, route-less):** `approvals.tsx` posts to
  `/api/projects/:id/approval/respond` — **no such route exists server-side** (grep: zero
  matches). `ApprovalRequiredEvent` is **never emitted** by the server. Corpse set:
  approvals.tsx · ws-types ApprovalRequiredEvent · EventBubbles case 'approval-required' ·
  useChatTimelineRenderer cases · use-project-unread.ts:294 kind check.
- **pending_interactions = write-only shadow.** Only writer is AskShadow (runtime-hook-ask);
  kinds `workflow-orchestrator-review`/`workflow-human-review`/`agent-*` are **defined, never
  written**. Boot-expires itself. No UI ever read it. The in-memory resolver stays the
  authority for /api/ask.
- **pending_asks = live + load-bearing** (pause/resume state machine, M7-hardened). It is run
  lifecycle state, NOT an inbox.
- **`system-notice` mailbox kind**: defined, never enqueued. `external-webhook`: ☠ FD-3, label
  still in web KIND_LABELS.
- `agent-approval` kind is in MailboxInbox HIDDEN_KINDS — approvals hidden from the one human
  surface that exists.

## Decisions (FD-7 resolutions)

**D1 — The ONE canonical durable inbox = the mailbox (`user-inbox` channel).**
It is already the one delivery door (FD-3/M4a), already durable, already has
read/action/dismiss routes + a global (`projectId:null`) listing route + live events.
No new table. `pending_asks` stays as ask-state (different job).
→ **☠ pending_interactions whole**: table (archive-rename migration, 0041 precedent) + repo +
PendingInteractionService + AskShadow + `pending-interaction.changed` live event + contracts
types + boot sweep. The durable record of human-bound moments is the mailbox message; /api/ask
keeps its in-memory authority (unchanged behavior, loses the write-only shadow).

**D2 — Verification holds and workflow review gates stay two mechanisms, ONE surface + ONE
decision shape.** They gate different things (a planned graph step vs. a contract's
deliverable); merging the machinery rebuilds M5+M6 for cosmetic gain. The merge FD-7 actually
needs: every human-bound decision arrives as the same **decision card** (context + artifacts +
approve/reject + feedback-required-on-reject) and resolves through its existing typed door.

**D3 — Review package = payload of IDs + display summary; UI fetches truth live.** The card
carries enough to read at a glance (prompt, bundle/deliverable summary, escalated flag, source
ids); detail (diary, contract, AC, attachments) is fetched from source-of-truth routes at
render. No stale snapshots (DB is the source of truth).

**D4 — Scope of the inbox (FD-6 3-layer, unchanged):** formal reviews/approvals + run failures
land in the Inbox. Agent questions stay orchestrator-first (chat). Runtime-hook asks stay
blocking chat cards.

**D5 — Global surface (FD-7 req 3, already locked):** one cross-project Inbox + unread badge
in the shell; per-project view stays in ActivityPanel.

## Slices

**A — Demolition + truth.** ☠ pending_interactions/AskShadow/PendingInteractionService/live
event/types/boot-sweep (archive-rename migration) · ☠ v1 approval corpse (approvals.tsx +
ApprovalRequiredEvent + render cases + unread check) · ☠ dead `external-webhook` label.
Banned-resurrection += names. Gates updated.

**B — Delivery: no human decision is invisible.** (1) `requestReview` human flavor (incl.
ceiling escalation) → enqueue durable `workflow-review` mailbox message to **user-inbox**
(payload: runId/nodeId/prompt/summary/escalated; idempotency `workflow-review:<run>:<node>:<iteration>`).
(2) verification human-review parking → NEW mailbox kind `verification-review` to user-inbox
(payload: workItemId/contractId/deliverable summary/AC). (3) Resolution closes the loop:
review decision + verification approve/reject handlers mark matching inbox recipients actioned
(by idempotency key) so acted-elsewhere items don't linger. (4) orchestrator-review tier +
orchestrator flavor unchanged.

**C — The surface.** MailboxInbox grows actionable decision cards (approve / reject+feedback,
calling the existing doors; transient confirm states per UI feedback law) for `workflow-review`
+ `verification-review` + unhide `agent-approval` if still addressed to user-inbox; global
Inbox surface + cross-project unread badge in the shell; project chips on global rows.
(Emerson UX pass mid-slice: placement + what floats.)

**D — Docs + gauntlet.** FD doc (FD-7 → executed; FD-8 note) · asks-deliverables-review.md ·
mailbox.md · orchestrator pod prompt row 3 lie becomes true · sequencing. Live gauntlet:
human review gate → inbox card → approve from card → run completes · ceiling escalation →
card (escalated) → reject w/ feedback → loop continues · verification human-review →
card → approve → card moves · cross-project badge fires from the other project.

## Open questions for Emerson (mid-pass, plain English)

- Where the Inbox lives day-to-day: proposal = bell + count in the top bar, opens a panel that
  shows everything across projects; ActivityPanel keeps the per-project slice.
- Decide-from-the-card vs. jump-to-context default.
- Loop-ceiling cards: distinct "agent failed 3 times" framing?

## Known risks

- Double-actor race (orchestrator answers an escalated gate the human is looking at): both
  doors already guard wrong-state → second actor gets a typed 409; B's resolution hook clears
  the card. Test it.
- MailboxInbox currently renders text rows only; C is real UI work (Vellum zero-radii, visible
  feedback law, explicit-close).
- `agent-question`/`agent-approval` user-inbox addressing: verify actual recipient addressing
  in agent-delivery.ts during B (explore agents disagreed).
