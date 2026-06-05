# M4b — FD-8 remainder: nothing waits invisibly, nothing dies invisibly (2026-06-04)

FD-8's law: every undelivered or unanswered message must retry or surface visibly. M4a closed the
delivery half (defer-not-die, honest dead-letters only). M4b closes the rest: the expiry knob, the
dead-letter surface, and the "expecting a response that never came" watchdog.

---

## Trace — what actually exists today (post-M4a/M8)

1. **`mailbox_messages.expires_at`** — a DEAD COLUMN. One write site
   (`packages/db/src/repos/mailbox.ts:102`) hard-codes `null`; zero readers; no contract field;
   no sweep. The FD-8 bullet "expiresAt exists, nothing sweeps it" was half-wrong: nothing
   WRITES it either. A sweep would sweep nothing, forever.

2. **Honest dead letters are still silent.** Post-M4a a delivery dead-letters only for: a pinned
   orchestrator session that doesn't exist · a real send failure ×5 · an unsupported channel.
   `MailboxService.deadLetterDelivery` writes the `mailbox_dead_letters` row + a
   `mailbox.delivery.changed` live frame — but NO surface consumes either: the one repo reader
   (`listDeadLettersForMessage`) is test-only, no route serves the table, no UI renders it.
   A message can still die with no human ever knowing. (93 historical rows = M4a forensics,
   mostly pre-fix doomed synthetic-dispatcher envelopes — NOT worth a requeue surface.)

3. **An unanswered ask waits forever, invisibly.** An agent's ask pauses the run
   (`pending_asks` open row) and delivers to the orchestrator as a turn. If the orchestrator
   never answers (busy, confused, or no orchestrator exists — the delivery defers silently on a
   60s cadence), NOTHING escalates. The only surface is the project Activity Panel's passive
   list. The cross-project Inbox bell (M8) never hears about it. M7's sequencing note said it:
   "the lifecycle watchdog catches unanswered asks" — that's this pass.

4. **Decision cards need no watchdog.** A paused review gate is already a persistent actionable
   card + badge (M8). Visible-by-design ≠ unanswered-invisible. Out of scope.

5. **FD-17 silence ladder doesn't cover asks — deliberately.** P9 excluded paused runs from the
   stall ladder (a pause is intentional silence). The stale-ask watchdog is the missing
   complement, not a duplicate. `agent-stalled` (running-but-silent) and stale-ask
   (paused-and-unanswered) are different facts.

## Refute pass

- "Implement the expiry sweep" — REFUTED. Auto-expiring messages CONTRADICTS FD-8 (silent loss
  by timer). Nothing writes the column, nothing wants it. Dead knob → delete whole
  (M5 `output_destination` precedent). FD-8 amendment recorded below.
- "Dead-letter requeue UI" — REFUTED as scoped. M4a made away-orchestrator (the only recoverable
  case) defer instead of die; the remaining dead-letter causes are permanent (session gone,
  channel unsupported) or already-retried ×5. Requeue would re-run a guaranteed failure.
  The right surface is NOTICE, not requeue.
- "Unified lifecycle state machine (sent→delivered→expecting→answered→done)" — REFUTED as a
  literal table. The states already live in the right places: delivery rows (sent→delivered),
  `pending_asks` (expecting→answered). Unifying them into one machine would be a shadow of two
  truths (the pending_interactions mistake, ☠ M8). The watchdog reads the existing truth.

## Decisions (FD-8 amendments + resolutions)

- **D1 — ☠ `expires_at`, delete whole** (migration 0046). FD-8 amendment: message expiry is
  not a feature of a system whose law is "no message silently dies."
- **D2 — dead-letter mints a user-inbox notice.** Inside `deadLetterDelivery` (THE one door —
  catches every cause): enqueue a `system-notice` user-inbox card "A message could not be
  delivered" (subject of the dead message + reason), idempotency `dead-letter:<deliveryId>`.
  No recursion: ui-inbox deliveries accept immediately; guard skips re-noticing a notice
  (sourceKind `mailbox-dead-letter`). Historical rows get nothing (no backfill sweep).
- **D3 — stale-ask watchdog → escalated ask card.** A 60s server interval
  (`pending-ask-watchdog.ts`): open `pending_asks` older than **15 min** → user-inbox card,
  NEW kind `agent-ask-escalated` (+= `ACTIONABLE_MAILBOX_KINDS`), payload
  {pendingAskId, runId, promptBody, context, options, askedAt}, idempotency
  `ask-stale:<askId>` (one card per ask, ever — the card persists until decided, badge carries
  the nag). sourceKind/sourceId = `agent`/`<askId>` (same source as the orchestrator ask
  envelope → M8 resolve-by-source clears everything at once).
- **D4 — answer from the card through the EXISTING door.** Card = the M8 decision-card pattern:
  option buttons (when the ask has options) + free-text answer →
  `POST /api/projects/:pid/agent-pending-asks/:id/answer` `answeredBy:'user'`. The answer and
  cancel doors gain M8's snapshot-before-decide resolve-by-source so a decision through ANY
  door (card, orchestrator tool, HTTP) clears the card.

## Slices

- **A** — ☠ `expires_at`: migration 0046 (+ `_journal.json` entry!) · schema/repo/test sweep ·
  stays-deleted gate.
- **B** — dead-letter notice in `deadLetterDelivery` + recursion guard + tests (worker
  dead-letter path mints exactly one notice; notice's own delivery accepts).
- **C** — stale-ask watchdog service + `agent-ask-escalated` kind + web card (options/free-text
  → answer door) + resolve-by-source on answer/cancel + tests.
- **D** — live gauntlet: force a pinned-nonexistent-session dead letter → notice card appears ·
  fire a real agent ask, don't answer past a dropped threshold → escalated card → answer from
  the card → agent resumes → run completes · answer a second ask via the orchestrator door →
  its card clears.

## OUTCOME — ✅ ALL FOUR SLICES SHIPPED + LIVE GAUNTLET GREEN (2026-06-04)

Commits: scope `3b2a2c3e` · A `6260c394` · B `cb8af617` · C `f6327fd2` · D (this sweep).
Suites: server 285 · web 126 · app-services 83 · db 41 · contracts 73 · workspace typecheck — all green.
Migration 0046 verified on the live dev DB (`expires_at` gone).

**Live gauntlet (dev stack, real agents):**
- **G1 dead-letter notice:** enqueued a message pinned to a nonexistent orchestrator session →
  dead-lettered non-retryable on the first worker pass → `system-notice` card in `GET /api/inbox`
  with full forensics payload (originalMessageId, deliveryId, reason, lastError). ✓
- **G2 stale-ask → card → answer-from-card → resume:** live `writer` agent asked w/ options
  alpha/bravo → paused → ask backdated 16min (time machine) → watchdog minted the card on its
  next sweep ("Agent writer has been waiting 17m on a question", options in payload) → answered
  `alpha` through the card door (`answeredBy:'user'`) → card actioned instantly → agent resumed →
  run `completed`, result = `alpha`. ✓
- **G3 decided-anywhere:** second live ask → card → answered through the ORCHESTRATOR door →
  card auto-cleared without being touched → run `completed`, result = `yes`. ✓

Gauntlet debris left deliberately: the G1 notice card + two actioned escalation cards sit in the
inbox for Emerson's visual pass (a DECIDED card shows only Dismiss — the M8 gotcha).

## Open questions for Emerson

- 15-minute threshold OK? (Watchdog constant `STALE_ASK_THRESHOLD_MS`; can become a setting later.)

## Known risks

- The notice enqueue runs inside the dead-letter mutation; keep it in the same txn or
  immediately after — a crash between the two loses the notice (acceptable: the dead-letter row
  itself survives as truth; the next M-pass could add a reconcile if it ever matters).
- `agent-ask-escalated` is a NEW mailbox kind — web mirror surfaces (kind→card renderer) must
  both learn it or the card renders as a plain notice (check MailboxInbox + InboxBell card
  switch).
