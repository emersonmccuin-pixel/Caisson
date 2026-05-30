// Attachment contract family (slice 003). Browser-safe, zero runtime deps.
//
// Attachments store inline content with provenance, bound to a work item.
// This slice defines the DTO + request schemas + the canonical
// `attachment.changed` payload contract. Storage stays inline in SQLite.

import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
} from './live-events.ts';
import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

export type AttachmentSource = 'agent' | 'user';

export interface AttachmentDto {
  id: ULID;
  workItemId: ULID;
  kind: string;
  name: string;
  content: string;
  contentType: string | null;
  runId: ULID | null;
  createdBySessionId: ULID | null;
  source: AttachmentSource;
  agentName: string | null;
  nodeId: string | null;
  createdAt: number;
}

export interface CreateAttachmentRequest {
  workItemId: ULID;
  kind: string;
  name: string;
  content: string;
  contentType?: string | null;
  runId?: ULID | null;
  createdBySessionId?: ULID | null;
  source?: AttachmentSource;
  agentName?: string | null;
  nodeId?: string | null;
}

export interface DeleteAttachmentRequest {
  attachmentId: ULID;
}

export type AttachmentChangedReason = 'created' | 'deleted';

export interface AttachmentChangedLivePayload {
  reason: AttachmentChangedReason;
  workItemId: ULID;
  attachment?: AttachmentDto;
}

export interface AttachmentChangedRefetchEnvelope {
  type: 'attachment-changed';
  projectId: ULID;
  workItemId: ULID;
  reason: AttachmentChangedReason;
  attachmentId: ULID;
}

export type AttachmentChangedLiveEvent = LiveEvent<AttachmentChangedLivePayload> & {
  type: 'attachment.changed';
  entity: 'attachment';
  scope: 'project';
  projectId: ULID;
};

export function isAttachmentSource(value: unknown): value is AttachmentSource {
  return value === 'agent' || value === 'user';
}

export function isAttachmentDto(value: unknown): value is AttachmentDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.workItemId === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.name === 'string' &&
    typeof value.content === 'string' &&
    (value.contentType === null || typeof value.contentType === 'string') &&
    (value.runId === null || typeof value.runId === 'string') &&
    (value.createdBySessionId === null || typeof value.createdBySessionId === 'string') &&
    isAttachmentSource(value.source) &&
    (value.agentName === null || typeof value.agentName === 'string') &&
    (value.nodeId === null || typeof value.nodeId === 'string') &&
    typeof value.createdAt === 'number'
  );
}

export function parseCreateAttachmentRequest(
  input: unknown,
): ParseResult<CreateAttachmentRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  if (typeof input.workItemId !== 'string' || !input.workItemId) {
    return parseErr('workItemId required');
  }
  if (typeof input.name !== 'string' || !input.name.trim()) return parseErr('name required');
  if (typeof input.content !== 'string') return parseErr('content required');
  const kind = typeof input.kind === 'string' && input.kind ? input.kind : 'text';
  const request: CreateAttachmentRequest = {
    workItemId: input.workItemId,
    kind,
    name: input.name,
    content: input.content,
  };
  if (input.contentType !== undefined) {
    request.contentType = input.contentType === null ? null : String(input.contentType);
  }
  if (input.runId !== undefined) request.runId = input.runId === null ? null : String(input.runId);
  if (input.createdBySessionId !== undefined) {
    request.createdBySessionId =
      input.createdBySessionId === null ? null : String(input.createdBySessionId);
  }
  if (input.source !== undefined) {
    if (!isAttachmentSource(input.source)) return parseErr('source must be agent or user');
    request.source = input.source;
  }
  if (input.agentName !== undefined) {
    request.agentName = input.agentName === null ? null : String(input.agentName);
  }
  if (input.nodeId !== undefined) {
    request.nodeId = input.nodeId === null ? null : String(input.nodeId);
  }
  return parseOk(request);
}

export function buildAttachmentChangedRefetchEnvelope(input: {
  projectId: ULID;
  workItemId: ULID;
  reason: AttachmentChangedReason;
  attachmentId: ULID;
}): AttachmentChangedRefetchEnvelope {
  return {
    type: 'attachment-changed',
    projectId: input.projectId,
    workItemId: input.workItemId,
    reason: input.reason,
    attachmentId: input.attachmentId,
  };
}

export function isAttachmentChangedLivePayload(
  value: unknown,
): value is AttachmentChangedLivePayload {
  if (!isRecord(value)) return false;
  if (value.reason !== 'created' && value.reason !== 'deleted') return false;
  if (typeof value.workItemId !== 'string') return false;
  if (value.attachment !== undefined && !isAttachmentDto(value.attachment)) return false;
  return true;
}

export function isAttachmentChangedLiveEvent(value: unknown): value is AttachmentChangedLiveEvent {
  return (
    isLiveEvent(value) &&
    value.type === 'attachment.changed' &&
    value.entity === 'attachment' &&
    value.scope === 'project' &&
    typeof value.projectId === 'string' &&
    isAttachmentChangedLivePayload(value.payload)
  );
}

export function isAttachmentChangedLiveEventFrame(value: unknown): boolean {
  return isLiveEventFrame(value) && isAttachmentChangedLiveEvent(value.event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
