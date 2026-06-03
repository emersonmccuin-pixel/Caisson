# Contracts System

> **Role:** cross-cutting (shared seam — consumed by Engine, Brain, Store, and UI)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `packages/contracts/src/` — the shared type package
> `packages/domain/src/contract.ts` — domain-layer v2 union (server/DB-only)
> `packages/app-services/src/contracts/service.ts` — the durable write door
> `apps/server/src/features/contracts/routes.ts` — HTTP read endpoints
> `packages/db/src/repos/contracts.ts` — SQLite persistence

---

## Disambiguation — two meanings of "contract" in this codebase

**Sense A — `@pc/contracts` (the package):** A shared TypeScript type library. Every shape
that crosses a boundary in the app lives here: server↔web DTOs, live-event payloads, request
parsers, guards. No runtime behavior, no imports from any app or server package. The package is
browser-safe by design (zero runtime deps). This is the architectural seam.

**Sense B — the `Contract` product concept:** A first-class agent assignment — a machine task
with a typed expected output, a captured deliverable, and an acceptance/verification lifecycle.
One `Contract` row optionally rolls up to one work item (1:many), but can also exist without one.
This is a product entity that lives in the `agent_contracts` SQLite table. Types for Sense B
live *inside* Sense A's package (`contracts.ts`) but the entity itself is managed by the service
and repo layers.

Both senses are real and active. They are not the same thing.

---

## What it is (plain English)

`@pc/contracts` is the single "language dictionary" for the whole app — every type that
crosses a package or process boundary is defined here and only here. The web frontend, the API
server, the agent host, and background services all import from the same package; none of them
independently invent their own shapes. Alongside this type library, the `Contract` product
concept tracks each task an agent is assigned: what output was expected, what was actually
delivered, and whether it passed acceptance checks.

## What it's supposed to do (intent)

`@pc/contracts` exists to enforce boundary purity. If every boundary type is defined in one
browser-safe, zero-dep package, no server-only code can accidentally leak into the browser bundle
and no two layers can drift into describing the same wire shape differently. It is the seam — and
keeping it a seam (no behavior, no imports from apps) is the invariant.

The `Contract` entity exists to give the orchestrator a durable record of every agent assignment:
what was asked for, what came back, whether it passed.

---

## How it works today (as-built)

### The `@pc/contracts` package

Single entry point at `packages/contracts/src/index.ts` re-exports 20 source files.

**Boundary rule** (`contracts.ts:7-8`): no imports from `apps`, `@pc/db`, or `@pc/domain`. Every
file in the package is browser-safe. Parsers accept `unknown` and return `ParseResult<T>`
(defined in `shared.ts`).

**Files by category:**

| Category | Files | What they define |
|---|---|---|
| Primitives | `shared.ts` | `ULID`, `ParseResult<T>`, `ApiOk/ApiErr/ApiResult`, `parseOk/parseErr` |
| Live-event infrastructure | `live-events.ts` | `LiveEvent<T>`, `LiveEventFrame<T>`, subscribe/reset handshake, cursor types, all `LiveEventTypeName` literals (18 event types), `HostHealthSnapshot` |
| Domain DTOs | `agent-runs.ts`, `workflow-runs.ts`, `contracts.ts`, `work-items.ts`, `areas.ts`, `stages.ts`, `field-schemas.ts`, `attachments.ts`, `workflow-definitions.ts`, `projects.ts`, `pods.ts` | Browser-safe DTO mirrors of every server entity + their canonical `*.changed` live-event payloads |
| Runtime wire shapes | `runtime-transcript.ts`, `runtime-send-queue.ts`, `runtime-hook-ask.ts` | The session-replay response, send-queue item DTO, and hook-ask request/response shapes |
| Async coordination | `pending-asks.ts`, `pending-interactions.ts`, `mailbox.ts` | Agent pause/ask/approval DTOs + the full mailbox address/message/delivery DTO set |

**Pattern per file:** each domain file exports (1) a DTO interface, (2) `const`/`type` enums,
(3) `is*` type guards that accept `unknown`, (4) `parse*` functions that return `ParseResult`,
(5) the canonical live-event payload + frame types and their guards. The `agent-runs.ts` and
`workflow-runs.ts` files also export legacy compatibility adapters (`toLegacyAgentRunChanged`,
`buildWorkflowRunChangedRefetchEnvelope`) that project canonical events back to the old WS
envelope shape.

**`contractDeliverableText`** (`contracts.ts:141`): the ONE place that decides what a
`Deliverable` "reads as" as plain text. Both `agent-run-terminal-effects.ts:248` (completion
envelope) and `dag-run-service.ts:196` (`$node.output` resolver) call it, ensuring neither can
diverge in how they render a deliverable.

### The `Contract` product entity

**Domain types:** `packages/domain/src/contract.ts` — the v2 `ExpectedOutput` / `Deliverable` /
`AcceptancePredicate` union, used by the server and DB layers. The identical union is mirrored
into `packages/contracts/src/contracts.ts` so the browser bundle can consume it without reaching
into `@pc/domain`.

**Persistence:** `packages/db/src/repos/contracts.ts` — `agent_contracts` SQLite table.
`createContractInDb`, `setContractRunInDb`, `setContractDeliverableInDb`,
`setContractVerificationInDb`. All writes bump the `version` counter; no outbox write here.
Reads include by-work-item (oldest first), by-run, and by-project.

**Service layer:** `packages/app-services/src/contracts/service.ts` — `ContractService`. Every
mutation runs the repo write + `insertLiveEvent(tx, draft)` **in the same transaction**. The
live-relay drains the committed `contract.changed` outbox row automatically. Four mutations:
`create`, `setRun` (→ `dispatched`), `setDeliverable` (→ `submitted`), `setVerification`
(→ `accepted` | `rejected` | `verifying`).

**HTTP routes:** `apps/server/src/features/contracts/routes.ts` — three read-only GET endpoints:
contract detail, work-item contract timeline (oldest-first), and project-scoped contract list
(newest-first, includes WI-optional contracts). Writes go through the service elsewhere (no
mutation routes here yet).

**Web client:** `apps/web/src/features/contracts/client.ts` — thin fetch wrapper over
`contractRoutes` from `@pc/contracts`.

**Status lifecycle:** `issued → dispatched → submitted → verifying → accepted | rejected`
(`contracts.ts:168`).

**Deliverable kinds** (7): `answer`, `prose`, `payload`, `repo`, `external`, `binary`, `action`.

---

## Integrations (how it connects)

- **Depends on:** nothing (the type package). The service layer depends on `@pc/db` and `@pc/domain`.
- **Used by:**
  - `apps/web/*` — imports DTOs, guards, route constants, live-event types for rendering and WS parsing
  - `apps/server/*` — imports parsers for all request validation; service/terminal-effects import `contractDeliverableText` and `Contract` DTO
  - `packages/app-services/*` — imports all DTO and event types; `ContractService` imports from here
  - `packages/mcp/*` (unverified) — MCP tools that surface agent contracts to the orchestrator likely import request/response types from here
- **Contracts / events crossed:**
  - `contract.changed` live event (project-scoped) — emitted in-transaction by `ContractService`, drained by the live-relay to the web
  - `agent_contracts` table — the authoritative store for `Contract` rows
  - `contractDeliverableText` — the single projection function that both the terminal-effects path and the DAG `$node.output` resolver call

---

## Target shape (per north star)

The consolidation ledger (`consolidation-ledger-2026-06-02.md §2`, Sources of truth) verdict:
**KEEP `agent_contracts.deliverable` as the owned deliverable store; KEEP `work_items.body` for
backward-compat (dag-run-service reads it live for `$root.output` refs) — DO NOT delete.**

`@pc/contracts` as the boundary-type package is **foundational and unchanged by the migration**.
The five-role design does not redistribute type ownership — it just requires that every new
boundary type be added here. The package is already in the correct shape for the target.

The `Contract` entity's role in the target: as the Engine moves to own all `claude.exe` sessions
and the Brain runs a single reconciler, contracts become the durable record that the reconciler
checks to know what a run was asked to produce. The `setDeliverable` call (triggered by
`pc_submit_deliverable` → `complete-run`) is already the positive receipt signal. No structural
changes needed — contract writes ride the existing `ContractService` door.

**What changes from today:** None for the type package. For the entity: once the workflow event
log becomes truth (ledger row 12), `appendEvent` will route through the live-outbox so
`workflow_run_events` rows become observable; the contract's deliverable is still written via the
service unchanged.

---

## Known issues / scar tissue

- **Mirrored union (two sources):** `packages/domain/src/contract.ts` and
  `packages/contracts/src/contracts.ts` both define the v2 `ExpectedOutput` / `Deliverable` /
  `AcceptancePredicate` union — byte-for-byte identical. The comment in `contracts.ts:9` explains
  this is intentional (browser bundle must not reach into `@pc/domain`), but it means any change
  to the union must be made in both files. No drift guard exists today (unverified).
- **`work_items.body` dual purpose:** `dag-run-service.ts:173` reads `wi.body` live to resolve
  `$root.output` workflow refs, so the body field is both a legacy display field and a
  workflow-ref source. The ledger re-scoped this to KEEP + document; a round-trip guard is
  recommended but not yet written (`consolidation-ledger-2026-06-02.md §0`).
- **`workflow_run_events` writes are dead observability:** `appendEvent` writes the table but
  the events bypass the gateway/live_outbox and the UI discards `res.events`
  (`consolidation-ledger-2026-06-02.md §0`). The `workflow.run.changed` live event contract
  exists and is correct, but the full "events = truth" path is unbuilt (ledger row 12 / slice 3).
- **Legacy envelope adapters not yet retired:** `agent-runs.ts` and `workflow-runs.ts` still
  export `toLegacyAgentRunChanged` and `buildWorkflowRunChangedRefetchEnvelope`. These exist
  because the server still emits the old WS envelope shapes alongside the canonical events.
  They should be deleted when the raw-WS-broadcast → live-relay merge completes (ledger: `raw WS
  broadcast → MERGE→live-relay`).
- **No mutation HTTP routes yet:** `routes.ts` is read-only. Contract creation and deliverable
  submission happen through the service called from within other handlers (agent-run-terminal-
  effects, workflow dispatch). There is no REST surface for authoring a contract directly.

---

## Open questions

- Should a drift test enforce that `packages/domain/src/contract.ts` and
  `packages/contracts/src/contracts.ts` stay byte-identical? The mirror is intentional but there
  is no guard against the two drifting.
- When should mutation routes be added to `contracts/routes.ts`? Currently the only write path
  is through agent-run completion or the workflow engine. A direct "create contract" API surface
  would let the orchestrator issue contracts without spawning a run first.
- Once the raw-WS-broadcast → live-relay merge lands, can the legacy envelope adapters
  (`toLegacyAgentRunChanged`, etc.) be deleted, or do external consumers of the WS still depend
  on the old envelope format?
