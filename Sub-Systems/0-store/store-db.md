# Store / Database

> **Role:** Store
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `packages/db/src/schema.ts`, `packages/db/src/schema-agent-system.ts`, `packages/db/src/connection.ts`, `packages/db/src/migrate.ts`, `packages/db/src/id.ts`, `packages/db/src/repos/`

## What it is (plain English)

A single SQLite file (`pc.sqlite`) that holds everything the app knows about projects, work items, agents, runs, workflows, and messages. Every other part of the app — the server, the workflow engine, the agent runner — reads from and writes to this file. If the server restarts, the DB is the only thing that survives and the processes rebuild from it.

## What it's supposed to do (intent)

Own the permanent record. Be the one place where "what is true" is answered. Processes, in-memory registries, and live WebSocket state are all *projections* of it; the DB is the root. If the DB says a run is completed, it's completed — no process memory required.

## How it works today (as-built)

**Connection** (`connection.ts`)
- Lazy singleton: `getDb()` returns the one `BetterSQLite3Database` instance (Drizzle ORM wrapper) for the life of the process.
- Opens `<PC_DATA_DIR>/pc.sqlite` (dir created on first call).
- WAL mode + foreign keys enabled via PRAGMA on every connect.
- `getRawDb()` exposes the raw `better-sqlite3` handle for PRAGMAs and introspection.

**Migrations** (`migrate.ts`)
- `runMigrations()` calls Drizzle's built-in migrator against `packages/db/drizzle/*.sql` (40 migrations, `0000_init.sql` → `0040_agent_run_delivered.sql`).
- After migrating: `assertSchemaIntact()` cross-checks every column declared in `schema.ts` against `PRAGMA table_info(...)`. Throws a hard error with repair instructions if a column is missing — prevents silent "no such column" crashes from ledger drift.
- Seeds the single `settings_global` singleton row if it doesn't exist.
- In a packaged Electron build the caller passes an explicit migrations folder path (the bundle's `__dirname` is inside the bundle, not next to the `drizzle/` folder).

**ID generation** (`id.ts`)
- Single export: `newId() → ULID`. Uses `monotonicFactory()` (from the `ulid` package) so two calls within the same millisecond produce strictly-increasing IDs — `ORDER BY id ASC` == insertion order everywhere.
- All PKs in the schema are typed `ULID` (a branded `string` from `@pc/domain`).

**Schema conventions** (`schema.ts`, `schema-agent-system.ts`)
- All PKs: `text` ULID.
- Timestamps: `integer` epoch-ms (no ISO strings).
- JSON blobs: `text({ mode: 'json' })` with a typed `.$type<T>()` annotation.
- Soft delete: nullable `deleted_at` (where applicable); partial unique indices filter on `deleted_at IS NULL`.
- Optimistic concurrency: `version` or `rev` integer incremented on every mutating write; WS deltas carry it so the frontend discards stale deliveries.

---

### Table inventory by domain

**Projects / core**
| Table | Owns |
|---|---|
| `projects` | Project rows: slug, name, settings JSON, stages JSON, folder path, git remote, drag-order position, callsign sequence counter, stages rev counter. Soft-deleted. |
| `settings_global` | Single singleton row of global app settings. |

**Work items**
| Table | Owns |
|---|---|
| `work_items` | Cards on the kanban: title, body, stage, status, type, custom fields JSON, append-only `history` JSON (move/update entries), position, callsign, area FK, workflow-root flag. Soft-deleted. |
| `areas` | Project-scoped buckets work items roll up into. Soft-deleted. |
| `attachments` | File/text content stored **inline** (no filesystem path). Linked to a work item; optionally linked to a run/node. |
| `field_schemas` | Per-project custom field definitions (label, type, options, required, order). |

**Workflows**
| Table | Owns |
|---|---|
| `workflows` | Workflow definitions: YAML source, parsed DAG JSON, scope (global/project), status (active/invalid), origin (stock/user-created), disabled flag. Soft-deleted. |
| `workflow_audit` | Append-only mutation log for workflow definitions (mirrors `agent_audit`). |
| `workflow_runs_v2` | Active run sidecar: DAG execution state (`dag_state` JSON), status, trigger context, YAML snapshot frozen at dispatch, rev stamp. The run IS a `work_item` (`is_workflow_root=true`); this table holds only DAG bookkeeping not derivable from the WI. |
| `workflow_run_events` | Append-only observability log for workflow events. **Currently dead writes** — `appendEvent` writes here but the gateway/live_outbox path is unwired and the UI discards them. Not yet truth; see Target shape. |
| `failed_run_dismissals` | Per-run dismissal timestamps for the "Failed recently" UI region. |
| `worktrees` | Git worktree paths tied to a work item or run. |

**Agents / pods**
| Table | Owns |
|---|---|
| `agents` | Pod definitions: name, scope, prompt, allowed tools JSON, model, effort, max turns, output destination, origin (stock/user-created), dispatch guidance, expected output, rev stamp. Soft-deleted. |
| `agent_knowledge` | Knowledge documents attached to a pod. |
| `agent_secrets` | Env-var secrets for a pod (plaintext v1; encrypted v2 is planned). |
| `agent_mcp_servers` | MCP server configs for a pod. |
| `agent_audit` | Append-only change log for all pod mutations. Groups related field edits by `change_set_id`. |

**Agent runs**
| Table | Owns |
|---|---|
| `agent_runs` | One row per dispatched run. Full state machine persisted: `queued → spawning → running → paused → completed/failed/cancelled`. Carries CC session id, pod name, pod revision hash, PID, deliverable timestamp, continuation FK (`continues` self-FK). |
| `agent_contracts` | First-class machine assignment: expected output, acceptance criteria, verification tier/status, typed deliverable, report. Optional FK to a work item. |
| `pending_asks` | One row per agent-pause event (`pc_ask_user`/`pc_ask_orchestrator`). Status: `open → answered/cancelled`. Answer-once enforced by UPDATE WHERE status='open'. |
| `agent_inbox` | **Legacy / pending deletion** — durable outbound event rows for the pre-mailbox delivery transport. TS repo has 0 callers but `templates/.claude/hooks/inbox-drain.cjs` still writes these via raw SQL. Gated: refactor hook → mailbox, then drop. |
| `agent_delivery_audit` | Observational audit for `agent_inbox` deliveries. Lives and dies with `agent_inbox`. |

**Orchestrator**
| Table | Owns |
|---|---|
| `orchestrator_sessions` | One row per orchestrator session: provider session id, model, title, status (active/ended), JSONL path, JSONL line cursor. Partial unique index: one active session per project. |
| `orchestrator_send_queue` | Outbound user-message queue for the orchestrator PTY. Status: `queued_* → delivering → delivered_to_pty → observed_in_jsonl / failed / cancelled`. Retry counter, failure reason. |

**Live events (the fanout bus)**
| Table | Owns |
|---|---|
| `live_outbox` | Append-only, auto-increment PK (`seq`). Every entity mutation announces itself here; the relay drain reads rows after its cursor and pushes them over WebSocket. `publishedAt` is stamped when fanned out. Entities: project, work-item, agent-run, workflow-run, pod, contract, mailbox-message, etc. |

**Mailbox**
| Table | Owns |
|---|---|
| `mailbox_messages` | Durable messages with idempotency key, subject, body, payload JSON, source reference. |
| `mailbox_recipients` | Per-recipient address + UI read/action/dismiss state. |
| `mailbox_deliveries` | Delivery lease/ack/retry/dead-letter state per (message, recipient, channel). |
| `mailbox_dead_letters` | Terminal dead-letter audit for exhausted deliveries. |
| `mailbox_audit` | Append-only audit of all mailbox actions. |
| `pending_interactions` | Cross-system ask/review/approval state. Open → answered/cancelled. |

**Telemetry / observability**
| Table | Owns |
|---|---|
| `statusline_snapshots` | Per-turn snapshots of Claude's rate limits, token counters, model info. Powers the Global Settings Usage tab and the left-rail caps panel. |
| `post_turn_summaries` | CC's `system:post_turn_summary` rows: title, description, needs_action, artifact_urls. Forensic/future surface. |

---

### Repo layer (`packages/db/src/repos/`)

Each file owns exactly one table family. All repos call `getDb()` directly; callers pass a `DbExecutor` (the `DB` or an open transaction) only where the operation must participate in a caller's transaction. The `*InDb` suffix pattern = a variant that accepts an injected executor for transaction composition.

| Repo file | Table(s) it owns |
|---|---|
| `projects.ts` | `projects` — CRUD, soft-delete, reorder, slug lookup |
| `work-items.ts` | `work_items` — create, list, get, move stage, patch fields, append history, apply run outcome, soft-delete/restore |
| `areas.ts` | `areas` — create, list, patch, reorder, soft-delete; plus `setWorkItemArea` |
| `attachments.ts` | `attachments` — create, get, list by work item, delete |
| `field-schemas.ts` | `field_schemas` — list, replace (full replace in one tx) |
| `live-outbox.ts` | `live_outbox` — insert event, list after cursor, mark published, prune, high-water/floor queries |
| `workflows.ts` | `workflows` — create, list, get by slug/id, update, soft-delete |
| `workflow-audit.ts` | `workflow_audit` — build audit row, list for workflow |
| `workflow-runs-v2.ts` | `workflow_runs_v2` + `workflow_run_events` — create run, get run, update dag state, append event, update status |
| `worktrees.ts` | `worktrees` — upsert, get by name, list active, mark destroyed |
| `failed-run-dismissals.ts` | `failed_run_dismissals` — dismiss, list for project, list for runs |
| `pods.ts` | `agents` + `agent_knowledge` + `agent_secrets` + `agent_mcp_servers` — full CRUD for pod rows and all sub-tables; resolve for dispatch; clone to project; promote to global |
| `pod-audit.ts` | `agent_audit` — build audit row, list for agent |
| `pod-revision.ts` | Compute + compare pod revision hashes (no table — reads `agents` + sub-tables) |
| `contracts.ts` | `agent_contracts` — create, get, list (by project/run/work-item), set deliverable, set run, set verification |
| `agent-runs.ts` | `agent_runs` — insert, get, list active/non-terminal/recent-terminal, update status, mark terminal, mark delivered, touch activity, bump rev, set contract id, reconcile orphaned runs |
| `pending-asks.ts` | `pending_asks` — create, get, answer, cancel, list open by project/session, existence checks |
| `agent-inbox.ts` | `agent_inbox` + `agent_delivery_audit` — enqueue, get, list pending for session, mark delivered |
| `orchestrator-sessions.ts` | `orchestrator_sessions` — create, get active, get by id, list for project, end, reactivate, set JSONL path/cursor/title |
| `orchestrator-send-queue.ts` | `orchestrator_send_queue` — enqueue, get, list open/queued/visible, mark delivering/delivered/failed/observed, retry, cancel open/session |
| `mailbox.ts` | `mailbox_messages` + `mailbox_recipients` + `mailbox_deliveries` + `mailbox_dead_letters` + `mailbox_audit` — full lifecycle for all mailbox tables |
| `pending-interactions.ts` | `pending_interactions` — create, get, answer, cancel, expire, list open |
| `settings.ts` | `settings_global` — get, set |
| `statusline-snapshots.ts` | `statusline_snapshots` — insert, list for project/session, get latest per project, list latest per session |
| `post-turn-summaries.ts` | `post_turn_summaries` — insert, list for project, list for session |

---

## Integrations (how it connects)

- **Depends on:** `@pc/domain` (all domain types + `ULID` brand), `@pc/utils` (`getDataDir()`), `better-sqlite3` (native module), `drizzle-orm`.
- **Used by:** Everything server-side. `apps/server` is the primary consumer. The agent host (`packages/agent-host`) reads `agent_runs`; workflow engine reads `workflow_runs_v2` and `work_items`; the live-relay reads `live_outbox`; the mailbox worker reads `mailbox_deliveries`.
- **Contracts / events crossed:** The `live_outbox` table is the synchronisation contract between the server-side DB writes and the WebSocket relay. A write to any entity row + a corresponding `live_outbox` insert (in the same transaction in well-behaved paths) is how UI state updates reach the browser.

## Target shape (per north star)

The north star (`unified-process-supervision-2026-06-02.md §2`) defines Store as: **append-only event log = truth; all live state is a projection of it.**

**How far the current DB is from that ideal — plainly stated:**

Today the DB is **primarily row-state** (mutable rows with `updatedAt` / `rev`), not an event log. The gap is large:

- `work_items`, `agent_runs`, `agent_contracts`, `workflow_runs_v2`, `agents`, `orchestrator_sessions` — all mutable row-state. A reconciler reading these rows sees *current state* only; the history of how it got there is lossy.
- The only genuinely append-only tables today are: `live_outbox` (the fanout bus), `work_items.history` JSON column (appended, never mutated), `agent_audit` / `workflow_audit` / `mailbox_audit` (change logs), `statusline_snapshots` / `post_turn_summaries` (insert-only telemetry).
- `workflow_run_events` is the most direct attempt at an event log for workflow execution — it exists and `appendEvent` writes to it — but it is **currently dead**: the writes bypass the gateway/live_outbox and the UI discards `res.events` (`WorkflowsList.tsx:871`). The dag_state JSON blob on `workflow_runs_v2` is still the actual store. (Ledger §0 + §2, confirmed 2026-06-03.)

**What changes toward the target:**
- `workflow_run_events` needs to be routed through `live_outbox` so events become truth and `dag_state` becomes a derived projection (ledger row 12, Slice-3 work — high effort).
- Long-term, agent run lifecycle events (queued/spawned/ready/paused/completed) could become appended events rather than status mutations — that is not yet scoped.

**Ledger verdict (consolidation-ledger-2026-06-02.md §2 "Sources of truth"):**
- `agent_runs`, `live_outbox`, `work_items.history`, `orchestrator_sessions`, `field_schemas` — KEEP as truth.
- `agent_contracts.deliverable` — KEEP (the typed deliverable store).
- `work_items.body` — KEEP (dual purpose: also read live by `dag-run-service.ts:173` for `$root.output` workflow refs — do NOT remove).
- `workflow_runs_v2.dag_state` → CREATE live events log; make `dag_state` a projection (not yet built).

## Known issues / scar tissue

- **better-sqlite3 + Electron 35 pin.** `better-sqlite3` 11.10.0 requires V8 compatibility; Electron 36+ breaks it. The packaged desktop app is pinned to Electron 35. Upgrading Electron requires either rebuilding `better-sqlite3` for the new V8 or migrating to a different SQLite driver. (`memory/MEMORY.md` "Dev vs dogfood setup".)
- **Migration ledger drift.** Drizzle decides which migrations to apply from the `__drizzle_migrations` timestamp table, not from schema inspection. If a migration is recorded as applied but its ALTERs weren't actually run (e.g. from a botched manual migration), the app silently starts with missing columns and fails at runtime with an opaque "no such column". `assertSchemaIntact()` in `migrate.ts:34` is the guard — it re-checks every column after migration and throws a hard error with repair instructions. Several migrations (0015+) are hand-authored, not generated by drizzle-kit, which is where drift historically occurs.
- **`dag_state` JSON vs `workflow_run_events` dual truth.** Two representations of workflow execution state exist side by side. `dag_state` is the authoritative store today; `workflow_run_events` receives writes that are currently discarded by the UI. Any code reading `workflow_run_events` as "the truth" would be wrong. (Ledger §0 confirmed 2026-06-03.)
- **`agent_inbox` / `agent_delivery_audit` — alive in the DB, dead in TS, live in a hook.** The TypeScript repo `repos/agent-inbox.ts` has zero callers in server code, but `templates/.claude/hooks/inbox-drain.cjs` (lines 66/74/77) still reads/writes these tables via raw SQL on every `UserPromptSubmit`. The tables cannot be dropped until that hook is refactored to use the mailbox. (Ledger §0 confirmed 2026-06-03.)
- **`work_items.body` dual purpose.** The body column stores the human-readable description AND is read live by `dag-run-service.ts:173` to resolve `$root.output` workflow variable references. Any attempt to remove it or move it breaks the workflow engine's variable resolution. (Ledger §0 confirmed 2026-06-03.)
- **`agentRuns.pid` column.** Populated only for in-process spawns. Host-mode runs (the real production path) leave it NULL. The in-process spawn branch is dead in any real server (`index.ts:279,304` always wires a host connection) — the pid column is vestigial for the production path.

## Open questions

- When `workflow_run_events` becomes truth (Slice 3), what is the migration path for runs in-flight at the time of the cutover? Their history lives only in `dag_state`.
- Should `agent_runs` status transitions become appended events (append-only) rather than mutable row updates? This would make run history reconstructible after the fact — today there is no record of when a run transitioned through `spawning → running → paused`.
- The mailbox platform tables (`mailbox_*`, `pending_interactions`) were added in migration 0036 alongside the old `agent_inbox`. The cutover (refactor hook, drop inbox tables) is tracked but unscheduled. What is the completion gate?
- `better-sqlite3` + Electron 35 pin: is there a concrete plan/timeline for the Electron upgrade, or is this indefinitely deferred?
- `assertSchemaIntact()` only checks columns present — it does not check that index definitions match, or that constraints are intact. Is column-presence sufficient for production safety?
