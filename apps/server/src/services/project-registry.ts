// ProjectRegistry — owns one ProjectRuntime per project. Resolves requests by
// project id, lazily loads runtimes for known projects, lets the bootstrap
// pre-populate from the DB at server start.

import type { Project, ULID } from '@pc/domain';
import { getProjectById, listProjects } from '@pc/db';

import { ProjectRuntime, type BroadcastFn } from './project-runtime.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';
import type { WorkflowReviewDelivery } from './dag-run-service.ts';

export interface ProjectRegistryDeps {
  dataDir: string;
  templatesDir: string;
  /** Trunk repo root. 18.4 — threaded into ProjectRuntime so the
   *  refresh-hooks template substitution can resolve `{{PC_TRUNK_PATH}}` for
   *  the inbox-drain hook's `createRequire` of `better-sqlite3`. */
  trunkPath: string;
  serverPort: number;
  channelPort: number;
  getHostClient?: () => AgentHostReattachClient | null;
  /** Factory: produces a broadcast fn pre-bound to the given project id. */
  broadcastFor: (projectId: ULID) => BroadcastFn;
  /** Slice 008 — injected workflow-review delivery seam, forwarded to every
   *  ProjectRuntime. Default (absent) keeps the unchanged Channel path. */
  deliverWorkflowReview?: WorkflowReviewDelivery;
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

  /** Drop a runtime (e.g. on soft-delete). Kills its PtySession + clears caches. */
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
      channelPort: this.deps.channelPort,
      broadcast: this.deps.broadcastFor(project.id),
      ...(this.deps.getHostClient ? { getHostClient: this.deps.getHostClient } : {}),
      ...(this.deps.deliverWorkflowReview
        ? { deliverWorkflowReview: this.deps.deliverWorkflowReview }
        : {}),
    });
  }
}
