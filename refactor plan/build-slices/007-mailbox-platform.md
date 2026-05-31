# 007 Mailbox Platform

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-05-30 (hardened on opus from the original draft) |
| Branch | `refactor/auto-pathway` |
| Commit | baseline `c7bd0fb2` (slices 001/002/003 verified — tags `slice-00{1,2,3}-verified`; 004/005/006 built + fix, human review pending) |
| Artifact status | Planned build slice |
| Owning roadmap phase | Phase 8 mailbox + pending-interaction platform |
| Slice subject | The durable mailbox PLATFORM: message/recipient/delivery contracts, additive DB tables + repos (the FIRST real schema migration of the refactor), enqueue/lease/ack/retry/dead-letter delivery semantics, a UI inbox surface, an orchestrator-turn delivery worker built OVER the slice-006 `ConversationSendService.enqueueRuntimeTurn` facade, and the deferred slice-006 `/api/ask` pending-interaction ask-shadow + `pending_interactions` table — all additive, with Channel left fully in place |
| Implementation target | This repo. Do not create a parallel app. |
| Scope rule | This is a build plan only. Do not implement until the user explicitly asks to build. |

Decision:

- **Recommendation:** Build the mailbox as the durable delivery primitive defined by `refactor plan/foundation specs/mailbox-and-pending-interactions.md`, additively and NEXT TO the existing Channel/`agent_inbox` path — do NOT cut any sender over to it (cutover is slice 008). Add browser-safe contracts (message/recipient/delivery DTOs, the typed `MailboxAddress` recipient union, pending-interaction DTOs, enqueue/ack/list command shapes, canonical live payloads); add the additive DB tables (`pending_interactions`, `mailbox_messages`, `mailbox_recipients`, `mailbox_deliveries`, `mailbox_dead_letters`, `mailbox_audit`) as the first real migration of the refactor with explicit fresh-DB-boot safety; add `MailboxService` + `PendingInteractionService` over those repos following the slice-002/003/004/005 single-transaction outbox-write-door pattern; add a delivery worker with lease/ack/retry/dead-letter semantics; add an orchestrator-turn delivery channel whose adapter wraps the slice-006 `enqueueRuntimeTurn` facade (never a raw send); land the deferred slice-006 `/api/ask` shadow as the first `pending_interactions` writer; add a UI inbox feature; and emit canonical `mailbox.*` / `pending-interaction.changed` visibility facts on the slice-002 `live_outbox` with legacy projections.
- **Reason:** The mailbox foundation spec is explicit (Sections 4–10): mailbox owns messages/recipients/delivery leases/retries/acks/dead-letters/audit; pending interactions own ask/review/approval action state separately; recipients use a typed address union; the UI inbox is the first-class surface for user/human decisions; orchestrator-addressed messages deliver through the app send-service facade over `orchestrator_send_queue` (NOT raw PTY, NOT Channel); the first orchestrator-turn acknowledgement is "accepted by the send service" with the send-queue row id stored as `target_ref`; live events are visibility nudges, not delivery receipts. Code inspection confirms the substrate already exists: the slice-006 `ConversationSendService.enqueueRuntimeTurn` (`packages/app-services/src/conversations/send-service.ts:169`) is the idempotent, never-raw-send command the spec's `RuntimeTurnDeliveryPort` was written around (the shapes differ — see §3 and §8); the slice-002 `live_outbox` + replay route + dual fanout (reused by 003/004/005) is the visibility spine; and the `/api/ask` in-memory resolver (`apps/server/src/features/chat-bridges/routes.ts:122`) is the first concrete `pending_interactions` writer (the slice-006 ask-shadow, deferred to here). So slice 007 is the platform build (contracts + tables + repos + services + worker + inbox + ask-shadow), NOT a cutover.
- **Compatibility stance:** Everything is additive. The mailbox runs ALONGSIDE Channel; no agent/workflow/webhook sender is moved off `enqueueAndPush`/`postChannel`/`/channel/:slug/:source` this slice. The `/api/ask` in-memory resolver stays the authoritative answer path; the shadow row is inspectable, not the authority. New tables are additive with nullable/defaulted columns; the migration is designed to survive a fresh DB boot under the repo's `assertSchemaIntact()` drift guard. No legacy route, WS envelope, or table is removed (cleanup is slice 011).

## 2. Problem Statement

Verified facts (code-evidence based, this checkout `c7bd0fb2`):

- **There is no mailbox or pending-interaction code today.** `rg "pending_interactions|mailbox_messages|mailbox_recipients|mailbox_deliveries" --glob "!archive/**"` returns ONLY plan/spec docs — no schema, no repo, no service, no web feature. `packages/contracts/src/` has no `mailbox.ts` / `pending-interactions.ts`. `packages/app-services/src/` = `agent-runs/`, `conversations/`, `projects.ts`, `workflows/`, `work-items/` — no `mailbox/`. There is no `packages/mailbox` package.
- **The slice-006 send facade is the runtime-turn COMMAND the worker wraps — but its shape DIFFERS from the spec's proposed port.** `ConversationSendService.enqueueRuntimeTurn({ projectId, sessionId, clientMessageId, text, source?, sourceRef? })` (`packages/app-services/src/conversations/send-service.ts:169`) is **synchronous**, idempotent by `(sessionId, clientMessageId)` (returns the existing row on replay via `getOrchestratorSendByClientMessageId`), NEVER raw-sends (the delivery loop drains the queued row), and returns `{ row: OrchestratorSendQueueRow; created: boolean }`. `source` is `RuntimeTurnSource = 'user'|'mailbox'|'workflow'|'system'` (`packages/contracts/src/runtime-send-queue.ts:37`) — so a `'mailbox'` value exists. **It is NOT the exact `RuntimeTurnDeliveryPort` interface the foundation spec §8 sketches** (that one is `async`, takes required `source:'mailbox'`/`messageId`/`deliveryId`, and returns `Promise<{ ok:true; sendQueueId } | { ok:false; error; retryable }>`). The real facade gives the worker a row synchronously and signals failure only by THROWING. The mailbox worker's `orchestrator-turn` channel must wrap this real facade in a small adapter: call `enqueueRuntimeTurn`, treat a returned `row` (created or replayed) as `accepted`, store `{ kind:'send-queue', id: row.id }` as `target_ref`, and treat a thrown enqueue error as a retryable failure. Do NOT re-implement send, and do NOT widen `enqueueRuntimeTurn` to the spec's async shape this slice (that is gold-plating; the sync facade is sufficient for "accepted = a send-queue row exists").
- **The `/api/ask` flow is an in-memory blocking resolver with NO durable shadow, and does NOT yet use the slice-006 contract parser.** `chat-bridges/routes.ts` (`InMemoryPendingAskStore` at `:16`, `app.post('/api/ask')` at `:122`) parses the body INLINE (not via `parseRuntimeHookAskRequest`), broadcasts the `{ type:'ask', ... }` WS envelope, then `await`s a `Promise` keyed by `toolUseId` (resolved by `ask-reply` in `runtime-host/websocket-message.ts:152`, or a 10-minute timeout that resolves with the literal text `'(timeout — no user response)'`), and returns `{ answer }` inline (`:148`). A server restart loses the resolver. The `PendingAskStore` is INJECTED (`deps.pendingAsks`, `createPendingAskStore()` at `:40`) — that injection point is the clean shadow seam. The slice-006 plan specified a durable `pending_interactions` shadow row here; **slice 006 DEFERRED it to slice 007** (its tracker row + the contract banner record the human decision). The parse-only `runtime-hook-ask.ts` contract already shipped (slice 006) with a reserved optional `interactionId` on the response (`packages/contracts/src/runtime-hook-ask.ts:22`) — this slice is its first writer.
- **The slice-002 outbox + replay spine is shipped and reused.** `live_outbox` table/repo (`insertLiveEvent`, `listLiveEventsAfter`, `getLiveEventHighWater`), `/api/live-events` replay, the `LiveEvent`/`LiveEventFrame` envelope (`packages/contracts/src/live-events.ts`), and dual canonical/legacy fanout exist (slices 003/004/005 added entities `work-item`/`stage`/`field-schema`/`attachment`/`workflow-definition`/`workflow-run`/`workflow-review`/`agent-run`). `LiveEventEntity` / `LiveEventTypeName` / the `live_outbox.entity` `$type` union do NOT yet include any mailbox/pending-interaction entity.
- **`listLiveEventsAfter` scope filtering is strict — and this constrains the global user-inbox design.** `listLiveEventsAfter` (`packages/db/src/repos/live-outbox.ts:89`) returns ONLY `scope='global'` events when no `projectId` is supplied; with a `projectId` it returns that project's scoped events (and global too only when `includeGlobal`). `insertLiveEvent` asserts `scope='global' ⟺ projectId IS NULL` (`:157`), and the `0035` SQL CHECK + schema enforce the same. **Consequence (corrects the draft):** a `user-inbox` message with `projectId: null` CANNOT be emitted as a `scope:'project'` event — it must be `scope:'global'` with `projectId: null`, and the web global-inbox hook must replay with `includeGlobal=1` (or a `projectId`). Only project-bound mailbox/interaction rows are `scope:'project'`.
- **The mutation-gateway pattern is established (slices 002–005).** Each durable family has a single write door that, in one `getDb().transaction`, runs the product mutation + `insertLiveEvent` + re-reads the post-write row, returning a publication the server composition layer fans out (canonical frame + legacy envelope) AFTER commit; a rollback emits nothing (`packages/app-services/src/agent-runs/run-gateway.ts`, `workflows/run-gateway.ts`, `work-items/`). The gateway takes a deps seam (`transaction`, `insertLiveEvent`, repo fns) for test injection. Mailbox/pending-interaction services should mirror it.
- **Migrations are hand-authored SQL in `packages/db/drizzle/`, applied by `runMigrations()`.** The latest is `0035_live_outbox.sql` (journal idx 35); the next is `0036_*`. `runMigrations()` (`packages/db/src/migrate.ts:20`) runs drizzle's `migrate()` then **`assertSchemaIntact()`** (`:23`/`:34`), which fails fast if any `schema.ts`-declared table/column is absent from the live DB. The function comment warns: drizzle decides what to apply by the last-applied timestamp in `__drizzle_migrations`, NOT by inspecting the schema — a ledger that records a migration applied while its columns are absent silently skips the real CREATE/ALTER and the code crashes later with `no such column`/`no such table` (the MEMORY "Drizzle ledger lies → fresh-DB boot crash" risk; migrations 0015+ are hand-authored, meta snapshots stale, `schema.ts` is the source of truth). **This is the FIRST real schema migration of the refactor** (002–006 were strictly no-migration / type-only union widening), so the migration-safety care is load-bearing.
- **The slice-002 `live_outbox` migration is the additive-table template to mirror.** `0035_live_outbox.sql` is a clean `CREATE TABLE` + indexes with CHECK constraints, no ALTER of existing tables, journal entry idx 35 (per-entry `version:"6"`; the top-level journal `version` is `"7"` — do not confuse the two), `--> statement-breakpoint` separators, monotonic `when` (`1781481600000`). New mailbox tables follow the same shape (CREATE-only, no destructive ALTER, no rewrite of existing rows).
- **The existing `live-outbox.test.ts` already proves the fresh-DB apply pattern.** `packages/db/test/live-outbox.test.ts:22` runs `runMigrations()` in `before()` against a fresh tmp `PC_DATA_DIR` — which runs `assertSchemaIntact()`. So any schema/SQL drift on the new tables would already throw there; the new migration test (§11) extends this pattern with explicit table/column assertions.
- **Channel / `agent_inbox` / `pending_asks` delivery are intact and stay intact.** `ChannelServer` owns `/channel/:slug/:source`, `/channel-register`, the live registrant map, `emitToSession`, and `channel-event` (`apps/server/src/services/channel-server.ts:59,73,115,194,247`). `enqueueAndPush`/`drainPendingForSession` (`apps/server/src/services/agent-delivery.ts:71`) write `agent_inbox` + best-effort Channel push (transport modes `hybrid`/`inbox-only`/`channel-only` via `PC_DELIVERY_TRANSPORT`). Agent pause/resume delivery (`pause-resume.ts`), terminal effects (`agent-run-terminal-effects.ts`), factory (`agent-run-factory.ts`), and workflow review (`dag-run-service.ts` `postChannel` at `:666`, `orchestrator-review-step.ts`) all call `enqueueAndPush`/`postChannel`. **This slice changes NONE of those call sites** — cutover is slice 008.
- **Agent `pending_asks` is a separate durable table** (`packages/db/src/repos/pending-asks.ts`, schema `schema-agent-system.ts`) with atomic `WHERE status='open'` flips. The foundation spec keeps it as the agent-run compatibility source (§2 decision) and DOES NOT mirror it into `pending_interactions` in the first mailbox slice (§15 open question; slice-005 deferred the mirror here, and the spec defers the mirror decision). This slice does NOT touch or mirror `pending_asks`.
- **The web has no mailbox/inbox feature.** `apps/web/src/features/` has `agent-runs/`, `runtime/`, `live/`, `workflows/`, `work-items/`, etc., but no `mailbox/`. Agent pending-ask client types are local to `agent-runs/`. The slice-002 web live client (cursor/replay) exists and is reused.

Synthesis — this slice implements the mailbox platform cartridge layer, additive and pre-cutover:

```text
contract (mailbox message/recipient/delivery + recipient address union + pending-interaction DTOs + canonical mailbox.* payloads)
  -> DB (FIRST real migration: additive pending_interactions + mailbox_* tables + repos)
  -> app-service write door (MailboxService + PendingInteractionService over the slice-002 single-tx outbox pattern)
  -> delivery worker (lease/ack/retry/dead-letter; orchestrator-turn channel ADAPTER wraps slice-006 enqueueRuntimeTurn)
  -> route adapter (mailbox HTTP routes + the /api/ask ask-shadow writer)
  -> live event fact (mailbox.message.changed / mailbox.delivery.changed / pending-interaction.changed) on slice-002 outbox + legacy projections
  -> web inbox feature/hook + canonical fanout + cursor replay
  -> tests
```

## 3. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | No mailbox/pending-interaction code exists (no contracts, schema, repo, service, web feature, or `packages/mailbox`). | `rg "pending_interactions\|mailbox_messages\|mailbox_recipients\|mailbox_deliveries" --glob "!archive/**"` → docs only; `packages/contracts/src/`, `packages/app-services/src/`, `apps/web/src/features/` listings |
| Verified fact | The slice-006 `enqueueRuntimeTurn` facade is **synchronous**, idempotent by `(sessionId, clientMessageId)`, never raw-sends, returns `{ row, created }`, accepts `source?: RuntimeTurnSource` + `sourceRef?: string`. It is NOT the spec §8 async `RuntimeTurnDeliveryPort` shape; the worker wraps it. | `packages/app-services/src/conversations/send-service.ts:169-195` |
| Verified fact | `RuntimeTurnSource` includes `'mailbox'`; `parseSendRuntimeTurnRequest` validates it. | `packages/contracts/src/runtime-send-queue.ts:37,84` |
| Verified fact | `/api/ask` is an in-memory blocking resolver keyed by `toolUseId`, parsed inline (NOT via `parseRuntimeHookAskRequest`), resolved by `ask-reply`, 10-min timeout text `'(timeout — no user response)'`, returns `{ answer }` inline; `PendingAskStore` is injected via `deps.pendingAsks`. Restart loses it; no durable shadow. | `apps/server/src/features/chat-bridges/routes.ts:16,40,122,136,138,143,148`; `runtime-host/websocket-message.ts:152` |
| Verified fact | Slice 006 DEFERRED the durable ask-shadow + `pending_interactions` table to slice 007 (human decision); the parse-only `runtime-hook-ask` contract already shipped with a reserved optional `interactionId`. | `refactor plan/refactor-session-tracker.md` Session 24 row + slice 006 doc banner; `packages/contracts/src/runtime-hook-ask.ts:22` |
| Verified fact | Slice-002 outbox/replay/dual-fanout spine shipped; `LiveEventEntity`/`LiveEventTypeName`/`live_outbox.entity` `$type` cover project/work-item/stage/field-schema/attachment/workflow-definition/workflow-run/workflow-review/agent-run — NOT mailbox/pending-interaction. | `packages/contracts/src/live-events.ts:4-37`; `packages/db/src/schema.ts:86-98`; `packages/db/src/repos/live-outbox.ts:9-18` |
| Verified fact | `/api/live-events` is fully contract-driven: it calls `parseListLiveEventsQuery` and `listLiveEventsAfter` with no server-side type allow-list — widening `LiveEventTypeName` + `LIVE_EVENT_TYPE_NAMES` in contracts is the only change needed for the route to accept the new `type=` filters. | `apps/server/src/features/live-events/routes.ts:9-39`; `packages/contracts/src/live-events.ts:27-43,114-143` |
| Verified fact | `listLiveEventsAfter` returns ONLY `scope='global'` events when no `projectId` is passed; project-scoped requires `projectId`; `global ⟺ projectId IS NULL` is asserted. This constrains the global user-inbox to `scope:'global'`. | `packages/db/src/repos/live-outbox.ts:89-121,157-159`; `0035_live_outbox.sql` CHECK |
| Verified fact | The single-transaction outbox-write-door gateway pattern is established and to be mirrored, with a deps seam (`transaction`/`insertLiveEvent`/repo fns) for test injection. | `packages/app-services/src/agent-runs/run-gateway.ts:1-69` |
| Verified fact | Migrations are hand-authored SQL in `packages/db/drizzle/`; latest `0035_live_outbox` (journal idx 35); next is `0036_*`; per-entry `version:"6"`, top-level journal `version:"7"`. | `packages/db/drizzle/` listing; `packages/db/drizzle/meta/_journal.json` |
| Verified fact | `runMigrations()` runs drizzle `migrate()` then `assertSchemaIntact()`, which fails fast on any `schema.ts` table/column missing from the live DB (the ledger-drift guard); `schema.ts` is the source of truth. | `packages/db/src/migrate.ts:20-58` |
| Verified fact | `0035_live_outbox.sql` is the additive-CREATE template (CREATE TABLE + CHECK + indexes, `--> statement-breakpoint`, no ALTER of existing tables). | `packages/db/drizzle/0035_live_outbox.sql` |
| Verified fact | `live-outbox.test.ts` already runs `runMigrations()` on a fresh tmp DB in `before()`, exercising `assertSchemaIntact()`. | `packages/db/test/live-outbox.test.ts:7,22` |
| Verified fact | Channel/`agent_inbox`/`enqueueAndPush`/`postChannel`/`/channel/:slug/:source` are intact and called by agent pause/terminal/factory + workflow review. | `apps/server/src/services/channel-server.ts:59,73,194,247`; `agent-delivery.ts:71`; `dag-run-service.ts:666`; `orchestrator-review-step.ts:53` |
| Verified fact | Agent `pending_asks` is a separate durable table with atomic `WHERE status='open'` flips; the spec keeps it as the agent compatibility source and does not mirror it in the first mailbox slice. | `packages/db/src/repos/pending-asks.ts`; `schema-agent-system.ts`; foundation spec §2, §15 |
| Verified fact | The web has no mailbox/inbox feature; the slice-002 live client (cursor/replay) exists for reuse. | `apps/web/src/features/` listing |

## 4. Exact Scope

Implement only these behaviors when the user asks to build:

1. **Contracts.** Add a mailbox + pending-interaction contract family to `@pc/contracts` (`mailbox.ts`, `pending-interactions.ts`):
   - `MailboxAddress` typed recipient union exactly per spec §5 (`user-inbox` | `project-inbox` | `active-orchestrator` | `orchestrator-session` | `agent-run` | `workflow-review`) with a parser that rejects missing project/session/run/node ids (note `user-inbox.projectId` is intentionally `string | null`).
   - `MailboxMessageKind`, `MailboxDeliveryChannel`, `MailboxDeliveryStatus`, `MailboxMessageDto`, `MailboxRecipientDto`, `MailboxDeliveryDto` per spec §5.
   - `PendingInteractionKind`, `PendingInteractionStatus`, `PendingInteractionDto` per spec §5.
   - Command request shapes: `EnqueueMailboxMessageRequest` (message + recipients + optional interaction + idempotency key), `MarkRecipientReadRequest` / `ActionRecipientRequest` / `DismissRecipientRequest`, `ListMailboxQuery`, `AnswerPendingInteractionRequest`.
   - Parser/guard helpers per the contracts convention (browser-safe, zero deps, `ParseResult<T>`; no imports from apps, `@pc/db`, `@pc/domain` value imports, Hono, React, or Node built-ins).
2. **Canonical live-event payloads** built on the slice-002 `LiveEvent` + `{ type: 'live-event', event }` frame (visibility only, per spec §9):
   - `mailbox.message.changed` (entity `mailbox-message`; **scope `project` when project-bound, `global` when the message has no project context**; payload = message id/kind/recipient summary/unread+action hint, NO body leak across projects).
   - `mailbox.delivery.changed` (entity `mailbox-message`; scope matches the parent message; payload = delivery id/message id/status/attempts/target ref/last-error summary).
   - `pending-interaction.changed` (entity `pending-interaction`; project-scoped — `PendingInteractionDto.projectId` is non-null in the spec; payload = interaction id/kind/status/version).
   Extend `LiveEventEntity` with `'mailbox-message'` and `'pending-interaction'`, `LiveEventTypeName` + `LIVE_EVENT_TYPE_NAMES` with the three names, and (consequently) `parseListLiveEventsQuery` accepts them with no route change. Add NO legacy-projection adapter (mailbox + the durable interaction shadow are new surfaces; see §8).
3. **DB — the FIRST real migration (additive).** Add the six additive tables from spec §6 to `schema.ts` and a single new hand-authored `0036_*.sql` migration:
   - `pending_interactions`, `mailbox_messages`, `mailbox_recipients`, `mailbox_deliveries`, `mailbox_dead_letters`, `mailbox_audit` with the fields/indexes/idempotency-unique-index from spec §6.
   - **Migration-safety care (load-bearing — see §10):** CREATE-only, no ALTER of any existing table, no row rewrite; every `schema.ts` column present verbatim in the SQL so `assertSchemaIntact()` passes on a fresh DB; journal `0036` entry with a correct monotonic `when` (> `1781481600000`); verify a fresh-DB boot applies cleanly (the Drizzle ledger-lies trap).
   - Add repos (`mailbox.ts` or split, `pending-interactions.ts`) with: transactional enqueue (message + recipients + deliveries + optional interaction + audit + live_outbox in ONE tx), idempotent enqueue by `idempotency_key`, exclusive lease acquisition with expiry, retry backoff (`attempts++`, `next_attempt_at`), accept/ack, dead-letter write + audit, recipient read/action/dismiss state (separate from delivery status), and pending-interaction create/answer/cancel/expire with a `version` bump.
4. **App-services — `MailboxService` + `PendingInteractionService`** (`packages/app-services/src/mailbox/`), mirroring the slice-002/003/004/005 single-transaction outbox-write-door pattern: validate → persist product rows → `insertLiveEvent` in the SAME `getDb().transaction` → re-read post-write rows → return a publication the server composition layer fans out (canonical frame) AFTER commit; a rollback emits nothing. Use a deps seam (`transaction`/`insertLiveEvent`/repo fns) for test injection, like the agent-run gateway. Boundary purity identical to that gateway: depend on `@pc/contracts`/`@pc/db`/`@pc/domain` only; NO Hono, React, websocket hub, Channel, MCP SDK, runtime process classes, or the PTY. Recipient resolution policy (spec §7), idempotency, and the "no recipient → UNSUPPORTED/NOT_FOUND unless park-in-project-inbox policy" rule live here.
5. **Delivery worker** (server-owned, composed in `apps/server`): a lease-driven loop that picks deliveries with `status IN (pending,retrying)` and `next_attempt_at <= now`, acquires an exclusive lease, attempts delivery by `channel`, and on the outcome either marks `accepted` (with `target_ref`), schedules a retry (backoff), or writes dead-letter + audit. Delivery channels:
   - `orchestrator-turn`: a small server-local **adapter** wraps the slice-006 `ConversationSendService.enqueueRuntimeTurn` (synchronous, returns `{ row, created }`). Call it with a mailbox-derived `clientMessageId` (stable so a repeated delivery is idempotent — recommend `mb:${deliveryId}` or `${messageId}:${recipientId}`) and `source:'mailbox'`; mark `accepted` when a `row` comes back (created OR replayed); store `{ kind:'send-queue', id: row.id }` on `mailbox_deliveries.target_ref` (spec §8). A THROWN enqueue error is a retryable failure. NEVER raw-send; NEVER call `enqueueAndPush`/`postChannel`. Do NOT change the `enqueueRuntimeTurn` signature.
   - `ui-inbox`: delivery is "available in the inbox" — `accepted` once the recipient row is visible; UI read/action state is recipient state, NOT delivery acknowledgement.
   - `compat-channel`: defined in the contract enum but NOT wired this slice (Channel stays on its own path; this channel value is reserved for the slice-008 cutover).
   Worker rules per spec §7/§10: do not answer/resume/complete an interaction during delivery; a repeated delivery is safe because action commands validate current interaction state; live events are NOT delivery receipts.
6. **The deferred slice-006 `/api/ask` ask-shadow** (the first `pending_interactions` writer). In `chat-bridges/routes.ts`, write a durable `pending_interactions` row (kind `runtime-hook-ask`, `source = { kind:'runtime-hook', id: toolUseId }`, status `open`) when `/api/ask` arrives, via an injected shadow seam (e.g. wrap `deps.pendingAsks` or add a sibling `deps.askShadow?`), while keeping the **existing in-memory resolver as the authoritative blocking response path** (the route still parses the body as today, or optionally adopts `parseRuntimeHookAskRequest` — additive only). Terminalize the shadow to `answered` when the resolver resolves via `ask-reply`, `expired` on the 10-minute timeout, and boot-sweep orphaned `open` rows to `expired` on startup. The `/api/ask` HTTP response stays `{ answer }` (optionally `+ interactionId`, additive/omitted by default — if adding it changes any client parsing, STOP and confirm). The `ask` / `ask-reply` WS envelopes, the 10-minute timeout, and the timeout text `'(timeout — no user response)'` are unchanged. The shadow is inspectable, NOT the answer authority, and does NOT add a mailbox delivery.
7. **Mailbox HTTP routes** (additive; no existing route changed). Resolve the route shape (spec §15 open question) before building — recommend project-scoped + an app-level user inbox: list/read/action/dismiss recipients, list/inspect deliveries, answer a pending interaction. Use contract parsers; these are NEW routes (no legacy parity to preserve). The mailbox does NOT register a webhook entry this slice (the spec §10 Phase 8 webhook route is part of cutover; `/channel/:slug/:source` stays).
8. **Live event / replay / fanout.** No `/api/live-events` route code change is needed (it is contract-driven; §3) — widening the contract type union is sufficient. After a committed mailbox/interaction mutation, fan out canonical `{ type:'live-event', event }` frames (project-bound → `scope:'project'`+projectId; project-less message → `scope:'global'`+projectId:null). No legacy projection exists for these (new surface). The UI inbox refetches on the event (patching can come later, per spec §9). Do NOT fan out before the outbox row commits.
9. **Web inbox feature** (`apps/web/src/features/mailbox/`): a client + hook + inbox list view that lists recipients (unread/actioned), renders an action form for actionable items (answer/approve/dismiss), and a live helper that consumes the canonical `mailbox.*` / `pending-interaction.changed` frames (dedupe by `event.id`, refetch on event) via the slice-002 live client. The global single-user inbox must replay with `includeGlobal=1` (so `scope:'global'` user-inbox events arrive without a projectId); the project inbox replays with `projectId`. No component holds backend route strings or raw event parsing (spec §4 boundary rule).
10. Run the listed automated verification.

Non-goals (explicitly OUT — and which slice owns each):

- **The Channel → mailbox CUTOVER of agent/workflow/webhook delivery — slice 008.** This slice builds the mailbox PLATFORM + worker + inbox + ask-shadow, keeping Channel fully in place. Do NOT change `enqueueAndPush`, `drainPendingForSession`, `postChannel`, `ChannelServer`, `/channel/:slug/:source`, `/channel-register`, `channel-event`, `agent_inbox`, the agent pause/terminal/factory delivery call sites, or the workflow `orchestrator-review`/`dag-run-service.ts` delivery. Do NOT add a mailbox webhook route or deprecate `/channel`. The `compat-channel` delivery channel value ships in the contract enum but is NOT wired.
- **Agent `pending_asks` convergence — deferred.** Do NOT migrate, mirror, or read agent `pending_asks` into `pending_interactions`. The agent ask path (slice 005) stays on `pending_asks` + `enqueueAndPush`. Whether they converge is a later decision (spec §15 open question).
- **Runtime-host split incl. the host-resume defect — slice 009.** Do NOT change `ProjectRuntime`, the PTY/`InteractiveSession`, the JSONL tailer, transient-session handling, worktree/path-guard behavior, or the agent-host protocol. The orchestrator-turn worker rides the slice-006 `RuntimeTurnPort` seam only (through the send facade). The deferred host-resume defect is explicitly NOT in this slice.
- **MCP typed client / capability registry — slice 010.** Do NOT add or rename `pc_*` tools, route MCP through the mailbox, or change `pc_answer_pending`/`pc_complete_node`.
- **Compatibility cleanup — slice 011.** Do NOT remove any legacy route, WS envelope, table, or Channel target path.
- Do NOT change `/api/ask` blocking semantics, the `ask`/`ask-reply` envelopes, the 10-minute timeout, the timeout text, or make the shadow row the answer authority.
- Do NOT widen `ConversationSendService.enqueueRuntimeTurn` to the spec §8 async/`messageId`/`deliveryId` shape; the sync `{ row, created }` facade is sufficient (the worker adapts it).
- Do NOT implement workflow `human-review` as a wired action path beyond the inbox surface this slice provides (spec rules it must be inbox-backed or rejected; the inbox surface lands here, the workflow-review SENDER cutover is slice 008).
- Do NOT add a destructive or ALTER-existing-table migration. The only migration is the additive `0036_*` CREATE of the six tables.
- Do NOT restart or kill dev servers while implementing or verifying.

## 5. Contract Plan

Files likely affected:

```text
packages/contracts/src/mailbox.ts
packages/contracts/src/pending-interactions.ts
packages/contracts/src/live-events.ts        (extend entity/type union + accept-list; do not rewrite existing members)
packages/contracts/src/index.ts
packages/contracts/test/mailbox.test.ts
packages/contracts/test/pending-interactions.test.ts
packages/contracts/test/live-events.test.ts  (extend)
```

Contract rules (unchanged from slices 001–006): browser-safe, side-effect-free, zero runtime deps; no imports from apps, `@pc/db`, `@pc/domain` value imports (type-only `ULID` is fine, as the existing files do), `@pc/runtime`, `@pc/mcp`, Hono, React, or Node built-ins; parsers accept `unknown` and return `ParseResult<T>`.

Core DTOs (mirror the foundation spec §5 exactly):

| Contract | Initial contents |
|---|---|
| `MailboxAddress` | `{ kind:'user-inbox'; userId:'local-user'; projectId: string\|null }` \| `{ kind:'project-inbox'; projectId }` \| `{ kind:'active-orchestrator'; projectId }` \| `{ kind:'orchestrator-session'; projectId; sessionId }` \| `{ kind:'agent-run'; projectId; agentRunId }` \| `{ kind:'workflow-review'; projectId; workflowRunId; nodeId }`. Parser rejects missing required ids (note `user-inbox.projectId` MAY be null). |
| `MailboxMessageKind` | `'agent-question'\|'agent-approval'\|'agent-terminal'\|'workflow-review'\|'external-webhook'\|'runtime-hook-ask'\|'system-notice'`. |
| `MailboxDeliveryChannel` | `'ui-inbox'\|'orchestrator-turn'\|'compat-channel'`. (`compat-channel` reserved; not wired this slice.) |
| `MailboxDeliveryStatus` | `'pending'\|'leased'\|'accepted'\|'retrying'\|'failed'\|'dead-lettered'\|'cancelled'`. |
| `MailboxMessageDto` | id, projectId (nullable), kind, subject (nullable), body, payload, source `{ kind; id:string\|null }`, interactionId (nullable), idempotencyKey, createdAt, updatedAt. |
| `MailboxRecipientDto` | id, messageId, address (`MailboxAddress`), readAt, actionedAt, dismissedAt. |
| `MailboxDeliveryDto` | id, messageId, recipientId, channel, status, attempts, nextAttemptAt, targetRef `{ kind:'send-queue'\|'ui-inbox'\|'channel'\|null; id:string\|null }`, lastError, createdAt, updatedAt. |
| `PendingInteractionKind` | `'agent-asks-orchestrator'\|'agent-asks-user'\|'agent-approval-request'\|'workflow-orchestrator-review'\|'workflow-human-review'\|'runtime-hook-ask'`. |
| `PendingInteractionStatus` | `'open'\|'answered'\|'cancelled'\|'expired'\|'failed'`. |
| `PendingInteractionDto` | id, projectId, kind, status, source `{ kind:'agent-run'\|'workflow-run-node'\|'runtime-hook'; id:string }`, prompt, context, options (`{ value; label }[]\|null`), answer, answeredBy (`'orchestrator'\|'user'\|null`), createdAt, answeredAt, cancelledAt, version. |
| Command shapes | `EnqueueMailboxMessageRequest`, `MarkRecipientReadRequest`/`ActionRecipientRequest`/`DismissRecipientRequest`, `ListMailboxQuery`, `AnswerPendingInteractionRequest`. Parse-only; validate ids/enums. |

Canonical live-event extension (build on slice-002 `LiveEvent` + frame):

```ts
// LiveEventEntity union extended: ... | 'mailbox-message' | 'pending-interaction'
// LiveEventTypeName union extended: ... | 'mailbox.message.changed' | 'mailbox.delivery.changed' | 'pending-interaction.changed'
// LIVE_EVENT_TYPE_NAMES array extended to match (this is what makes the replay route accept the new type= filters).

export interface MailboxMessageChangedLivePayload {
  messageId: ULID;
  kind: MailboxMessageKind;
  recipientSummary: { total: number; unread: number; actionable: number };
  interactionId?: ULID | null;
}
export interface MailboxDeliveryChangedLivePayload {
  deliveryId: ULID;
  messageId: ULID;
  status: MailboxDeliveryStatus;
  attempts: number;
  targetRef: MailboxDeliveryDto['targetRef'];
  lastError?: string | null;
}
export interface PendingInteractionChangedLivePayload {
  interactionId: ULID;
  kind: PendingInteractionKind;
  status: PendingInteractionStatus;
  version: number;
}
```

First canonical shapes — **scope is computed from the message's project, NOT hardcoded `project`** (corrects the original draft, which hardcoded `scope:'project'` and would have violated the `global ⟺ projectId null` invariant for the global user-inbox):

```ts
// project-bound message:
{ type:'mailbox.message.changed', entity:'mailbox-message', scope:'project', projectId, entityId: messageId, version: null, payload: MailboxMessageChangedLivePayload }
// project-less message (e.g. user-inbox with projectId:null):
{ type:'mailbox.message.changed', entity:'mailbox-message', scope:'global', projectId: null, entityId: messageId, version: null, payload: MailboxMessageChangedLivePayload }

{ type:'mailbox.delivery.changed', entity:'mailbox-message', scope: <matches parent message>, projectId: <matches parent>, entityId: messageId, version: attempts, payload: MailboxDeliveryChangedLivePayload }
{ type:'pending-interaction.changed', entity:'pending-interaction', scope:'project', projectId, entityId: interactionId, version, payload: PendingInteractionChangedLivePayload }
```

Contract decisions (recorded; see Open Questions):

- Mailbox/interaction live events are **visibility nudges only** (spec §9): payloads carry summaries/ids, NOT message bodies or another project's recipient data. The UI inbox refetches on the event.
- A project-less message (`user-inbox` with `projectId:null`) emits `scope:'global'` (the only replay scope that has no projectId). The web global inbox replays with `includeGlobal=1`. Project-bound messages emit `scope:'project'`.
- `mailbox.delivery.changed` reuses entity `mailbox-message` (per spec §9) keyed on `messageId`; `version` carries `attempts` so the web hook can discard stale delivery snapshots.
- `pending-interaction.changed` gets its OWN entity `pending-interaction` (spec §9 allows "future `pending-interaction` entity"); `version` carries the interaction `version`. `PendingInteractionDto.projectId` is non-null, so it is always `scope:'project'`.
- No legacy projection is added (mailbox + the durable interaction shadow are new surfaces). `channel-event` is NOT expanded (spec §9).

## 6. App-Service / Repo Boundary

Files likely affected:

```text
packages/app-services/src/mailbox/mailbox-service.ts
packages/app-services/src/mailbox/pending-interaction-service.ts
packages/app-services/src/mailbox/adapters.ts
packages/app-services/src/mailbox/index.ts
packages/app-services/src/index.ts                              (re-export)
packages/db/src/schema.ts                                       (add 6 tables; widen live_outbox entity $type)
packages/db/src/repos/mailbox.ts                                (NEW)
packages/db/src/repos/pending-interactions.ts                   (NEW)
packages/db/src/repos/live-outbox.ts                            (widen LiveOutboxEntity union)
packages/db/src/index.ts                                        (export new repos)
packages/db/drizzle/0036_<name>.sql                             (NEW additive migration)
packages/db/drizzle/meta/_journal.json                          (idx 36 entry)
apps/server/src/services/mailbox-worker.ts                      (NEW delivery worker)
apps/server/src/services/mailbox-orchestrator-turn-adapter.ts   (NEW: wraps the slice-006 send facade)
apps/server/src/features/mailbox/routes.ts                      (NEW additive routes)
apps/server/src/features/chat-bridges/routes.ts                 (ask-shadow writer via injected shadow seam)
apps/server/src/index.ts                                        (wire service + worker + fanout seam; boot ask-shadow sweep)
```

Service responsibilities:

| Service | Owns | Must not own |
|---|---|---|
| `MailboxService` | Enqueue (message+recipients+deliveries+optional interaction+audit+live_outbox in ONE tx, idempotent by key), recipient read/action/dismiss, delivery lease/accept/retry/dead-letter state, recipient-resolution policy (spec §7) | WebSocket hub, raw PTY / the `enqueueRuntimeTurn` call (the worker's adapter calls the facade), Channel registrants, HTTP/status mapping |
| `PendingInteractionService` | Create/answer/cancel/expire a `pending_interactions` row with a `version` bump + the `pending-interaction.changed` fact in one tx | Product transitions (agent resume / workflow complete stay in their owners), mailbox delivery, the in-memory `/api/ask` resolve authority |
| `mailbox-orchestrator-turn-adapter` (server) | Wrap the sync `ConversationSendService.enqueueRuntimeTurn`: map a returned `row` → `accepted` + `{ kind:'send-queue', id: row.id }`, a thrown error → retryable failure | Mailbox state transitions (delegates to `MailboxService`), send policy (lives in the facade) |
| ask-shadow seam (server-local, in `chat-bridges`) | Write/terminalize the `/api/ask` shadow `pending_interactions` row around the unchanged resolver (delegating the durable write to `PendingInteractionService`) | The blocking resolve authority (stays the in-memory `deps.pendingAsks` store), the hook protocol |
| `mailbox-worker` (server) | Lease → attempt by channel → accept/retry/dead-letter; the `orchestrator-turn` channel calls the adapter | Send policy, mailbox state transitions (delegates to `MailboxService`) |

Transaction + purity rules (same as slices 003/004/005): validate → persist product mutation → insert `live_outbox` row in the **same SQLite transaction** → re-read post-write rows → fan out after commit. A rollback emits nothing. `MailboxService`/`PendingInteractionService` may depend on `@pc/contracts`/`@pc/db`/`@pc/domain`; they must NOT import Hono, React, the websocket hub, Channel, MCP SDK, or runtime process classes. The orchestrator-turn adapter (server layer) holds the injected `ConversationSendService`; fanout (`broadcast`) is injected at the server composition layer.

## 7. Route / Compat Adapter Plan

Files likely affected:

```text
apps/server/src/features/mailbox/routes.ts        (NEW additive routes)
apps/server/src/features/chat-bridges/routes.ts   (ask-shadow side write; /api/ask response unchanged)
apps/server/test/mailbox-routes.test.ts
apps/server/test/chat-bridges-routes.test.ts       (ask-shadow)
```

- NEW additive mailbox routes (no legacy parity to preserve — confirm the route shape per spec §15 first; recommended):
  - `GET  /api/projects/:projectId/mailbox` — list recipients/messages for the project inbox (filter unread/actionable).
  - `GET  /api/mailbox` — the single-user/global inbox (messages with `user-inbox`/`projectId:null` addresses).
  - `POST /api/projects/:projectId/mailbox/recipients/:recipientId/read`
  - `POST /api/projects/:projectId/mailbox/recipients/:recipientId/action`
  - `POST /api/projects/:projectId/mailbox/recipients/:recipientId/dismiss`
  - `GET  /api/projects/:projectId/mailbox/deliveries` — delivery inspector (status/attempts/target ref/dead-letter).
  - `POST /api/projects/:projectId/pending-interactions/:interactionId/answer`
- `/api/ask` (`chat-bridges/routes.ts`): write the shadow row through the injected shadow seam BEFORE blocking on the unchanged in-memory resolver; terminalize on resolve/timeout. Response stays `{ answer }` (optionally `+ interactionId`, default omitted; STOP and confirm before adding the field if any client parses the response strictly). The route's inline body parse is unchanged; adopting `parseRuntimeHookAskRequest` is optional and additive.
- No mailbox webhook route this slice (the spec §10 Phase 8 webhook route is cutover; `/channel/:slug/:source` stays).
- No MCP stage this slice. The agent ask/answer (`pc_answer_pending`) and workflow review (`pc_complete_node`) tools stay on their current routes; do NOT route them through the mailbox (slice 008/010). If the build reveals an MCP caller needing the mailbox, STOP and confirm.

## 8. Live Event / Replay / WebSocket Compatibility Plan

Files likely affected:

```text
apps/server/src/features/live-events/routes.ts   (NO code change — the route is contract-driven; verify only)
apps/server/src/index.ts                         (wire mailbox/interaction publication fanout)
apps/server/test/live-events-routes.test.ts
```

- `/api/live-events` (slice 002) accepts `type=mailbox.message.changed` / `type=mailbox.delivery.changed` / `type=pending-interaction.changed` automatically once `LiveEventTypeName` + `LIVE_EVENT_TYPE_NAMES` widen in `@pc/contracts` — **the route reads `parseListLiveEventsQuery` and `listLiveEventsAfter` with no server-side allow-list, so no route code changes** (verified §3). Mailbox/interaction events are project-scoped EXCEPT a project-less message, which is `scope:'global'`; `listLiveEventsAfter` returns global events only when no `projectId` is passed (or `includeGlobal=1` is set with a `projectId`). `project.changed`/`work-item.changed`/`workflow.*`/`agent.run.changed` behavior unchanged.
- After a committed mailbox/interaction mutation, fan out canonical `{ type:'live-event', event }`. There is NO legacy projection for these (new surface); do NOT expand `channel-event`. Do not fan out before the outbox row commits; zero subscribers or a fanout throw must leave the row replayable.
- Keep `/ws`, the project WebSocket hub broadcast helpers, `agent-jsonl-event`, `channel-event`, and all existing runtime envelopes unchanged.
- Mailbox worker acknowledgement does NOT depend on live outbox publication (spec §9): a delivery is `accepted` because the send facade returned a row / the inbox row is visible, NOT because a live frame went out.

## 9. Identity / Atomicity / Lifecycle

**Message identity + idempotency.** Each message is a PC-minted ULID; the `idempotency_key` unique index (spec §6) makes a replayed agent/workflow/webhook event a no-op re-enqueue. Recipients and deliveries are child rows minted in the same enqueue transaction.

**Delivery lease / ack / retry / dead-letter (the slice's core model).**
- A delivery is born `pending` with `attempts=0`, `next_attempt_at=now`, `lease_owner=null`, `lease_expires_at=null`.
- The worker acquires an **exclusive lease** before attempting: an atomic conditional update (`WHERE status IN ('pending','retrying') AND (lease_expires_at IS NULL OR lease_expires_at <= now) AND next_attempt_at <= now`) that stamps `lease_owner` + `lease_expires_at` and flips `status='leased'`. Only the worker pass that wins the conditional update owns the delivery. A lease that expires (worker crashed mid-attempt) is reclaimable by a later pass because the `lease_expires_at <= now` predicate lets another acquire it; the reclaim treats the prior attempt as failed/unknown and retries (the delivery is idempotent — see below). A single in-process worker runs today, but the lease keeps the model correct and restart-safe.
- **Idempotency / exactly-once-ish acceptance.** Re-delivery is safe because the `orchestrator-turn` adapter calls `enqueueRuntimeTurn` with a STABLE mailbox-derived `clientMessageId` (recommend `mb:${deliveryId}`), which is idempotent by `(sessionId, clientMessageId)` — a reclaimed/retried attempt returns the SAME send-queue row (`created:false`), so at most one runtime turn is ever queued per delivery. For `ui-inbox`, the recipient row already exists from enqueue, so re-acceptance is a no-op. Acceptance is therefore at-least-once attempts with at-most-one effect.
- On a successful channel attempt → `accepted` + `target_ref` + `accepted_at` + audit; this is "accepted by the app send service" (spec §8), NOT observed-in-JSONL (a stronger milestone is deferred to a later runtime-transcript step).
- On a retryable failure (a thrown enqueue error, transient channel error) → `retrying`, `attempts++`, `next_attempt_at = now + backoff(attempts)`, clear the lease, audit.
- On exhausted retries (attempts ≥ max) / non-retryable failure (no recipient resolvable, unknown channel) → `dead-lettered` + a `mailbox_dead_letters` row + audit.
- `cancelled` is an explicit terminal state.
- A delivery attempt NEVER answers/resumes/completes an interaction (spec §7); a repeated delivery is safe because action commands validate current state.

**Recipient state vs delivery state.** `read_at`/`actioned_at`/`dismissed_at` are recipient state set by the UI; they are NOT delivery acknowledgement (spec §6). The inbox unread/actionable counts derive from recipient state.

**Pending-interaction lifecycle.** A `pending_interactions` row is `open` → `answered`/`cancelled`/`expired`/`failed`, each bumping `version` and emitting `pending-interaction.changed`. For the `/api/ask` shadow: the in-memory resolver remains the answer authority; the shadow row is `open` on ask, `answered` on `ask-reply` resolve, `expired` on the 10-minute timeout, and boot-swept to `expired` for orphans (it cannot unblock a lost HTTP connection — documented). Agent `pending_asks` are NOT merged into this table this slice.

**Recipient resolution policy** (spec §7): `orchestrator-session`/`active-orchestrator` → `orchestrator-turn` channel; `user-inbox`/`workflow-human-review`/`pc_ask_user`/`pc_request_approval` → `ui-inbox`; unresolved recipient → `UNSUPPORTED`/`NOT_FOUND` unless the "park in project inbox" policy is configured. No default fan-out to every orchestrator session.

## 10. DB

- **Migration needed: YES — this is the FIRST real schema migration of the refactor.** Slices 002–006 were strictly no-migration (002 added `live_outbox`, but the journal shows that migration is already at idx 35 and applied; 003/004/005 widened `$type` unions only; 006 added a read helper, no schema change). This slice adds the six additive tables from spec §6 in one new hand-authored `0036_<name>.sql`.
- **Additive + reversible design:**
  - CREATE TABLE only — NO `ALTER` of any existing table, NO rewrite/backfill of any existing row. The six tables are independent of the live product tables; spec §5 allows a project reference to be nullable/soft (no hard FK coupling required).
  - Nullable/defaulted columns throughout (status defaults, nullable timestamps, nullable lease fields) so a fresh row is valid without app backfill.
  - Indexes per spec §6: `pending_interactions` on `(project_id,status,created_at)`/`(source_kind,source_id)`/`(kind,status)`; `mailbox_messages` unique `idempotency_key`; `mailbox_recipients` on `(address_kind,message_id)` + unread queries; `mailbox_deliveries` on `(status,next_attempt_at)`/`(recipient_id,status)`/`(target_ref_kind,target_ref_id)`; dead-letter + audit by message/recipient/delivery.
  - **Rollback:** the six tables are inert if no caller exists — disabling the worker + routes leaves them unused; a down-path simply `DROP`s them (no data migration to reverse).
- **Migration-safety care (the load-bearing part — MEMORY "Drizzle ledger lies → fresh-DB boot crash"):**
  - drizzle decides what to apply by the last-applied timestamp in `__drizzle_migrations`, NOT by inspecting the schema. If the journal records `0036` applied while the columns are absent, `runMigrations()` skips the real CREATE forever and the code crashes later with `no such column`/`no such table`.
  - `runMigrations()` (`migrate.ts:20`) runs `assertSchemaIntact()` AFTER `migrate()`, which fails fast if any `schema.ts`-declared table/column is missing from the live DB. So **every column declared in `schema.ts` for the six tables MUST appear verbatim (same column name) in `0036_*.sql`**, or a fresh boot throws the drift error. Mirror the `0035_live_outbox.sql` shape (CREATE + CHECK + indexes, `--> statement-breakpoint` separators) and add the journal entry (idx 36, per-entry `version:"6"`, monotonic `when` > `1781481600000`; leave the top-level journal `version:"7"` as-is).
  - Use SQLite-honest column types matching the drizzle builders the slice picks (`text`/`integer`; JSON columns are `text` with `{ mode: 'json' }` in `schema.ts` but plain `text` in SQL, as `live_outbox.payload` does). Boolean-ish flags as `integer`. Keep `$type<...>()` annotations type-only (they don't appear in SQL).
  - **Verify on a FRESH DB:** the build session must run a fresh-DB migration test (extend the `live-outbox.test.ts` pattern: `runMigrations()` on a tmp `PC_DATA_DIR`, then assert via `pragma table_info` that all six tables + every column exist and that `assertSchemaIntact()` does not throw). Do NOT hand-edit `__drizzle_migrations`.
- Widen the `live_outbox.entity` drizzle `$type` union (schema.ts) + `LiveOutboxEntity` (repos/live-outbox.ts) to include `'mailbox-message'` and `'pending-interaction'` (additive type-only, as slices 004/005 did — NOT a migration; `live_outbox.entity` is a free-text column).
- No existing table is altered destructively. `pending_asks` / `agent_inbox` / `orchestrator_send_queue` are untouched.

## 11. Test Plan

Minimum automated tests (add before behavior changes where practical), mirroring the slice-002/003/004/005 style:

| Priority | Test | Purpose |
|---|---|---|
| P0 | `packages/contracts/test/mailbox.test.ts` + `pending-interactions.test.ts` | Parser/guard coverage for `MailboxMessageDto`/`MailboxRecipientDto`/`MailboxDeliveryDto`/`PendingInteractionDto` + command shapes; `MailboxAddress` parser rejects missing project/session/run/node ids (but accepts `user-inbox.projectId:null`); canonical `mailbox.*`/`pending-interaction.changed` payload guards; `LIVE_EVENT_TYPE_NAMES` now includes the three names (so the replay route accepts them); invalid scope/project/status combos rejected. |
| P0 | `packages/db/test/mailbox-migration.test.ts` | **Fresh-DB migration safety:** `runMigrations()` on an empty tmp DB creates all six tables + every `schema.ts` column (assert via `pragma table_info`); `assertSchemaIntact()` does not throw; idempotency unique index enforced (duplicate `idempotency_key` rejected). Extends the `live-outbox.test.ts` pattern; guards the Drizzle ledger-lies trap. |
| P0 | `packages/db` repo tests | Transactional enqueue writes message+recipients+deliveries+interaction+audit+live_outbox atomically (a forced rollback writes NOTHING — no orphan outbox row); idempotency key dedupes; lease acquisition is exclusive (a second acquire on the same row fails) and a stale lease is reclaimable after expiry; retry increments attempts + schedules `next_attempt_at`; dead-letter writes a queryable row + audit; recipient read/action/dismiss is separate from delivery status. |
| P0 | `MailboxService` emission tests | Enqueue/lease/accept/retry/dead-letter each emit the correct canonical fact with the post-write row; project-bound → `scope:'project'`, project-less → `scope:'global'`+`projectId:null`; rollback emits nothing. |
| P0 | Orchestrator-turn worker/adapter test | The `orchestrator-turn` channel adapter calls `enqueueRuntimeTurn` (stable mailbox-derived `clientMessageId`, `source:'mailbox'`), marks `accepted` with `target_ref = { kind:'send-queue', id: row.id }`, NEVER raw-sends / NEVER calls `enqueueAndPush`. A repeated delivery returns the SAME send-queue row (`created:false`) → still exactly one runtime turn. A thrown enqueue error → `retrying` with backoff. |
| P0 | `PendingInteractionService` test | Create/answer/cancel/expire bumps `version` + emits `pending-interaction.changed`; a delivery attempt does not answer/resume the interaction. |
| P0 | Ask-shadow test | `/api/ask` still broadcasts `ask`, blocks on the in-memory resolver, resolves via `ask-reply`, times out with the current text `'(timeout — no user response)'`; the shadow `pending_interactions` row is written `open` and terminalized `answered`/`expired`; the HTTP response is `{ answer }` (shadow does not change it). |
| P1 | Ask-shadow boot-sweep test | An orphaned `open` shadow row is swept to `expired` on boot and does not attempt to unblock anything. |
| P0 | `apps/server/test/live-events-routes.test.ts` updates | Replay returns project-scoped `mailbox.message.changed`/`mailbox.delivery.changed`/`pending-interaction.changed` after cursor when `projectId` is passed; a `scope:'global'` user-inbox message replays only with no projectId or `includeGlobal=1`; excludes other-project events; message body never leaks; `project.changed`/`work-item.changed`/`workflow.*`/`agent.run.changed` unchanged. |
| P0 | `apps/server/test/mailbox-routes.test.ts` | New inbox/delivery/answer routes return the contract shapes; recipient read/action/dismiss updates recipient state; reads do not emit. |
| P0 | Channel-untouched test | Enqueuing through the mailbox does NOT call `enqueueAndPush`/`postChannel`/`emitToSession`; the agent/workflow delivery call sites are unchanged. |
| P1 | `apps/web/test/mailbox-live-events.test.ts` | Filters accept the canonical `mailbox.*`/`pending-interaction.changed` frames; dedupe by id; refetch on event; the global inbox hook replays with `includeGlobal`; reject unrelated frames. |

Gate commands (run from repo root; matches slices 002–006):

```powershell
pnpm --filter @pc/contracts test
pnpm --filter @pc/contracts typecheck
pnpm --filter @pc/db test
pnpm --filter @pc/db typecheck
pnpm --filter @pc/app-services test
pnpm --filter @pc/app-services typecheck
pnpm --filter @pc/server test
pnpm --filter @pc/server typecheck
pnpm --filter @pc/web test
pnpm --filter @pc/web typecheck
pnpm typecheck
git diff --check
```

`@pc/app-services` already has the package-local `tsx --test "test/*.test.ts"` script (slice 003); reuse it. `pnpm --filter @pc/db test` MUST cover the new repos + the `0036_*` migration applying cleanly on a fresh DB. (Note: `pnpm typecheck` excludes `test/**` per the known deferred defect — type errors in new test files will NOT be caught by the build gate; the build session should typecheck new test files manually or rely on `tsx` runtime failures.)

Manual verification after implementation (batched to the human end-of-section pass):

- Enqueue a `system-notice` to a project inbox; confirm it appears in a second client's inbox without refresh (canonical fanout), and read/dismiss propagates.
- Enqueue a `system-notice` to a `user-inbox` (`projectId:null`); confirm it appears in the global inbox and replays after a reconnect with `includeGlobal`.
- Enqueue an `orchestrator-turn` message to the active orchestrator session; confirm exactly ONE send-queue row is created (the runtime turn appears in chat) and the delivery is `accepted` with a send-queue `target_ref` — and that NO Channel push fired. Re-trigger the same delivery and confirm STILL one send-queue row.
- Enqueue with an unresolvable recipient; confirm the documented `UNSUPPORTED`/`NOT_FOUND` or project-inbox-park behavior (not a silent drop).
- Force a delivery failure; confirm retry backoff increments attempts and a final dead-letter row appears in the delivery inspector.
- Trigger `AskUserQuestion`; confirm one ask card appears, answering unblocks the hook, and the `pending_interactions` shadow row terminalizes `answered`; let one time out and confirm `expired`.
- Disconnect one client websocket, enqueue a message, reconnect; replay after cursor reconciles the inbox.
- Relaunch the server (NOT during this build session — human-controlled end-of-section) on a DB created before this slice AND on a fresh DB; confirm `runMigrations()` applies `0036` cleanly (no `assertSchemaIntact()` drift error), the inbox loads, and orphaned `open` shadow rows sweep to `expired`.
- Confirm agent/workflow Channel delivery, chat, work-item, agent-run behavior is unchanged (Channel still in place).

## 12. Migration Steps

1. Add contract tests for the mailbox + pending-interaction DTOs + `MailboxAddress` parser + canonical payload guards + the widened `LIVE_EVENT_TYPE_NAMES`.
2. Add the contract files (`mailbox.ts`, `pending-interactions.ts`) and extend `live-events.ts` + `index.ts`.
3. Add the six tables to `schema.ts`; author `0036_<name>.sql` (CREATE-only, mirroring `0035_live_outbox.sql`); add the journal idx-36 entry; widen the `live_outbox.entity` `$type` + `LiveOutboxEntity` union.
4. Add the `@pc/db` mailbox + pending-interaction repos + the fresh-DB migration test; run `pnpm --filter @pc/db test` to prove the migration applies and `assertSchemaIntact()` passes BEFORE wiring anything else.
5. Add `MailboxService` + `PendingInteractionService` in `@pc/app-services` (validate → persist → outbox-insert in one tx → re-read → publication); add adapters + the deps seam.
6. Add the `mailbox-worker` + the `orchestrator-turn` adapter in `apps/server` (lease → attempt by channel → accept/retry/dead-letter); the adapter wraps the slice-006 `enqueueRuntimeTurn` facade (stable `clientMessageId`, `source:'mailbox'`).
7. Add the additive mailbox HTTP routes.
8. Add the ask-shadow seam; write the `/api/ask` shadow row around the unchanged resolver + a boot sweep.
9. Wire the mailbox/interaction publication fanout in `apps/server/src/index.ts` (canonical after commit; no `/api/live-events` route change).
10. Add the web mailbox feature (client + hook + inbox view + live helper + cursor replay; global inbox uses `includeGlobal`).
11. Run automated verification.
12. Update trackers with implementation notes.

## 13. Rollback Plan

- Contracts are additive; revert the mailbox/pending-interaction contract files to drop the family (and the `LiveEventTypeName`/`LIVE_EVENT_TYPE_NAMES` additions).
- The `0036_*` migration is additive CREATE-only: the six tables are inert if no caller exists. Disabling the worker + routes leaves them unused; a down-path `DROP`s them (no data migration to reverse). Do NOT hand-edit `__drizzle_migrations`; if a fresh boot drift error appears, the fix is to apply the missing CREATE by hand (the MEMORY ledger-lies repair), not to re-record the ledger.
- The `live_outbox.entity` union widening is type-only and inert if unused.
- `MailboxService`/`PendingInteractionService`/the worker/the adapter are new code with no existing call site to revert; remove them to roll back the platform.
- The `/api/ask` ask-shadow is a SIDE write: disable the shadow seam to restore the exact current `/api/ask` behavior; the in-memory resolver is unchanged regardless.
- The web inbox feature is additive; remove the route from the app shell to hide it.
- Channel / `agent_inbox` / `pending_asks` / agent + workflow delivery are untouched, so disabling the mailbox restores nothing (it never replaced them).

## 14. Stop Conditions

Stop and return to planning if implementation requires any of the following:

- Cutting ANY agent/workflow/webhook sender over to the mailbox, or changing `enqueueAndPush`/`drainPendingForSession`/`postChannel`/`ChannelServer`/`/channel/:slug/:source`/`/channel-register`/`channel-event`/`agent_inbox`, or the agent pause/terminal/factory + workflow `orchestrator-review`/`dag-run-service.ts` delivery call sites (slice 008).
- Adding a mailbox webhook route or deprecating `/channel` (slice 008).
- Wiring the `compat-channel` delivery channel (it ships in the enum but stays unwired this slice — slice 008).
- Migrating, mirroring, or reading agent `pending_asks` into `pending_interactions`.
- Changing `/api/ask` blocking semantics, the `ask`/`ask-reply` envelopes, the 10-minute timeout, the timeout text, or making the shadow row the answer authority.
- Adding `interactionId` to the `/api/ask` response in a way that changes current client parsing.
- Changing the `ConversationSendService.enqueueRuntimeTurn` signature (e.g. to the spec §8 async/`messageId`/`deliveryId` shape) — the worker must ADAPT the existing sync `{ row, created }` facade.
- A destructive or ALTER-existing-table migration, a backfill/rewrite of existing rows, or more than the single additive `0036_*` CREATE of the six tables.
- Changing `ProjectRuntime`, the PTY/`InteractiveSession`, the JSONL tailer, transient-session handling, worktree/path-guard behavior, or the agent-host protocol (slice 009), or any work on the deferred host-resume defect.
- Adding/renaming MCP tools or routing `pc_answer_pending`/`pc_complete_node` through the mailbox (slice 010).
- Removing any legacy route, WS envelope, table, or Channel target path (slice 011).
- Raw-sending to the PTY (the worker must ride `enqueueRuntimeTurn`), or fanning out a live frame before the outbox row commits.
- Replacing `/ws`, changing connection semantics, or restarting/killing dev processes.

## 15. Acceptance Criteria

This slice is ready to implement only when the user explicitly asks to build and these criteria are accepted:

- `@pc/contracts` owns the mailbox message/recipient/delivery DTOs, the typed `MailboxAddress` recipient union (parser rejects missing required ids, accepts `user-inbox.projectId:null`), the pending-interaction DTOs, the command shapes, the canonical `mailbox.*`/`pending-interaction.changed` payload contracts (with the scope-from-project rule), and parser/guard helpers; `LIVE_EVENT_TYPE_NAMES` includes the three new names.
- The six additive tables land in one new `0036_*` CREATE-only migration that applies cleanly on a fresh DB (verified by a fresh-DB test) and passes `assertSchemaIntact()`; no existing table is altered, no row rewritten; the migration-safety care (Drizzle ledger-lies trap, every `schema.ts` column verbatim in SQL) is honored.
- `MailboxService` + `PendingInteractionService` are single-transaction outbox-write-doors; enqueue/lease/ack/retry/dead-letter + recipient read/action/dismiss + interaction lifecycle are durable, idempotent, and emit canonical visibility facts after commit; a rollback emits nothing.
- The delivery worker leases (exclusive, expiry-reclaimable), attempts by channel, and accepts/retries/dead-letters; the `orchestrator-turn` channel adapter wraps the slice-006 `enqueueRuntimeTurn` facade (accepted = send-service acceptance with a send-queue `target_ref`; stable `clientMessageId` so re-delivery yields one runtime turn), never raw-sends, and never calls Channel.
- The deferred slice-006 `/api/ask` ask-shadow is implemented as the first `pending_interactions` writer; `/api/ask` keeps blocking semantics; the shadow is created/terminalized/boot-swept/inspectable and is NOT the answer authority.
- A UI inbox surface lists recipients, actions actionable items, and refetches on canonical live events with cursor replay on reconnect; the global inbox replays with `includeGlobal`.
- `/api/live-events` replays the three new types with correct cursor/scope filtering (project events with a projectId; global user-inbox events with `includeGlobal`/no projectId); no body leak; live events are visibility nudges, not delivery receipts.
- Channel, `agent_inbox`, `pending_asks`, and every agent/workflow/webhook delivery call site remain untouched (no cutover); the mailbox runs alongside.
- Tests cover contracts, the fresh-DB migration, repo transactions/idempotency/lease/retry/dead-letter, service emission, the orchestrator-turn worker, the ask-shadow, replay filtering (incl. global scope), route shapes, Channel-untouched, and web frame handling.
- Runtime-host split (incl. host-resume defect), MCP, and cleanup remain untouched except for unaffected typecheck/test fallout.
- Tracker marks this build-slice artifact `planned`.

## 16. Open Questions

| Question | Status |
|---|---|
| Mailbox route shape: `/api/projects/:projectId/mailbox/*`, `/api/mailbox/*`, or both? | Recommended for v1: BOTH — project-scoped routes for project inbox + an app-level `/api/mailbox` for the single-user global inbox (messages without project context). Confirm before building. (spec §15) |
| Should the first UI inbox be project-scoped only or include a global single-user inbox? | Recommended for v1: include the global single-user inbox (`user-inbox` with `projectId:null`, emitted as `scope:'global'` live events) so `pc_ask_user`/approvals without project context have a home. (spec §15) |
| Which first message kind should the worker prove against? | Recommended for v1: `system-notice` (ui-inbox) + `runtime-hook-ask` (the ask-shadow) for the inbox path, and a synthetic `orchestrator-turn` enqueue for the send-facade path — WITHOUT cutting over any real agent/workflow sender (that is slice 008). |
| Should the first implementation mirror agent `pending_asks` into `pending_interactions`? | Resolved for v1: NO mirror — the `/api/ask` shadow is the only `pending_interactions` writer this slice; agent `pending_asks` stays the agent compatibility source. (spec §2/§15; slice-005) |
| Add `interactionId` to the `/api/ask` response? | Default: omit it (response stays `{ answer }`). If a richer hook wants it, add it additively only after confirming no client parses the response strictly. |
| Should `enqueueRuntimeTurn` be widened to the spec §8 async `RuntimeTurnDeliveryPort` shape (returns `retryable`)? | Resolved for v1: NO. The real facade is sync and returns `{ row, created }`; the worker's adapter derives `accepted` from the row and treats a thrown enqueue error as retryable. Widening the facade is out of scope (and a slice-006 surface). |
| What feature flag / config key controls per-message-kind fallback to Channel during the LATER cutover? | Deferred to slice 008. This slice ships no cutover, so no fallback flag is needed yet. (spec §15) |
| Should mailbox wait for `observed_in_jsonl` before marking an orchestrator-turn `accepted`? | Resolved for v1: NO — `accepted` = send-service acceptance with the send-queue `target_ref` (spec §8). The stronger observed-in-JSONL milestone is deferred. |
| Should the `pending-interaction.changed` fact use its own entity or `mailbox-message`? | Resolved for v1: its own entity `pending-interaction` (spec §9 allows it); `mailbox.delivery.changed` reuses `mailbox-message`. |
| Retention/ordering policy for read/actioned messages, audit, dead-letters? | Deferred (non-blocking; spec §15). Order by `created_at` + id for now. |

## 17. Notes for the Implementation Agent

- Reuse the slice-002 `live_outbox` table, replay route, and web live client (cursor/replay); do NOT add a second outbox or a parallel live mechanism. Mirror the slice-005 `AgentRunMutationGateway` shape closely (`packages/app-services/src/agent-runs/run-gateway.ts`) for the single-transaction write-door + the `transaction`/`insertLiveEvent`/repo deps seam + `InsertLiveEventDraft`/`LiveOutboxEvent`/`build*Draft` helpers.
- **The orchestrator-turn delivery wraps a SYNC facade — do NOT assume the spec §8 async port shape.** `ConversationSendService.enqueueRuntimeTurn` (`packages/app-services/src/conversations/send-service.ts:169`) is synchronous, returns `{ row, created }`, and signals failure only by throwing. Build a thin server-side adapter: `accepted` ⟺ a `row` came back (created OR replayed → idempotent), `target_ref = { kind:'send-queue', id: row.id }`, thrown → retryable. Use a STABLE mailbox-derived `clientMessageId` (e.g. `mb:${deliveryId}`) so a retried/reclaimed delivery returns the same send-queue row and never double-queues. Inject the facade into the adapter; do NOT re-implement send, do NOT call `enqueueAndPush`/`postChannel`, and do NOT change the facade's signature.
- **The migration is the highest-risk part of this slice** (the first real one). Author `0036_*.sql` by hand mirroring `0035_live_outbox.sql`; keep `schema.ts` and the SQL in exact lockstep (every column name verbatim) so `assertSchemaIntact()` passes on a fresh boot; add the fresh-DB migration test FIRST (extend `packages/db/test/live-outbox.test.ts`'s `runMigrations()`-on-tmp-DB pattern) and run `pnpm --filter @pc/db test` before wiring anything else. Per-entry journal `version:"6"`, monotonic `when` > `1781481600000`; leave the top-level journal `version:"7"`. Re-read MEMORY "Drizzle ledger lies → fresh-DB boot crash" — the trap is a recorded-but-not-applied migration; never hand-edit `__drizzle_migrations`.
- **Scope-from-project for live events (the original draft's bug):** the `global ⟺ projectId IS NULL` invariant is enforced by `insertLiveEvent`, the schema, and the SQL CHECK. A project-less message MUST emit `scope:'global'`+`projectId:null`; only project-bound rows are `scope:'project'`. The web global inbox must replay with `includeGlobal=1`, since `listLiveEventsAfter` returns only global events when no `projectId` is passed.
- This slice is ADDITIVE and PRE-CUTOVER. Channel stays. Do NOT touch the agent/workflow/webhook delivery call sites or `agent_inbox`/`pending_asks`. The `compat-channel` enum value ships unwired.
- The `/api/ask` ask-shadow is a SIDE write through the injected `deps.pendingAsks` seam (or a sibling dep): do NOT touch the in-memory resolver, the `ask`/`ask-reply` envelopes, or the 10-minute timeout text. The route currently parses the body inline (not via `parseRuntimeHookAskRequest`); adopting the parser is optional/additive. The parse-only `runtime-hook-ask.ts` contract already exists (slice 006) — this slice is its first writer.
- Live events are visibility nudges, not delivery receipts (spec §9): mark a delivery `accepted` because the send facade returned a row / the inbox row is visible, NOT because a frame went out. Worker ack must not depend on outbox publication.
- Keep boundary purity: services import only `@pc/contracts`/`@pc/db`/`@pc/domain`; the worker + adapter (server) own the injected facade + fanout.
- `pnpm typecheck` excludes `test/**` (known deferred defect) — new test files won't be type-checked by the build gate; rely on `tsx` runtime + a manual test-file typecheck if needed, and avoid `string`→branded-`ULID` casts in tests (build real rows via `createProject`/repos).
- Do not use `archive/` as evidence or a source for tests.
