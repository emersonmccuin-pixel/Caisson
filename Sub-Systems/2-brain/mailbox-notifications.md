# Mailbox & Notifications

> **Role:** cross-cutting (Brain writes, Engine reads, UI views)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> - `packages/contracts/src/mailbox.ts`
> - `packages/db/src/repos/mailbox.ts`
> - `packages/app-services/src/mailbox/mailbox-service.ts`
> - `packages/app-services/src/mailbox/pending-interaction-service.ts`
> - `packages/app-services/src/mailbox/adapters.ts`
> - `apps/server/src/services/mailbox-worker.ts`
> - `apps/server/src/services/mailbox-orchestrator-turn-adapter.ts`
> - `apps/server/src/services/agent-delivery.ts`
> - `apps/server/src/features/mailbox/routes.ts`

---

## What it is (plain English)

A durable message queue built into the app. When an agent finishes, fails, asks a question, or
needs approval, it drops a message into the mailbox. That message sits in SQLite until a background
worker delivers it to whoever is supposed to receive it — the human's inbox in the UI, or the
orchestrator as a new conversation turn. If the recipient is offline the message waits; it drains
automatically when the recipient comes back.

---

## What it's supposed to do (intent)

The single "notify door" between agents/workflows and their recipients. Nothing else notifies a
human or the orchestrator of agent events — not a raw WebSocket push, not a direct HTTP call.
It exists because recipients can be offline (orchestrator restarting, user away), so delivery
must survive process restarts and not depend on a live connection at the moment of the event.

---

## How it works today (as-built)

### Message schema

A message has three related rows in SQLite:

- **`mailbox_messages`** — the content: `id`, `kind`, `subject`, `body`, `payload` (JSON),
  `source` (who sent it), optional `interactionId` (links to a `pending_interactions` row for
  ask/approval flows), `idempotencyKey` (prevents duplicate enqueues on replay), `projectId`
  (`null` for global user-inbox messages).
  - `contracts/src/mailbox.ts:43` lists the message kinds:
    `agent-terminal`, `agent-question`, `agent-approval`, `workflow-review`,
    `workflow-run-failed`, `runtime-hook-ask`, `system-notice`, `external-webhook`.

- **`mailbox_recipients`** — one row per addressee. Holds a typed `MailboxAddress` as JSON
  (`addressKind` + `addressJson`). Tracks read/actioned/dismissed state for the UI.
  - Address kinds (`contracts/src/mailbox.ts:22`): `user-inbox`, `project-inbox`,
    `active-orchestrator`, `orchestrator-session`, `agent-run`, `workflow-review`.

- **`mailbox_deliveries`** — one row per (recipient × delivery channel). Tracks the worker
  state: status (`pending` → `leased` → `accepted`/`retrying`/`dead-lettered`), attempt count,
  next retry time, lease owner, and a `targetRef` pointing to the created send-queue row or
  UI-inbox row after acceptance.
  - Channels: `ui-inbox` (show in the UI), `orchestrator-turn` (inject as a runtime turn),
    `compat-channel` (reserved, not wired).

### Who writes messages

1. **Agent terminal effects** (`agent-run-terminal-effects.ts:453`) — calls `deliverAgentEnvelope`
   when a run completes, fails, asks, or requests approval.
2. **Agent factory queued-start** (`agent-run-factory.ts:1142`) — delivers a `queued-started`
   envelope when a run's queue slot opens.
3. **Pause/resume** (`pause-resume.ts:221`) — delivers the ask envelope when a run pauses with
   an open question.
4. **Workflow engine** — enqueues `workflow-run-failed` messages targeting both the human inbox
   and the active orchestrator.
5. **HTTP API** — `POST /api/projects/:projectId/mailbox/messages` and
   `POST /api/mailbox/messages` (`features/mailbox/routes.ts:99,108`) allow external or
   system callers to enqueue directly.
6. **`inbox-drain.cjs` hook** (legacy, see Known Issues) — still reads/writes the OLD
   `agent_inbox` tables directly via raw SQL, not the mailbox. Must be migrated.

All internal callers go through `deliverAgentEnvelope` (`agent-delivery.ts:86`) which calls the
injected `MailboxEnqueuePort` (i.e. `MailboxService.enqueue`). The enqueue is idempotent on
`idempotencyKey` — a repeated call returns the existing rows and emits nothing new.

### The service layer

`MailboxService` (`app-services/src/mailbox/mailbox-service.ts:79`) is the single write door.
Every mutation runs in a SQLite transaction that atomically writes the product rows AND inserts
a `live_outbox` row. The outbox row is what the 250ms relay picks up and fans out to WebSocket
subscribers — no direct WS broadcast happens here.

### The worker loop (draining)

`MailboxWorker.runOnce` (`mailbox-worker.ts:75`) runs on a 1-second interval
(`apps/server/src/index.ts:775-782`). One pass:

1. `listDueDeliveries(now, 50)` — fetches up to 50 pending/retrying deliveries whose
   `nextAttemptAt <= now` and whose lease is free or expired (`db/repos/mailbox.ts:293`).
2. For each row, `service.lease(...)` does an atomic conditional UPDATE. Only the pass that wins
   the UPDATE owns the row (others skip). Lease duration: 30 seconds (`mailbox-worker.ts:53`).
3. **`ui-inbox` channel:** immediately accepted — the recipient row exists from enqueue, no
   further action needed (`mailbox-worker.ts:126-135`).
4. **`orchestrator-turn` channel:** resolves the recipient's `MailboxAddress` to a live
   orchestrator session, then calls `MailboxOrchestratorTurnAdapter.deliver` which calls
   `ConversationSendService.enqueueRuntimeTurn` with a stable `clientMessageId` of
   `mb:${deliveryId}` (`mailbox-orchestrator-turn-adapter.ts:33,42`). The stable key makes
   retries idempotent — the same send-queue row comes back.
5. On success: `service.acceptDelivery(...)` records `targetRef` (the send-queue row id) and
   writes the outbox row for the live relay.
6. On failure: exponential backoff — 1s, 2s, 4s … capped at 60s (`mailbox-worker.ts:57`).
   After 5 attempts (`DEFAULT_MAX_ATTEMPTS`), the delivery is dead-lettered with reason
   `max-retries` and a `mailbox_dead_letters` row is written.

The worker is unref'd (`index.ts:783`) so it does not block process shutdown.

### How the UI reads messages

- `GET /api/projects/:projectId/mailbox` — project-scoped inbox.
- `GET /api/mailbox` — global single-user inbox (project-less messages).
- Both return `(recipient, message)` pairs filtered by `unreadOnly` / `actionableOnly`.
- `POST .../recipients/:id/read|action|dismiss` — recipient state changes; each re-emits the
  message fact via the outbox so the unread/actionable summary updates live.

### Live events pushed to the UI

Two event types flow through the `live_outbox` relay:
- `mailbox.message.changed` — on enqueue and on recipient state change; carries a
  `recipientSummary` (total/unread/actionable count).
- `mailbox.delivery.changed` — on accept/retry/dead-letter; keyed by delivery id (not message
  id) to avoid colliding with the message frame in the client live store.
  (`app-services/src/mailbox/mailbox-service.ts:302-309`).

### `PendingInteractionService` (related but separate)

`PendingInteractionService` (`app-services/src/mailbox/pending-interaction-service.ts`) owns the
`pending_interactions` lifecycle (create/answer/cancel/expire). A `pending_interactions` row is
the durable record for an agent ask or approval; the mailbox message carries its `interactionId`
as a link. Answering an interaction writes the answer to the DB and emits
`pending-interaction.changed` via the outbox. The HTTP answer route lives at
`POST /api/projects/:projectId/pending-interactions/:id/answer` and is explicitly a "durable
shadow" — the in-memory resolver in `/api/ask` is still the authoritative unblock path.

---

## Integrations (how it connects)

- **Depends on:**
  - `@pc/db` — five mailbox tables (`mailbox_messages`, `mailbox_recipients`,
    `mailbox_deliveries`, `mailbox_dead_letters`, `mailbox_audit`) + `live_outbox` (via
    `insertLiveEvent`).
  - `ConversationSendService` — injected into `MailboxOrchestratorTurnAdapter`; the one caller
    that actually injects a message into an orchestrator session.
  - `getActiveOrchestratorSession` (`@pc/db`) — resolves an `active-orchestrator` address to
    the current live session id.

- **Used by:**
  - `agent-run-terminal-effects.ts` — terminal envelope delivery.
  - `agent-run-factory.ts` — queued-start envelope delivery.
  - `pause-resume.ts` — ask/approval envelope delivery.
  - Workflow engine — `workflow-run-failed` enqueue.
  - HTTP callers via `POST /api/mailbox/messages`.

- **Contracts / events crossed:**
  - `MailboxAddress` union + `MailboxMessageKind` + `MailboxDeliveryChannel` enums — all in
    `packages/contracts/src/mailbox.ts`.
  - `mailbox.message.changed` and `mailbox.delivery.changed` live-event frames (WS → UI).
  - `pending-interaction.changed` live-event frame.

---

## Target shape (per north star)

Per `unified-process-supervision-2026-06-02.md §7` the mailbox IS the target shape for this
concern. It is already the one "notify door" — no competing path.

Ledger verdict (`consolidation-ledger-2026-06-02.md §2` Notification/delivery):
**KEEP** — `mailbox / deliverAgentEnvelope` is the durable notify door; no merge/delete action.

What does need to happen before this is fully clean:

- **Migrate `inbox-drain.cjs` → mailbox.** The hook still reads/writes the old `agent_inbox` and
  `agent_delivery_audit` tables via raw SQL (lines 66/74/77 of the hook). Until that refactor
  lands, the `agent_inbox` tables cannot be dropped. Ledger row 9 is gated on this.
- **`active-orchestrator` address resolution is a live-DB lookup.** When the orchestrator is not
  running, the delivery fails immediately (non-retryable: `'no orchestrator session resolvable'`,
  `mailbox-worker.ts:140`). This is correct behaviour — it reaches max-retries and dead-letters.
  Under the target architecture the Brain's reconciler would re-dispatch on reconnect; today
  dead-lettered messages don't auto-recover.
- **`compat-channel` is reserved but unimplemented.** Deliveries with that channel dead-letter
  immediately (`mailbox-worker.ts:162`). No callers enqueue with it today — safe to ignore until
  needed.

---

## Known issues / scar tissue

1. **Dead-lettered orchestrator-turn messages don't auto-recover.** If the orchestrator was down
   when max-retries was hit, the delivery is dead-lettered and there is no sweep to retry it
   once the orchestrator comes back. The human inbox copy (ui-inbox channel) survives — the
   orchestrator copy is lost. The fix is either a longer `maxAttempts` ceiling or a dead-letter
   requeue endpoint, neither of which exists yet.

2. **`inbox-drain.cjs` hook is a parallel path.** The hook (`templates/.claude/hooks/inbox-drain.cjs`)
   still drains the legacy `agent_inbox` table on every `UserPromptSubmit`. That table is written
   by nobody on the server path today (the TS repo at `repos/agent-inbox.ts` has zero callers),
   but the hook's raw SQL writes are still live. It creates an invisible secondary delivery path
   that runs inside the orchestrator's Claude process, not the server worker. Must be refactored
   to enqueue a mailbox message instead (and the `agent_inbox` tables dropped after).
   Ledger entry: `consolidation-ledger-2026-06-02.md §2 Dead/legacy`.

3. **`active-orchestrator` address resolved at delivery time, not enqueue time.** If the session
   id changes between enqueue and the first worker pass (e.g. orchestrator restarts), the
   delivery resolves the new session correctly — that is intentional. But if no orchestrator
   session exists on ANY of the 5 attempts, the message is dead-lettered silently. No alert or
   UI indicator surfaces this today.

4. **Delivery frame `entityId` was changed to `delivery.id` (not `messageId`) in slice 015b**
   to prevent collisions in the client live store (`mailbox-service.ts:302-308`). Consumers must
   read `payload.messageId` not the frame's `entityId` when correlating. This is documented in a
   comment but easy to miss.

5. **`compat-channel` deliveries dead-letter immediately** with `'unsupported delivery channel'`.
   If any future code enqueues with that channel without wiring the worker branch first, those
   deliveries will silently fail after 5 attempts.

---

## Open questions

1. **Dead-letter recovery.** Should there be a requeue endpoint or a periodic sweep for dead-lettered
   `orchestrator-turn` deliveries once an orchestrator comes back online?

2. **`inbox-drain.cjs` migration order.** Which slice / step owns this refactor? It is a prereq
   for dropping `agent_inbox` tables (ledger step 9) but has no assigned owner.

3. **`PendingInteractionService` answer authority.** The in-memory resolver (`/api/ask`) is still
   the authoritative unblock path; `PendingInteractionService.answer` is a "durable shadow." When
   does the durable path become the sole authority, and does the orchestrator-turn adapter need
   to be wired to answer/resume agent runs as a result?

4. **Worker interval.** 1-second sweep with a 30-second lease. Under high agent throughput (many
   concurrent runs completing at once), does the 50-message-per-pass cap cause delivery lag? No
   monitoring on queue depth today.
