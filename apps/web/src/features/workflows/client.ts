import { getJson, postJson, postJsonMethod } from '@/api/http';
import type { ULID } from '@/features/projects/types';
import type {
  V2RunDetail,
  V2RunEvent,
  V2RunSummary,
  V2WorkflowDef,
  V2WorkflowDefSummary,
  WorkflowFireResult,
  WorkflowRow,
  WorkflowScope,
} from './types';

export * from './types';

export const workflowsApi = {
  listV2WorkflowDefinitions: (projectId: ULID) =>
    getJson<{
      ok: true;
      valid: Array<{ id: string; name: string; workflow: V2WorkflowDefSummary }>;
      invalid: Array<{ fileName: string; errors: string[] }>;
    }>(`/api/projects/${projectId}/workflow-v2/definitions`),

  listV2WorkflowRuns: (projectId: ULID) =>
    getJson<{ ok: true; runs: V2RunSummary[] }>(
      `/api/projects/${projectId}/workflow-v2/runs`,
    ),

  getV2Run: (projectId: ULID, runId: string) =>
    getJson<{ ok: true; run: V2RunDetail; events: V2RunEvent[] }>(
      `/api/projects/${projectId}/workflow-v2/runs/${encodeURIComponent(runId)}`,
    ),

  getV2WorkflowDef: (projectId: ULID, wfId: string) =>
    getJson<{ ok: true; workflow: V2WorkflowDef; yamlText: string }>(
      `/api/projects/${projectId}/workflow-v2/definitions/${encodeURIComponent(wfId)}`,
    ),

  listWorkflowRows: (projectId: ULID) =>
    getJson<{ ok: true; workflows: WorkflowRow[] }>(
      `/api/workflows?projectId=${encodeURIComponent(projectId)}`,
    ).then((r) => r.workflows),

  getWorkflowRow: (id: ULID) =>
    getJson<{ ok: true; workflow: WorkflowRow }>(
      `/api/workflows/${encodeURIComponent(id)}`,
    ).then((r) => r.workflow),

  createWorkflowRow: (input: {
    def: unknown;
    projectId?: ULID | null;
    scope?: WorkflowScope;
    displayName?: string | null;
    actor?: 'user' | 'orchestrator';
    reason?: string;
  }) =>
    postJson<{ ok: true; workflow: WorkflowRow }>('/api/workflows', input).then(
      (r) => r.workflow,
    ),

  updateWorkflowRow: (
    id: ULID,
    patch: {
      def?: unknown;
      yaml?: string;
      displayName?: string | null;
      disabled?: boolean;
      name?: string;
      actor?: 'user' | 'orchestrator';
      reason?: string;
    },
  ) =>
    postJsonMethod<{ ok: true; workflow: WorkflowRow }>(
      `/api/workflows/${encodeURIComponent(id)}`,
      patch,
      'PUT',
    ).then((r) => r.workflow),

  deleteWorkflowRow: async (id: ULID, opts?: { cancel?: boolean }): Promise<void> => {
    const qs = opts?.cancel ? '?cancel=1' : '';
    const res = await fetch(`/api/workflows/${encodeURIComponent(id)}${qs}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      kind?: string;
      inFlight?: number;
    };
    if (!res.ok || data.ok === false) {
      const msg = data.error ?? `delete workflow → ${res.status}`;
      const err = new Error(msg) as Error & {
        kind?: string;
        status?: number;
        inFlight?: number;
      };
      if (data.kind) err.kind = data.kind;
      if (data.inFlight !== undefined) err.inFlight = data.inFlight;
      err.status = res.status;
      throw err;
    }
  },

  promoteWorkflowToGlobal: (id: ULID) =>
    postJson<{ ok: true; workflow: WorkflowRow }>(
      `/api/workflows/${encodeURIComponent(id)}/promote-to-global`,
      {},
    ).then((r) => r.workflow),

  duplicateWorkflowRow: (
    id: ULID,
    input?: {
      newName?: string;
      newSlug?: string;
      targetScope?: WorkflowScope;
      targetProjectId?: ULID | null;
    },
  ) =>
    postJson<{ ok: true; workflow: WorkflowRow }>(
      `/api/workflows/${encodeURIComponent(id)}/duplicate`,
      input ?? {},
    ).then((r) => r.workflow),

  fireWorkflowRow: (
    id: ULID,
    input?: {
      projectId?: ULID;
      /** Run the workflow ON this existing card (it becomes the run root). */
      workItemId?: ULID;
    },
  ) =>
    postJson<WorkflowFireResult>(
      `/api/workflows/${encodeURIComponent(id)}/fire`,
      input ?? {},
    ),
};
