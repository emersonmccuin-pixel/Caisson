# Store / Database

> **Role:** Store
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `packages/db/src/schema.ts` · `schema-agent-system.ts` · `connection.ts` · `migrate.ts` · `id.ts` · `packages/db/src/repos/`

---

## What it is (plain English)

Think of it as the **app's single filing cabinet.** Everything Caisson knows — projects, cards on boards, agent definitions, workflow runs, messages, settings — lives in one SQLite file (`pc.sqlite`) on disk. Every other part of the app reads from and writes to that file. If the server restarts, the filing cabinet is the only thing that survives; everything else rebuilds from it.

---

## What it's supposed to do (intent)

Be the one place where "what is true" is answered. Processes, in-memory bookkeeping, and live browser state are all *temporary reflections* of the DB — the DB is the root. If the DB says a run is completed, it's completed, no process memory required.

---

## The parts (every component, plain English)

### 1. Opening and connecting (`connection.ts`)

The app opens exactly one database connection for its entire lifetime (a "lazy singleton" — created the first time anything asks for it). It lives at `<PC_DATA_DIR>/pc.sqlite`. Two safety settings are turned on every time it opens: **WAL mode** (lets reads and writes happen simultaneously without blocking each other) and **foreign key enforcement** (prevents orphaned records).

### 2. Migrations — keeping the schema up to date (`migrate.ts`, `packages/db/drizzle/`)

A **migration** is a numbered script that alters the database structure (adds a column, creates a table, etc.). There are 40 of them, run in order at startup (`0000_init.sql` → `0040_agent_run_delivered.sql`).

After every migration run, a **schema integrity check** (`assertSchemaIntact`) compares every column defined in code against the actual database. If a column is missing it throws a hard error with repair instructions — preventing silent "no such column" crashes. The packaged desktop app handles the migrations folder path separately (the file layout inside the package is different from development).

### 3. IDs — how every record is identified (`id.ts`)

Every row in the database gets a **ULID** — a 26-character ID that sorts chronologically. Two IDs created in the same millisecond are still strictly ordered. That means `ORDER BY id` always equals insertion order, everywhere.

### 4. Schema conventions (how tables are built)

Four rules applied consistently across all tables:

| Convention | What it means | Example |
|---|---|---|
| Text ID | Every primary key is a ULID string | `"01J5…"` |
| Integer timestamp | Dates stored as milliseconds since 1970 (not text) | `1748908800000` |
| JSON columns | Typed blobs for structured sub-data | `dag_state`, `custom_fields` |
| Soft delete | Deletions stamp a `deleted_at` time rather than erasing the row | empty = alive |
| Optimistic concurrency | A `version` or `rev` counter increments on every change; the browser discards updates it's already seen | `rev: 3` |

### 5. What's stored — the table inventory

#### Projects and global settings

| Table | What it holds |
|---|---|
| `projects` | Project rows: name, slug, board stages, folder path, git remote, callsign counter, drag order. Soft-deleted. |
| `settings_global` | One row. The global app settings singleton. |

#### Cards (work items)

| Table | What it holds |
|---|---|
| `work_items` | Cards on the board: title, body, stage, status, type, custom fields, move/edit history, callsign, area link, workflow-root flag. Soft-deleted. |
| `areas` | Project-scoped buckets that cards can roll up into. Soft-deleted. |
| `attachments` | File or text content stored **inline in the DB** — no filesystem path. Linked to a card; optionally linked to a run. |
| `field_schemas` | Per-project definitions for custom card fields (label, type, options, required, order). |

#### Workflows

| Table | What it holds |
|---|---|
| `workflows` | Workflow definitions: YAML source, parsed logic, scope, status (active/invalid), origin. Soft-deleted. |
| `workflow_audit` | Append-only change log for workflow definitions. |
| `workflow_runs_v2` | One row per live or recent run: current DAG state blob (`dag_state`), status, trigger context, frozen workflow snapshot, rev. The run itself is a `work_item` (flagged `is_workflow_root=true`); this table holds only the bookkeeping the work-item table can't. |
| `workflow_run_events` | **✅ THE run diary (truth-grade since M3a 2026-06-04)** — append-only story of each run; every line written through `WorkflowRunMutationGateway.appendRunEvent` (row + `workflow.run.event` live fact, one txn; DIARY-DOOR gate). Read by `pc_get_workflow_run` + the Workflows run panel. `dag_state` remains the EXECUTION store until M6 projects from the diary. |
| `failed_run_dismissals` | Timestamps for when a user dismissed a "Failed recently" notice per run. |
| `worktrees` | Git worktree paths tied to a card or run. |

#### Agents / Pods

| Table | What it holds |
|---|---|
| `agents` | Pod definitions: name, scope, prompt, allowed tools, model, effort, max turns, output destination, origin, rev. Soft-deleted. |
| `agent_knowledge` | Reference documents attached to a pod. |
| `agent_secrets` | API keys and env-var secrets for a pod. ⚠️ Stored as plain text today; encrypted storage is planned. |
| `agent_mcp_servers` | Extra tool servers attached to a pod. |
| `agent_audit` | Append-only change log for all pod mutations. Groups related edits by `change_set_id`. |

#### Agent runs

| Table | What it holds |
|---|---|
| `agent_runs` | One row per dispatched run. Full state machine: `queued → spawning → running → paused → completed/failed/cancelled`. Carries CC session id, pod name, pod rev hash, PID (see Known issues), deliverable timestamp, continuation link. |
| `agent_contracts` | The machine assignment for a run: expected output, acceptance criteria, verification status, typed deliverable. Optional link to a card. |
| `pending_asks` | One row per agent pause (`pc_ask_user` / `pc_ask_orchestrator`). Status: `open → answered/cancelled`. Answer-once enforced in the DB. |
| `agent_inbox` | **☠ Legacy / pending deletion.** Pre-mailbox delivery rows. Zero TypeScript callers on the server, but `templates/.claude/hooks/inbox-drain.cjs` still reads/writes these via raw SQL on every prompt. Cannot be dropped until that hook is refactored to use the mailbox. (Ledger §0 confirmed 2026-06-03.) |
| `agent_delivery_audit` | Audit trail for `agent_inbox` deliveries. Lives and dies with `agent_inbox`. |

#### Orchestrator

| Table | What it holds |
|---|---|
| `orchestrator_sessions` | One row per orchestrator session: provider session id, model, title, status (active/ended), JSONL path and line cursor. One active session per project enforced. |
| `orchestrator_send_queue` | Outbound message queue for the orchestrator PTY. Status: `queued → delivering → delivered_to_pty → observed_in_jsonl / failed / cancelled`. Retry counter and failure reason. |

#### Live events (the broadcast bus)

| Table | What it holds |
|---|---|
| `live_outbox` | Append-only, auto-incrementing sequence. Every entity change inserts a row here; a relay worker drains rows after its cursor and pushes them to the browser over WebSocket. Stamped when sent. |

#### Mailbox

| Table | What it holds |
|---|---|
| `mailbox_messages` | Durable messages with idempotency key, subject, body, payload, and source reference. |
| `mailbox_recipients` | Per-recipient address and UI read/action/dismiss state. |
| `mailbox_deliveries` | Delivery lease, ack, retry, and dead-letter state per (message, recipient, channel). |
| `mailbox_dead_letters` | Terminal dead-letter audit for exhausted deliveries. |
| `mailbox_audit` | Append-only audit of all mailbox actions. |
| `pending_interactions` | Cross-system ask/review/approval state. `open → answered/cancelled`. |

#### Telemetry

| Table | What it holds |
|---|---|
| `statusline_snapshots` | Per-turn snapshots of Claude's rate limits, token counters, and model info. Powers the Usage tab and the left-rail caps panel. |
| `post_turn_summaries` | CC's post-turn summary rows: title, description, needs-action flag, artifact URLs. Forensic surface, not yet exposed in the UI. |

### 6. The repo layer — one file per table family (`packages/db/src/repos/`)

Every table has exactly one "repo" file that owns all reads and writes for it. Repos call the shared connection directly; they accept an injected transaction handle (the `*InDb` suffix pattern) only when an operation needs to participate in a caller's transaction — that's how multi-table writes stay atomic.

| Repo file | Table(s) it owns |
|---|---|
| `projects.ts` | `projects` |
| `work-items.ts` | `work_items` |
| `areas.ts` | `areas` |
| `attachments.ts` | `attachments` |
| `field-schemas.ts` | `field_schemas` |
| `live-outbox.ts` | `live_outbox` |
| `workflows.ts` | `workflows` |
| `workflow-audit.ts` | `workflow_audit` |
| `workflow-runs-v2.ts` | `workflow_runs_v2` + `workflow_run_events` |
| `worktrees.ts` | `worktrees` |
| `failed-run-dismissals.ts` | `failed_run_dismissals` |
| `pods.ts` | `agents` + four sub-tables |
| `pod-audit.ts` | `agent_audit` |
| `pod-revision.ts` | Computes revision hashes (no table) |
| `contracts.ts` | `agent_contracts` |
| `agent-runs.ts` | `agent_runs` |
| `pending-asks.ts` | `pending_asks` |
| `agent-inbox.ts` | `agent_inbox` + `agent_delivery_audit` |
| `orchestrator-sessions.ts` | `orchestrator_sessions` |
| `orchestrator-send-queue.ts` | `orchestrator_send_queue` |
| `mailbox.ts` | All five `mailbox_*` tables |
| `pending-interactions.ts` | `pending_interactions` |
| `settings.ts` | `settings_global` |
| `statusline-snapshots.ts` | `statusline_snapshots` |
| `post-turn-summaries.ts` | `post_turn_summaries` |

---

## How it connects

- **Depends on:** `@pc/domain` (all domain types, the `ULID` brand) · `@pc/utils` (the data directory path) · `better-sqlite3` (the native SQLite driver) · `drizzle-orm` (the query builder).
- **Used by:** everything server-side. The agent host reads `agent_runs`; the workflow engine reads `workflow_runs_v2` and `work_items`; the live relay reads `live_outbox`; the mailbox worker reads `mailbox_deliveries`.
- **The key contract:** a write to an entity row + a matching `live_outbox` insert in the **same transaction** is how the UI learns about changes. Break that pairing and the UI goes stale silently.

---

## Target shape (per north star + Foundation Decisions)

The north star (`unified-process-supervision-2026-06-02.md §2`) says: **append-only event log = truth; all live state is a projection of it.** 🟢 **FD-13 (locked 2026-06-03)** scopes this deliberately: it applies to *happenings* (workflow runs, agent runs, messages); *configuration* (pods, projects, settings, cards) stays row-state + audit tables.

**How far we are today — plainly stated:**

The DB is primarily **row-state** (mutable rows with `updatedAt`/`rev` that overwrite each other). The only genuinely append-only tables today are `live_outbox`, `work_items.history` (a JSON column that's appended, never mutated), the `*_audit` tables, and the insert-only telemetry tables.

`workflow_run_events` became the first REAL event log in M3a (2026-06-04): one gateway door,
complete lifecycle lines, every line a live fact, read by tool + UI. The `dag_state` JSON blob on
`workflow_runs_v2` is still the *execution* truth — projecting it from the diary is the M6 leg.
(The #1 store decision itself was resolved as FD-13: the split.)

**What changes toward the target (ledger verdicts, `consolidation-ledger-2026-06-02.md §2`):**

- `agent_runs`, `live_outbox`, `work_items.history`, `orchestrator_sessions`, `field_schemas` — **KEEP** as truth.
- `agent_contracts.deliverable` — **KEEP** (the typed deliverable store).
- `work_items.body` — **KEEP**; it is read live by `dag-run-service.ts:173` to resolve `$root.output` workflow variable references — do not remove.
- `workflow_runs_v2.dag_state` → ✅ the live events log EXISTS (M3a, ledger row 12 done); making `dag_state` a derived projection rides M6 (step-model v3 — build the new semantics on the spine once).
- Long-term: `agent_runs` status transitions could become appended events rather than mutations, making run history reconstructible. Not yet scoped.

---

## Known issues / scar tissue

- **`dag_state` vs `workflow_run_events` — a deliberate split since M3a (2026-06-04).** `dag_state` is the EXECUTION truth (resume/state); `workflow_run_events` is the truth-grade STORY (one gateway door, complete, read by tool + UI). They converge when M6 projects state from the diary. Code must still not derive execution state from events until then.
- **`agent_inbox` is alive in the DB, dead in TypeScript, live in a hook.** The server's TypeScript code has zero callers of `repos/agent-inbox.ts`, but the hook script at `templates/.claude/hooks/inbox-drain.cjs` (lines 66/74/77) still reads and writes these tables via raw SQL on every user prompt. The tables cannot be dropped until the hook is refactored to the mailbox. (Ledger §0 confirmed 2026-06-03.)
- **`work_items.body` does double duty.** It stores the human-readable card description AND is the live source for `$root.output` workflow variable references (`dag-run-service.ts:173`). Removing or moving it breaks the workflow engine. (Ledger §0 confirmed 2026-06-03.)
- **`agentRuns.pid` is vestigial in production.** The `pid` column is only populated for in-process spawns. The real production path always uses a host connection (`index.ts:279,304`) and leaves `pid` NULL. The in-process branch is dead on the production path.
- **Migration ledger drift.** Drizzle tracks applied migrations by timestamp, not by inspecting the schema. A botched manual migration can be recorded as applied but leave columns missing, causing silent runtime failures. `assertSchemaIntact()` is the guard — it re-checks every column after migration and throws with repair instructions. Several migrations (0015+) are hand-authored rather than generated by drizzle-kit, which is historically where drift occurs.
- **`better-sqlite3` + Electron 35 pin.** `better-sqlite3` 11.10.0 requires V8 compatibility that breaks on Electron 36+. The packaged desktop app is pinned to Electron 35. Upgrading requires either rebuilding the driver for the new V8 or migrating to a different SQLite driver.

---

## Decisions & open questions

**For Emerson (product calls):**

1. ~~Event log vs row-state — the #1 decision.~~ 🟢 **FD-13 (locked 2026-06-03): the split.**
   Happenings (workflow runs, agent runs, messages) become append-only event logs — the diary is the
   truth. Configuration (pods, projects, settings, cards) stays as mutable rows + audit tables.
   Full event-sourcing of config was deliberately rejected (tax with no user-visible gain).
2. **When `workflow_run_events` becomes truth (Slice 3), runs in flight at cutover have history only in `dag_state` — no events.** Do we migrate their history, accept the gap, or wait for a quiet moment with zero in-flight runs? — still open (noted in FD-13).

**Technical:**

- `agent_runs` status transitions (queued → spawning → running → paused): should these become appended events so the history of a run is reconstructible? Not yet scoped.
- Mailbox cutover gate: the `mailbox_*` / `pending_interactions` tables replaced `agent_inbox`, but the hook refactor is unscheduled. What is the completion gate?
- Electron upgrade path: is there a concrete plan for the `better-sqlite3` / Electron 35 pin, or is it indefinitely deferred?
- `assertSchemaIntact()` checks that every declared column exists, but does not verify index definitions or constraint integrity. Is column-presence sufficient for production safety, or do we need more?
