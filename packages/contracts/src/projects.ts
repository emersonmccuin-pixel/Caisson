import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
  type LiveEventFrame,
} from './live-events.ts';
import { parseErr, parseOk, type ApiResult, type ParseResult, type ULID } from './shared.ts';

export type { ApiResult, ParseResult, ULID } from './shared.ts';

export interface ProjectStageDto {
  id: string;
  name: string;
  order: number;
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
  rev?: number;
}

export interface ProjectSettingsDto {
  cancelledVisibility: 'use-global' | 'force-visible' | 'force-hidden';
}

export interface ProjectDto {
  id: ULID;
  slug: string;
  name: string;
  stages: ProjectStageDto[];
  folderPath: string;
  gitRemote: string | null;
  settings: ProjectSettingsDto;
  callsignSeq: number;
}

export type CreateProjectMode = 'init-empty' | 'init-in-place' | 'attach-to-git';

export interface ListProjectsQuery {
  include_deleted?: '1';
}

export type ListProjectsResponse = { projects: ProjectDto[] };

export interface CreateProjectRequest {
  name: string;
  folder_path: string;
  mode: CreateProjectMode;
  git_remote?: string | null;
}

export type CreateProjectResponse = ApiResult<{ project: ProjectDto }>;

export interface UpdateProjectRequest {
  name?: string;
  git_remote?: string | null;
}

export type UpdateProjectResponse = ApiResult<{ project: ProjectDto }>;

export interface ReorderProjectsRequest {
  orderedIds: ULID[];
}

export type ReorderProjectsResponse = ApiResult<{ projects: ProjectDto[] }>;

export type DeleteProjectResponse = ApiResult<{ project: ProjectDto }>;

export const projectRoutes = {
  list: '/api/projects',
  create: '/api/projects',
  reorder: '/api/projects/reorder',
  detail: (projectId: ULID) => `/api/projects/${encodeURIComponent(projectId)}`,
} as const;

export type ProjectMutationReason =
  | 'created'
  | 'metadata-updated'
  | 'reordered'
  | 'soft-deleted';

export interface ProjectChangedRefetchEnvelope {
  type: 'project.changed';
  scope: 'global';
  projectId: null;
  reason: ProjectMutationReason;
  projectIdChanged?: ULID;
  project?: ProjectDto;
}

export interface ProjectChangedLivePayload {
  reason: ProjectMutationReason;
  projectIdChanged?: ULID;
  project?: ProjectDto;
}

export type ProjectChangedLiveEvent = LiveEvent<ProjectChangedLivePayload> & {
  type: 'project.changed';
  entity: 'project';
  scope: 'global';
  projectId: null;
  version: null;
};

export type ProjectChangedLiveEventFrame = LiveEventFrame<ProjectChangedLivePayload> & {
  event: ProjectChangedLiveEvent;
};

export function parseCreateProjectRequest(input: unknown): ParseResult<CreateProjectRequest> {
  if (!isRecord(input)) return invalidCreateRequest();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const folderPath = typeof input.folder_path === 'string' ? input.folder_path.trim() : '';
  const mode = input.mode;
  if (!name || !folderPath || !isCreateProjectMode(mode)) return invalidCreateRequest();
  const request: CreateProjectRequest = {
    name,
    folder_path: folderPath,
    mode,
  };
  if (input.git_remote !== undefined) {
    const gitRemote = parseOptionalGitRemote(input.git_remote);
    if (!gitRemote.ok) return gitRemote;
    request.git_remote = gitRemote.value;
  }
  return parseOk(request);
}

export function parseUpdateProjectRequest(input: unknown): ParseResult<UpdateProjectRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const request: UpdateProjectRequest = {};
  if (typeof input.name === 'string') {
    const name = input.name.trim();
    if (!name) return parseErr('name cannot be empty');
    request.name = name;
  }
  if (input.git_remote !== undefined) {
    const gitRemote = parseOptionalGitRemote(input.git_remote);
    if (!gitRemote.ok) return gitRemote;
    request.git_remote = gitRemote.value;
  }
  return parseOk(request);
}

export function parseReorderProjectsRequest(input: unknown): ParseResult<ReorderProjectsRequest> {
  if (!isRecord(input) || !Array.isArray(input.orderedIds) || !input.orderedIds.every(isString)) {
    return parseErr('orderedIds must be an array of strings');
  }
  return parseOk({ orderedIds: [...input.orderedIds] });
}

export function parseListProjectsQuery(input: unknown): ListProjectsQuery {
  if (!isRecord(input)) return {};
  return input.include_deleted === '1' ? { include_deleted: '1' } : {};
}

export function isCreateProjectMode(value: unknown): value is CreateProjectMode {
  return value === 'init-empty' || value === 'init-in-place' || value === 'attach-to-git';
}

export function isProjectStageDto(value: unknown): value is ProjectStageDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.order === 'number' &&
    isOptionalBoolean(value.isDone) &&
    isOptionalBoolean(value.isCancelled) &&
    isOptionalBoolean(value.isNew) &&
    (value.rev === undefined || typeof value.rev === 'number')
  );
}

export function isProjectSettingsDto(value: unknown): value is ProjectSettingsDto {
  if (!isRecord(value)) return false;
  return (
    value.cancelledVisibility === 'use-global' ||
    value.cancelledVisibility === 'force-visible' ||
    value.cancelledVisibility === 'force-hidden'
  );
}

export function isProjectDto(value: unknown): value is ProjectDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.slug === 'string' &&
    typeof value.name === 'string' &&
    Array.isArray(value.stages) &&
    value.stages.every(isProjectStageDto) &&
    typeof value.folderPath === 'string' &&
    (value.gitRemote === null || typeof value.gitRemote === 'string') &&
    isProjectSettingsDto(value.settings) &&
    typeof value.callsignSeq === 'number'
  );
}

export function buildProjectChangedRefetchEnvelope(input: {
  reason: ProjectMutationReason;
  projectIdChanged?: ULID;
  project?: ProjectDto;
}): ProjectChangedRefetchEnvelope {
  const out: ProjectChangedRefetchEnvelope = {
    type: 'project.changed',
    scope: 'global',
    projectId: null,
    reason: input.reason,
  };
  if (input.projectIdChanged !== undefined) out.projectIdChanged = input.projectIdChanged;
  if (input.project !== undefined) out.project = input.project;
  return out;
}

export function isProjectChangedRefetchEnvelope(
  value: unknown,
): value is ProjectChangedRefetchEnvelope {
  if (!isRecord(value)) return false;
  if (
    value.type !== 'project.changed' ||
    value.scope !== 'global' ||
    value.projectId !== null ||
    !isProjectMutationReason(value.reason)
  ) {
    return false;
  }
  if (value.projectIdChanged !== undefined && typeof value.projectIdChanged !== 'string') {
    return false;
  }
  if (value.project !== undefined && !isProjectDto(value.project)) return false;
  return true;
}

export function isProjectChangedLivePayload(
  value: unknown,
): value is ProjectChangedLivePayload {
  if (!isRecord(value) || !isProjectMutationReason(value.reason)) return false;
  if (value.projectIdChanged !== undefined && typeof value.projectIdChanged !== 'string') {
    return false;
  }
  if (value.project !== undefined && !isProjectDto(value.project)) return false;
  return true;
}

export function isProjectChangedLiveEvent(value: unknown): value is ProjectChangedLiveEvent {
  return (
    isLiveEvent(value) &&
    value.type === 'project.changed' &&
    value.entity === 'project' &&
    value.scope === 'global' &&
    value.projectId === null &&
    value.version === null &&
    isProjectChangedLivePayload(value.payload)
  );
}

export function isProjectChangedLiveEventFrame(
  value: unknown,
): value is ProjectChangedLiveEventFrame {
  return isLiveEventFrame(value) && isProjectChangedLiveEvent(value.event);
}

export function toProjectChangedRefetchEnvelope(
  event: ProjectChangedLiveEvent,
): ProjectChangedRefetchEnvelope {
  return buildProjectChangedRefetchEnvelope(event.payload);
}

function invalidCreateRequest(): ParseResult<never> {
  return parseErr('name, folder_path, and mode required');
}

function parseOptionalGitRemote(value: unknown): ParseResult<string | null> {
  if (value === null || value === undefined) return parseOk(null);
  return parseOk(String(value).trim() || null);
}

function isProjectMutationReason(value: unknown): value is ProjectMutationReason {
  return (
    value === 'created' ||
    value === 'metadata-updated' ||
    value === 'reordered' ||
    value === 'soft-deleted'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}
