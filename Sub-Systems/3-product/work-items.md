# Work Items

> **Role:** Store (durable state) · cross-cutting — agents, workflows, and UI all act on it
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `packages/domain/src/work-item.ts` · `packages/domain/src/work-item-policy.ts` · `packages/contracts/src/work-items.ts` · `packages/db/src/repos/work-items.ts` · `packages/app-services/src/work-items/gateway.ts` · `apps/server/src/services/work-item.ts` · `apps/server/src/services/work-item-writer.ts` · `apps/server/src/services/agent-work-item.ts` · `apps/server/src/features/work-items/routes.ts` · `apps/web/src/features/work-items/`

---

## What it is (plain English)

A **work item is a card on the board.** Every task, bug, feature, or research spike lives as exactly one row in the database. That row is the truth — the card's title, description, stage (column), status, and full history are whatever the row says they are. Everything you see in the app — the board, the detail panel, the agent's task list — is just a view on top of that row.

Work items are also the anchor point for everything automated: every agent dispatch, every workflow run, and every agent result links back to a work item.

---

## What it's supposed to do (intent)

Hold durable intent. Every piece of work — whether a human typed it or an agent minted it — has exactly one card. The database row is the single source of truth; runtime processes and UI views are just projections of it.

---

## The parts (every component, plain English)

### 1. The card's fields

The full set of information on each card (`packages/domain/src/work-item.ts`):

| Field | Plain English | Example / values |
|---|---|---|
| **id** | Unique ID, never reused | `01J...` (ULID) |
| **callsign** | The short human handle — write-once, stable forever | `pc-2`, `pc-2.1` |
| **title** | The card's name | "Draft onboarding email" |
| **body** | The description/brief — *also* where agents write their deliverable (see Known issues) | prose |
| **type** | What kind of work it is | `task` · `bug` · `feature` · `spike` |
| **stageId** | Which column it's in right now | (a stage ID) |
| **position** | Sort order within that column | a number |
| **areaId** | An optional "bucket" grouping across the board | (an area ID, or empty) |
| **status** | Lifecycle state | see status table below |
| **statusReason** | Why it's in that state (e.g. a rejection note) | text or empty |
| **fields** | Custom fields defined by the project's field schema | JSON blob |
| **isWorkflowRoot** | Marks this card as the anchor for a v2 workflow run | `true` / `false` |
| **parentId** | Points to the parent card, if this is a child | (a work item ID, or empty) |
| **projectId** | Which project it belongs to | (a project ID) |
| **version** | A counter that ticks up on every write — used to prevent two edits from colliding | `1`, `2`, `3`… |
| **history** | The append-only diary of everything that happened to this card | see history section |
| **deletedAt** | Soft-delete marker — "deleted" hides the card rather than erasing it | empty = alive |

**Statuses:**

| Status | Plain English |
|---|---|
| `pending` | Active, in progress |
| `complete` | Done (set automatically when moved to a "done" stage) |
| `cancelled` | Cancelled (set automatically when moved to a "cancelled" stage) |
| `archived` | Soft-deleted — hidden from board, not erased |
| *(plus 4 others)* | (additional statuses for agent-specific lifecycle states) |

### 2. Parent / child nesting

Cards can have children. A child card (`parentId` set) gets a callsign like `pc-2.1` — the parent's callsign plus a suffix. Children appear under their parent in the board and detail panel.

Callsigns are minted inside the same database write that creates the card, so two cards created at the same moment can't accidentally get the same callsign. (`packages/db/src/repos/work-items.ts:153`)

### 3. The history (the card's diary)

Every card carries an **append-only log** of everything that has happened to it — stored as a JSON array in the `history` column and shown in the UI's Activity tab. You can never edit or delete a history entry; new ones are only appended.

Entry kinds:

| Kind | What it records |
|---|---|
| `move` | Card moved from one stage to another — records `from` and `to` |
| `update` | A field was changed |
| `agent-invoke` | An agent was dispatched against this card |
| `agent-ask-user` | An agent paused and asked a human for input |
| `agent-ask-orchestrator` | An agent asked the orchestrator for input |
| `agent-approval-request` | A human review was requested |
| `agent-answer` | A question was answered |
| `agent-completed` | An agent finished successfully |
| `agent-failed` | An agent failed |

### 4. How agents touch cards

Three MCP tools (functions the orchestrator and agents can call) act on work items:

- **`pc_create_work_item`** — create a new card.
- **`pc_move_work_item`** — move a card to a different stage (this also fires workflow triggers if any are wired to that stage — ☠ trigger-firing dies with FD-10).
- **`pc_update_work_item`** — update a card's title, body, or fields.

When an agent is dispatched via `pc_create_agent_work_item`, the system mints a new child card *and* a linked "contract" row at the same moment. The contract is the verification spine — it records what the agent was asked for, and the acceptance criteria the result must meet. (`apps/server/src/services/agent-work-item.ts`)

The agent then writes its finished work back into the card's `body` column via `pc_update_work_item`. That same `body` column is where workflow steps read `$root.output` from — see Known issues.

### 5. The write gateway (the one door)

Every mutation — whether from a human clicking in the UI or an agent calling a tool — follows one path:

1. **`WorkItemService`** validates the change (checks the stage exists, validates custom field schemas, checks the version number to prevent collisions), writes the row, then calls `announceWorkItemRow`. (`apps/server/src/services/work-item.ts`)
2. **`announceWorkItemRow`** inserts a `work-item.changed` entry into the `live_outbox` table in its own transaction. The live relay picks it up and pushes it to every connected browser. (`apps/server/src/services/work-item-writer.ts`)

The **`WorkItemMutationGateway`** is the lower-level version of the same contract, used by workflows and the verification system. It runs the mutation *and* the live-event insert in a **single atomic transaction** — so if anything goes wrong, the card doesn't change *and* no event is broadcast. It has three entry points: `commitWorkItemChange` (full atomic), `announceWorkItemChange` (outbox only, mutation already happened), `announceWorkItemById` (re-reads then announces). (`packages/app-services/src/work-items/gateway.ts`)

Every mutation carries a typed reason (`WorkItemMutationReason`): `created` · `patched` · `moved` · `soft-deleted` · `restored` · `verified` · `approved` · `rejected` · `auto-advanced`.

### 6. Stage moves

Moving a card is version-checked (no overwriting a concurrent move). On a move, the system appends a `move` history entry with `from`/`to` and automatically derives the new status from the destination stage's flags (`isDone → 'complete'`, `isCancelled → 'cancelled'`, else `'pending'`).

Workflow triggers are **not** fired by `WorkItemService.move` itself — callers that want both compose the move *plus* the trigger call on top. (`apps/server/src/services/work-item.ts:311`) ☠ The trigger half goes away entirely under FD-10 — in the rebuild, a move is just a move.

### 7. The work-item policy (which outputs need a card)

`expectedOutputRequiresWorkItem` answers the question: "does this type of agent output need a card to land in?" The dispatch guard uses it to reject a dispatch that declares a card-requiring output but has no card linked. (`packages/domain/src/work-item-policy.ts`)

Current answers: `prose` output (unless stored as a contract) → requires a card; `repo` output → requires a card; `answer`, `payload`, `action`, `external`, `binary` → no card required (some forks open — see Decisions).

> 🟢 **FD-5 context (locked 2026-06-03):** `expected_output` moves off the pod onto the **Work
> Contract**, set at dispatch. So this policy's input becomes the contract's declared output for the
> job — not an agent-level default.

---

## How it connects

- **Depends on:** SQLite `work_items` table (via `@pc/db`) · `@pc/domain` types + field validation · `@pc/contracts` DTOs + live-event shapes · `live_outbox` table (for the broadcast write).
- **Used by:**
  - **Orchestrator** — creates, moves, and updates cards via MCP tools.
  - **Agent dispatch** — mints a card + contract for each agent job.
  - **Workflow engine** — creates a card as the workflow's root (`isWorkflowRoot: true`); reads `wi.body` live to resolve `$root.output` references (`dag-run-service.ts:173`); child steps create child cards.
  - **Verification / review** — flips status + appends history on run end; approve/reject advance or kick back at a human gate.
  - **UI** — the board renders one card per work item; the detail modal shows body, children, documents, and activity; subscribes to `work-item.changed` live events.
- **Events / contracts:**
  - `work-item.changed` live event — carries a typed reason + full card snapshot + optional attachments. (`packages/contracts/src/work-items.ts:82`)
  - Legacy `work-item-changed` WebSocket envelope — still emitted alongside the canonical event for backward compatibility.
  - `agent_contracts` table — created alongside an agent work item; the verification authority.

---

## Target shape (per north star + Foundation Decisions)

Per the consolidation ledger (`refactor plan/consolidation-ledger-2026-06-02.md §2`):

- **`work_items.history` → KEEP as truth** (HIGH confidence). `position` and `status` are projections; `history` is the append-only log.
- **`work_items.body` → KEEP, do NOT delete** (HIGH confidence, re-scoped 2026-06-03). `dag-run-service.ts:173` reads it live for `$root.output` workflow refs. A round-trip guard test should be added (`ledger §6 row 11`). ☠ The dual-purpose tension (brief AND deliverable in one column) feeds `_Foundation-Decisions.md` — see Decisions below.
- **`workflow_run_events` → aspirational** — the "events = truth" path is unbuilt; `dag_state` JSON is the workflow store today. Routing `appendEvent` through the gateway is Slice-3 work (`ledger §6 row 12`).

In the five-role target, the work-item store is owned by **Brain** (control plane). Every mutation goes through the gateway → `live_outbox` → live relay. The `history` array grows into a proper append-only event log in Slice-3. No behavioral change to the mutation interface is needed — the gateway pattern already matches the target shape.

---

## Known issues / scar tissue

- **`wi.body` does double duty.** The `body` column holds the original task brief *and* the agent's prose deliverable. `dag-run-service.ts:173` reads it live as `$root.output`. Before a prior fix, agents wrote their output into `fields.body` instead, silently freezing the column and breaking both workflow refs and `body_contains` acceptance-criteria checks. Fixed: `updateWorkItemFields` now promotes `body`/`title` keys from the fields map onto their real columns (`packages/db/src/repos/work-items.ts:306-348`). The deeper structural question is resolved — **FD-5**: the deliverable moves to the Work Contract; `body` returns to human-description-only in the rebuild.
- **The agent-update route bypasses `WorkItemService`.** `POST /api/projects/:id/work-items/update` calls `dbUpdateWorkItemFields` directly then announces separately. It skips field-schema validation (intentional for agent writes — agents don't use custom field schemas), but it's a second write path. (`apps/server/src/features/work-items/routes.ts`)
- **`workflow_run_events` writes go nowhere.** `appendEvent` writes to this table but bypasses the gateway/live_outbox pipeline, and the UI discards `res.events`. Observability stubs only — Slice-3 unbuilt. (`ledger §0 row 3`)
- **Callsign suffix scan is linear.** The per-parent suffix scan to find the next child number reads all siblings. Correct and safe today; not indexed; will slow at scale. (`packages/db/src/repos/work-items.ts:196-213`)

---

## Decisions & open questions

**Resolved 2026-06-03 → Foundation Decisions:**

- ~~Where does the deliverable live?~~ — **FD-5**: the deliverable lives on the **Work Contract**; `body` returns to being the human description only. (Migration guard: the `wi.body` ↔ `$root.output` coupling needs the round-trip test before the write moves.)
- **Patterns** — locked as **FD-20**: a "Patterns" place for repeatable work — a template (context + instructions + optional workflow) that mints a fresh, fully-loaded work item when invoked. Work items complete; Patterns persist; finished work items can be promoted to Patterns. No new runtime machinery.
- **Work item as context pod** — intent confirmed: a work item is the unit of work and the human↔AI collaboration point; humans define + provide context, the agent works from it. Whether the *full* card (attachments, fields, parent context) actually reaches the agent at dispatch is unverified → **dispatch-payload audit** (FD audit backlog).
- The three open output-type forks (`repo` / `external` / `binary` — card or no card) stay **parked** until those agent types are actually used.

**Still open (product calls):**

1. **Child cards per workflow step — do you want to see them?** Each workflow step today can create its own child card. That means a single workflow run may produce several cards under the root. Is that the right experience, or should intermediate step results live somewhere less visible?

**Technical:**
- Should the agent-update route be absorbed into `WorkItemService` so there is truly one write door? (Current bypass skips field validation — intentional, but structural inconsistency.)
- When Slice-3 lands (workflow events = truth), does `history` on the WI row become redundant for workflow-related entries, or do both coexist?
- `body_contains` acceptance-criteria predicate and `$root.output` both depend on `wi.body` being the deliverable — should this be made an explicit contract field to avoid silent regressions?
