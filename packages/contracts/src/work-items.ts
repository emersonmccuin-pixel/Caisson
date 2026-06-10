// Work-item contract family (slice 003). Browser-safe, zero runtime deps.
//
// Owns the shared `WorkItemDto`, request schemas, `WorkItemMutationResult`,
// and the canonical `work-item.changed` live-event payload contract plus
// parser/guards. Work-item events are PROJECT-scoped. Mirrors the helper
// trio (build*/is*/to*) in projects.ts.

import type { AttachmentDto } from './attachments.ts';
import { isAttachmentDto } from './attachments.ts';
import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
  type LiveEventFrame,
} from './live-events.ts';
import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

export const WORK_ITEM_TYPES = ['task', 'bug', 'feature', 'spike'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export type WorkItemStatus =
  | 'pending'
  | 'in-progress'
  | 'awaiting-verification'
  | 'blocked'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'archived';

export interface WorkItemDto {
  id: ULID;
  projectId: ULID;
  parentId: ULID | null;
  callsign: string | null;
  position: number;
  title: string;
  body: string;
  stageId: string;
  status: WorkItemStatus;
  statusReason: string | null;
  type: WorkItemType;
  fields: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** Section 19 — true when this row is a v2 workflow run's root. */
  isWorkflowRoot: boolean;
  /** Slice 010 — Area bucket FK, or null for Uncaptured. */
  areaId: ULID | null;
  /** Command focus — epoch-ms the planner starred this item; null = not in focus. */
  focusedAt: number | null;
}

/** Reasons a work item changed durably. `verified`/`approved`/`rejected`/
 *  `auto-advanced` close the previously-missing event gap on the agent
 *  verification + auto-advance paths. */
export type WorkItemMutationReason =
  | 'created'
  | 'patched'
  | 'moved'
  | 'soft-deleted'
  | 'restored'
  | 'verified'
  | 'approved'
  | 'rejected'
  | 'auto-advanced';

export interface WorkItemChangedLivePayload {
  reason: WorkItemMutationReason;
  workItem?: WorkItemDto;
  attachments?: AttachmentDto[];
}

/** Legacy compatibility projection broadcast under the websocket name
 *  `work-item-changed` (full-snapshot). */
export interface WorkItemChangedRefetchEnvelope {
  type: 'work-item-changed';
  projectId: ULID;
  workItem: WorkItemDto;
}

export type WorkItemChangedLiveEvent = LiveEvent<WorkItemChangedLivePayload> & {
  type: 'work-item.changed';
  entity: 'work-item';
  scope: 'project';
  projectId: ULID;
};

export type WorkItemChangedLiveEventFrame = LiveEventFrame<WorkItemChangedLivePayload> & {
  event: WorkItemChangedLiveEvent;
};

export interface WorkItemMutationResult {
  workItem: WorkItemDto;
  attachments?: AttachmentDto[];
  version: number;
  /** Canonical live-event id(s) emitted for this mutation. */
  eventIds: ULID[];
}

// ── Request schemas ─────────────────────────────────────────────────────────

export interface CreateWorkItemRequest {
  stageId: string;
  title: string;
  body?: string;
  parentId?: ULID | null;
  position?: number;
  type?: WorkItemType;
  fields?: Record<string, unknown>;
  /** Slice 010 — Area bucket FK, or null for Uncaptured. */
  areaId?: ULID | null;
}

export interface PatchWorkItemRequest {
  expectedVersion: number;
  title?: string;
  body?: string;
  stageId?: string;
  parentId?: ULID | null;
  position?: number;
  type?: WorkItemType;
  fields?: Record<string, unknown>;
  /** Slice 010 — Area bucket FK, or null for Uncaptured. */
  areaId?: ULID | null;
}

export interface MoveWorkItemRequest {
  expectedVersion: number;
  stageId: string;
  position?: number;
}

export interface SoftDeleteWorkItemRequest {
  workItemId: ULID;
}

export interface RestoreWorkItemRequest {
  workItemId: ULID;
}

export const workItemRoutes = {
  list: (projectId: ULID) => `/api/projects/${encodeURIComponent(projectId)}/work-items`,
  create: (projectId: ULID) => `/api/projects/${encodeURIComponent(projectId)}/work-items`,
} as const;

export function isWorkItemType(value: unknown): value is WorkItemType {
  return typeof value === 'string' && (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return (
    value === 'pending' ||
    value === 'in-progress' ||
    value === 'awaiting-verification' ||
    value === 'blocked' ||
    value === 'complete' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'archived'
  );
}

export function isWorkItemDto(value: unknown): value is WorkItemDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    (value.parentId === null || typeof value.parentId === 'string') &&
    (value.callsign === null || typeof value.callsign === 'string') &&
    typeof value.position === 'number' &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    typeof value.stageId === 'string' &&
    isWorkItemStatus(value.status) &&
    (value.statusReason === null || typeof value.statusReason === 'string') &&
    isWorkItemType(value.type) &&
    isRecord(value.fields) &&
    typeof value.version === 'number' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    (value.deletedAt === null || typeof value.deletedAt === 'number') &&
    typeof value.isWorkflowRoot === 'boolean' &&
    (value.areaId === null || typeof value.areaId === 'string') &&
    (value.focusedAt === null || typeof value.focusedAt === 'number')
  );
}

export function parseCreateWorkItemRequest(input: unknown): ParseResult<CreateWorkItemRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const stageId = typeof input.stageId === 'string' ? input.stageId.trim() : '';
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!stageId) return parseErr('stageId required');
  if (!title) return parseErr('title required');
  const request: CreateWorkItemRequest = { stageId, title };
  if (typeof input.body === 'string') request.body = input.body;
  if (input.parentId !== undefined) {
    request.parentId = input.parentId === null ? null : String(input.parentId);
  }
  if (input.areaId !== undefined) {
    request.areaId = input.areaId === null ? null : String(input.areaId);
  }
  if (typeof input.position === 'number') request.position = input.position;
  if (input.type !== undefined) {
    if (!isWorkItemType(input.type)) return parseErr('invalid work item type');
    request.type = input.type;
  }
  if (input.fields !== undefined) {
    if (!isRecord(input.fields)) return parseErr('fields must be an object');
    request.fields = { ...input.fields };
  }
  return parseOk(request);
}

export function parsePatchWorkItemRequest(input: unknown): ParseResult<PatchWorkItemRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  if (typeof input.expectedVersion !== 'number') return parseErr('expectedVersion required');
  const request: PatchWorkItemRequest = { expectedVersion: input.expectedVersion };
  if (typeof input.title === 'string') request.title = input.title;
  if (typeof input.body === 'string') request.body = input.body;
  if (typeof input.stageId === 'string') request.stageId = input.stageId;
  if (input.parentId !== undefined) {
    request.parentId = input.parentId === null ? null : String(input.parentId);
  }
  if (input.areaId !== undefined) {
    request.areaId = input.areaId === null ? null : String(input.areaId);
  }
  if (typeof input.position === 'number') request.position = input.position;
  if (input.type !== undefined) {
    if (!isWorkItemType(input.type)) return parseErr('invalid work item type');
    request.type = input.type;
  }
  if (input.fields !== undefined) {
    if (!isRecord(input.fields)) return parseErr('fields must be an object');
    request.fields = { ...input.fields };
  }
  return parseOk(request);
}

export function parseMoveWorkItemRequest(input: unknown): ParseResult<MoveWorkItemRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  if (typeof input.expectedVersion !== 'number') return parseErr('expectedVersion required');
  const stageId = typeof input.stageId === 'string' ? input.stageId.trim() : '';
  if (!stageId) return parseErr('stageId required');
  const request: MoveWorkItemRequest = { expectedVersion: input.expectedVersion, stageId };
  if (typeof input.position === 'number') request.position = input.position;
  return parseOk(request);
}

// ── Live-event helpers ──────────────────────────────────────────────────────

export function isWorkItemMutationReason(value: unknown): value is WorkItemMutationReason {
  return (
    value === 'created' ||
    value === 'patched' ||
    value === 'moved' ||
    value === 'soft-deleted' ||
    value === 'restored' ||
    value === 'verified' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'auto-advanced'
  );
}

export function isWorkItemChangedLivePayload(
  value: unknown,
): value is WorkItemChangedLivePayload {
  if (!isRecord(value) || !isWorkItemMutationReason(value.reason)) return false;
  if (value.workItem !== undefined && !isWorkItemDto(value.workItem)) return false;
  if (
    value.attachments !== undefined &&
    !(Array.isArray(value.attachments) && value.attachments.every(isAttachmentDto))
  ) {
    return false;
  }
  return true;
}

export function isWorkItemChangedLiveEvent(value: unknown): value is WorkItemChangedLiveEvent {
  return (
    isLiveEvent(value) &&
    value.type === 'work-item.changed' &&
    value.entity === 'work-item' &&
    value.scope === 'project' &&
    typeof value.projectId === 'string' &&
    isWorkItemChangedLivePayload(value.payload)
  );
}

export function isWorkItemChangedLiveEventFrame(
  value: unknown,
): value is WorkItemChangedLiveEventFrame {
  return isLiveEventFrame(value) && isWorkItemChangedLiveEvent(value.event);
}

export function buildWorkItemChangedRefetchEnvelope(input: {
  projectId: ULID;
  workItem: WorkItemDto;
}): WorkItemChangedRefetchEnvelope {
  return { type: 'work-item-changed', projectId: input.projectId, workItem: input.workItem };
}

/** Build the legacy `work-item-changed` envelope from a canonical event.
 *  Returns null when the canonical payload carries no work-item snapshot
 *  (the legacy channel is full-snapshot only). */
export function toWorkItemChangedRefetchEnvelope(
  event: WorkItemChangedLiveEvent,
): WorkItemChangedRefetchEnvelope | null {
  if (!event.payload.workItem) return null;
  return buildWorkItemChangedRefetchEnvelope({
    projectId: event.projectId,
    workItem: event.payload.workItem,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
