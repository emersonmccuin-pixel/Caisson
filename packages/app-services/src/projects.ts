import type {
  CreateProjectMode,
  CreateProjectRequest,
  ProjectChangedLiveEvent,
  ProjectChangedLivePayload,
  ProjectChangedRefetchEnvelope,
  ProjectDto,
  ProjectMutationReason,
  ReorderProjectsRequest,
  UpdateProjectRequest,
  ULID as ContractULID,
} from '@pc/contracts';
import { buildProjectChangedRefetchEnvelope } from '@pc/contracts';
import type { Project, ProjectSettings, Stage, ULID as DomainULID } from '@pc/domain';
import {
  createProjectInDb,
  getDb,
  getProjectById as defaultGetProjectById,
  insertLiveEvent,
  listProjects as defaultListProjects,
  listProjectsInDb,
  reorderProjects as defaultReorderProjects,
  reorderProjectsInDb,
  softDeleteProject as defaultSoftDeleteProject,
  softDeleteProjectInDb,
  updateProjectMeta as defaultUpdateProjectMeta,
  updateProjectMetaInDb,
  type CreateProjectInput,
  type DbExecutor,
  type InsertLiveEventDraft,
  type LiveOutboxEvent,
} from '@pc/db';

export interface ProjectRepositoryPort {
  listProjects(options?: { includeDeleted?: boolean }): Project[];
  getProjectById(projectId: ContractULID): Project | null;
  updateProjectMeta(
    projectId: ContractULID,
    input: { name?: string; gitRemote?: string | null; settings?: Partial<ProjectSettings> },
  ): Project | null;
  reorderProjects(orderedIds: ContractULID[]): void;
  softDeleteProject(projectId: ContractULID): Project | null;
}

export interface ProjectCreateFlowInput {
  name: string;
  folderPath: string;
  mode: CreateProjectMode;
  gitRemote?: string | null;
}

export interface ProjectChangedPublication {
  legacyEvent: ProjectChangedRefetchEnvelope;
  liveEvent: ProjectChangedLiveEvent;
}

export interface ProjectCreateFlowResult extends ProjectChangedPublication {
  project: Project;
}

export type ProjectCreateFlowPort = (input: ProjectCreateFlowInput) => Promise<ProjectCreateFlowResult>;

export type ProjectServiceResult<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; code: 'NOT_FOUND' | 'INTERNAL' };

export type ProjectMutationResult<T extends object> = ProjectServiceResult<
  T & ProjectChangedPublication
>;

const defaultRepo: ProjectRepositoryPort = {
  listProjects: defaultListProjects,
  getProjectById: (projectId) => defaultGetProjectById(projectId as DomainULID),
  updateProjectMeta: (projectId, input) => defaultUpdateProjectMeta(projectId as DomainULID, input),
  reorderProjects: (orderedIds) => defaultReorderProjects(orderedIds as DomainULID[]),
  softDeleteProject: (projectId) => defaultSoftDeleteProject(projectId as DomainULID),
};

export class ProjectService {
  constructor(private readonly repo: ProjectRepositoryPort = defaultRepo) {}

  listProjects(options: { includeDeleted?: boolean } = {}): { projects: ProjectDto[] } {
    return {
      projects: this.repo.listProjects(options).map(toProjectDto),
    };
  }

  getProject(projectId: ContractULID): ProjectServiceResult<{ project: ProjectDto }> {
    const project = this.repo.getProjectById(projectId);
    if (!project) return notFound(projectId);
    return { ok: true, project: toProjectDto(project) };
  }

  async createProject(
    request: CreateProjectRequest,
    createProject: ProjectCreateFlowPort,
  ): Promise<ProjectMutationResult<{ project: ProjectDto }>> {
    const created = await createProject({
      name: request.name,
      folderPath: request.folder_path,
      mode: request.mode,
      gitRemote: request.git_remote ?? null,
    });
    const project = toProjectDto(created.project);
    return {
      ok: true,
      project,
      legacyEvent: created.legacyEvent,
      liveEvent: created.liveEvent,
    };
  }

  updateProjectMeta(
    projectId: ContractULID,
    request: UpdateProjectRequest,
  ): ProjectMutationResult<{ project: ProjectDto }> {
    if (this.repo !== defaultRepo) {
      const updated = this.repo.updateProjectMeta(projectId, {
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.git_remote !== undefined ? { gitRemote: request.git_remote } : {}),
        ...(request.settings !== undefined ? { settings: request.settings } : {}),
      });
      if (!updated) return notFound(projectId);
      const project = toProjectDto(updated);
      const publication = projectChanged('metadata-updated', project);
      return { ok: true, project, ...publication };
    }

    return updateProjectMetaWithLiveEvent(projectId, request);
  }

  reorderProjects(
    request: ReorderProjectsRequest,
  ): ProjectMutationResult<{ projects: ProjectDto[] }> {
    if (this.repo !== defaultRepo) {
      this.repo.reorderProjects(request.orderedIds);
      const projects = this.repo.listProjects().map(toProjectDto);
      const publication = projectChanged('reordered');
      return { ok: true, projects, ...publication };
    }

    return reorderProjectsWithLiveEvent(request);
  }

  softDeleteProject(projectId: ContractULID): ProjectMutationResult<{ project: ProjectDto }> {
    if (this.repo !== defaultRepo) {
      const deleted = this.repo.softDeleteProject(projectId);
      if (!deleted) return notFound(projectId);
      const project = toProjectDto(deleted);
      const publication = projectChanged('soft-deleted', project);
      return { ok: true, project, ...publication };
    }

    return softDeleteProjectWithLiveEvent(projectId);
  }
}

export function persistCreatedProjectWithLiveEvent(
  input: CreateProjectInput,
): ProjectCreateFlowResult {
  return getDb().transaction((tx) => {
    const project = createProjectInDb(tx, input);
    const dto = toProjectDto(project);
    const publication = projectChanged('created', dto, tx);
    return { project, ...publication };
  });
}

export function updateProjectMetaWithLiveEvent(
  projectId: ContractULID,
  request: UpdateProjectRequest,
): ProjectMutationResult<{ project: ProjectDto }> {
  return getDb().transaction((tx) => {
    const updated = updateProjectMetaInDb(tx, projectId as DomainULID, {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.git_remote !== undefined ? { gitRemote: request.git_remote } : {}),
      ...(request.settings !== undefined ? { settings: request.settings } : {}),
    });
    if (!updated) return notFound(projectId);
    const project = toProjectDto(updated);
    return { ok: true, project, ...projectChanged('metadata-updated', project, tx) };
  });
}

export function reorderProjectsWithLiveEvent(
  request: ReorderProjectsRequest,
): ProjectMutationResult<{ projects: ProjectDto[] }> {
  return getDb().transaction((tx) => {
    reorderProjectsInDb(tx, request.orderedIds as DomainULID[]);
    const projects = listProjectsInDb(tx).map(toProjectDto);
    return { ok: true, projects, ...projectChanged('reordered', undefined, tx) };
  });
}

export function softDeleteProjectWithLiveEvent(
  projectId: ContractULID,
): ProjectMutationResult<{ project: ProjectDto }> {
  return getDb().transaction((tx) => {
    const deleted = softDeleteProjectInDb(tx, projectId as DomainULID);
    if (!deleted) return notFound(projectId);
    const project = toProjectDto(deleted);
    return { ok: true, project, ...projectChanged('soft-deleted', project, tx) };
  });
}

export function toProjectDto(project: Project): ProjectDto {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    stages: project.stages.map(toStageDto),
    folderPath: project.folderPath,
    gitRemote: project.gitRemote,
    settings: toProjectSettingsDto(project.settings),
    callsignSeq: project.callsignSeq ?? 0,
    notes: project.notes ?? null,
    focusedAt: project.focusedAt ?? null,
  };
}

function toStageDto(stage: Stage): ProjectDto['stages'][number] {
  return {
    id: stage.id,
    name: stage.name,
    order: stage.order,
    ...(stage.isDone !== undefined ? { isDone: stage.isDone } : {}),
    ...(stage.isCancelled !== undefined ? { isCancelled: stage.isCancelled } : {}),
    ...(stage.isNew !== undefined ? { isNew: stage.isNew } : {}),
    ...(stage.rev !== undefined ? { rev: stage.rev } : {}),
  };
}

function toProjectSettingsDto(settings: ProjectSettings): ProjectDto['settings'] {
  const cancelledVisibility = settings.cancelledVisibility;
  const remoteControl = settings.remoteControl;
  return {
    cancelledVisibility:
      cancelledVisibility === 'force-visible' ||
      cancelledVisibility === 'force-hidden' ||
      cancelledVisibility === 'use-global'
        ? cancelledVisibility
        : 'use-global',
    remoteControl:
      remoteControl === 'on' || remoteControl === 'off' || remoteControl === 'use-global'
        ? remoteControl
        : 'use-global',
  };
}

function projectChanged(
  reason: ProjectMutationReason,
  project?: ProjectDto,
  db: DbExecutor | null = null,
): ProjectChangedPublication {
  const payload = projectChangedPayload(reason, project);
  const legacyEvent = buildProjectChangedRefetchEnvelope(payload);
  const liveEvent = db
    ? toProjectChangedLiveEvent(insertLiveEvent(db, buildProjectChangedLiveEventDraft(payload)))
    : buildEphemeralProjectChangedLiveEvent(payload);
  return {
    legacyEvent,
    liveEvent,
  };
}

export function projectChangedPayload(
  reason: ProjectMutationReason,
  project?: ProjectDto,
): ProjectChangedLivePayload {
  return {
    reason,
    ...(project ? { projectIdChanged: project.id, project } : {}),
  };
}

export function buildProjectChangedLiveEventDraft(
  payload: ProjectChangedLivePayload,
): InsertLiveEventDraft<ProjectChangedLivePayload> {
  return {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    // Reorder frames carry no projectIdChanged → give them a stable synthetic id
    // so the store (which drops null-entityId frames) keeps them and the global
    // `project` signature advances on a reorder. ULIDs are never literal 'reorder'.
    entityId: (payload.projectIdChanged as DomainULID | undefined) ?? ('reorder' as DomainULID),
    version: null,
    payload,
  };
}

function toProjectChangedLiveEvent(
  event: LiveOutboxEvent<ProjectChangedLivePayload>,
): ProjectChangedLiveEvent {
  return {
    id: event.id,
    cursor: event.cursor,
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: event.entityId,
    version: null,
    createdAt: event.createdAt,
    payload: event.payload,
  };
}

function buildEphemeralProjectChangedLiveEvent(
  payload: ProjectChangedLivePayload,
): ProjectChangedLiveEvent {
  return {
    id: `ephemeral-${Date.now()}`,
    cursor: '0',
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    // Match buildProjectChangedLiveEventDraft: reorder frames get the synthetic
    // id so ephemeral (no-tx) and relayed (DB round-trip) frames agree.
    entityId: payload.projectIdChanged ?? ('reorder' as ContractULID),
    version: null,
    createdAt: Date.now(),
    payload,
  };
}

function notFound(projectId: ContractULID): ProjectServiceResult<never> {
  return { ok: false, error: `unknown project: ${projectId}`, code: 'NOT_FOUND' };
}
