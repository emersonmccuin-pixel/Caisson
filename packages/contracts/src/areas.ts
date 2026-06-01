// Area contract family (slice 010). Browser-safe, zero runtime deps.
//
// Owns the shared `AreaDto`, request schemas, and the canonical
// `area.changed` live-event payload contract plus parser/guards. Area events
// are PROJECT-scoped. Mirrors the helper trio (is*/parse*) in work-items.ts.
//
// An Area is a first-class, project-scoped bucket. A work item belongs to
// exactly one Area or to none ("Uncaptured"). Per-project, manual `sortOrder`,
// plain editable `summary`.

import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
  type LiveEventFrame,
} from './live-events.ts';
import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

export interface AreaDto {
  id: ULID;
  projectId: ULID;
  name: string;
  summary: string;
  sortOrder: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

// ── Request schemas ─────────────────────────────────────────────────────────

export interface CreateAreaRequest {
  name: string;
  summary?: string;
}

export interface PatchAreaRequest {
  expectedVersion: number;
  name?: string;
  summary?: string;
}

export interface ReorderAreasRequest {
  orderedIds: ULID[];
}

export const areaRoutes = {
  list: (projectId: ULID) => `/api/projects/${encodeURIComponent(projectId)}/areas`,
} as const;

// ── Live-event contract ──────────────────────────────────────────────────────

export type AreaMutationReason = 'created' | 'patched' | 'reordered' | 'deleted';

export interface AreaChangedLivePayload {
  reason: AreaMutationReason;
  /** Single-area mutations carry `area`. */
  area?: AreaDto;
  /** reorder / list-shaped mutations carry `areas`. */
  areas?: AreaDto[];
}

export type AreaChangedLiveEvent = LiveEvent<AreaChangedLivePayload> & {
  type: 'area.changed';
  entity: 'area';
  scope: 'project';
  projectId: ULID;
};

export type AreaChangedLiveEventFrame = LiveEventFrame<AreaChangedLivePayload> & {
  event: AreaChangedLiveEvent;
};

// ── Guards ────────────────────────────────────────────────────────────────────

export function isAreaDto(value: unknown): value is AreaDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.sortOrder === 'number' &&
    typeof value.version === 'number' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    (value.deletedAt === null || typeof value.deletedAt === 'number')
  );
}

export function isAreaMutationReason(value: unknown): value is AreaMutationReason {
  return (
    value === 'created' ||
    value === 'patched' ||
    value === 'reordered' ||
    value === 'deleted'
  );
}

export function isAreaChangedLivePayload(value: unknown): value is AreaChangedLivePayload {
  if (!isRecord(value) || !isAreaMutationReason(value.reason)) return false;
  if (value.area !== undefined && !isAreaDto(value.area)) return false;
  if (
    value.areas !== undefined &&
    !(Array.isArray(value.areas) && value.areas.every(isAreaDto))
  ) {
    return false;
  }
  return true;
}

export function isAreaChangedLiveEvent(value: unknown): value is AreaChangedLiveEvent {
  return (
    isLiveEvent(value) &&
    value.type === 'area.changed' &&
    value.entity === 'area' &&
    value.scope === 'project' &&
    typeof value.projectId === 'string' &&
    isAreaChangedLivePayload(value.payload)
  );
}

export function isAreaChangedLiveEventFrame(value: unknown): value is AreaChangedLiveEventFrame {
  return isLiveEventFrame(value) && isAreaChangedLiveEvent(value.event);
}

// ── Parsers ────────────────────────────────────────────────────────────────────

export function parseCreateAreaRequest(input: unknown): ParseResult<CreateAreaRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return parseErr('name required');
  const request: CreateAreaRequest = { name };
  if (typeof input.summary === 'string') request.summary = input.summary;
  return parseOk(request);
}

export function parsePatchAreaRequest(input: unknown): ParseResult<PatchAreaRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  if (typeof input.expectedVersion !== 'number') return parseErr('expectedVersion required');
  const request: PatchAreaRequest = { expectedVersion: input.expectedVersion };
  if (typeof input.name === 'string') {
    const name = input.name.trim();
    if (!name) return parseErr('name must be non-empty');
    request.name = name;
  }
  if (typeof input.summary === 'string') request.summary = input.summary;
  if (request.name === undefined && request.summary === undefined) {
    return parseErr('at least one of name or summary required');
  }
  return parseOk(request);
}

export function parseReorderAreasRequest(input: unknown): ParseResult<ReorderAreasRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  if (!Array.isArray(input.orderedIds)) return parseErr('orderedIds array required');
  if (!input.orderedIds.every((id) => typeof id === 'string' && id.length > 0)) {
    return parseErr('orderedIds must be non-empty strings');
  }
  return parseOk({ orderedIds: [...(input.orderedIds as ULID[])] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
