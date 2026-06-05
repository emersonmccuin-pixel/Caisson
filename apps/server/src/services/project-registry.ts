// ProjectRegistry — owns one ProjectRuntime per project. Resolves requests by
// project id, lazily loads runtimes for known projects, lets the bootstrap
// pre-populate from the DB at server start.

import type { Project, ULID } from '@pc/domain';
import { getProjectById, listProjects } from '@pc/db';

import { ProjectRuntime, type BroadcastFn } from './project-runtime.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';
import type {
  ReviewInboxResolution,
  WorkflowReviewDelivery,
  WorkflowRunFailedDelivery,
  WorkflowRunCompletedDelivery,
} from './dag-run-service.ts';

export interface ProjectRegistryDeps {
  dataDir: string;
  templatesDir: string;
  /** Trunk repo root. Threaded into ProjectRuntime for `{{PC_TRUNK_PATH}}`
   *  template substitution (README; historically the ☠ inbox-drain hook — M4a). */
  trunkPath: string;
  serverPort: number;
  getHostClient?: () => AgentHostReattachClient | null;
  /** Factory: produces a broadcast fn pre-bound to the given project id. */
  broadcastFor: (projectId: ULID) => BroadcastFn;
  /** Slice 008 — injected workflow-review delivery seam, forwarded to every
   *  ProjectRuntime. Default (absent) keeps the unchanged Channel path. */
  deliverWorkflowReview?: WorkflowReviewDelivery;
  /** Workflow-engine redesign — failed-run notification seam, forwarded to every
   *  ProjectRuntime. Absent ⟹ no notice (back-compat). */
  deliverWorkflowRunFailed?: WorkflowRunFailedDelivery;
  /** First-run nudge seam — forwarded to every ProjectRuntime. Absent ⟹ no
   *  nudge (back-compat). */
  deliverWorkflowRunCompleted?: WorkflowRunCompletedDelivery;
  /** M8 (FD-7) — decided-elsewhere inbox resolution, forwarded to every
   *  ProjectRuntime. */
  reviewInbox?: ReviewInboxResolution;
}

export class ProjectRegistry {
  private readonly runtimes = new Map<ULID, ProjectRuntime>();

  constructor(private readonly deps: ProjectRegistryDeps) {}

  /** Load every non-deleted project from the DB into the registry. */
  loadAll(): void {
    for (const p of listProjects()) {
      const runtime = this.construct(p);
      this.runtimes.set(p.id, runtime);
      // Section 19.13 — run one-shot init (YAML→DB workflow import) before
      // any UI fetch lands. bootstrap() is idempotent.
      runtime.bootstrap();
    }
  }

  /** Resolve (or hydrate) the runtime for `projectId`. Returns null if no such project. */
  ensure(projectId: ULID): ProjectRuntime | null {
    const cached = this.runtimes.get(projectId);
    if (cached) return cached;
    const project = getProjectById(projectId);
    if (!project) return null;
    const runtime = this.construct(project);
    this.runtimes.set(projectId, runtime);
    runtime.bootstrap();
    return runtime;
  }

  get(projectId: ULID): ProjectRuntime | null {
    return this.runtimes.get(projectId) ?? null;
  }

  /** Register a freshly-created project so subsequent calls skip the DB hit. */
  register(project: Project): ProjectRuntime {
    const runtime = this.construct(project);
    this.runtimes.set(project.id, runtime);
    runtime.bootstrap();
    return runtime;
  }

  /** Apply an updated `Project` to its cached runtime + slug cache. P11's
   *  PATCH endpoint calls this so renames + git-remote edits stick without
   *  a server restart. No-op if the runtime hasn't been hydrated yet. */
  refresh(project: Project): void {
    const runtime = this.runtimes.get(project.id);
    if (runtime) runtime.refresh(project);
  }

  /** Drop a runtime (e.g. on soft-delete). Kills its chat session + clears caches. */
  remove(projectId: ULID): void {
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return;
    runtime.shutdown();
    this.runtimes.delete(projectId);
  }

  list(): ProjectRuntime[] {
    return Array.from(this.runtimes.values());
  }

  shutdownAll(): void {
    for (const r of this.runtimes.values()) r.shutdown();
    this.runtimes.clear();
  }

  private construct(project: Project): ProjectRuntime {
    return new ProjectRuntime(project, {
      dataDir: this.deps.dataDir,
      templatesDir: this.deps.templatesDir,
      trunkPath: this.deps.trunkPath,
      serverPort: this.deps.serverPort,
      broadcast: this.deps.broadcastFor(project.id),
      ...(this.deps.getHostClient ? { getHostClient: this.deps.getHostClient } : {}),
      ...(this.deps.deliverWorkflowReview
        ? { deliverWorkflowReview: this.deps.deliverWorkflowReview }
        : {}),
      ...(this.deps.deliverWorkflowRunFailed
        ? { deliverWorkflowRunFailed: this.deps.deliverWorkflowRunFailed }
        : {}),
      ...(this.deps.deliverWorkflowRunCompleted
        ? { deliverWorkflowRunCompleted: this.deps.deliverWorkflowRunCompleted }
        : {}),
      ...(this.deps.reviewInbox ? { reviewInbox: this.deps.reviewInbox } : {}),
    });
  }
}
