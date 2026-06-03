# App-Services Layer (Gateways & Adapters)

> **Role:** Brain (control plane — the home of all durable write logic)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `packages/app-services/src/index.ts`, `packages/app-services/src/`

---

## What it is (plain English)

`@pc/app-services` is a portable package that sits between the raw database
(SQLite, via `@pc/db`) and the HTTP server (`apps/server`). It is the single
durable write door for every entity the UI cares about. Every mutation — creating
a work item, pausing an agent run, cancelling a workflow, enqueuing a mailbox
message — routes through one of its gateways. The gateway writes the product row
and the matching `live_outbox` notification row in one atomic transaction, then
hands back a typed publication that the server fans out to WebSocket clients.

The package also owns the pure mappers (adapters) that convert raw SQLite rows
to the browser-safe DTOs defined in `@pc/contracts`.

---

## What it's supposed to do (intent)

Own the "durable write + outbox fact" step for every entity, with no knowledge
of HTTP, WebSockets, or runtime processes. The reason it is a separate package:
any code that needs to write durable state should import *this* package, not
re-implement the transaction-plus-outbox pattern inline. The boundary keeps the
server's HTTP wiring (routes, broadcast) from leaking into business logic, and
makes the gateways unit-testable without a running server (inject fake `transaction`
and `insertLiveEvent` via the `Deps` constructor pattern).

---

## How it works today (as-built)

### The core pattern — identical across all gateways

1. Caller invokes a gateway method (e.g. `gateway.pauseRun(...)`).
2. The gateway opens a `getDb().transaction(...)`.
3. Inside the same transaction: product mutation (repo write) + `insertLiveEvent(tx, draft)` writes a `live_outbox` row.
4. On commit, the gateway returns a typed `Publication` object (the updated DTO + the live-outbox row).
5. The **caller** (a server-side writer service, never the gateway itself) fans out the canonical `{type:'live-event'}` frame and any legacy WS envelope to clients via the live-relay or broadcast.
6. On rollback, nothing is emitted — structural guarantee.

This is the "one durable fact point" principle applied per entity.

### Domains covered

| File | Gateway / Service | Entity |
|------|-------------------|--------|
| `work-items/gateway.ts` | `WorkItemMutationGateway` | work items, stages, field schemas, attachments |
| `workflows/run-gateway.ts` | `WorkflowRunMutationGateway` | workflow runs, review facts |
| `workflows/boot-reconcile.ts` | `reconcileWorkflowRunsOnBoot()` | workflow boot-time fail-close |
| `agent-runs/run-gateway.ts` | `AgentRunMutationGateway` | agent runs, pending asks |
| `mailbox/mailbox-service.ts` | `MailboxService` | mailbox messages, deliveries, recipients |
| `mailbox/pending-interaction-service.ts` | `PendingInteractionService` | pending interactions |
| `contracts/service.ts` | `ContractService` | agent contracts |
| `areas/service.ts` | `AreaService` | areas (project groupings) |
| `projects.ts` | `ProjectService` | projects |
| `conversations/send-service.ts` | `ConversationSendService` | orchestrator send queue |
| `conversations/replay-service.ts` | `ConversationReplayService` | transcript replay |

### Adapter files (pure, no side effects)

Each domain folder has an `adapters.ts`: pure functions mapping SQLite rows to
`@pc/contracts` DTOs. Zero imports from Hono, WS, process classes, or runtime.
Used by the gateway itself when building the outbox draft, and exported for
server routes that need to map rows without going through a full mutation.

### Dependency injection pattern

Every gateway accepts an optional `Deps` constructor arg. Defaults wire to the
live `@pc/db` functions. Tests inject fakes. Example from
`agent-runs/run-gateway.ts:57–89`: `transaction`, `insertLiveEvent`, `getRun`,
`updateStatus`, `markTerminal`, etc. are all overridable.

### `WorkflowBootReconcile` (pure logic, no DB calls itself)

`workflows/boot-reconcile.ts` is intentionally side-effect-free: it takes a
`listRuns` function and a `failClosed` callback as deps and calls them. The
server wires the real DB reads + gateway writes. This makes the boot-reconcile
policy testable without a DB (`reconcileWorkflowRunsOnBoot`, line 43).

---

## The architectural seam — app-services vs apps/server/src/services

This is the key question. The answer: **app-services is the portable core; the
server's `services/` directory is the HTTP-wiring and runtime-composition layer**.
They are not duplicates — they are two distinct layers.

### What `@pc/app-services` owns

- Transaction-wrapped durable writes + outbox fact insertion.
- Row-to-DTO adapters (pure).
- Boot-reconcile logic (pure, injectable deps).
- Dependency-injectable constructors so the layer is testable in isolation.
- No Hono, no WS hub, no `AgentRun`/`PtySession`/`HostClient` runtime classes.
  Every gateway file enforces this in its header comment ("Boundary purity").

### What `apps/server/src/services/` owns

- **Writer shims** that hold a singleton gateway instance and add the broadcast
  call: `agent-run-writer.ts`, `workflow-run-writer.ts`, `work-item-writer.ts`.
  These are thin — they instantiate the gateway, call the gateway method, and
  call `fanout(pub, broadcast)`.
- **Runtime services** with no app-services equivalent: `agent-run-factory.ts`,
  `agent-run-settle.ts`, `agent-run-terminal-effects.ts`, `project-runtime.ts`,
  `dag-run-service.ts`, `host-connection.ts`, etc. These are heavy — they own
  `AgentRun` objects, `PtySession`, `InteractiveSession`, host-client handles.
  They are NOT being extracted into app-services; they belong to the Brain /
  Engine layer, not the portable write-door layer.
- **Pure utility services** (file system, onboarding, preflight, etc.) that have
  no durable-write concern and never will.

### Evidence this is a clean seam, not accidental duplication

`apps/server/src/services/work-item-writer.ts` (the old writer) predates the
gateway. It still exists as a thin shim that calls `announceWorkItemRow`, which
does its own `getDb().transaction(() => insertLiveEvent(...))` — a slightly
older inline form of the same pattern. The newer gateway pattern (`WorkItemMutationGateway`)
is the correct form: it accepts the product mutation as a callback, so mutation +
outbox happen in one txn. The old writer does them in separate txns (mutation
happened before the writer was called). This inconsistency is the main scar: two
forms of the same "announce" pattern coexist. The gateway form is the keeper.

`apps/server/src/services/agent-run-writer.ts` and `workflow-run-writer.ts` both
import from `@pc/app-services` and hold singleton gateway instances. The legacy
`broadcast` callback arg is now a no-op in both (comments say "relay-delivered;
no hand fanout"). The fanout seam is structurally correct; the legacy arg is dead.

---

## Integrations (how it connects)

- **Depends on:** `@pc/db` (repo functions + `insertLiveEvent` + `getDb`) · `@pc/contracts` (DTO types, payload types) · `@pc/domain` (row types, domain value objects).
- **Does NOT depend on:** Hono · WebSocket hub · `AgentRun` · `PtySession` · `HostClient` · MCP SDK · any `apps/` package. The boundary is strictly enforced in every file's header.
- **Used by:** `apps/server/src/services/*-writer.ts` (thin broadcast shims) · `apps/server/src/services/agent-run-settle.ts` + `agent-run-terminal-effects.ts` · `apps/server/src/services/dag-run-service.ts` · `apps/server/src/routes/*` · `apps/server/src/features/*/routes.ts` (23 server files total import from `@pc/app-services`).
- **Contracts / events crossed:** writes to `live_outbox` (the durable event log the live-relay drains); reads from `agent_runs`, `workflow_runs_v2`, `work_items`, `mailbox_messages`, `agent_contracts`, `areas`, `projects` tables. Returns typed `Publication` objects that carry both the outbox row and the mapped DTO.

---

## Target shape (per north star)

In the five-role target, `@pc/app-services` maps to the **Brain's control-plane
write surface** — the Brain owns the Store and all durable transitions route
through it. The gateways are already shaped correctly for this: transport-free,
injectable, one txn per mutation.

**Ledger verdict (implied, no explicit row):** KEEP + finish the extraction.
Specifically:

1. The `work-item-writer.ts` inline announce pattern (separate txns) should be
   migrated to use `WorkItemMutationGateway.commitWorkItemChange(...)` so the
   mutation and outbox fact are one txn. Today `work-item.ts` calls
   `announceWorkItemRow` *after* the repo write — if the second txn fails the
   outbox row is missing.
2. The `ConversationSendService` / `ConversationReplayService` are thin facades
   with no gateway-pattern equivalents yet (the send queue is already durable via
   its own repo; these are read-path adapters). They stay as-is.
3. Once Step 12 (ledger §6, row 12) ships — routing `appendEvent` through the
   gateway/live_outbox — `workflow_run_events` becomes a live entity and its
   gateway should live here.
4. The dead `broadcast` callback arg on `agent-run-writer` and
   `workflow-run-writer` shims should be removed in a cleanup pass.

No merge or delete verdict for this package. It is the correct extraction target.

---

## Known issues / scar tissue

1. **Two "announce" forms coexist for work items.** `work-item-writer.ts` (old form: mutation already happened, writer announces separately — two txns). `WorkItemMutationGateway.commitWorkItemChange` (correct form: mutation + outbox in one txn). The gateway form is the keeper; the writer shim has not yet been cut.

2. **Dead `broadcast` arg on writer shims.** `agent-run-writer.ts:fanoutAgentRunChange` and `workflow-run-writer.ts:fanout` accept a broadcast callback and immediately no-op it. The arg is kept for caller compat but adds noise and creates the false impression that broadcast is still happening there. Cleanup deferred.

3. **`ProjectService` has a code smell: it dispatches to `updateProjectMetaWithLiveEvent` (inline form) vs `this.repo.updateProjectMeta` (injectable form) based on `this.repo !== defaultRepo`** (`projects.ts:119`). This is a test-compat shim — the injectable form can't write the outbox in the same txn because the repo abstraction doesn't receive the txn. The gateway pattern (pass mutation as callback) would clean this up.

4. **`workflow_run_events` writes are currently dead** (ledger §0, row 3): `appendEvent` writes to the table but the rows bypass the gateway/live_outbox and the UI discards `res.events`. The table exists; the gateway wiring does not. Until Slice 3 ships, these are orphaned writes.

5. **`toAgentRunDto` hard-codes `model: 'opus'`** (`agent-runs/adapters.ts:20`). The run row carries no model field; the DTO freezes the legacy fallback. This is a known lossy mapping, documented in the file.

---

## Open questions

1. Should `work-item-writer.ts` (server-side shim) be deleted in favour of routing all callers directly to `WorkItemMutationGateway`? The shim adds a layer of indirection that no longer pays for itself now that the gateway exists.

2. The `ProjectService` injectable-vs-default dispatch split (`projects.ts:119`) — is it worth normalizing to the callback-mutation pattern used by the other gateways? Low risk, low urgency.

3. When the Brain is separated from the HTTP server (migration Steps 4–7), does `@pc/app-services` stay as the Brain's write surface, or does it get inlined into a new `@pc/brain` package? The current boundary would survive that split unchanged — the package has no HTTP surface.
