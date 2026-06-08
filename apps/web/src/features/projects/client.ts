import { getJson, postJson, postJsonMethod } from '@/api/http';
import {
  projectRoutes,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type DeleteProjectResponse,
  type ListProjectsResponse,
  type ProjectDto,
  type ReorderProjectsResponse,
  type ULID,
  type UpdateProjectRequest,
  type UpdateProjectResponse,
} from '@pc/contracts';

export * from './types';

export const projectsApi = {
  listProjects: () =>
    getJson<ListProjectsResponse>(projectRoutes.list).then((r) => r.projects),

  createProject: (input: CreateProjectRequest) =>
    postJson<CreateProjectResponse>(projectRoutes.create, input).then(
      (r) => {
        if (!r.ok) throw new Error(r.error);
        return r.project;
      },
    ),

  project: (projectId: ULID) => getJson<ProjectDto>(projectRoutes.detail(projectId)),

  updateProject: (projectId: ULID, patch: UpdateProjectRequest) =>
    postJsonMethod<UpdateProjectResponse>(
      projectRoutes.detail(projectId),
      patch,
      'PATCH',
    ).then((r) => {
      if (!r.ok) throw new Error(r.error);
      return r.project;
    }),

  softDeleteProject: async (projectId: ULID): Promise<void> => {
    const res = await fetch(projectRoutes.detail(projectId), { method: 'DELETE' });
    const data = (await res.json()) as DeleteProjectResponse;
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `delete → ${res.status}`);
    }
  },

  deleteProjectFiles: async (projectId: ULID): Promise<string[]> => {
    const res = await fetch(`/api/projects/${projectId}/files`, { method: 'DELETE' });
    const data = (await res.json()) as { ok?: boolean; error?: string; removed?: string[] };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete files → ${res.status}`);
    }
    return data.removed ?? [];
  },

  revealProject: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/reveal`, { method: 'POST' });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `reveal → ${res.status}`);
    }
  },

  reorderProjects: (orderedIds: ULID[]) =>
    postJsonMethod<ReorderProjectsResponse>(
      projectRoutes.reorder,
      { orderedIds },
      'PATCH',
    ).then((r) => {
      if (!r.ok) throw new Error(r.error);
      return r.projects;
    }),

  updateProjectNotes: (projectId: ULID, text: string) =>
    postJsonMethod<{ ok: true; notes: string | null } | { ok: false; error: string }>(
      projectRoutes.notes(projectId),
      { text },
      'PATCH',
    ).then((r) => {
      if (!r.ok) throw new Error((r as { ok: false; error: string }).error);
      return (r as { ok: true; notes: string | null }).notes;
    }),
};
