# App-Services Layer (Gateways & Adapters)

> **Role:** Brain (control plane — the home of all durable write logic)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `packages/app-services/src/` · `apps/server/src/services/*-writer.ts` (thin broadcast shims)

---

## What it is (plain English)

Think of it as **the one cashier's window** — every change to the books goes through it and gets receipted in the same motion. Want to create a work item? Move a card? Cancel a workflow run? Each of those writes flows through this layer, which saves the change to the database AND stamps a "this changed" notification at the exact same instant in one unbreakable step (called an atomic transaction). If the save fails, no notification goes out — structurally impossible to announce something that didn't actually happen.

This layer (`@pc/app-services`) sits between the raw database and the HTTP server. It knows nothing about web requests, WebSockets, or running processes — just "write the change, stamp the receipt."

---

## What it's supposed to do (intent)

Own the "save + receipt" step for every entity in the app. Its one law: **a state change and its notification are written in the same transaction.** That law is what makes the live UI trustworthy — any card move, run status flip, or mailbox message the UI sees was durably committed the moment the notification was emitted. No phantom announcements.

It also owns the pure mappers (adapters) that convert raw database rows into the browser-safe data shapes defined in `@pc/contracts`.

---

## The parts (every component, plain English)

### 1. The one-cashier-window pattern (the gateway)

Every gateway — there's one per domain — does exactly the same five steps:

1. A caller (a server-side service) asks the gateway to do something (e.g., "pause this run").
2. The gateway opens a database transaction.
3. Inside that transaction: **write the product change** (the actual row update) + **write a `live_outbox` row** (the "this changed" receipt) — both or neither, never just one.
4. The transaction commits; the gateway hands back a typed `Publication` — the updated data shape plus the outbox row.
5. The caller fans out the live notification to WebSocket clients. The gateway itself never touches WebSockets.

If anything goes wrong inside the transaction, it rolls back completely — the outbox row is never written, so nothing reaches the UI.

(`packages/app-services/src/` — every gateway file; the `live_outbox` table is in `packages/db/src/schema.ts`)

### 2. The gateways — one per domain

Each domain has its own gateway that applies the pattern above to its tables:

| Gateway | What it writes |
|---|---|
| `WorkItemMutationGateway` | work items, stages, field schemas, attachments |
| `WorkflowRunMutationGateway` | workflow runs, review facts |
| `AgentRunMutationGateway` | agent runs, pending asks |
| `MailboxService` | mailbox messages, deliveries, recipients |
| `PendingInteractionService` | pending interactions (paused human gates) |
| `ContractService` | agent contracts (an agent's assignment + work context) |
| `AreaService` | areas (project groupings) |
| `ProjectService` | projects |
| `ConversationSendService` | orchestrator send queue |
| `ConversationReplayService` | transcript replay (read-path adapter, no write concern) |

(`work-items/gateway.ts`, `workflows/run-gateway.ts`, `agent-runs/run-gateway.ts`, `mailbox/mailbox-service.ts`, etc.)

### 3. The adapters (pure translators)

Each domain folder has an `adapters.ts` file — a set of simple functions that convert raw database rows into the data shapes the browser expects. Zero side effects; zero knowledge of the server, web requests, or processes. Used inside the gateways when building the outbox draft, and available to server routes that need to map rows without going through a full mutation.

(`work-items/adapters.ts`, `agent-runs/adapters.ts`, etc.)

### 4. Boot reconciliation (what happens on server restart)

A special piece of logic (`workflows/boot-reconcile.ts`) runs once at startup. It looks for workflow runs that were actively executing when the server last died and marks them as failed with the reason `interrupted-on-boot`. Runs parked at a review gate are left exactly as they were.

This is intentionally written without any direct database calls of its own — it just receives a "read runs" function and a "fail this run" callback as inputs. That makes the policy easy to test and reason about in isolation.

### 5. The broadcast shims (thin wrappers in the server)

The gateways live in `@pc/app-services` and know nothing about broadcasting. In the server, three thin "writer" files hold a singleton gateway instance and add the one extra step: call the gateway, then fan out the result to live WebSocket clients:

- `agent-run-writer.ts`
- `workflow-run-writer.ts`
- `work-item-writer.ts`

These are intentionally thin — they are not business logic.

### 6. Dependency injection (why it's testable)

Every gateway accepts an optional `Deps` argument at construction time. In production, those deps default to the real database functions. In tests, fake versions are injected instead — so the entire gateway can be tested without a running server or real database. (`agent-runs/run-gateway.ts:57–89`)

---

## How it connects

- **Depends on:** `@pc/db` (repo functions + `insertLiveEvent` + `getDb`) · `@pc/contracts` (DTO types) · `@pc/domain` (row types, domain value objects).
- **Does NOT depend on:** Hono (the web framework) · WebSocket hub · `AgentRun` · `PtySession` · `HostClient` · MCP SDK · any `apps/` package. Strictly enforced in every file's header comment ("Boundary purity").
- **Used by:** `apps/server/src/services/*-writer.ts` (broadcast shims) · `agent-run-settle.ts` · `agent-run-terminal-effects.ts` · `dag-run-service.ts` · server routes and feature routes (23 server files total import from `@pc/app-services`).
- **Crossing the boundary:** writes to `live_outbox` (the durable event log the live-relay drains to the UI); returns typed `Publication` objects carrying both the updated DTO and the outbox row; reads from `agent_runs`, `workflow_runs_v2`, `work_items`, `mailbox_messages`, `agent_contracts`, `areas`, `projects`.

---

## Target shape (per north star + Foundation Decisions)

In the five-role target architecture, `@pc/app-services` maps to the **Brain's control-plane write surface** — every durable state change routes through it. The gateways are already shaped correctly: transport-free, injectable, one transaction per mutation.

**Ledger verdict:** KEEP + finish the extraction. Remaining:

1. Migrate `work-item-writer.ts` (the old two-step form — see Known Issues) to route through `WorkItemMutationGateway`, so the work-item domain matches the other gateways.
2. Once Slice 3 of the workflow rebuild ships (run-event diary), route `appendEvent` through the gateway + `live_outbox`. Then `workflow_run_events` becomes a live entity and its gateway should live here.
3. Remove the dead `broadcast` callback arg from the agent-run and workflow-run shims in a cleanup pass.
4. If/when the Brain is separated from the HTTP server, `@pc/app-services` stays as-is — it has no HTTP surface and would survive the split unchanged.

---

## Known issues / scar tissue

**The biggest one — is there ANYTHING that circumvents the one door?**

Yes: one known bypass exists today, and a second gap.

1. **Work-item writes are a two-step, not one-step.** The old `work-item-writer.ts` (predates the gateway) does the product mutation first, *then* calls `announceWorkItemRow` as a separate transaction. So the write and the receipt are in two separate database transactions — if the second one fails, the outbox row is never written and the UI doesn't see the change. The newer `WorkItemMutationGateway.commitWorkItemChange()` is the correct form (mutation + outbox in one txn) and is the keeper. The old shim has not yet been cut. This is the main scar.

2. **The workflow run-event diary bypasses the gateway entirely.** `appendEvent` writes to the `workflow_run_events` table but those writes skip the gateway and skip `live_outbox`. The UI discards them (`res.events`). Until Slice 3 of the workflow rebuild ships, these are orphaned writes — the table exists but nothing reads it. (Ledger §0, row 3.)

3. **Dead `broadcast` arg on the run writer shims.** `agent-run-writer.ts` and `workflow-run-writer.ts` each accept a broadcast callback and immediately no-op it. Kept for caller compatibility but adds noise and creates a false impression. Cleanup deferred.

4. **`ProjectService` has a split-brain dispatch.** It calls two different code paths (`updateProjectMetaWithLiveEvent` vs `this.repo.updateProjectMeta`) depending on whether it was constructed with injected deps or defaults (`projects.ts:119`). This is a test-compat shim; the injectable path can't write the outbox in the same transaction. The callback-mutation pattern used elsewhere would clean this up.

5. **`toAgentRunDto` hard-codes `model: 'opus'`** (`agent-runs/adapters.ts:20`). The run row carries no model field; this is a known lossy mapping, documented in the file.

---

## Decisions & open questions

**For Emerson (product calls):**
- None immediately — this is infrastructure. The issues above are all engineering cleanup, not product choices. The only one that has a user-visible consequence: if the work-item two-step ever races (write succeeds, announce fails), a card change in the UI could silently not update. Worth knowing exists; not a daily hazard.

**Technical:**
1. Should `work-item-writer.ts` be deleted entirely in favour of routing all callers directly to `WorkItemMutationGateway`? The shim now adds indirection that doesn't pay for itself.
2. The `ProjectService` split dispatch (`projects.ts:119`) — worth normalizing to the callback-mutation pattern? Low risk, low urgency.
3. When the Brain is separated from the HTTP server (migration Steps 4–7), does `@pc/app-services` stay as the Brain's write surface, or get inlined into a new `@pc/brain` package? Current boundary would survive unchanged.
