// ProjectRuntime — per-project bundle of PtySession + DagExecutor +
// WorktreeService. Replaces the singleton wiring that lived in apps/server's
// bootstrap during the rig phase. One instance per active project; held by
// ProjectRegistry.
//
// Lazy spawn: the PtySession + DagExecutor are only constructed on first
// access. Lets the server boot with N projects in the DB without spawning N
// claude.exe processes — each waits for a UI subscriber.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { OrchestratorSession, Project, ULID, WorkflowRow, WorkflowV2, WorkItem } from '@pc/domain';
import { postMoveStatusForStage } from '@pc/domain';
import type { ReviewDecision } from '@pc/workflows';
import {
  createOrchestratorSession,
  endOrchestratorSession,
  getActiveOrchestratorSession,
  getOrchestratorSession,
  moveWorkItemStage,
  reactivateOrchestratorSession,
  workflowsRepo,
} from '@pc/db';
import {
  claudeConfigDirFromJsonlPath,
  InteractiveSession,
  jsonlPathFor,
  PtySession,
} from '@pc/runtime';
import type { InteractiveSessionState } from '@pc/runtime';
import { selectStageEntryWorkflows } from '@pc/workflows';

import { renderTemplate } from './project-scaffold.ts';
import { preparePodSpawn, type PodSpawnPrep } from './pod-spawn.ts';
import { prepareClaudeRuntimeFiles } from './claude-runtime-bundle.ts';
import { WorktreeService } from './worktree.ts';
import { importV2WorkflowsFromDisk } from './workflow-import.ts';
import {
  fireDagWorkflow,
  applyV2ReviewDecision,
  type DagRunServiceOptions,
  type WorkflowReviewDelivery,
  type WorkflowRunFailedDelivery,
} from './dag-run-service.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';
import { WorkItemService } from './work-item.ts';
import { announceWorkItemRow } from './work-item-writer.ts';
import { AttachmentService } from './attachment.ts';
import { FieldSchemaService } from './field-schema.ts';
import { getWorkItem, listFieldSchemas } from '@pc/db';

/** WS broadcast bound to a single project. Was originally exported from the
 *  now-deleted workflow-runtime.ts; lives here so consumers don't need to
 *  drag in a defunct module just for the type alias. */
export type BroadcastFn = (event: unknown) => void;

const CLAUDE_TERMINAL_ENV: Readonly<Record<string, string>> = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  FORCE_COLOR: '3',
  CLAUDE_CODE_NO_FLICKER: '1',
};

function resizePty(
  session: { resize(cols: number, rows: number): void } | null,
  cols: number,
  rows: number,
): void {
  const safeCols = Math.max(20, Math.min(400, Math.trunc(cols)));
  const safeRows = Math.max(5, Math.min(200, Math.trunc(rows)));
  session?.resize(safeCols, safeRows);
}

export interface ProjectRuntimeOptions {
  /** Trunk data dir. Per-project subpaths derived from this. */
  dataDir: string;
  /** Channel server port for subagent dispatch + UI proxy. */
  channelPort: number;
  /** HTTP server port for hook callbacks and pc-rig MCP. */
  serverPort: number;
  /** WS broadcaster pre-bound to this project — registry produces it. */
  broadcast: BroadcastFn;
  /** Templates dir for hook re-render (per-session paths via env var). */
  templatesDir: string;
  /** Trunk repo root. 18.4 — substituted as `{{PC_TRUNK_PATH}}` into the
   *  inbox-drain hook so it can `createRequire` better-sqlite3 from the
   *  trunk's pnpm-managed `node_modules`. */
  trunkPath: string;
  getHostClient?: () => AgentHostReattachClient | null;
  /** Slice 008 — injected workflow-review delivery seam (friction #1). When
   *  the workflow-review gate = `mailbox` this routes the review prompt to a
   *  durable mailbox message instead of `/channel`. Composed in index.ts where
   *  the mailboxService lives — ProjectRuntime gains ONE function, no mailbox
   *  ref and no runtime-host change. Absent ⟹ unchanged Channel path. */
  deliverWorkflowReview?: WorkflowReviewDelivery;
  /** Workflow-engine redesign — failed-run notification seam (human inbox +
   *  project orchestrator). Composed in index.ts; absent ⟹ no notice. */
  deliverWorkflowRunFailed?: WorkflowRunFailedDelivery;
}

export class ProjectRuntime {
  private pty: InteractiveSession | null = null;
  /** 17b.12 — transient agent-designer session that spawns CC with
   *  `--agent agent-designer` + the materialised pod (prompt + tools +
   *  knowledge from the agent-designer pod row). One per project at a time.
   *  Pod-spawn cleanup is bound to the session end. */
  private agentDesigner: PtySession | null = null;
  private agentDesignerPrep: PodSpawnPrep | null = null;
  private agentDesignerSessionId: string | null = null;
  /** Section 19.9 — transient `workflow-builder` stock pod session that drives
   *  the "+ New workflow" modal. v1 `workflowCreator` removed in 19.12. */
  private workflowBuilder: PtySession | null = null;
  private workflowBuilderPrep: PodSpawnPrep | null = null;
  private workflowBuilderSessionId: string | null = null;
  private setupWizard: PtySession | null = null;
  private setupWizardCleanup: (() => void) | null = null;
  private setupWizardSessionId: string | null = null;
  private worktreesSvc: WorktreeService | null = null;
  private orchestratorCols = 120;
  private orchestratorRows = 30;
  /** Section 19.13 — one-shot YAML→DB import per ProjectRuntime lifetime.
   *  ProjectRegistry calls `bootstrap()` right after construct; the flag
   *  keeps the second call a no-op (defends against hot-reload + ensure()
   *  fallthrough during dev). */
  private workflowsBootstrapped = false;
  private workItemSvc: WorkItemService | null = null;
  private attachmentSvc: AttachmentService | null = null;
  private fieldSchemaSvc: FieldSchemaService | null = null;
  private hooksRefreshed = false;
  /** Section 19.9 — v2 workflow-builder drafts keyed by transient PC_SESSION_ID.
   *  Populated by `pc_save_workflow_draft` mid-interview; consumed by the
   *  visualizer via the `workflow-builder-draft` WS envelope. Cleared on
   *  session exit. */
  private readonly workflowBuilderDrafts: Map<string, WorkflowV2.Workflow> = new Map();

  constructor(public project: Project, private readonly opts: ProjectRuntimeOptions) {}

  get id(): ULID {
    return this.project.id;
  }

  get folderPath(): string {
    return this.project.folderPath;
  }

  /** Per-project data root. Holds the `sessions/` subtree + legacy
   *  project-wide files (until they're all session-scoped). */
  get dataPath(): string {
    return resolve(this.opts.dataDir, 'projects', this.project.id);
  }

  /** Per-session data dir. Hooks read PC_SESSION_ID to write here; the
   *  Sessions tab reads from here to render past chats. */
  sessionDataPath(sessionId: string): string {
    return resolve(this.dataPath, 'sessions', sessionId);
  }

  /**
   * Base dir for this project's worktrees: `<data_dir>/worktrees/<slug>/`.
   * Per `the multi-tenancy design` §4 — keeps the user's actual repo clean and
   * namespaces parallel-project worktrees on disk. Slug is locked at create
   * time (rename → slug migration is a deferred followup).
   */
  get worktreeBaseDir(): string {
    return resolve(this.opts.dataDir, 'worktrees', this.project.slug);
  }

  /** Refresh the cached `Project` after rename / settings change. Drops the
   *  cached WorktreeService when slug changes so the next access rebuilds with
   *  the new baseDir. Rename → slug migration itself is a deferred followup.
   *  WorkItemService reads `this.project` via a closure so it picks up the
   *  new stage list automatically without a rebuild. */
  refresh(project: Project): void {
    const slugChanged = project.slug !== this.project.slug;
    this.project = project;
    if (slugChanged) this.worktreesSvc = null;
  }

  /** Section 19.13 — one-shot bootstrap. Called by ProjectRegistry right
   *  after construct() / register(). Runs the v2 YAML → DB importer. Future
   *  one-shot project-init work can chain here.
   *
   *  Idempotent: the second call (e.g. via `ensure()` after `loadAll()`) is
   *  a no-op. Synchronous on purpose — fs reads are cheap, and we want the
   *  import to happen before any UI fetch lands. */
  bootstrap(): void {
    if (this.workflowsBootstrapped) return;
    this.workflowsBootstrapped = true;
    const dir = resolve(this.project.folderPath, '.project-companion', 'workflows');
    try {
      const out = importV2WorkflowsFromDisk({ projectId: this.project.id, workflowsDir: dir });
      if (out.scanned > 0 || out.yamlFilesDeleted > 0) {
        console.log(
          `[pc] workflow-import ${this.project.slug}: scanned=${out.scanned} imported=${out.imported} invalid=${out.importedInvalid} alreadyPresent=${out.alreadyPresent} yamlFilesDeleted=${out.yamlFilesDeleted} skippedNonV2=${out.skippedNonV2}`,
        );
      }
    } catch (err) {
      console.log(
        `[pc] workflow-import ${this.project.slug} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Section 19.17 — DB-backed view of every v2 workflow visible to this
   *  project (project-scope rows + globals). Returns `{ valid, invalid }`
   *  shaped to match the legacy registry surface so the compat GET endpoint
   *  (`/api/projects/:id/workflow-v2/definitions`) can serialize without
   *  reshaping. 19.18 swaps the web client over to `/api/workflows` and the
   *  compat endpoint goes with it. */
  listV2Workflows(): {
    valid: Array<{ id: string; name: string; workflow: WorkflowV2.Workflow; rowId: ULID }>;
    invalid: Array<{ id: string; slug: string; errors: string[] }>;
  } {
    const rows = workflowsRepo.listWorkflows({
      projectId: this.project.id,
      includeGlobals: true,
    });
    const valid: Array<{
      id: string;
      name: string;
      workflow: WorkflowV2.Workflow;
      rowId: ULID;
    }> = [];
    const invalid: Array<{ id: string; slug: string; errors: string[] }> = [];
    for (const r of rows) {
      if (r.status === 'active' && r.parsedDefinition !== null) {
        const wf = r.parsedDefinition as WorkflowV2.Workflow;
        valid.push({ id: r.slug, name: r.name, workflow: wf, rowId: r.id });
      } else {
        invalid.push({
          id: r.id,
          slug: r.slug,
          errors: r.parseError ? [r.parseError] : ['invalid workflow row'],
        });
      }
    }
    return { valid, invalid };
  }

  /** Look up a single v2 workflow by its YAML slug (the legacy in-memory
   *  registry's contract). Used by the slug-based compat GET endpoint;
   *  prefer `getWorkflowById` for new code paths. */
  findV2WorkflowBySlug(slug: string): {
    workflow: WorkflowV2.Workflow;
    yamlText: string;
    row: WorkflowRow;
  } | null {
    const project = workflowsRepo.getWorkflowBySlug({
      slug,
      scope: 'project',
      projectId: this.project.id,
    });
    const row = project ?? workflowsRepo.getWorkflowBySlug({ slug, scope: 'global' });
    if (!row || row.status !== 'active' || row.parsedDefinition === null) return null;
    return {
      workflow: row.parsedDefinition as WorkflowV2.Workflow,
      yamlText: row.yaml,
      row,
    };
  }

  /**
   * Lazy: WorktreeService bound to this project's repo + per-project baseDir
   * under `<data_dir>/worktrees/<slug>/`.
   */
  worktrees(): WorktreeService {
    if (!this.worktreesSvc) {
      this.worktreesSvc = new WorktreeService(this.project.folderPath, this.worktreeBaseDir);
    }
    return this.worktreesSvc;
  }

  /** Section 19.4f — assemble the live deps options for the v2 DAG executor
   *  from this project's existing context. */
  private dagRunOptions(): DagRunServiceOptions {
    return {
      projectId: this.project.id,
      workspaceDir: this.project.folderPath,
      channelPort: this.opts.channelPort,
      serverPort: this.opts.serverPort,
      dataDir: this.opts.dataDir,
      templatesDir: this.opts.templatesDir,
      trunkPath: this.opts.trunkPath,
      getProject: () => this.project,
      workItemService: this.workItemService(),
      worktrees: this.worktrees(),
      sessionDirFor: (pcSessionId) => this.sessionDataPath(pcSessionId),
      broadcast: this.opts.broadcast,
      hostClient: this.opts.getHostClient?.() ?? null,
      ...(this.opts.deliverWorkflowReview ? { deliverReview: this.opts.deliverWorkflowReview } : {}),
      ...(this.opts.deliverWorkflowRunFailed
        ? { deliverRunFailed: this.opts.deliverWorkflowRunFailed }
        : {}),
    };
  }

  /** Fire a v2 workflow. Returns once the run is set up (root WI + sidecar);
   *  the run itself proceeds in the background (the executor advances on its
   *  own and broadcasts state). Errors after setup are logged, not thrown.
   *
   *  When `triggerWorkItemId` is supplied (stage-on-entry path) the existing
   *  card is used as the run root — no new work item is minted and the card's
   *  stage is left unchanged. Without it (manual fire) a blank root is created. */
  async fireV2Workflow(
    workflow: WorkflowV2.Workflow,
    trigger: WorkflowV2.WorkflowTrigger = { kind: 'manual' },
    triggerWorkItemId?: ULID,
  ): Promise<{ runId: ULID; rootWorkItemId: ULID }> {
    const res = await fireDagWorkflow(workflow, trigger, this.dagRunOptions(), triggerWorkItemId);
    res.done.catch((err: Error) => {
      console.error(`[dag-run] run ${res.runId} failed:`, err.message);
    });
    return { runId: res.runId, rootWorkItemId: res.rootWorkItemId };
  }

  /** Section 19.12 — pure stage-move + v2 stage-on-entry firing. Reads
   *  `fromStageId` before the move, commits the move (version-checked when
   *  `expectedVersion` is supplied, legacy otherwise), then evaluates v2
   *  workflows whose `stage-on-entry` trigger matches and fires each.
   *
   *  Move errors (unknown stage, version conflict) propagate — the card stays
   *  put. v2 firing errors are logged, not thrown: the move already succeeded
   *  and a misconfigured v2 workflow shouldn't retro-fail the move.
   *
   *  v1's on_enter trigger + lock-on-fire + worktree-ensure semantics are
   *  gone — v2 attaches the run to a `WorkItem` via the runtime's own
   *  attach-to-work-item node instead. */
  async moveAndFireV2(args: {
    id: string;
    toStage: string;
    expectedVersion?: number;
    position?: number;
    notes?: string | null;
  }): Promise<WorkItem> {
    const pre = getWorkItem(args.id as ULID);
    if (!pre) throw new Error(`unknown work item: ${args.id}`);
    const fromStageId = pre.stageId ?? null;
    const destStage = this.project.stages.find((s) => s.id === args.toStage);
    if (!destStage) throw new Error(`unknown stage: ${args.toStage}`);

    let moved: WorkItem;
    if (args.expectedVersion !== undefined) {
      const input: { expectedVersion: number; stageId: string; position?: number } = {
        expectedVersion: args.expectedVersion,
        stageId: args.toStage,
      };
      if (args.position !== undefined) input.position = args.position;
      moved = this.workItemService().move(args.id as ULID, input, args.notes ?? undefined);
    } else {
      // Legacy path (no expectedVersion) — MCP `pc_move_work_item` lands here.
      const targetStatus = postMoveStatusForStage(destStage);
      const out = moveWorkItemStage(args.id as ULID, args.toStage, targetStatus, args.notes ?? null);
      if (!out) throw new Error(`unknown work item: ${args.id}`);
      moved = out;
      // Slice 015b — announce through the durable door (outbox row); the relay
      // delivers the canonical work-item.changed frame. No hand-fanout.
      announceWorkItemRow(moved, this.project.id, 'moved');
    }

    if (fromStageId !== args.toStage) {
      const stages = (this.project.stages ?? []).map((s) => ({
        id: s.id,
        ...(s.order !== undefined ? { order: s.order } : {}),
      }));
      const validDefs = this.listV2Workflows().valid.map((e) => e.workflow);
      const matches = selectStageEntryWorkflows(validDefs, stages, {
        fromStageId,
        toStageId: args.toStage,
      });
      for (const workflow of matches) {
        try {
          await this.fireV2Workflow(
            workflow,
            { kind: 'stage-on-entry', stage: args.toStage },
            args.id as ULID,
          );
        } catch (err) {
          console.error(
            `[project-runtime] v2 fire failed (workflow=${workflow.id} stage=${args.toStage}):`,
            (err as Error).message,
          );
        }
      }
    }

    return moved;
  }

  /** Apply an orchestrator/human review decision to a paused v2 run. */
  async applyV2Review(
    runId: ULID,
    reviewNodeId: string,
    decision: ReviewDecision,
  ): Promise<string | null> {
    return applyV2ReviewDecision(runId, reviewNodeId, decision, this.dagRunOptions());
  }

  /** Lazy: WorkItemService — owns create/patch/move/softDelete/restore/list/get
   *  with stage + field validation. workflow-runtime's createWorkItem shim
   *  delegates here. */
  workItemService(): WorkItemService {
    if (!this.workItemSvc) {
      this.workItemSvc = new WorkItemService({
        projectId: this.project.id,
        getProject: () => this.project,
        getFieldSchemas: () => listFieldSchemas(this.project.id),
      });
    }
    return this.workItemSvc;
  }

  /** Lazy: AttachmentService — project-scoped facade over the attachments repo,
   *  asserts work-item ownership before any CRUD. */
  attachmentService(): AttachmentService {
    if (!this.attachmentSvc) {
      this.attachmentSvc = new AttachmentService({
        projectId: this.project.id,
        getWorkItem,
        broadcast: this.opts.broadcast,
      });
    }
    return this.attachmentSvc;
  }

  /** Lazy: FieldSchemaService — list + bulk-replace per-project field schemas. */
  fieldSchemaService(): FieldSchemaService {
    if (!this.fieldSchemaSvc) {
      this.fieldSchemaSvc = new FieldSchemaService({
        projectId: this.project.id,
      });
    }
    return this.fieldSchemaSvc;
  }

  /**
   * Lazy: InteractiveSession — spawned on first WS connect. cwd is still the
   * user's project folder, but PC's Claude runtime files are passed explicitly
   * from the per-session data dir so terminal-launched Claude does not inherit
   * them.
   *
   * Session continuity: looks up the active OrchestratorSession row for this
   * project. If found → spawn with `--resume <uuid>` so Claude picks up the
   * conversation it had. If none → mint a UUID, insert a row, spawn with
   * `--session-id <uuid>` so the UI's events.jsonl and Claude's session JSONL
   * stay in lockstep.
   */
  ensurePty(): InteractiveSession {
    if (this.pty && !['exited', 'failed'].includes(this.pty.getState())) return this.pty;
    this.refreshProjectCompanionFilesIfStale();
    const session = this.resolveSessionForSpawn();
    const sessionDir = this.sessionDataPath(session.row.id);
    mkdirSync(sessionDir, { recursive: true });
    // Deterministic JSONL path. With --session-id passed at spawn (gate on
    // by default since 15.3), claude.exe writes to this exact filename. No
    // directory scan, no mtime race, no bleed-through risk from a sibling
    // claude.exe in the same cwd. Uses path-resolver to honor
    // CLAUDE_CONFIG_DIR (was a latent bug pre-Section-23: hardcoded homedir
    // here, CC writes elsewhere when env var is set, hooks hid the
    // mismatch by feeding the chat panel directly).
    const jsonlPath = session.jsonlPath;
    // Section 16a.3 — materialise the project's PM pod into a session-local
    // plugin. Nothing lands in `<project>/.claude`.
    // Replaces the pre-16a `--append-system-prompt-file` lever (which layered
    // PC's PM identity on top of CC's coding-assistant default). `--agent
    // <name>` REPLACES the default — PC owns the prompt + tool surface end-
    // to-end via the pod row seeded at server boot (16a.2).
    //
    let podPrep: PodSpawnPrep;
    try {
      const prep = preparePodSpawn({
        agentName: 'orchestrator',
        projectId: this.project.id,
        worktreeDir: this.project.folderPath,
        scratchDir: sessionDir,
        dataDir: this.opts.dataDir,
        templatesDir: this.opts.templatesDir,
        trunkPath: this.opts.trunkPath,
        serverPort: this.opts.serverPort,
        channelPort: this.opts.channelPort,
        projectSlug: this.project.slug,
        projectName: this.project.name,
      });
      if (!prep) {
        // Boot-time seed (16a.2) always inserts the row; a null here
        // means the DB is in an unexpected state (row deleted manually
        // mid-session?). Fail loud — falling back to a default-CC PM
        // would silently lose the locked tool allowlist.
        throw new Error(
          'orchestrator pod row not found (boot-time seed did not run, or row was deleted)',
        );
      }
      podPrep = prep;
    } catch (err) {
      throw new Error(
        `orchestrator pod materialisation failed: ${(err as Error).message}`,
      );
    }

    this.pty = new InteractiveSession({
      pcSessionId: session.row.id,
      ccProviderSessionId: session.providerSessionId,
      podDefinition: { name: podPrep.agentCliName },
      worktreePath: this.project.folderPath,
      env: {
        ...(process.env as Record<string, string | undefined>),
        ...podPrep.extraEnv,
        PC_SESSION_ID: session.row.id,
        PC_AGENT_SESSION_ID: session.providerSessionId,
        ...(session.claudeConfigDir ? { CLAUDE_CONFIG_DIR: session.claudeConfigDir } : {}),
      },
      envOverrides: { ...CLAUDE_TERMINAL_ENV },
      mode: session.resume ? 'resume' : 'fresh',
      jsonlPath,
      jsonlStartLine: session.resume ? session.row.jsonlLineCursor : 0,
      mcpConfigPath: podPrep.mcpConfigPath,
      settingsPath: podPrep.settingsPath,
      settingSources: podPrep.settingSources,
      pluginDirs: [podPrep.pluginDir],
      transcriptPath: resolve(sessionDir, 'transcript.log'),
      replayEventsPath: resolve(sessionDir, 'jsonl-events.jsonl'),
      model: 'opus',
      // Reliability over phone handoff: local PC chat writes directly through
      // the PTY, so the Claude remote-control bridge is not required. Keep a
      // regular composer-ready signal so historical resumes that skip MCP
      // handshake do not deliver into the dev-channel confirmation prompt.
      remoteControl: false,
      requireReadySignal: true,
      loadDevChannels: true,
      requireMcpHandshake: !session.resume,
      maxSpawnAttempts: 2,
      retryBackoffMs: 1500,
      spawnTimeoutMs: 120_000,
      cols: this.orchestratorCols,
      rows: this.orchestratorRows,
    });
    this.pty.start();

    // Process lifecycle is not chat lifecycle. A claude.exe child can exit
    // because of a transient resume/config problem, a terminal disconnect, or
    // a user-level Ctrl+D. The orchestrator session row stays active until PC
    // explicitly starts another session; the next ensurePty() resumes the same
    // row from its persisted JSONL path.
    let cleaned = false;
    const cleanupPodPrep = () => {
      if (cleaned) return;
      cleaned = true;
      try { podPrep.cleanup(); } catch { /* best-effort */ }
    };
    // LowLevelSpawn emits `exit` for every child attempt. InteractiveSession may
    // legitimately retry after an early child exit, and those retries still need
    // the session-local settings/plugin files. Clean up only once the wrapper is
    // terminal, not between attempts.
    this.pty.once('exited', cleanupPodPrep);
    this.pty.once('failed', cleanupPodPrep);

    return this.pty;
  }

  /** Returns the live orchestrator InteractiveSession if one is spawned. */
  ptySession(): InteractiveSession | null {
    return this.pty && !['exited', 'failed'].includes(this.pty.getState()) ? this.pty : null;
  }

  /** Remember the requested terminal geometry so future respawns for the same
   *  live runtime start at the user's current panel size. */
  resizeOrchestrator(cols: number, rows: number): void {
    const safeCols = Math.max(20, Math.min(400, Math.trunc(cols)));
    const safeRows = Math.max(5, Math.min(200, Math.trunc(rows)));
    this.orchestratorCols = safeCols;
    this.orchestratorRows = safeRows;
    this.ptySession()?.resize(safeCols, safeRows);
  }

  /** Smoke-test hook: kill the orchestrator child and detach the wrapper
   *  without ending the durable session row. The next send/subscribe can
   *  respawn against the same PC session. */
  killOrchestratorForSmoke(): boolean {
    if (!this.pty) return false;
    try { this.pty.kill(); } catch { /* best-effort */ }
    this.pty = null;
    return true;
  }

  /** Returns the current orchestrator process state without spawning. */
  orchestratorPtyState(): InteractiveSessionState | null {
    return this.pty ? this.pty.getState() : null;
  }

  orchestratorRuntimeSnapshot(): {
    spawnAttemptId: string | null;
    spawnAttempt: number;
    lastReadyAt: number | null;
    nextRetryAt: number | null;
    runtimeFailureReason: string | null;
  } {
    const snapshot = this.pty?.getSnapshot();
    return {
      spawnAttemptId: snapshot?.spawnAttemptId ?? null,
      spawnAttempt: snapshot?.spawnAttempt ?? 0,
      lastReadyAt: snapshot?.lastReadyAt ?? null,
      nextRetryAt: snapshot?.nextRetryAt ?? null,
      runtimeFailureReason: snapshot?.failureReason ?? null,
    };
  }

  notifyOrchestratorMcpHandshake(providerSessionId: string): boolean {
    const active = getActiveOrchestratorSession(this.project.id);
    if (!active || active.providerSessionId !== providerSessionId) return false;
    if (!this.pty) return false;
    this.pty.notifyMcpHandshake();
    return true;
  }

  /** Returns the active orchestrator session row, if any. */
  activeSession(): OrchestratorSession | null {
    return getActiveOrchestratorSession(this.project.id);
  }

  /** Ensure there is a durable active chat row without spawning Claude.
   *  Used by WS subscribe / send paths so UI replay and queueing are not
   *  blocked on a slow provider process start. */
  ensureActiveSession(): OrchestratorSession {
    const active = getActiveOrchestratorSession(this.project.id);
    if (active) return active;
    return createOrchestratorSession({
      projectId: this.project.id,
      providerSessionId: randomUUID(),
    });
  }

  /**
   * End the current session row, kill the PtySession, and clear cached state.
   * The next `ensurePty()` mints a fresh session row + spawns into a new
   * per-session dir — UI and Claude both start blank, and the prior session's
   * events.jsonl is preserved on disk for the Sessions tab to surface.
   */
  startNewSession(): OrchestratorSession {
    const active = getActiveOrchestratorSession(this.project.id);
    if (active) endOrchestratorSession(active.id, 'user_ended');
    try { this.pty?.kill(); } catch { /* best-effort */ }
    this.pty = null;
    const fresh = createOrchestratorSession({
      projectId: this.project.id,
      providerSessionId: randomUUID(),
    });
    return fresh;
  }

  /**
   * Resume a past orchestrator session by re-activating its row. Ends the
   * current active row (if different), kills the current PtySession,
   * flips the target's status back to 'active' + bumps its startedAt so it
   * sorts to the top of the Sessions list. Next ensurePty() picks up the
   * re-activated row and spawns claude.exe with --resume <uuid> when its raw
   * provider transcript still exists. Legacy rows that predate durable JSONL
   * path capture are still re-opened; their next spawn mints a fresh provider
   * transcript for the same PC session instead of failing the chat.
   *
   * Identity is preserved — same row id, same title, same conversation. The
   * chat panel re-renders by tailing the existing JSONL from its start.
   *
   * Errors if the target doesn't exist, belongs to another project, or has no
   * providerSessionId. If the target is already the active row, returns it
   * unchanged (no-op).
   */
  resumeSession(targetId: ULID): OrchestratorSession {
    const target = getOrchestratorSession(targetId);
    if (!target) throw new Error(`session not found: ${targetId}`);
    if (target.projectId !== this.project.id) {
      throw new Error('session belongs to a different project');
    }
    if (!target.providerSessionId) {
      throw new Error('session has no claude.exe conversation associated');
    }
    if (target.status === 'active') return target;
    // Do not reject missing raw JSONL here. resolveSessionForSpawn() does the
    // provider-side decision later: if the transcript exists it uses
    // `--resume`; otherwise it uses `--session-id` to make this legacy PC row
    // writable with a fresh provider transcript.
    const active = getActiveOrchestratorSession(this.project.id);
    if (active && active.id !== targetId) {
      endOrchestratorSession(active.id, 'user_ended');
    }
    try { this.pty?.kill(); } catch { /* best-effort */ }
    this.pty = null;
    const reactivated = reactivateOrchestratorSession(targetId);
    if (!reactivated) throw new Error('reactivation failed');
    return reactivated;
  }

  /**
   * Close the live chat back to the launcher: end the active session row
   * (status → 'ended') and kill the PtySession, WITHOUT minting a replacement.
   * Unlike startNewSession(), this leaves the project with no active session,
   * so the UI falls back to the Start-Chat launcher. The ended session's JSONL
   * is preserved on disk and stays resumable from the history list. Idempotent:
   * a no-op (returns false) when there's no active session to close.
   */
  closeSession(): boolean {
    const active = getActiveOrchestratorSession(this.project.id);
    try { this.pty?.kill(); } catch { /* best-effort */ }
    this.pty = null;
    if (!active) return false;
    endOrchestratorSession(active.id, 'user_ended');
    return true;
  }

  /**
   * Section 17d.10 — restart-on-pod-edit for the orchestrator. CC memoizes the
   * agent definition per-process, so mid-session pod edits don't propagate
   * until the claude.exe child is killed + respawned. After the kill, the
   * active session row is preserved (same id, same providerSessionId, same
   * JSONL on disk), so the next `ensurePty()` re-spawns with `--resume` and
   * the conversation continues from the same point — only with the new pod
   * content materialised. Returns true if a live PTY was killed (caller is
   * expected to ensure() + re-attach handlers); false if there was nothing
   * to restart.
   *
   * Worker agents (researcher / writer / etc.) deliberately do NOT restart on
   * pod edit — killing them mid-task would orphan their in-flight work. Worker
   * agents pick up new pod content on their next dispatch, which is the safer
   * default.
   */
  restartIfOrchestratorPod(podName: string): boolean {
    if (podName !== 'orchestrator') return false;
    if (!this.pty) return false;
    if (this.pty.getState() === 'exited') return false;
    try { this.pty.kill(); } catch { /* best-effort */ }
    this.pty = null;
    return true;
  }

  /** Kill the PtySession (if any) and clear caches so the runtime cold-starts. */
  shutdown(): void {
    try { this.pty?.kill(); } catch { /* best-effort */ }
    this.endAgentDesigner();
    this.endWorkflowBuilder();
    this.endSetupWizard();
    this.pty = null;
    this.worktreesSvc = null;
    this.workItemSvc = null;
    this.attachmentSvc = null;
    this.fieldSchemaSvc = null;
    this.workflowBuilderDrafts.clear();
  }

  /** 17b.12 — transient agent-designer session backed by the agent-designer
   *  pod (DB-resident; materialised at spawn time). Free-form chat
   *  conversation, like the orchestrator chat but scoped to designing a new
   *  pod. One per project at a time; calling `start` again kills any prior
   *  session. Pod materialisation cleanup is bound to session-end.
   *
   *  Differences from `startAgentCreator`:
   *   - uses `--agent agent-designer` (REPLACES CC's default system prompt
   *     with the pod's content; the pod owns the rulebook)
   *   - materialised pod mcp.json (carries the pod's tool allowlist + any
   *     per-pod MCP servers; session-local baseline pc-rig still present)
   *   - cleanup() on session-end removes the plugin, settings, and mcp.json
   *  Otherwise the wiring (events.jsonl path, transient session id,
   *  hook plumbing) mirrors startAgentCreator. */
  startAgentDesigner(): PtySession {
    this.endAgentDesigner();
    this.refreshProjectCompanionFilesIfStale();
    const transientId = `ad-${randomUUID()}`;
    const sessionDir = this.sessionDataPath(transientId);
    mkdirSync(sessionDir, { recursive: true });
    const cc = this.transientCcSession();

    const prep = preparePodSpawn({
      agentName: 'agent-designer',
      projectId: this.project.id,
      worktreeDir: this.project.folderPath,
      scratchDir: sessionDir,
      filterMcpToReferencedTools: false,
      dataDir: this.opts.dataDir,
      templatesDir: this.opts.templatesDir,
      trunkPath: this.opts.trunkPath,
      serverPort: this.opts.serverPort,
      channelPort: this.opts.channelPort,
      projectSlug: this.project.slug,
      projectName: this.project.name,
    });
    if (!prep) {
      throw new Error(
        'agent-designer pod row not found — boot-time seedStockPods should have ensured it exists',
      );
    }
    this.agentDesignerPrep = prep;

    this.agentDesigner = new PtySession({
      workspaceDir: this.project.folderPath,
      stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
      eventsPath: resolve(sessionDir, 'events.jsonl'),
      transcriptPath: resolve(sessionDir, 'transcript.log'),
      pcSessionId: transientId,
      claudeSessionId: cc.ccSessionId,
      resume: false,
      jsonlPath: cc.jsonlPath,
      extraEnv: { ...prep.extraEnv, PC_SESSION_ID: transientId },
      envOverrides: { ...CLAUDE_TERMINAL_ENV },
      agentName: prep.agentCliName,
      mcpConfigPath: prep.mcpConfigPath,
      settingsPath: prep.settingsPath,
      settingSources: prep.settingSources,
      pluginDirs: [prep.pluginDir],
    });
    this.agentDesignerSessionId = transientId;
    return this.agentDesigner;
  }

  /** Deterministic CC session identity for a transient (non-resumable) modal
   *  session — agent-designer / workflow-builder / setup-wizard. Mirrors the
   *  orchestrator's session ownership (resolveSessionForSpawn): mint a clean
   *  UUID, pass it as `--session-id`, and tail the EXACT jsonl path CC writes.
   *
   *  Without this, PtySession falls back to a directory scan of
   *  `~/.claude/projects/<cwd-hash>/` and attaches to the newest `.jsonl` by
   *  mtime — which latches onto a SIBLING claude.exe writing into the same
   *  cwd (e.g. a VS Code Claude Code session open in the same project folder),
   *  bleeding that unrelated chat into the modal. The CC session id is
   *  intentionally distinct from PC's internal `PC_SESSION_ID` (the `ad-`/`wc-`/
   *  `sw-` prefixed id that names the on-disk session dir). */
  private transientCcSession(): { ccSessionId: string; jsonlPath: string } {
    const ccSessionId = randomUUID();
    return {
      ccSessionId,
      jsonlPath: jsonlPathFor(this.project.folderPath, ccSessionId),
    };
  }

  /** Returns the live agent-designer PtySession, or null. */
  agentDesignerPty(): PtySession | null {
    return this.agentDesigner && this.agentDesigner.getState() !== 'exited'
      ? this.agentDesigner
      : null;
  }

  /** The transient PC_SESSION_ID assigned to the current agent-designer
   *  PtySession (or null when no designer modal session is live). */
  agentDesignerSession(): string | null {
    return this.agentDesignerSessionId;
  }

  /** True when a session id belongs to one of this project's live transient
   *  modal PTYs. Used by terminal-transcript routes; durable orchestrator
   *  sessions still validate through the DB row. */
  hasLiveTransientSession(sessionId: string): boolean {
    return (
      sessionId === this.agentDesignerSessionId ||
      sessionId === this.workflowBuilderSessionId ||
      sessionId === this.setupWizardSessionId
    );
  }

  resizeAgentDesigner(cols: number, rows: number): void {
    resizePty(this.agentDesignerPty(), cols, rows);
  }

  /** Kill the agent-designer session + clean up the materialised session-local
   *  runtime files. Idempotent. */
  endAgentDesigner(): void {
    if (this.agentDesigner) {
      try { this.agentDesigner.kill(); } catch { /* best-effort */ }
      this.agentDesigner = null;
    }
    if (this.agentDesignerPrep) {
      try { this.agentDesignerPrep.cleanup(); } catch { /* best-effort */ }
      this.agentDesignerPrep = null;
    }
    this.agentDesignerSessionId = null;
  }

  // ── Section 19.9 — workflow-builder transient session (v2-aware) ──────────
  //
  // Mirror of `startAgentDesigner` (uses `preparePodSpawn` to materialise the
  // pod's prompt + tool allowlist — REPLACES CC's default identity). Replaces
  // the v1 `workflow-creator` PtySession + draft store, both removed in 19.12.

  /** Section 19.9 — stash the latest v2 workflow-builder draft for a session.
   *  Called by the matching HTTP endpoint when `pc_save_workflow_draft` fires.
   *  Index.ts handles the WS broadcast. */
  setWorkflowBuilderDraft(sessionId: string, def: WorkflowV2.Workflow): void {
    this.workflowBuilderDrafts.set(sessionId, def);
  }

  /** Section 19.9 — read the current draft for a session. Used by
   *  `pc_read_workflow_draft` so the agent can pick up user drags between
   *  turns (sync-model-A). Returns undefined if no draft exists. */
  getWorkflowBuilderDraft(sessionId: string): WorkflowV2.Workflow | undefined {
    return this.workflowBuilderDrafts.get(sessionId);
  }

  /** Section 19.9 — drop draft state for a specific workflow-builder session.
   *  Called from `endWorkflowBuilder`. */
  clearWorkflowBuilderDraft(sessionId: string): void {
    this.workflowBuilderDrafts.delete(sessionId);
  }

  /** Section 19.9 — transient PtySession driving the conversational v2
   *  workflow-builder modal. Spawned with `--agent workflow-builder` (replaces
   *  CC's default identity with the pod's content). One workflow-builder at a
   *  time per project; calling `start` again kills the prior one. */
  startWorkflowBuilder(): PtySession {
    this.endWorkflowBuilder();
    this.refreshProjectCompanionFilesIfStale();
    const transientId = `wb-${randomUUID()}`;
    const sessionDir = this.sessionDataPath(transientId);
    mkdirSync(sessionDir, { recursive: true });
    const cc = this.transientCcSession();

    const prep = preparePodSpawn({
      agentName: 'workflow-builder',
      projectId: this.project.id,
      worktreeDir: this.project.folderPath,
      scratchDir: sessionDir,
      filterMcpToReferencedTools: false,
      dataDir: this.opts.dataDir,
      templatesDir: this.opts.templatesDir,
      trunkPath: this.opts.trunkPath,
      serverPort: this.opts.serverPort,
      channelPort: this.opts.channelPort,
      projectSlug: this.project.slug,
      projectName: this.project.name,
    });
    if (!prep) {
      throw new Error(
        'workflow-builder pod row not found — boot-time seedStockPods should have ensured it exists',
      );
    }
    this.workflowBuilderPrep = prep;

    this.workflowBuilder = new PtySession({
      workspaceDir: this.project.folderPath,
      stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
      eventsPath: resolve(sessionDir, 'events.jsonl'),
      transcriptPath: resolve(sessionDir, 'transcript.log'),
      pcSessionId: transientId,
      claudeSessionId: cc.ccSessionId,
      resume: false,
      jsonlPath: cc.jsonlPath,
      extraEnv: { ...prep.extraEnv, PC_SESSION_ID: transientId },
      envOverrides: { ...CLAUDE_TERMINAL_ENV },
      agentName: prep.agentCliName,
      mcpConfigPath: prep.mcpConfigPath,
      settingsPath: prep.settingsPath,
      settingSources: prep.settingSources,
      pluginDirs: [prep.pluginDir],
    });
    this.workflowBuilderSessionId = transientId;
    return this.workflowBuilder;
  }

  /** Returns the live workflow-builder PtySession, or null if not started /
   *  exited. */
  workflowBuilderPty(): PtySession | null {
    return this.workflowBuilder && this.workflowBuilder.getState() !== 'exited'
      ? this.workflowBuilder
      : null;
  }

  /** The transient PC_SESSION_ID assigned to the current workflow-builder
   *  PtySession (or the most-recently exited one). Used by the draft-state
   *  endpoint to scope cleanup. */
  workflowBuilderSession(): string | null {
    return this.workflowBuilderSessionId;
  }

  resizeWorkflowBuilder(cols: number, rows: number): void {
    resizePty(this.workflowBuilderPty(), cols, rows);
  }

  /** Kill the workflow-builder session + clean up the materialised
   *  session-local runtime files + drop its draft state. Idempotent. */
  endWorkflowBuilder(): void {
    if (this.workflowBuilder) {
      try { this.workflowBuilder.kill(); } catch { /* best-effort */ }
      this.workflowBuilder = null;
    }
    if (this.workflowBuilderPrep) {
      try { this.workflowBuilderPrep.cleanup(); } catch { /* best-effort */ }
      this.workflowBuilderPrep = null;
    }
    if (this.workflowBuilderSessionId) {
      this.clearWorkflowBuilderDraft(this.workflowBuilderSessionId);
      this.workflowBuilderSessionId = null;
    }
  }

  /** 5.6 / D82: transient PtySession driving the conversational setup wizard
   *  that writes CLAUDE.md. Mirrors startAgentCreator. One wizard at a time
   *  per project — calling start again kills the prior one. */
  startSetupWizard(): PtySession {
    if (this.setupWizard) {
      this.endSetupWizard();
    }
    this.refreshProjectCompanionFilesIfStale();
    const transientId = `sw-${randomUUID()}`;
    const sessionDir = this.sessionDataPath(transientId);
    mkdirSync(sessionDir, { recursive: true });
    const cc = this.transientCcSession();
    const runtimeFiles = prepareClaudeRuntimeFiles({
      scratchDir: sessionDir,
      worktreeDir: this.project.folderPath,
      projectId: this.project.id,
      projectSlug: this.project.slug,
      projectName: this.project.name,
      dataDir: this.opts.dataDir,
      templatesDir: this.opts.templatesDir,
      trunkPath: this.opts.trunkPath,
      serverPort: this.opts.serverPort,
      channelPort: this.opts.channelPort,
    });
    this.setupWizardCleanup = runtimeFiles.cleanup;
    this.setupWizard = new PtySession({
      workspaceDir: this.project.folderPath,
      stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
      eventsPath: resolve(sessionDir, 'events.jsonl'),
      transcriptPath: resolve(sessionDir, 'transcript.log'),
      pcSessionId: transientId,
      claudeSessionId: cc.ccSessionId,
      resume: false,
      jsonlPath: cc.jsonlPath,
      extraEnv: { ...runtimeFiles.extraEnv, PC_SESSION_ID: transientId },
      envOverrides: { ...CLAUDE_TERMINAL_ENV },
      mcpConfigPath: runtimeFiles.mcpConfigPath,
      settingsPath: runtimeFiles.settingsPath,
      settingSources: runtimeFiles.settingSources,
      appendSystemPromptPath: resolve(
        this.project.folderPath,
        '.project-companion',
        'setup-wizard-prompt.md',
      ),
    });
    this.setupWizardSessionId = transientId;
    this.setupWizard.once('exit', () => {
      if (this.setupWizardCleanup) {
        try { this.setupWizardCleanup(); } catch { /* best-effort */ }
        this.setupWizardCleanup = null;
      }
    });
    return this.setupWizard;
  }

  /** Returns the live setup-wizard PtySession, or null if not started / exited. */
  setupWizardPty(): PtySession | null {
    return this.setupWizard && this.setupWizard.getState() !== 'exited'
      ? this.setupWizard
      : null;
  }

  setupWizardSession(): string | null {
    return this.setupWizardSessionId;
  }

  resizeSetupWizard(cols: number, rows: number): void {
    resizePty(this.setupWizardPty(), cols, rows);
  }

  /** Kill the setup-wizard session. Idempotent. */
  endSetupWizard(): void {
    if (this.setupWizard) {
      try { this.setupWizard.kill(); } catch { /* best-effort */ }
      this.setupWizard = null;
    }
    if (this.setupWizardCleanup) {
      try { this.setupWizardCleanup(); } catch { /* best-effort */ }
      this.setupWizardCleanup = null;
    }
    this.setupWizardSessionId = null;
  }

  private resolveSessionForSpawn(): {
    row: OrchestratorSession;
    providerSessionId: string;
    resume: boolean;
    jsonlPath: string;
    claudeConfigDir: string | null;
  } {
    const active = getActiveOrchestratorSession(this.project.id);
    if (active?.providerSessionId) {
      // Only resume if claude.exe has a JSONL on disk for this UUID. UUIDs
      // minted in the DB without a matching JSONL ("phantoms") happen when
      // a row pre-dates --session-id rollout or was never spawned. Passing
      // --resume on a phantom UUID makes claude.exe exit with "No
      // conversation found with session ID..." — pass --session-id to mint
      // at the recorded UUID instead.
      const expectedJsonl = active.jsonlPath ?? jsonlPathFor(
        this.project.folderPath,
        active.providerSessionId,
      );
      return {
        row: active,
        providerSessionId: active.providerSessionId,
        resume: existsSync(expectedJsonl),
        jsonlPath: expectedJsonl,
        claudeConfigDir: active.jsonlPath
          ? claudeConfigDirFromJsonlPath(active.jsonlPath)
          : null,
      };
    }
    if (active) {
      // Row exists but no provider id — shouldn't happen since we mint at
      // create-time, but treat it as resume-with-no-target → end and re-mint.
      endOrchestratorSession(active.id, 'provider_session_lost');
    }
    const fresh = createOrchestratorSession({
      projectId: this.project.id,
      providerSessionId: randomUUID(),
    });
    return {
      row: fresh,
      providerSessionId: fresh.providerSessionId!,
      resume: false,
      jsonlPath: jsonlPathFor(this.project.folderPath, fresh.providerSessionId!),
      claudeConfigDir: null,
    };
  }

  /**
   * Backfill project-visible PC files that are intentionally part of the repo
   * scaffold (`.project-companion/*`). Claude runtime files (`.mcp.json`,
   * `.claude/settings.json`, hooks, and agents) are now session-local and must
   * never be refreshed into the user's project root.
   */
  private refreshProjectCompanionFilesIfStale(): void {
    if (this.hooksRefreshed) return;
    this.hooksRefreshed = true;
    const tokens = {
      PROJECT_DATA_DIR: this.dataPath.replace(/\\/g, '/'),
      PROJECT_ID: this.project.id,
      PROJECT_SLUG: this.project.slug,
      PROJECT_NAME: this.project.name,
      PROJECT_FOLDER: this.project.folderPath.replace(/\\/g, '/'),
      // 18.4 — added so refresh-on-boot picks up the inbox-drain hook template
      // for projects scaffolded pre-18.4. Trunk path resolves better-sqlite3
      // via createRequire from the hook script; db path is the global
      // PC sqlite file the drain query reads from.
      PC_TRUNK_PATH: this.opts.trunkPath.replace(/\\/g, '/'),
      PC_DB_PATH: resolve(this.opts.dataDir, 'pc.sqlite').replace(/\\/g, '/'),
    };
    try {
      // Section 16a.4 — orchestrator-prompt.md backfill removed. The
      // orchestrator's identity now lives in the `agents` DB table as a
      // pod row (seeded at boot per 16a.2; materialised into a session-local
      // plugin at spawn). Existing per-project copies of the legacy
      // `.project-companion/orchestrator-prompt.md` are unused post-16a;
      // safe to leave on disk (no reader) or manually delete.

      // 19.12 — workflow-creator-prompt.md backfill removed. The v1
      // workflow-creator session (which `appendSystemPromptPath`-ed this file
      // onto CC's default identity) is gone; v2 uses the workflow-builder
      // stock pod via `preparePodSpawn`. Existing per-project copies are
      // unused; safe to leave on disk or manually delete.

      // 5.6 / D82: setup-wizard prompt. Always-re-render (nobody hand-edits
      // this file, and the interview script may evolve between PC versions).
      const swCreatorSrc = resolve(
        this.opts.templatesDir,
        '.project-companion',
        'setup-wizard-prompt.md',
      );
      const swCreatorDest = resolve(
        this.project.folderPath,
        '.project-companion',
        'setup-wizard-prompt.md',
      );
      if (existsSync(swCreatorSrc)) {
        mkdirSync(resolve(this.project.folderPath, '.project-companion'), { recursive: true });
        const raw = readFileSync(swCreatorSrc, 'utf-8');
        writeFileSync(swCreatorDest, renderTemplate(raw, tokens), 'utf-8');
      }
      // Section 3 phase 3i: backfill any workflow YAMLs from templates that
      // don't yet exist in the project. Write-if-missing — user-edited copies
      // of seed workflows (bash-loop.yaml, approval-demo.yaml, etc.) survive.
      // New built-in workflows land in existing projects on next boot.
      const workflowsSrc = resolve(this.opts.templatesDir, '.project-companion', 'workflows');
      const workflowsDest = resolve(this.project.folderPath, '.project-companion', 'workflows');
      if (existsSync(workflowsSrc)) {
        mkdirSync(workflowsDest, { recursive: true });
        for (const f of readdirSync(workflowsSrc)) {
          if (!f.endsWith('.yaml')) continue;
          const destFile = resolve(workflowsDest, f);
          if (existsSync(destFile)) continue;
          const raw = readFileSync(resolve(workflowsSrc, f), 'utf-8');
          writeFileSync(destFile, raw, 'utf-8');
        }
      }
    } catch (err) {
      console.error(`[pc] project companion refresh failed for ${this.project.slug}:`, (err as Error).message);
    }
  }
}
