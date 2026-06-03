# Mailbox & Notifications

> **Role:** cross-cutting (Brain writes, Engine reads, UI views)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `packages/contracts/src/mailbox.ts` · `packages/db/src/repos/mailbox.ts`
> `packages/app-services/src/mailbox/mailbox-service.ts`
> `packages/app-services/src/mailbox/pending-interaction-service.ts`
> `packages/app-services/src/mailbox/adapters.ts`
> `apps/server/src/services/mailbox-worker.ts`
> `apps/server/src/services/mailbox-orchestrator-turn-adapter.ts`
> `apps/server/src/services/agent-delivery.ts`
> `apps/server/src/features/mailbox/routes.ts`

---

## What it is (plain English)

**Think of it as a real mailbox.** When an agent finishes a job, fails, asks a question, or needs a human to approve something, it drops a message into the mailbox. The message sits there safely — in the database — until it gets delivered to whoever is supposed to see it: either the person's inbox in the UI, or the AI orchestrator as its next conversation message. If the recipient is offline, the message waits. When they come back, it delivers automatically. Nothing is lost because someone was away.

---

## What it's supposed to do (intent)

Own the **single channel through which agents and workflows notify people and the orchestrator.** Nothing else is allowed to send these notifications — no direct message-pushes, no HTTP shortcuts that bypass this queue. It exists so that a notification survives a server restart, an orchestrator reboot, or a user closing the tab. The message is durable the moment it is written.

> **FD-3 (locked):** The mailbox is the **only** notify door. The old "channel notification system" — a separate process that also pushed notifications — has been sentenced to deletion. See Target shape.

---

## The parts (every component, plain English)

### 1. The message

Every notification is a **message** stored in three linked database rows. Together they capture: what the message says, who it's for, and what state the delivery is in.

**The message itself** (`mailbox_messages` table) holds:

| Field | Plain meaning | Example |
|---|---|---|
| `kind` | What type of event this is | `agent-terminal`, `agent-question`, `agent-approval`, `workflow-review`, `workflow-run-failed`, `runtime-hook-ask`, `system-notice`, `external-webhook` |
| `subject` | A short summary line | "Agent 'writer' completed" |
| `body` | The full message text | (the agent's output, a question, etc.) |
| `payload` | Structured data for the app to act on | JSON with run ID, project ID, etc. |
| `source` | Who sent it | `agent-run-manager`, `workflow-engine` |
| `interactionId` | Links to a pending approval or question, if this message requires a reply | (a UUID, or empty) |
| `idempotencyKey` | Prevents the same message from being written twice if something retries | (a hash of the event) |
| `projectId` | Which project this belongs to (`null` = global / not project-specific) | a UUID, or null |

(`contracts/src/mailbox.ts:43`)

### 2. The addressees

**Who gets the message** is a separate row per recipient (`mailbox_recipients` table). Each row holds a typed address and tracks whether the person has read, acted on, or dismissed the message — so the "unread" badge in the UI stays accurate.

Address types the system knows about (`contracts/src/mailbox.ts:22`):

| Address kind | Plain meaning |
|---|---|
| `user-inbox` | Show this in the person's global inbox |
| `project-inbox` | Show this in a specific project's inbox |
| `active-orchestrator` | Deliver to whichever orchestrator session is alive right now |
| `orchestrator-session` | Deliver to one specific named orchestrator session |
| `agent-run` | Deliver to a specific agent run (reserved / future use) |
| `workflow-review` | Deliver to a workflow's human-review gate |

One message can have multiple recipient rows — for example, a failed workflow notifies both the human inbox AND the active orchestrator.

### 3. The delivery attempts

**How it gets there** is tracked in yet another row per (recipient × delivery method) (`mailbox_deliveries` table). "Delivery method" here means: is this message headed to the UI inbox, or being injected as a conversation turn for the orchestrator? These are called delivery channels in the code — that word means **delivery method only**, and has nothing to do with the old channel-server notification system (which is dead per FD-3).

Delivery method kinds:

| Method (code: "channel") | Plain meaning |
|---|---|
| `ui-inbox` | Appears in the inbox panel in the app |
| `orchestrator-turn` | Injected as the orchestrator's next conversation message |
| `compat-channel` | Reserved, not wired — dead-letters immediately |

The delivery row tracks: status (`pending` → `leased` → `accepted` / `retrying` / `dead-lettered`), how many attempts have been made, when the next attempt is scheduled, and a reference to the created result (the send-queue row or UI-inbox row).

### 4. Who writes messages (the senders)

Five callers can drop a message into the mailbox today:

1. **When an agent finishes, fails, asks, or requests approval** — `agent-run-terminal-effects.ts:453` calls `deliverAgentEnvelope`.
2. **When a queued agent's turn to run opens up** — `agent-run-factory.ts:1142` sends a `queued-started` envelope.
3. **When an agent pauses to ask a question** — `pause-resume.ts:221` sends the ask envelope.
4. **When a workflow run fails** — the workflow engine enqueues a `workflow-run-failed` message targeting both the human inbox and the active orchestrator.
5. **Via HTTP** — `POST /api/projects/:projectId/mailbox/messages` and `POST /api/mailbox/messages` let the server or an external caller enqueue directly (`features/mailbox/routes.ts:99,108`).

All internal callers go through `deliverAgentEnvelope` (`agent-delivery.ts:86`), which calls `MailboxService.enqueue`. The enqueue is idempotent on `idempotencyKey` — calling it again with the same key returns the existing rows and emits nothing new.

> ☠ **`inbox-drain.cjs` hook — legacy, must be migrated (FD-3 / ledger row 9).** The hook (`templates/.claude/hooks/inbox-drain.cjs`) still reads and writes the old `agent_inbox` tables via raw SQL on every user message. It is a parallel delivery path that runs inside the orchestrator's Claude process, completely outside this worker. The `agent_inbox` tables cannot be dropped until this is refactored to enqueue a mailbox message instead. This is the one surviving piece of the pre-mailbox world; it must die.

### 5. The 1-second postman (the worker loop)

**`MailboxWorker`** (`mailbox-worker.ts:75`) runs every 1 second (`apps/server/src/index.ts:775–782`). On each pass it:

1. Fetches up to 50 deliveries that are due (`db/repos/mailbox.ts:293`).
2. **Claims** each one with an atomic database update — only one worker pass can own a row at a time. Lease duration: 30 seconds.
3. **`ui-inbox` deliveries:** immediately accepted — the recipient row already exists in the DB from enqueue, nothing else needed.
4. **`orchestrator-turn` deliveries:** looks up the live orchestrator session, then calls the turn adapter (see part 6 below).
5. **On success:** marks the delivery `accepted` and records the created row reference.
6. **On failure:** retries with exponential backoff — 1s, 2s, 4s … capped at 60s. After 5 failures, the delivery is dead-lettered and a `mailbox_dead_letters` row is written.

The worker is "unref'd" — it does not prevent the server process from shutting down cleanly.

### 6. How the orchestrator receives one (injected turn)

When the postman has an `orchestrator-turn` delivery to make, it calls `MailboxOrchestratorTurnAdapter.deliver` (`mailbox-orchestrator-turn-adapter.ts:33`), which calls `ConversationSendService.enqueueRuntimeTurn` with a stable message ID of `mb:<deliveryId>`. The stable ID makes retries safe — the same send-queue row comes back if the worker tries twice.

> **FD-3 requirement (locked):** injected turns must be:
> 1. **Clearly labeled as system messages** in the injected text — the orchestrator and anyone reading the transcript can always tell a system notification from a human message.
> 2. **Tagged with a machine-readable source/kind** all the way from the send-queue row through the transcript to the live events, so the frontend can filter them (e.g. a "hide system messages" toggle). The send-queue contract already carries a `source` field; the rebuild must carry that tag through to the chat renderer. *(Partial today.)*

### 7. How the UI inbox reads them

Two HTTP endpoints serve the inbox panels:

- `GET /api/projects/:projectId/mailbox` — project inbox.
- `GET /api/mailbox` — the global user inbox (project-less messages).

Both return (recipient, message) pairs, filterable by `unreadOnly` / `actionableOnly`. State changes (`read`, `action`, `dismiss`) are `POST`ed to `.../recipients/:id/read|action|dismiss` — each re-emits the message fact through the live-event path so the unread badge updates without a page refresh.

Two live-event types flow to the UI via the `live_outbox` relay:
- `mailbox.message.changed` — on enqueue and on any recipient state change; includes a `recipientSummary` (total/unread/actionable count).
- `mailbox.delivery.changed` — on accept/retry/dead-letter; keyed by **delivery ID** (not message ID) to avoid collisions in the client live store (`mailbox-service.ts:302–309`). Consumers must read `payload.messageId` to correlate — not the frame's `entityId`.

### 8. The "waiting for an answer" record (pending interactions)

Some messages require a reply — an agent asking a question, or a workflow pausing for approval. These use a **`pending_interactions`** row (`pending-interaction-service.ts`) as the durable record of the open question. The mailbox message carries the interaction's ID as a link (`interactionId`). When someone answers, the answer is written to the DB and `pending-interaction.changed` fires via the live-event path.

The HTTP answer route lives at `POST /api/projects/:projectId/pending-interactions/:id/answer`. Today this is a "durable shadow" — the in-memory resolver at `/api/ask` is still the authoritative path that actually unblocks the agent. The durable path does not yet replace it.

---

## How it connects

- **Depends on:** `@pc/db` — five mailbox tables (`mailbox_messages`, `mailbox_recipients`, `mailbox_deliveries`, `mailbox_dead_letters`, `mailbox_audit`) + `live_outbox` (via `insertLiveEvent`); `ConversationSendService` (injected into the turn adapter; the one caller that actually puts a message into an orchestrator session); `getActiveOrchestratorSession` (resolves `active-orchestrator` to the current live session).
- **Used by:** `agent-run-terminal-effects.ts`, `agent-run-factory.ts`, `pause-resume.ts`, workflow engine, HTTP callers.
- **Contracts / events:** `MailboxAddress` union + `MailboxMessageKind` + `MailboxDeliveryChannel` — all in `packages/contracts/src/mailbox.ts`; `mailbox.message.changed`, `mailbox.delivery.changed`, `pending-interaction.changed` live-event frames.

---

## Target shape (per north star + Foundation Decisions)

**FD-3 is locked:** the mailbox is already the one notify door. The old channel-server notification system — every piece of it — is sentenced to deletion.

What the channel system was (all dead): the per-orchestrator channel-server child process, the `--dangerously-load-development-channels` spawn flag, the regex-matched auto-confirm of Claude's dev-channel boot prompt, the `channel-event` direct-to-UI relay bypass, and the config-filtering machinery it required. All gone.

**What still needs to happen before this is fully clean:**

1. **Migrate `inbox-drain.cjs` → mailbox** (ledger row 9). The legacy hook must be rewritten to enqueue a mailbox message instead of writing raw SQL to `agent_inbox`. Until that lands, `agent_inbox` tables cannot be dropped.

2. **FD-3 injected-turn tagging** — system-label + machine-readable source/kind tag must flow all the way through to the chat renderer. The send-queue `source` field exists today; the rest of the chain is not yet complete.

3. **Dead-letter recovery for `orchestrator-turn` messages** — if the orchestrator is down for all 5 attempts, the delivery dies silently (see Known issues). The target architecture has the Brain's reconciler re-dispatch on reconnect; today there is no sweep.

4. **`compat-channel` cleanup** — reserved and unused; dead-letters immediately. Safe to ignore until a real use appears, then wire the worker branch before any caller uses it.

---

## Known issues / scar tissue

1. **Dead-lettered orchestrator-turn messages don't auto-recover.** If the orchestrator was down for all 5 attempts, the delivery is dead-lettered. The human-inbox copy (`ui-inbox` channel) survives — the orchestrator copy is silently gone. No alert, no UI indicator, no requeue path today. Fix is either a longer `maxAttempts` ceiling or a dead-letter requeue endpoint.

2. **`inbox-drain.cjs` is a parallel path.** See Part 4 above. The hook's raw SQL writes create an invisible secondary delivery path inside the orchestrator's Claude process, outside the worker. Must go.

3. **`active-orchestrator` resolved at delivery time, not enqueue time.** If no orchestrator session exists on ANY of the 5 worker attempts, the message is dead-lettered with no visible alert. Intentional behavior for the "orchestrator not running" case, but there is currently no surface that shows the owner their message was lost.

4. **Delivery frame `entityId` is the delivery ID, not the message ID.** Changed in slice 015b to prevent collisions in the client live store (`mailbox-service.ts:302–308`). Consumers must read `payload.messageId` to correlate with a message — not the frame's `entityId`. Documented in a code comment but easy to miss.

5. **`compat-channel` dead-letters immediately** with `'unsupported delivery channel'`. If any future code enqueues with that channel before wiring the worker branch, those deliveries will silently fail after 5 attempts.

---

## Decisions & open questions

**For Emerson (product calls):**

1. **When should the orchestrator get a dead-letter recovery UI?** If the orchestrator was down when a notification arrived and all retries failed, today that notification is silently gone on the orchestrator side (the human inbox copy survives). Is that acceptable, or should the product show a visible "missed notification" indicator?

2. **Should system-injected orchestrator messages be hidden by default in the transcript view?** FD-3 requires them to be tagged so they *can* be filtered — but the product call is whether the toggle is on or off by default. (Most owners probably don't want to see internal plumbing messages in their conversation thread.)

3. **`inbox-drain.cjs` migration timing.** This is the last piece of the pre-mailbox world still running. What slice/step owns it? It blocks dropping the `agent_inbox` tables (ledger row 9).

**Technical:**

- **Dead-letter requeue:** build a periodic sweep that retries dead-lettered `orchestrator-turn` deliveries once an orchestrator comes back online — or raise the `maxAttempts` ceiling as a short-term fix?
- **`PendingInteractionService` answer authority:** the in-memory resolver at `/api/ask` is still the actual unblock path; the durable `PendingInteractionService.answer` is a shadow. When does the durable path become sole authority, and does the turn adapter need to wire answer/resume as a result?
- **Worker throughput:** 1-second sweep, 50-message cap, 30-second lease. Under high agent concurrency, does the 50-per-pass ceiling cause delivery lag? No queue-depth monitoring exists today.
