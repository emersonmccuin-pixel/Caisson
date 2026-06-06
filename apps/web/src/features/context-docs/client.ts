// Slice 2 — context-doc API client. Thin wrappers over the Slice-1 HTTP routes.
// Used by the area detail page to list/add/edit area-scoped context docs.

import { getJson, postJson } from '@/api/http';
import type { ULID } from '@/features/projects/types';

export interface ContextDoc {
  id: ULID;
  projectId: ULID | null;
  areaId: ULID | null;
  workItemId: ULID | null;
  title: string;
  body: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type ContextDocScope = 'project' | 'area' | 'work-item';

export const contextDocsApi = {
  /** List docs directly attached to one scope (no chain walk). */
  list: (
    projectId: ULID,
    scope: ContextDocScope,
    scopeId?: ULID,
  ): Promise<ContextDoc[]> => {
    const params = new URLSearchParams({ scope });
    if (scopeId) params.set('scopeId', scopeId);
    return getJson<{ ok: true; docs: ContextDoc[] }>(
      `/api/projects/${projectId}/context-docs?${params.toString()}`,
    ).then((r) => r.docs);
  },

  get: (projectId: ULID, docId: ULID): Promise<ContextDoc> =>
    getJson<{ ok: true; doc: ContextDoc }>(
      `/api/projects/${projectId}/context-docs/${docId}`,
    ).then((r) => r.doc),

  create: (
    projectId: ULID,
    input: { scope: ContextDocScope; scopeId?: ULID; title: string; body?: string },
  ): Promise<ContextDoc> =>
    postJson<{ ok: true; doc: ContextDoc }>(
      `/api/projects/${projectId}/context-docs`,
      input,
    ).then((r) => r.doc),

  update: async (
    projectId: ULID,
    docId: ULID,
    patch: { title?: string; body?: string },
  ): Promise<ContextDoc> => {
    const res = await fetch(`/api/projects/${projectId}/context-docs/${docId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = (await res.json()) as { ok: true; doc: ContextDoc } | { ok: false; error: string };
    if (!res.ok || !data.ok) {
      throw new Error(data.ok === false ? data.error : `update context doc → ${res.status}`);
    }
    return data.doc;
  },
};
