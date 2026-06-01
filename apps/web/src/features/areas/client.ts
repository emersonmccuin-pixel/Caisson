// Slice 010 — Areas API client. Mirrors the workItemsApi fetch/error pattern.
// Areas are project-scoped buckets; a work item belongs to one Area or none.

import { getJson, postJson } from '@/api/http';
import type { ULID } from '@/features/projects/types';
import type { AreaDto } from '@pc/contracts';

export type Area = AreaDto;

export class AreaConflictError extends Error {
  current: Area;
  constructor(current: Area) {
    super('area version conflict');
    this.name = 'AreaConflictError';
    this.current = current;
  }
}

export const areasApi = {
  listAreas: (projectId: ULID) =>
    getJson<{ areas: Area[] }>(`/api/projects/${projectId}/areas`).then((r) => r.areas),

  createArea: (projectId: ULID, input: { name: string; summary?: string }) =>
    postJson<{ ok: true; area: Area }>(`/api/projects/${projectId}/areas`, input).then(
      (r) => r.area,
    ),

  patchArea: async (
    projectId: ULID,
    areaId: ULID,
    patch: { expectedVersion: number; name?: string; summary?: string },
  ): Promise<Area> => {
    const res = await fetch(`/api/projects/${projectId}/areas/${areaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = (await res.json()) as
      | { ok: true; area: Area }
      | { ok: false; error: string; current?: Area };
    if (res.status === 409 && data.ok === false && data.current) {
      throw new AreaConflictError(data.current);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `patch area → ${res.status}`);
    }
    return data.area;
  },

  reorderAreas: (projectId: ULID, orderedIds: ULID[]) =>
    postJson<{ ok: true; areas: Area[] }>(`/api/projects/${projectId}/areas/reorder`, {
      orderedIds,
    }).then((r) => r.areas),

  deleteArea: async (projectId: ULID, areaId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/areas/${areaId}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete area → ${res.status}`);
    }
  },
};
