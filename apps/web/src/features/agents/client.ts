import { getJson, postJson, postJsonMethod } from '@/api/http';
import type { ULID } from '@/features/projects/types';
import type {
  AgentContextDoc,
  CreatePodInput,
  ListAuditOptions,
  PatchPodInput,
  Pod,
  PodAuditEntry,
  PodBundle,
  PodSecret,
} from './types';

export * from './types';

export const agentsApi = {
  listPods: (projectId?: ULID) => {
    const path = projectId
      ? `/api/agents/pods?projectId=${encodeURIComponent(projectId)}`
      : '/api/agents/pods';
    return getJson<{ pods: Pod[] }>(path).then((r) => r.pods);
  },

  getPod: (podId: ULID) =>
    getJson<{ ok: true } & PodBundle>(`/api/agents/pods/${podId}`).then(
      ({ agent, contextDocs, secrets }) => ({
        agent,
        contextDocs,
        secrets,
      }),
    ),

  createPod: (input: CreatePodInput) =>
    postJson<{ ok: true; pod: Pod }>('/api/agents/pods', input).then((r) => r.pod),

  promotePodToGlobal: (podId: ULID) =>
    postJson<{ ok: true; pod: Pod }>(
      `/api/agents/pods/${podId}/promote-to-global`,
      {},
    ).then((r) => r.pod),

  /** Add a shareable agent to a project. Throws with `err.kind === 'name-collision'`
   *  when another agent in that project already has the same name. */
  addPodToProject: async (podId: ULID, projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/agents/pods/${podId}/add-to-project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string; kind?: string };
    if (!res.ok || data.ok === false) {
      const msg = data.error ?? `add-to-project → ${res.status}`;
      const err = new Error(msg) as Error & { kind?: string; status?: number };
      if (data.kind) err.kind = data.kind;
      err.status = res.status;
      throw err;
    }
  },

  /** Remove a shared agent from one project. Returns wasLastProject=true when
   *  the agent is now in no projects (still stays in the library). */
  removePodFromProject: async (
    podId: ULID,
    projectId: ULID,
  ): Promise<{ wasLastProject: boolean }> => {
    const res = await fetch(`/api/agents/pods/${podId}/projects/${projectId}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as {
      ok?: boolean;
      wasLastProject?: boolean;
      error?: string;
    };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `remove-from-project → ${res.status}`);
    }
    return { wasLastProject: data.wasLastProject ?? false };
  },

  resetStockPodToDefault: (podId: ULID) =>
    postJson<{ ok: true; pod: Pod; resetFields: string[] }>(
      `/api/agents/pods/${podId}/reset-to-default`,
      {},
    ).then((r) => ({ pod: r.pod, resetFields: r.resetFields })),

  resetAllStockPodsToDefault: () =>
    postJson<{
      ok: true;
      reset: Array<{ name: string; resetFields: string[] }>;
      unchanged: string[];
      missing: string[];
    }>(`/api/agents/pods/reset-all-stock-to-default`, {}).then((r) => ({
      reset: r.reset,
      unchanged: r.unchanged,
      missing: r.missing,
    })),

  patchPod: (podId: ULID, patch: PatchPodInput) =>
    postJsonMethod<{ ok: true; pod: Pod }>(
      `/api/agents/pods/${podId}`,
      patch,
      'PATCH',
    ).then((r) => r.pod),

  deletePod: async (podId: ULID): Promise<void> => {
    const res = await fetch(`/api/agents/pods/${podId}`, { method: 'DELETE' });
    const data = (await res.json()) as { ok?: boolean; error?: string; kind?: string };
    if (!res.ok || data.ok === false) {
      const msg = data.error ?? `delete pod → ${res.status}`;
      const err = new Error(msg) as Error & { kind?: string; status?: number };
      if (data.kind) err.kind = data.kind;
      err.status = res.status;
      throw err;
    }
  },

  createAgentDoc: (podId: ULID, input: { title: string; body?: string }) =>
    postJson<{ ok: true; contextDoc: AgentContextDoc }>(
      `/api/agents/pods/${podId}/context-docs`,
      input,
    ).then((r) => r.contextDoc),

  patchAgentDoc: (
    podId: ULID,
    docId: ULID,
    patch: { title?: string; body?: string },
  ) =>
    postJsonMethod<{ ok: true; contextDoc: AgentContextDoc }>(
      `/api/agents/pods/${podId}/context-docs/${docId}`,
      patch,
      'PATCH',
    ).then((r) => r.contextDoc),

  deleteAgentDoc: async (podId: ULID, docId: ULID): Promise<void> => {
    const res = await fetch(`/api/agents/pods/${podId}/context-docs/${docId}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete context doc → ${res.status}`);
    }
  },

  createSecret: (podId: ULID, input: { envVarName: string; valuePlaintext: string }) =>
    postJson<{ ok: true; secret: PodSecret }>(
      `/api/agents/pods/${podId}/secrets`,
      input,
    ).then((r) => r.secret),

  deleteSecret: async (podId: ULID, secretId: ULID): Promise<void> => {
    const res = await fetch(`/api/agents/pods/${podId}/secrets/${secretId}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete secret → ${res.status}`);
    }
  },

  listPodAudit: (podId: ULID, opts: ListAuditOptions = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts.beforeCreatedAt !== undefined) {
      qs.set('beforeCreatedAt', String(opts.beforeCreatedAt));
    }
    if (opts.actor) qs.set('actor', opts.actor);
    if (opts.field) qs.set('field', opts.field);
    const suffix = qs.toString();
    return getJson<{ ok: true; rows: PodAuditEntry[] }>(
      `/api/agents/pods/${podId}/audit${suffix ? `?${suffix}` : ''}`,
    ).then((r) => r.rows);
  },
};
