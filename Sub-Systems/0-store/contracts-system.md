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

**Sense B — the "Work Contract" product concept** (code name: `Contract`): A first-class agent
assignment — a machine task with a typed expected output, a captured deliverable, and an
acceptance/verification lifecycle. One Work Contract optionally rolls up to one work item (1:many),
but can also exist without one. This is a product entity that lives in the `agent_contracts` SQLite
table. Types for Sense B live *inside* Sense A's package (`contracts.ts`) but the entity itself is
managed by the service and repo layers.

> 📛 **Naming decision (Emerson, 2026-06-03):** in all prose/docs we call this the **"Work
> Contract"** to avoid confusion with the `@pc/contracts` type package. The underlying code still
> uses `Contract` / `agent_contracts`; renaming the code is a separate task for the rebuild.

Both senses are real and active. They are not the same thing.

---

## What it is (plain English)

`@pc/contracts` is the single **"shared dictionary"** for the whole app — every type that crosses
a package or process boundary is defined here and only here. The web frontend, the API server, the
agent host, and background services all read from the same dictionary; no layer invents its own
version of a shared shape. Think of it as the rulebook that says "a work item always has *exactly
these fields* and any update to one always looks *exactly like this*."

Separately, the **Work Contract** is a product record that tracks each task handed to an agent:
what output was expected, what actually came back, and whether it passed an acceptance check.

---

## What it's supposed to do (intent)

The type package (`@pc/contracts`) enforces boundary purity. One place, one definition — no server
code leaks into the browser, no two layers disagree about what a "run" or a "card" looks like.
Keeping it behavior-free (no imports from apps, no runtime side effects) is the standing rule.

The Work Contract entity gives the system a durable record of every agent assignment so the
orchestrator and the workflow engine always know what was asked for and what came back.

---

## The parts (every component, plain English)

### 1. The shared dictionary (`@pc/contracts`)

Think of this as a filing cabinet that every part of the app shares. It is **20 files**, each
covering one "kind of thing." Each file follows the same four-part recipe:

1. **The shape** — what fields the thing has (e.g. `WorkItemDto`).
2. **The allowed states** — the fixed values it can be in (statuses, kinds, etc.).
3. **Validators** — small checkers that confirm incoming data actually matches the shape.
4. **The "something changed" notification** — the format of the live update pushed to the browser
   whenever this thing changes.

So a file with 15 exports is usually *one thing* described four ways. Here are all 20 things,
grouped by what they represent:

**Foundations (basic building blocks)**
- **`shared.ts`** — the ID format used everywhere (`ULID`) and the standard "success-or-error"
  wrapper every server response comes back in (`ApiResult`, `ParseResult`).
- **`live-events.ts`** — the live-update plumbing: the list of all 18 "something changed" event
  types, the subscribe/reset handshake, cursors, and the host-health snapshot (is the engine alive).

**The things on your board**
- **`work-items.ts`** — the cards/tasks: shape, types, statuses, and create / move / edit / delete /
  restore requests.
- **`areas.ts`** — board areas: shape + create / reorder / edit.
- **`stages.ts`** — the columns work moves through.
- **`projects.ts`** — a project: shape, settings, and create / update / reorder / delete.
- **`field-schemas.ts`** — definitions of custom fields you can add to work items.
- **`attachments.ts`** — files attached to things: shape, source, add / delete.

**The AI execution**
- **`agent-runs.ts`** — one run of an agent: shape, statuses, and *why* it last changed.
- **`workflow-definitions.ts`** — the workflow *recipe* (saved design): shape, scope (global vs one
  project), status.
- **`workflow-runs.ts`** — one *execution* of a workflow: the run, each step's state, and the review
  decisions (approve/reject).
- **`pods.ts`** — agent definitions; the "an agent's config changed" notification.
- **`contracts.ts`** — the agent work-order concept (Sense B above): expected output, the delivered
  result, and the acceptance/verification states.

**Talking & waiting**
- **`conversations.ts`** — chat sessions: kinds, statuses, why one ended.
- **`mailbox.ts`** — the notification system (the biggest file): messages, who they're addressed to,
  delivery attempts, and all the address types.
- **`pending-asks.ts`** — when an agent asks you a question and pauses: the question, its options,
  its status.
- **`pending-interactions.ts`** — the durable, saved-to-database version of those asks/approvals.

**Runtime wire shapes (how the app talks to a live Claude process)**
- **`runtime-transcript.ts`** — the format for replaying a chat transcript.
- **`runtime-send-queue.ts`** — messages queued to be typed into a running Claude.
- **`runtime-hook-ask.ts`** — the request/response shape for an ask that arrives through a Claude hook.

**The standing boundary rule** (`contracts.ts:7-8`): nothing in this package imports from `apps`,
`@pc/db`, or `@pc/domain`. Every file must work in a browser. Parsers accept `unknown` and return a
`ParseResult<T>`.

Two files (`agent-runs.ts`, `workflow-runs.ts`) also export legacy adapters
(`toLegacyAgentRunChanged`, `buildWorkflowRunChangedRefetchEnvelope`) that translate new event
shapes back to the old WebSocket envelope format. ☠ Sentenced — deleted once the raw-WS path is
retired (see Known issues).

**One critical helper — `contractDeliverableText`** (`contracts.ts:141`): the single function that
decides how a deliverable reads as plain text. Both the agent-completion path
(`agent-run-terminal-effects.ts:248`) and the workflow engine's output resolver
(`dag-run-service.ts:196`) call this same function, so neither can drift from the other.

### 2. The Work Contract entity

A Work Contract is the system's record of one agent assignment: *what was asked*, *what came
back*, and *whether it passed*.

**Stored in:** the `agent_contracts` SQLite table (`packages/db/src/repos/contracts.ts`).

**Domain types:** `packages/domain/src/contract.ts` defines the v2 `ExpectedOutput` / `Deliverable`
/ `AcceptancePredicate` union (server and DB only). A byte-for-byte copy lives in
`packages/contracts/src/contracts.ts` so the browser bundle can consume it without pulling in
server-only code. ⚠️ Two sources — any change must be made in both files (no drift guard exists today).

**Lifecycle:** a Work Contract moves through five states:

| Status | Plain meaning |
|---|---|
| `issued` | Assignment created; not yet handed to an agent |
| `dispatched` | An agent run has been started for it |
| `submitted` | The agent handed in its deliverable |
| `verifying` | An automated or manual check is in progress |
| `accepted` / `rejected` | Final verdict |

(`contracts.ts:168`)

**Deliverable kinds** (7): `answer`, `prose`, `payload`, `repo`, `external`, `binary`, `action`.

### 3. The service layer (the write door)

**`ContractService`** (`packages/app-services/src/contracts/service.ts`) is the only door through
which Work Contract state changes. Four operations: `create`, `setRun` (→ `dispatched`),
`setDeliverable` (→ `submitted`), `setVerification` (→ `accepted` | `rejected` | `verifying`).

Every mutation runs the database write **and** a `contract.changed` live-event row in the
**same transaction**. The live-relay drains that row automatically, so the browser always hears
about a change at the exact same moment it's committed — not after a separate broadcast step. All
writes bump the `version` counter on the row.

### 4. The read routes

**`apps/server/src/features/contracts/routes.ts`** exposes three read-only GET endpoints:

- Contract detail (by ID)
- Work-item contract timeline (oldest-first — all contracts tied to one card)
- Project-scoped contract list (newest-first; includes contracts not tied to any card)

Writes happen only through the service, called from within other handlers (agent completion,
workflow dispatch). There are **no mutation HTTP routes today** — you cannot create or update a
Work Contract directly via REST.

---

## How it connects

- **`@pc/contracts` (the dictionary) depends on:** nothing. Zero runtime deps; imports nothing outside itself.
- **The Work Contract service depends on:** `@pc/db` (the `agent_contracts` table, `live_outbox`) · `@pc/domain` (v2 union types).
- **Used by:**
  - `apps/web/*` — imports DTOs, guards, route constants, live-event types for rendering and WebSocket parsing.
  - `apps/server/*` — imports parsers for all request validation; terminal-effects + workflow engine call `contractDeliverableText`.
  - `packages/app-services/*` — `ContractService` imports the full DTO and event type set.
  - `packages/mcp/*` (unverified) — MCP tools that surface Work Contracts to the orchestrator likely import request/response types from here.
- **Live boundary crossed:**
  - `contract.changed` live event (project-scoped) — emitted in-transaction, drained by live-relay to the web.
  - `contractDeliverableText` — the one function called by both the completion path and the DAG output resolver.

---

## Target shape (per north star + Foundation Decisions)

Consolidation ledger (`consolidation-ledger-2026-06-02.md §2`) verdict:
**KEEP `agent_contracts.deliverable` as the owned deliverable store. KEEP `work_items.body` for
backward-compat** (`dag-run-service.ts` reads it live for `$root.output` refs) — do not delete.

`@pc/contracts` as the boundary-type package is **foundational and unchanged by the migration**.
The five-role design just requires every new boundary type to be added here. The package is already
in the right shape.

The Work Contract's role in the target: as the Engine owns all `claude.exe` sessions and the Brain
runs a single reconciler, Work Contracts become the durable record the reconciler checks to know
what a run was supposed to produce. The `setDeliverable` call (triggered by `pc_submit_deliverable`
→ `complete-run`) is already the positive receipt signal. No structural change needed — contract
writes ride the existing service door unchanged.

**What changes:** nothing for the type package. For the entity: once the workflow event log becomes
truth (ledger row 12 / slice 3), `appendEvent` will route through the live-outbox so
`workflow_run_events` rows become observable; Work Contract writes are unaffected.

---

## Known issues / scar tissue

- **Mirrored union (two sources of truth).** `packages/domain/src/contract.ts` and
  `packages/contracts/src/contracts.ts` both define the identical v2 `ExpectedOutput` /
  `Deliverable` / `AcceptancePredicate` union. The comment in `contracts.ts:9` explains this is
  intentional (browser safety), but any change must be made in both files. No drift guard exists
  today (unverified).
- **`work_items.body` does double duty.** `dag-run-service.ts:173` reads `wi.body` live to resolve
  `$root.output` workflow refs, so the body field is both a display field and a workflow-ref source.
  Ledger verdict is KEEP + document; a round-trip guard is recommended but not written
  (`consolidation-ledger-2026-06-02.md §0`).
- **The workflow run-events diary is write-only.** `appendEvent` writes the `workflow_run_events`
  table but bypasses the gateway/live_outbox, and the UI discards `res.events`
  (`consolidation-ledger-2026-06-02.md §0`). The `workflow.run.changed` live event contract exists
  and is correct, but the full "events = truth" path is unbuilt (ledger row 12 / slice 3).
- **Legacy envelope adapters not yet retired.** `agent-runs.ts` and `workflow-runs.ts` still export
  `toLegacyAgentRunChanged` and `buildWorkflowRunChangedRefetchEnvelope`. These exist because the
  server still emits old WebSocket envelope shapes alongside canonical events. ☠ Delete when the
  raw-WS-broadcast → live-relay merge completes (ledger: `raw WS broadcast → MERGE→live-relay`).
- **No mutation HTTP routes yet.** `routes.ts` is read-only. Contract creation and deliverable
  submission happen inside other handlers (agent-run-terminal-effects, workflow dispatch). No REST
  surface for authoring a Work Contract directly.

---

## Decisions & open questions

**For Emerson (product calls):**
1. **Direct "create a Work Contract" API** — today you can only create one by dispatching an agent
   or running a workflow step. Should the orchestrator (or a human) be able to issue a Work Contract
   without starting a run first? Relevant if you ever want to stage assignments ahead of time.

**Technical:**
- Add a drift test that keeps `packages/domain/src/contract.ts` and
  `packages/contracts/src/contracts.ts` byte-identical? The mirror is intentional but unguarded.
- When do mutation routes land in `contracts/routes.ts`? Needed for a direct "create contract" API surface.
- Once raw-WS-broadcast → live-relay merge lands, can the legacy envelope adapters be deleted, or
  do external consumers still depend on the old envelope format?
