// ProjectRuntime — per-project bundle of the orchestrator chat session
// (OrchestratorHostSession, an Engine-owned host run) + DagExecutor +
// WorktreeService. One instance per active project; held by ProjectRegistry.
//
// Lazy spawn: the chat session + DagExecutor are only constructed on first
// access. Lets the server boot with N projects in the DB without spawning N
// claude.exe processes — each waits for a UI subscriber.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { OrchestratorSession, Project, ULID, WorkflowRow, WorkflowV2, WorkItem } from '@pc/domain';
import { postMoveStatusForStage, resolveRemoteControlEnabled, withSettingsDefaults } from '@pc/domain';
import type { ReviewDecision } from '@pc/workflows';
import {
  createOrchestratorSession,
  endOrchestratorSession,
  getActiveOrchestratorSession,
  getGlobalSettings,
  getOrchestratorSession,
  moveWorkItemStage,
  reactivateOrchestratorSession,
  workflowsRepo,
} from '@pc/db';
import { getDataDir } from '@pc/utils';
import {
  claudeConfigDirFromJsonlPath,
  jsonlPathFor,
} from '@pc/runtime';

import { preparePodSpawn, type PodSpawnPrep } from './pod-spawn.ts';
import { WorktreeService } from './worktree.ts';
import { importV2WorkflowsFromDisk } from './workflow-import.ts';
import {
  fireDagWorkflow,
  applyV2ReviewDecision,
  resumeFailedDagRun,
  type ResumeFailedRunResult,
  type DagRunServiceOptions,
  type ReviewInboxResolution,
  type WorkflowReviewDelivery,
  type WorkflowRunFailedDelivery,
  type WorkflowRunCompletedDelivery,
} from './dag-run-service.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';
import {
  asOrchestratorHostPort,
  OrchestratorHostSession,
  type OrchestratorHostSessionState,
} from './orchestrator-host-session.ts';
import { WorkItemService } from './work-item.ts';
import { AttachmentService } from './attachment.ts';
import { FieldSchemaService } from './field-schema.ts';
import { getWorkItem, listFieldSchemas } from '@pc/db';
import { WorkItemMutationGateway } from '@pc/app-services';

/** FD-12 — the one write door (repo write + outbox receipt in one txn). */
const workItemGateway = new WorkItemMutationGateway();

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

export interface ProjectRuntimeOptions {
  /** Trunk data dir. Per-project subpaths derived from this. */
  dataDir: string;
  /** HTTP server port for hook callbacks and pc-rig MCP. */
  serverPort: number;
  /** WS broadcaster pre-bound to this project — registry produces it. */
  broadcast: BroadcastFn;
  /** Templates dir for hook re-render (per-session paths via env var). */
  templatesDir: string;
  /** Trunk repo root. Substituted as `{{PC_TRUNK_PATH}}` in template renders
   *  (README; historically the ☠ inbox-drain hook's createRequire — M4a). */
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
  /** Completed-run notification seam — nudges the orchestrator to run the
   *  workflow-doctor on a workflow's first completion. Composed in index.ts;
   *  absent ⟹ no nudge. */
  deliverWorkflowRunCompleted?: WorkflowRunCompletedDelivery;
  /** M8 (FD-7) — decided-elsewhere inbox resolution (MailboxService pair),
   *  forwarded into DagRunServiceOptions. Composed in index.ts. */
  reviewInbox?: ReviewInboxResolution;
}

export class ProjectRuntime {
  private pty: OrchestratorHostSession | null = null;
  /** The previous chat session's host-terminal promise — the next spawn for
   *  the same CC session awaits it (the Engine holds the ccSessionId until
   *  the old run settles; see OrchestratorHostSession.settled). */
  private lastOrchestratorSettled: Promise<void> | null = null;
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
      ...(this.opts.deliverWorkflowRunCompleted
        ? { deliverRunCompleted: this.opts.deliverWorkflowRunCompleted }
        : {}),
      ...(this.opts.reviewInbox ? { reviewInbox: this.opts.reviewInbox } : {}),
    };
  }

  /** Fire a v2 workflow. Returns once the run is set up (root WI + sidecar);
   *  the run itself proceeds in the background (the executor advances on its
   *  own and broadcasts state). Errors after setup are logged, not thrown.
   *
   *  When `rootWorkItemId` is supplied the existing card is used as the run
   *  root — no new work item is minted and the card's stage is left unchanged.
   *  Without it a blank root is created. */
  async fireV2Workflow(
    workflow: WorkflowV2.Workflow,
    rootWorkItemId?: ULID,
  ): Promise<{ runId: ULID; rootWorkItemId: ULID }> {
    const res = await fireDagWorkflow(workflow, this.dagRunOptions(), rootWorkItemId);
    res.done.catch((err: Error) => {
      console.error(`[dag-run] run ${res.runId} failed:`, err.message);
    });
    return { runId: res.runId, rootWorkItemId: res.rootWorkItemId };
  }

  /** The one stage-move door. Commits the move (version-checked when
   *  `expectedVersion` is supplied, legacy otherwise). Move errors (unknown
   *  stage, version conflict) propagate — the card stays put.
   *
   *  ☠ M6/FD-10 (2026-06-04): the stage-on-entry firing half is DELETED — a
   *  card entering a stage no longer starts workflows. Runs start via "Run
   *  now" or the orchestrator fire tool only. */
  async moveWorkItemV2(args: {
    id: string;
    toStage: string;
    expectedVersion?: number;
    position?: number;
    notes?: string | null;
  }): Promise<WorkItem> {
    const pre = getWorkItem(args.id as ULID);
    if (!pre) throw new Error(`unknown work item: ${args.id}`);
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
      // FD-12 — move + receipt in one gateway transaction.
      const targetStatus = postMoveStatusForStage(destStage);
      let out!: WorkItem;
      workItemGateway.commitWorkItemChange({
        projectId: this.project.id,
        reason: 'moved',
        mutate: () => {
          const row = moveWorkItemStage(args.id as ULID, args.toStage, targetStatus, args.notes ?? null);
          if (!row) throw new Error(`unknown work item: ${args.id}`);
          out = row;
          return row;
        },
      });
      moved = out;
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

  /** M6 slice C (FD-11 restart-at-step) — resume a FAILED run against the
   *  CURRENT definition (the route resolves + validates the def row). */
  async resumeV2Run(
    runId: ULID,
    currentDefinition: WorkflowV2.Workflow | null,
  ): Promise<ResumeFailedRunResult> {
    return resumeFailedDagRun(runId, currentDefinition, this.dagRunOptions());
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
   * Lazy: the orchestrator chat session — Step-4 Slice 2: an Engine-owned
   * `persistent-interactive` run behind the OrchestratorHostSession adapter
   * (ONE owner of every Claude process). cwd is still the user's project
   * folder; PC's Claude runtime files are materialised into the per-session
   * data dir exactly as before — the host reads them off the shared disk.
   *
   * Session continuity: looks up the active OrchestratorSession row for this
   * project. If found → spawn with `--resume <uuid>` so Claude picks up the
   * conversation it had. If none → mint a UUID, insert a row, spawn with
   * `--session-id <uuid>` so the UI's events.jsonl and Claude's session JSONL
   * stay in lockstep. After an API restart the adapter ADOPTS a still-live
   * host run on the same CC session instead of double-spawning.
   */
  ensurePty(): OrchestratorHostSession {
    if (this.pty && !['exited', 'failed'].includes(this.pty.getState())) return this.pty;
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
    // Resolve whether this orchestrator session launches remote-ready:
    // per-project override wins, else the global default. Dispatched agent
    // workers never get remote control — only this orchestrator path passes it.
    const globalSettings = withSettingsDefaults(getGlobalSettings() ?? {}, getDataDir(), homedir());
    const remoteControl = resolveRemoteControlEnabled(
      this.project.settings,
      globalSettings.remoteControlEnabled,
    );

    let podPrep: PodSpawnPrep;
    try {
      const prep = preparePodSpawn({
        agentName: 'orchestrator',
        projectId: this.project.id,
        worktreeDir: this.project.folderPath,
        scratchDir: sessionDir,
        remoteControl,
        // FD-2 — identity for the pc-rig HTTP headers (mirrors the
        // PC_SESSION_ID / PC_AGENT_SESSION_ID env below).
        identity: {
          sessionId: session.row.id,
          agentSessionId: session.providerSessionId,
        },
        dataDir: this.opts.dataDir,
        templatesDir: this.opts.templatesDir,
        trunkPath: this.opts.trunkPath,
        serverPort: this.opts.serverPort,
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

    // Slice 2 — the host owns the spawn. No host connection = a loud typed
    // failure (never an alternate in-process spawn; ONE-SPAWN-OWNER).
    const hostPort = asOrchestratorHostPort(this.opts.getHostClient?.() ?? null);
    if (!hostPort) {
      throw new Error(
        'agent host connection unavailable — the Engine owns the orchestrator chat (no in-process spawn path exists)',
      );
    }

    const prior = this.lastOrchestratorSettled;
    const adapter = new OrchestratorHostSession(
      {
        pcSessionId: session.row.id,
        providerSessionId: session.providerSessionId,
        projectId: this.project.id,
        podDefinition: { name: podPrep.agentCliName, logicalName: 'orchestrator' },
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
        model: 'opus',
        requireReadySignal: true,
        requireMcpHandshake: !session.resume,
        cols: this.orchestratorCols,
        rows: this.orchestratorRows,
        // The Engine holds the ccSessionId until the previous run settles —
        // a restart (pod edit / new session) must not race it.
        ...(prior ? { awaitBefore: prior } : {}),
        // Session-local settings/plugin files clean up exactly once, at
        // terminal — the host process reads them for the whole run lifetime.
        onCleanup: () => {
          try { podPrep.cleanup(); } catch { /* best-effort */ }
        },
      },
      { hostClient: hostPort },
    );
    this.pty = adapter;
    this.lastOrchestratorSettled = adapter.settled;
    adapter.start();

    return adapter;
  }

  /** Returns the live orchestrator chat session if one is attached. */
  ptySession(): OrchestratorHostSession | null {
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
  orchestratorPtyState(): OrchestratorHostSessionState | null {
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

  /** Kill the chat session (if any) and clear caches so the runtime cold-starts. */
  shutdown(): void {
    try { this.pty?.kill(); } catch { /* best-effort */ }
    this.pty = null;
    this.worktreesSvc = null;
    this.workItemSvc = null;
    this.attachmentSvc = null;
    this.fieldSchemaSvc = null;
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

}
