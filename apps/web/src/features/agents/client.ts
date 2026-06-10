import { getJson, postJson, postJsonMethod } from '@/api/http';
import type { ULID } from '@/features/projects/types';
import type {
  CreatePodInput,
  ListAuditOptions,
  PatchPodInput,
  Pod,
  PodAuditEntry,
  PodBundle,
  PodKnowledge,
  PodKnowledgeKind,
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
      ({ agent, knowledge, secrets }) => ({
        agent,
        knowledge,
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

  clonePodToProject: (podId: ULID, projectId: ULID, name?: string) =>
    postJson<{ ok: true; pod: Pod; copied: { knowledge: number } }>(
      `/api/agents/pods/${podId}/clone-to-project`,
      name ? { projectId, name } : { projectId },
    ).then((r) => ({ pod: r.pod, copied: r.copied })),

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

  createKnowledge: (
    podId: ULID,
    input: { name: string; content?: string; kind?: PodKnowledgeKind },
  ) =>
    postJson<{ ok: true; knowledge: PodKnowledge }>(
      `/api/agents/pods/${podId}/knowledge`,
      input,
    ).then((r) => r.knowledge),

  patchKnowledge: (
    podId: ULID,
    knowledgeId: ULID,
    patch: { name?: string; content?: string; kind?: PodKnowledgeKind },
  ) =>
    postJsonMethod<{ ok: true; knowledge: PodKnowledge }>(
      `/api/agents/pods/${podId}/knowledge/${knowledgeId}`,
      patch,
      'PATCH',
    ).then((r) => r.knowledge),

  deleteKnowledge: async (podId: ULID, knowledgeId: ULID): Promise<void> => {
    const res = await fetch(`/api/agents/pods/${podId}/knowledge/${knowledgeId}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete knowledge → ${res.status}`);
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
