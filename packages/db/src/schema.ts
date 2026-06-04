import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  AgentEffort,
  AgentModel,
  AgentOutputDestination,
  ExpectedOutput,
  FieldSchemaType,
  GlobalSettings,
  PodAuditActor,
  PodAuditField,
  PodKnowledgeKind,
  PodMcpServerConfig,
  PodScope,
  ProviderId,
  SessionEndedReason,
  SessionStatus,
  Stage,
  ULID,
  WorkItemHistoryEntry,
  WorkItemStatus,
  WorkItemType,
  WorkflowAuditField,
  WorkflowV2,
  WorktreeStatus,
} from '@pc/domain';

/**
 * v2 trunk schema (sqlite migration). 7 tables — projects, work_items,
 * workflows, workflow_runs, worktrees, orchestrator_sessions, settings_global.
 *
 * Conventions (mirror v1):
 * - ULIDs as `text` PKs.
 * - Timestamps as `integer` epoch ms (numbers in TS).
 * - JSON blobs via `text({ mode: 'json' })`.
 * - Soft delete = nullable `deleted_at` (where the table needs it).
 */

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey().$type<ULID>(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    settings: text('settings', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    stages: text('stages', { mode: 'json' }).notNull().$type<Stage[]>(),
    folderPath: text('folder_path').notNull().default(''),
    gitRemote: text('git_remote'),
    /** 5+.4 (D87). Sort key for the LeftRail Projects list. New projects are
     *  appended at `max(position) + 1`; drag-reorder rewrites every row's
     *  position in a single transaction. */
    position: integer('position').notNull().default(0),
    /** Section 35 — monotonic, never-reused counter for top-level callsign
     *  numbering. New top-level work items claim `callsign_seq + 1` and
     *  bump the column in the same transaction (SQLite serializes writes
     *  → race-free). Archived numbers don't come back. */
    callsignSeq: integer('callsign_seq').notNull().default(0),
    /** UI Spine step 3 — monotonic counter for the stages set. Incremented
     *  every time the stages JSON is replaced; the new value is stamped into
     *  each Stage.rev so the frontend can discard stale WS deltas. */
    stagesRev: integer('stages_rev').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    uniqueIndex('projects_slug_idx').on(t.slug).where(sql`deleted_at IS NULL`),
    index('projects_position_idx').on(t.position),
  ],
);

export const liveOutbox = sqliteTable(
  'live_outbox',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    scope: text('scope').notNull().$type<'project' | 'global'>(),
    projectId: text('project_id').$type<ULID | null>(),
    type: text('type').notNull(),
    entity: text('entity')
      .notNull()
      .$type<
        | 'project'
        | 'project-claude-md'
        | 'work-item'
        | 'stage'
        | 'field-schema'
        | 'attachment'
        | 'workflow-definition'
        | 'workflow-run'
        | 'workflow-run-event'
        | 'workflow-review'
        | 'agent-run'
        | 'mailbox-message'
        | 'pending-interaction'
        | 'session-title'
        | 'pod'
        | 'area'
        | 'contract'
        | 'host-health'
      >(),
    entityId: text('entity_id').$type<ULID | null>(),
    version: integer('version'),
    payload: text('payload', { mode: 'json' })
      .notNull()
      .$type<Record<string, unknown>>(),
    createdAt: integer('created_at').notNull(),
    publishedAt: integer('published_at'),
  },
  (t) => [
    uniqueIndex('live_outbox_id_idx').on(t.id),
    index('live_outbox_created_idx').on(t.createdAt),
    index('live_outbox_project_seq_idx').on(t.projectId, t.seq),
    index('live_outbox_scope_seq_idx').on(t.scope, t.seq),
    index('live_outbox_type_seq_idx').on(t.type, t.seq),
    index('live_outbox_entity_idx').on(t.entity, t.entityId, t.seq),
  ],
);

export const workItems = sqliteTable(
  'work_items',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    /** Self-FK; app-enforced. */
    parentId: text('parent_id').$type<ULID | null>(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** Stage slug from `projects.stages` JSON; no FK. */
    stageId: text('stage_id').notNull(),
    status: text('status').notNull().default('pending').$type<WorkItemStatus>(),
    statusReason: text('status_reason'),
    /** Built-in fixed-set type ('task' | 'bug' | 'feature' | 'spike'). Default 'task'.
     *  Filed by `pc_log_bug` when value is 'bug'. */
    type: text('type').notNull().default('task').$type<WorkItemType>(),
    fields: text('fields', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    /** Append-only event log (move + update entries). v2-only. */
    history: text('history', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`)
      .$type<WorkItemHistoryEntry[]>(),
    /** Sort key within (parentId, stageId). Stable across moves. */
    position: integer('position').notNull().default(0),
    /** Optimistic-concurrency counter. */
    version: integer('version').notNull().default(1),
    /** Section 35 — display-alias short code (e.g. `pc-2`, `pc-2.1`). ULID
     *  stays the canonical id everywhere internal. Nullable: agent contracts
     *  (`is_agent_task = 1`) stay NULL so they don't burn the user-visible
     *  number space. Partial unique index enforces uniqueness scoped to
     *  project, ignoring NULLs. */
    callsign: text('callsign'),
    /** Section 19 — true when this row is a workflow run's root. Each workflow
     *  node spawns a child WI under it; DAG state lives in `workflow_runs_v2`
     *  keyed by this id. Hidden from the default kanban. */
    isWorkflowRoot: integer('is_workflow_root', { mode: 'boolean' }).notNull().default(false),
    /** Slice 010 — Area bucket FK (no DB FK; app-enforced), null = Uncaptured. */
    areaId: text('area_id').$type<ULID | null>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('work_items_project_idx').on(t.projectId),
    index('work_items_stage_idx').on(t.projectId, t.stageId),
    /** Slice 010 — fast filter for the Area / Uncaptured rail. */
    index('work_items_area_idx').on(t.projectId, t.areaId),
  ],
);

/**
 * Slice 010 — Areas. First-class, project-scoped buckets. A work item belongs
 * to exactly one Area (`work_items.area_id`) or to none ("Uncaptured"). Manual
 * `sort_order`, plain editable `summary`. Delete → member items fall back to
 * Uncaptured (FK set null); the area row soft-deletes.
 */
export const areas = sqliteTable(
  'areas',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    name: text('name').notNull(),
    summary: text('summary').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('areas_project_idx').on(t.projectId, t.sortOrder)],
);

/**
 * Section 19.16 — workflows are DB-resident. Replaces the YAML-on-disk model
 * v2 used through 19.11. Mirrors `agents`: scope ('global' | 'project'), per-
 * scope partial UNIQUE name indices, soft-delete via `deleted_at`. 19.13's
 * one-shot importer reads each project's `.project-companion/workflows/*.yaml`
 * and inserts as scope='project' rows; the YAML files survive the import boot
 * as a backup and are deleted on the next boot if the DB rows look healthy.
 *
 * `origin` is carried for forward compat with the agents pattern. v1 has no
 * stock workflows (every row is user-created), but the column lets a future
 * pass seed default workflows without a schema migration.
 */
export const workflows = sqliteTable(
  'workflows',
  {
    /** ULID PK (mirrors agents). The YAML's `id:` field lives in `slug`. */
    id: text('id').primaryKey().$type<ULID>(),
    scope: text('scope').notNull().default('project').$type<PodScope>(),
    /** NULL when `scope === 'global'`; required when `scope === 'project'`.
     *  App-enforced; sqlite doesn't constrain by enum-of-scope. */
    projectId: text('project_id')
      .$type<ULID | null>()
      .references(() => projects.id),
    /** Author-readable slug from the YAML's `id:` field. Per-scope partial
     *  UNIQUE — two projects can both define `triage`; one global. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** Optional pretty name surfaced in the rail when set; defaults to `name`. */
    displayName: text('display_name'),
    description: text('description'),
    yaml: text('yaml').notNull(),
    yamlHash: text('yaml_hash').notNull(),
    /** Parsed DAG (the @pc/domain `WorkflowV2.Workflow` shape, JSON-encoded). */
    parsedDefinition: text('parsed_definition', { mode: 'json' }),
    status: text('status', { enum: ['active', 'invalid'] }).notNull().default('active'),
    parseError: text('parse_error'),
    /** Lifted out of YAML so disable/enable is a cheap DB write that doesn't
     *  re-parse the workflow. */
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    /** v1: always 'user-created'. Column reserved for stock-workflow seeding. */
    origin: text('origin')
      .notNull()
      .default('user-created')
      .$type<'stock' | 'user-created'>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('workflows_scope_project_idx').on(t.scope, t.projectId),
    /** Unique global workflow slug (live rows only). */
    uniqueIndex('workflows_global_slug_idx')
      .on(t.slug)
      .where(sql`scope = 'global' AND deleted_at IS NULL`),
    /** Unique per-project workflow slug (live rows only). */
    uniqueIndex('workflows_project_slug_idx')
      .on(t.projectId, t.slug)
      .where(sql`scope = 'project' AND deleted_at IS NULL`),
    /** Unique global workflow name (live rows only). */
    uniqueIndex('workflows_global_name_idx')
      .on(t.name)
      .where(sql`scope = 'global' AND deleted_at IS NULL`),
    /** Unique per-project workflow name (live rows only). */
    uniqueIndex('workflows_project_name_idx')
      .on(t.projectId, t.name)
      .where(sql`scope = 'project' AND deleted_at IS NULL`),
  ],
);

/**
 * Section 19.16 — workflow audit log. Mirrors `agent_audit`: every mutation
 * in repos/workflows.ts writes a row in the same tx. Powers the future
 * History tab on the workflow detail pane.
 */
export const workflowAudit = sqliteTable(
  'workflow_audit',
  {
    id: text('id').primaryKey().$type<ULID>(),
    workflowId: text('workflow_id')
      .notNull()
      .$type<ULID>()
      .references(() => workflows.id),
    changeSetId: text('change_set_id').$type<ULID | null>(),
    actor: text('actor').notNull().$type<PodAuditActor>(),
    field: text('field').notNull().$type<WorkflowAuditField>(),
    fieldRef: text('field_ref'),
    priorValue: text('prior_value'),
    newValue: text('new_value'),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('workflow_audit_workflow_idx').on(t.workflowId),
    index('workflow_audit_change_set_idx').on(t.changeSetId),
  ],
);

/**
 * Section 19 — v2 workflow run sidecar. The v1 `workflow_runs` table was
 * dropped in 19.12 (migration 0025). The v2 run IS a work item
 * (`is_workflow_root`); node outputs live on child work items, so this row
 * holds only DAG bookkeeping (per-node state + reject-iteration counts) that
 * isn't derivable from the WIs.
 * See the workflow runtime design ("stateless over work items").
 */
export const workflowRunsV2 = sqliteTable(
  'workflow_runs_v2',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Workflow slug (the YAML `id:`). */
    workflowId: text('workflow_id').notNull(),
    /** Denormalised for the run viewer. */
    workflowName: text('workflow_name').notNull(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    /** The `is_workflow_root` work item for this run. */
    workItemId: text('work_item_id').$type<ULID | null>(),
    /** Trigger kind that fired this run (`manual` | `stage-on-entry` | …). */
    trigger: text('trigger').notNull().$type<WorkflowV2.TriggerKind>(),
    /** stage_id slug when trigger = `stage-on-entry`. */
    stageId: text('stage_id'),
    /** Session that fired a manual / orchestrator run. */
    triggeredBySessionId: text('triggered_by_session_id').$type<ULID | null>(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<WorkflowV2.WorkflowRunStatus>(),
    /** Frozen YAML at dispatch — immune to live edits mid-run. */
    workflowYamlSnapshot: text('workflow_yaml_snapshot').notNull(),
    worktreePath: text('worktree_path'),
    /** DAG execution state: per-node records + per-reject-edge iteration counts. */
    dagState: text('dag_state', { mode: 'json' })
      .notNull()
      .default(sql`'{"nodes":{}}'`)
      .$type<WorkflowV2.WorkflowDagState>(),
    /** Trigger payload (`$trigger.*`) — stage-move context, webhook body, etc. */
    triggerContext: text('trigger_context', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    metadata: text('metadata', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`)
      .$type<Record<string, unknown>>(),
    lastReason: text('last_reason'),
    /** Monotonic write counter. Incremented by every mutating write so the
     *  announcing write-door can stamp WS deltas. Frontend discards deltas
     *  where incoming rev ≤ stored rev (mirrors work_items.version). */
    rev: integer('rev').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    lastActivityAt: integer('last_activity_at'),
  },
  (t) => [
    index('workflow_runs_v2_project_idx').on(t.projectId),
    index('workflow_runs_v2_status_idx').on(t.status),
    index('workflow_runs_v2_workflow_idx').on(t.workflowId),
    index('workflow_runs_v2_work_item_idx').on(t.workItemId),
  ],
);

/**
 * Section 19 — workflow run event log. OBSERVABILITY / AUDIT ONLY. Feeds the
 * 4e drawer timeline. Resume reads the child work items' terminal states, NOT
 * this log — it is append-only and never the source of truth for execution.
 */
export const workflowRunEvents = sqliteTable(
  'workflow_run_events',
  {
    id: text('id').primaryKey().$type<ULID>(),
    runId: text('run_id')
      .notNull()
      .$type<ULID>()
      .references(() => workflowRunsV2.id),
    /** Event type — see `WorkflowV2.WORKFLOW_EVENT_TYPES`. */
    type: text('type').notNull().$type<WorkflowV2.WorkflowEventType>(),
    /** Node id the event pertains to (absent for run-level events). */
    nodeId: text('node_id'),
    /** Per-event payload (reason, iteration, durationMs, …). */
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    at: integer('at').notNull(),
  },
  (t) => [index('workflow_run_events_run_idx').on(t.runId)],
);

/** Section 6.6 — activity-panel "Failed recently" region. The v2 run viewer
 *  remains the canonical run history; this table only records per-row
 *  dismissals so a user can clear a failure off the at-a-glance list. FK
 *  re-pointed at `workflow_runs_v2` in 19.12 (migration 0025). */
export const failedRunDismissals = sqliteTable(
  'failed_run_dismissals',
  {
    runId: text('run_id')
      .primaryKey()
      .$type<ULID>()
      .references(() => workflowRunsV2.id),
    dismissedAt: integer('dismissed_at').notNull(),
  },
);

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Branch name == worktree dir name (`wi-<id>` or `run-<short>`). */
    name: text('name').notNull(),
    path: text('path').notNull(),
    workItemId: text('work_item_id').$type<ULID | null>(),
    workflowRunId: text('workflow_run_id').$type<ULID | null>(),
    status: text('status').notNull().default('active').$type<WorktreeStatus>(),
    createdAt: integer('created_at').notNull(),
    destroyedAt: integer('destroyed_at'),
  },
  (t) => [
    uniqueIndex('worktrees_name_active_idx').on(t.name).where(sql`status = 'active'`),
    uniqueIndex('worktrees_path_active_idx').on(t.path).where(sql`status = 'active'`),
  ],
);

export const orchestratorSessions = sqliteTable(
  'orchestrator_sessions',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    provider: text('provider').notNull().$type<ProviderId>(),
    /** Provider's own session ID. Null until first `result` event. */
    providerSessionId: text('provider_session_id'),
    model: text('model'),
    title: text('title'),
    status: text('status', { enum: ['active', 'ended'] })
      .notNull()
      .default('active')
      .$type<SessionStatus>(),
    endedReason: text('ended_reason').$type<SessionEndedReason>(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    deletedAt: integer('deleted_at'),
    /** Absolute path of CC's per-session JSONL file. Discovered by the runtime
     *  after spawn (scans `~/.claude/projects/<encoded-cwd>/`). */
    jsonlPath: text('jsonl_path'),
    /** Line count of CC's JSONL we've consumed. Persisted for resume. */
    jsonlLineCursor: integer('jsonl_line_cursor').notNull().default(0),
  },
  (t) => [
    /** One active session per project (DB-enforced). */
    uniqueIndex('orch_sessions_active_per_project_idx')
      .on(t.projectId)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
  ],
);

export const orchestratorSendQueue = sqliteTable(
  'orchestrator_send_queue',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    sessionId: text('session_id')
      .notNull()
      .$type<ULID>()
      .references(() => orchestratorSessions.id),
    clientMessageId: text('client_message_id').notNull(),
    text: text('text').notNull(),
    status: text('status').notNull().$type<
      | 'queued_busy'
      | 'queued_spawning'
      | 'queued_backlog'
      | 'delivering'
      | 'delivered_to_pty'
      | 'observed_in_jsonl'
      | 'failed'
      | 'cancelled'
    >(),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deliveredAt: integer('delivered_at'),
    failedAt: integer('failed_at'),
    cancelledAt: integer('cancelled_at'),
    failureReason: text('failure_reason'),
  },
  (t) => [
    uniqueIndex('orch_send_queue_client_msg_idx').on(t.sessionId, t.clientMessageId),
    index('orch_send_queue_project_idx').on(t.projectId, t.createdAt),
    index('orch_send_queue_session_status_idx').on(t.sessionId, t.status, t.createdAt),
  ],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey().$type<ULID>(),
    workItemId: text('work_item_id')
      .notNull()
      .$type<ULID>()
      .references(() => workItems.id),
    /** Free-form kind tag — 'text' | 'markdown' | 'json' are the known set. */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /** Inline payload. No filesystem-path variant — content always lives in the DB. */
    content: text('content').notNull(),
    contentType: text('content_type'),
    /** Workflow run that produced this attachment, or null for chat/user-created. */
    runId: text('run_id').$type<ULID | null>(),
    createdBySessionId: text('created_by_session_id').$type<ULID | null>(),
    /** Provenance — who produced the attachment. 'user' = chat/UI/test;
     *  'agent' = workflow subagent via the pc_attach_to_work_item MCP tool. */
    source: text('source').notNull().default('user').$type<'agent' | 'user'>(),
    /** When source === 'agent', the agent name. Null for user-created rows. */
    agentName: text('agent_name'),
    /** Workflow node id within `runId`. Null when the attachment was not produced
     *  by a workflow node (chat or top-of-run). */
    nodeId: text('node_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('attachments_work_item_idx').on(t.workItemId)],
);

export const fieldSchemas = sqliteTable(
  'field_schemas',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type').notNull().$type<FieldSchemaType>(),
    /** Options for `type === 'enum'`; ignored otherwise. */
    options: text('options', { mode: 'json' }).$type<string[] | null>(),
    /** Default applied on work-item create when the user didn't provide a value. */
    default: text('default', { mode: 'json' }).$type<unknown>(),
    required: integer('required', { mode: 'boolean' }).notNull().default(false),
    description: text('description'),
    /** Order within the editor (low → high). */
    order: integer('order').notNull().default(0),
  },
  (t) => [
    index('field_schemas_project_idx').on(t.projectId),
    uniqueIndex('field_schemas_project_key_idx').on(t.projectId, t.key),
  ],
);

export const settingsGlobal = sqliteTable('settings_global', {
  id: text('id').primaryKey(),
  values: text('values', { mode: 'json' })
    .notNull()
    .default(sql`'{}'`)
    .$type<GlobalSettings>(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Section 17a — Agent pod tables.
 *
 * Five tables (`agents` + four content tables + `agent_audit`). Every content
 * table carries `scope` + `project_id` from v1 even though v1 is global-only,
 * so the 17c per-project overlay lands without a migration.
 *
 * Conventions:
 * - ULIDs as `text` PKs.
 * - `tools_json` / `config_json` are JSON-encoded via Drizzle's `{ mode: 'json' }`.
 * - Soft delete on `agents` (`deleted_at` nullable); content tables are hard-
 *   deleted alongside an `agent_audit` row.
 * - Foreign keys: child tables reference `agents.id`. No CASCADE — application
 *   layer handles teardown order to ensure audit rows survive.
 */

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Kebab-case agent name (CC frontmatter `name:` field). Materialised
     *  to `<worktree>/.claude/agents/<name>.md` at spawn time. */
    name: text('name').notNull(),
    scope: text('scope').notNull().$type<PodScope>(),
    /** NULL when `scope === 'global'`; required when `scope === 'project'`.
     *  App-enforced; sqlite doesn't constrain by enum-of-scope. */
    projectId: text('project_id').$type<ULID | null>(),
    prompt: text('prompt').notNull().default(''),
    /** Allowlist of tool names. Wildcards (`mcp__server__*`) are EXPANDED at
     *  materialisation time — never stored expanded. Empty = allow all. */
    tools: text('tools_json', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`)
      .$type<string[]>(),
    model: text('model').$type<AgentModel | null>(),
    effort: text('effort').$type<AgentEffort | null>(),
    maxTurns: integer('max_turns'),
    outputDestination: text('output_destination').$type<AgentOutputDestination | null>(),
    description: text('description').notNull().default(''),
    /** Section 36 — `'stock'` (seeded by PC) vs `'user-created'` (any other
     *  row). Replaces the multi-list "is this pod stock?" pattern (deleted
     *  STOCK_POD_NAMES + the web mirror + the drift assertion). Defaulted to
     *  `'user-created'` so any insert path that doesn't pass `origin`
     *  explicitly lands as user-created; the seed inserts pass `'stock'`. */
    origin: text('origin')
      .notNull()
      .default('user-created')
      .$type<'stock' | 'user-created'>(),
    /** Section 36 — orchestrator-facing "when to dispatch this agent" hint,
     *  rendered into `{{AVAILABLE_AGENTS}}` by the pod materializer. Different
     *  from `description` (which has UI-display contracts); may be longer +
     *  more directive. Nullable — most user-created pods don't need one. */
    dispatchGuidance: text('dispatch_guidance'),
    /** Section 26 Issue #3 — default expected_output for this pod. When set,
     *  createAgentWorkItem uses this before the stock map (pod-defaults.ts).
     *  Null for stock pods and user-created pods that haven't declared one. */
    expectedOutput: text('expected_output', { mode: 'json' }).$type<ExpectedOutput | null>(),
    /** UI Spine step 3 — monotonic write counter. Incremented inside every
     *  mutating write so the pod write-door can stamp WS deltas. Frontend
     *  discards deltas where incoming rev ≤ stored rev (mirrors
     *  workflow_runs_v2.rev / work_items.version). */
    rev: integer('rev').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    /** Unique global agent name (live rows only). */
    uniqueIndex('agents_global_name_idx')
      .on(t.name)
      .where(sql`scope = 'global' AND deleted_at IS NULL`),
    /** Unique per-project agent name (live rows only). 17c lands without
     *  migration once project-scoped rows start arriving. */
    uniqueIndex('agents_project_name_idx')
      .on(t.projectId, t.name)
      .where(sql`scope = 'project' AND deleted_at IS NULL`),
    index('agents_scope_project_idx').on(t.scope, t.projectId),
  ],
);

export const agentKnowledge = sqliteTable(
  'agent_knowledge',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    scope: text('scope').notNull().$type<PodScope>(),
    projectId: text('project_id').$type<ULID | null>(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('knowledge').$type<PodKnowledgeKind>(),
    content: text('content').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('agent_knowledge_agent_idx').on(t.agentId),
    index('agent_knowledge_scope_project_idx').on(t.scope, t.projectId),
    /** Unique knowledge-doc name per agent. Split into two partial indices
     *  because sqlite treats NULL as distinct in unique indices — a single
     *  composite index on `project_id` would let dup names slip through for
     *  global rows (where project_id is NULL). */
    uniqueIndex('agent_knowledge_global_name_idx')
      .on(t.agentId, t.name)
      .where(sql`scope = 'global'`),
    uniqueIndex('agent_knowledge_project_name_idx')
      .on(t.agentId, t.projectId, t.name)
      .where(sql`scope = 'project'`),
  ],
);

export const agentSecrets = sqliteTable(
  'agent_secrets',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    scope: text('scope').notNull().$type<PodScope>(),
    projectId: text('project_id').$type<ULID | null>(),
    envVarName: text('env_var_name').notNull(),
    /** v1: plaintext. v2 swaps to `encrypted_value` (DPAPI). Warning banner
     *  in the Secrets tab keeps the user aware of the v1 limitation. */
    valuePlaintext: text('value_plaintext').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('agent_secrets_agent_idx').on(t.agentId),
    index('agent_secrets_scope_project_idx').on(t.scope, t.projectId),
    /** Per-scope partial uniqueness — sqlite NULL-distinct gotcha (see
     *  agent_knowledge note). */
    uniqueIndex('agent_secrets_global_env_idx')
      .on(t.agentId, t.envVarName)
      .where(sql`scope = 'global'`),
    uniqueIndex('agent_secrets_project_env_idx')
      .on(t.agentId, t.projectId, t.envVarName)
      .where(sql`scope = 'project'`),
  ],
);

export const agentMcpServers = sqliteTable(
  'agent_mcp_servers',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    scope: text('scope').notNull().$type<PodScope>(),
    projectId: text('project_id').$type<ULID | null>(),
    /** Server name as it lands in the materialised `mcp.json`'s `mcpServers`
     *  map. Project overlay wins per-server-name (17c). */
    name: text('name').notNull(),
    config: text('config_json', { mode: 'json' }).notNull().$type<PodMcpServerConfig>(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('agent_mcp_servers_agent_idx').on(t.agentId),
    index('agent_mcp_servers_scope_project_idx').on(t.scope, t.projectId),
    /** Per-scope partial uniqueness — sqlite NULL-distinct gotcha (see
     *  agent_knowledge note). Project overlay wins per-server-name (17c). */
    uniqueIndex('agent_mcp_servers_global_name_idx')
      .on(t.agentId, t.name)
      .where(sql`scope = 'global'`),
    uniqueIndex('agent_mcp_servers_project_name_idx')
      .on(t.agentId, t.projectId, t.name)
      .where(sql`scope = 'project'`),
  ],
);

export const agentAudit = sqliteTable(
  'agent_audit',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentId: text('agent_id')
      .notNull()
      .$type<ULID>()
      .references(() => agents.id),
    /** Groups multi-field edits (orchestrator change-set touching prompt +
     *  knowledge in one transaction renders as one expandable History card).
     *  NULL for solo edits. */
    changeSetId: text('change_set_id').$type<ULID | null>(),
    actor: text('actor').notNull().$type<PodAuditActor>(),
    field: text('field').notNull().$type<PodAuditField>(),
    /** Disambiguator for list-shaped fields (knowledge row id, secret env-var
     *  name, mcp server name). NULL for scalar fields. */
    fieldRef: text('field_ref'),
    /** Always NULL for `secret` rows — secrets log event-only. */
    priorValue: text('prior_value'),
    newValue: text('new_value'),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('agent_audit_agent_idx').on(t.agentId),
    index('agent_audit_change_set_idx').on(t.changeSetId),
  ],
);

// Section 25 — agent system tables. Defined in schema-agent-system.ts (kept
// in a separate file so the concern stays grep-able). Re-exported here so
// drizzle-kit's single-file config picks them up.
export {
  agentRuns,
  agentContracts,
  pendingAsks,
  agentInbox,
  agentDeliveryAudit,
} from './schema-agent-system.ts';

// Section 31.12 — post-turn summary log. CC's `system:post_turn_summary` row
// carries rich per-turn metadata (title/description/needs_action/artifact_urls)
// the buildout deferred placing in UI until a week of real data could inform
// the call. Land the table now; surface design after.
// Section 31.11 — statusline snapshot log. Every POST /api/internal/statusline-
// data writes one row; the in-memory latest-per-project Map drives the live
// left-rail caps panel, this table drives the Global Settings Usage tab +
// future aggregations. Many rows per session (debounced ~1×/turn).
export const statuslineSnapshots = sqliteTable(
  'statusline_snapshots',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** PC session ULID from the spawn env (`PC_SESSION_ID`). */
    pcSessionId: text('pc_session_id').notNull(),
    /** CC provider session UUID, when the snapshot carries it. */
    ccSessionId: text('cc_session_id'),
    /** Epoch ms when the server received this snapshot. */
    receivedAt: integer('received_at').notNull(),
    modelId: text('model_id'),
    modelDisplayName: text('model_display_name'),
    /** Account-wide rate limits — may be null until CC has measured them. */
    fiveHourPct: real('five_hour_pct'),
    fiveHourResetsAt: text('five_hour_resets_at'),
    sevenDayPct: real('seven_day_pct'),
    sevenDayResetsAt: text('seven_day_resets_at'),
    /** Per-session running totals from CC's cost-tracker. */
    totalCostUsd: real('total_cost_usd'),
    totalDurationMs: integer('total_duration_ms'),
    totalApiDurationMs: integer('total_api_duration_ms'),
    contextCurrentUsage: integer('context_current_usage'),
    contextWindowSize: integer('context_window_size'),
    contextUsedPercentage: real('context_used_percentage'),
    /** Section 31.11 follow-up — session-cumulative input + output tokens
     *  from CC's statusline `context_window.total_input_tokens` /
     *  `total_output_tokens`. Latest snapshot per session = end-of-session
     *  total; aggregate sums these for global day/week views. */
    totalInputTokens: integer('total_input_tokens'),
    totalOutputTokens: integer('total_output_tokens'),
  },
  (t) => [
    index('statusline_snapshots_project_idx').on(t.projectId, t.receivedAt),
    index('statusline_snapshots_session_idx').on(t.pcSessionId, t.receivedAt),
  ],
);

export const postTurnSummaries = sqliteTable(
  'post_turn_summaries',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** CC provider session id (the uuid in the .jsonl filename). Nullable for
     *  legacy or pre-Section-15 sessions where we don't have it. */
    sessionId: text('session_id'),
    /** UUID of the assistant turn this summary describes. */
    summarizesUuid: text('summarizes_uuid'),
    statusCategory: text('status_category'),
    statusDetail: text('status_detail'),
    isNoteworthy: integer('is_noteworthy').notNull().default(0),
    title: text('title'),
    description: text('description'),
    recentAction: text('recent_action'),
    needsAction: integer('needs_action').notNull().default(0),
    /** Stored as JSON text — value shape varies; the tailer preserves whatever
     *  CC wrote. Null when CC omits it. */
    artifactUrls: text('artifact_urls'),
    /** ISO string from the JSONL row, if present. */
    timestamp: text('timestamp'),
    /** Server insert time, epoch ms. Used for ordering across sessions. */
    createdAt: integer('created_at').notNull(),
    /** Full original entry as JSON text — forensic / future surface decisions. */
    raw: text('raw').notNull(),
  },
  (t) => [
    index('post_turn_summaries_project_idx').on(t.projectId, t.createdAt),
    index('post_turn_summaries_session_idx').on(t.sessionId, t.timestamp),
  ],
);

// ── Slice 007 — mailbox platform + pending interactions ──────────────────────
//
// FIRST real schema migration of the refactor (migration 0036). All six tables
// are additive CREATE-only and inert until the mailbox worker/routes are wired;
// they run ALONGSIDE Channel/agent_inbox (no cutover this slice). Project
// references are soft (no FK) — a project-less message (global user-inbox) is
// valid. JSON columns are `text({ mode:'json' })` in schema.ts but plain `text`
// in 0036_mailbox_platform.sql (mirrors live_outbox.payload). Every column here
// MUST appear verbatim in the SQL or assertSchemaIntact() fails on a fresh boot.

/** General cross-system ask/review/approval state (separate from delivery). */
export const pendingInteractions = sqliteTable(
  'pending_interactions',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Soft project reference (no FK); always non-null in the DTO. */
    projectId: text('project_id').notNull().$type<ULID>(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('open'),
    sourceKind: text('source_kind').notNull(),
    sourceId: text('source_id').notNull(),
    sourceRef: text('source_ref', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    prompt: text('prompt').notNull(),
    context: text('context'),
    options: text('options', { mode: 'json' }).$type<{ value: string; label: string }[] | null>(),
    answerBody: text('answer_body'),
    answeredBy: text('answered_by').$type<'orchestrator' | 'user' | null>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    answeredAt: integer('answered_at'),
    cancelledAt: integer('cancelled_at'),
    expiresAt: integer('expires_at'),
    /** Monotonic write counter for live-event stale-update guards. */
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('pending_interactions_project_idx').on(t.projectId, t.status, t.createdAt),
    index('pending_interactions_source_idx').on(t.sourceKind, t.sourceId),
    index('pending_interactions_kind_idx').on(t.kind, t.status),
  ],
);

/** A durable mailbox message. `idempotency_key` dedupes replayed sources. */
export const mailboxMessages = sqliteTable(
  'mailbox_messages',
  {
    id: text('id').primaryKey().$type<ULID>(),
    /** Soft project reference (no FK); null for the global user-inbox. */
    projectId: text('project_id').$type<ULID | null>(),
    kind: text('kind').notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    payload: text('payload', { mode: 'json' }).notNull().default(sql`'{}'`).$type<Record<string, unknown>>(),
    sourceKind: text('source_kind').notNull(),
    sourceId: text('source_id'),
    interactionId: text('interaction_id').$type<ULID | null>(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    expiresAt: integer('expires_at'),
  },
  (t) => [
    uniqueIndex('mailbox_messages_idempotency_idx').on(t.idempotencyKey),
    index('mailbox_messages_project_idx').on(t.projectId, t.createdAt),
  ],
);

/** Per-recipient address + UI read/action/dismiss state (NOT delivery state). */
export const mailboxRecipients = sqliteTable(
  'mailbox_recipients',
  {
    id: text('id').primaryKey().$type<ULID>(),
    messageId: text('message_id').notNull().$type<ULID>(),
    addressKind: text('address_kind').notNull(),
    addressJson: text('address_json', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    readAt: integer('read_at'),
    actionedAt: integer('actioned_at'),
    dismissedAt: integer('dismissed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('mailbox_recipients_message_idx').on(t.addressKind, t.messageId),
    index('mailbox_recipients_unread_idx').on(t.addressKind, t.readAt),
  ],
);

/** Delivery lease/ack/retry/dead-letter state per (message, recipient, channel). */
export const mailboxDeliveries = sqliteTable(
  'mailbox_deliveries',
  {
    id: text('id').primaryKey().$type<ULID>(),
    messageId: text('message_id').notNull().$type<ULID>(),
    recipientId: text('recipient_id').notNull().$type<ULID>(),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('pending'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    targetRefKind: text('target_ref_kind'),
    targetRefId: text('target_ref_id'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    acceptedAt: integer('accepted_at'),
    failedAt: integer('failed_at'),
  },
  (t) => [
    index('mailbox_deliveries_status_idx').on(t.status, t.nextAttemptAt),
    index('mailbox_deliveries_recipient_idx').on(t.recipientId, t.status),
    index('mailbox_deliveries_target_idx').on(t.targetRefKind, t.targetRefId),
  ],
);

/** Terminal dead-letter audit for exhausted/non-retryable deliveries. */
export const mailboxDeadLetters = sqliteTable(
  'mailbox_dead_letters',
  {
    id: text('id').primaryKey().$type<ULID>(),
    messageId: text('message_id').notNull().$type<ULID>(),
    recipientId: text('recipient_id').$type<ULID | null>(),
    deliveryId: text('delivery_id').$type<ULID | null>(),
    reason: text('reason').notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('mailbox_dead_letters_message_idx').on(t.messageId)],
);

/** Append-only mailbox action audit. */
export const mailboxAudit = sqliteTable(
  'mailbox_audit',
  {
    id: text('id').primaryKey().$type<ULID>(),
    messageId: text('message_id').$type<ULID | null>(),
    recipientId: text('recipient_id').$type<ULID | null>(),
    deliveryId: text('delivery_id').$type<ULID | null>(),
    action: text('action').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id'),
    details: text('details', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('mailbox_audit_message_idx').on(t.messageId, t.createdAt),
    index('mailbox_audit_delivery_idx').on(t.deliveryId, t.createdAt),
  ],
);
