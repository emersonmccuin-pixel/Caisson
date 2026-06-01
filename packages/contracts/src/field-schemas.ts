// Field-schema contract family (slice 003). Browser-safe, zero runtime deps.
//
// Per-project field schemas define the typed editors and validation for
// work-item `fields`. This module owns the shared `FieldSchemaDto`, the
// replace request, and the canonical `field-schema.list.changed` payload
// contract. Emission of the event may be staged, but the contract ships here.

import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
} from './live-events.ts';
import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

export type FieldSchemaType = 'text' | 'number' | 'boolean' | 'enum' | 'date';

export interface FieldSchemaDto {
  id: ULID;
  projectId: ULID;
  key: string;
  label: string;
  type: FieldSchemaType;
  options?: string[];
  default?: unknown;
  required: boolean;
  description?: string;
  order: number;
}

/** One item in a field-schema replace request. `id` is optional so callers
 *  can keep stable ids across edits or let the server mint one. */
export interface FieldSchemaInput {
  id?: ULID;
  key: string;
  label: string;
  type: FieldSchemaType;
  options?: string[];
  default?: unknown;
  required: boolean;
  description?: string;
  order?: number;
}

export interface ReplaceFieldSchemasRequest {
  items: FieldSchemaInput[];
}

export interface FieldSchemaListChangedLivePayload {
  schemas: FieldSchemaDto[];
  reason: 'replaced';
}

export interface FieldSchemasChangedRefetchEnvelope {
  type: 'field-schemas-changed';
  projectId: ULID;
  schemas: FieldSchemaDto[];
}

export type FieldSchemaListChangedLiveEvent = LiveEvent<FieldSchemaListChangedLivePayload> & {
  type: 'field-schema.list.changed';
  entity: 'field-schema';
  scope: 'project';
  projectId: ULID;
  // Q1-A (T3.2b): keyed by projectId (per-project singleton list) so the frame
  // enters the identity-keyed live store.
  entityId: ULID;
};

export function isFieldSchemaType(value: unknown): value is FieldSchemaType {
  return (
    value === 'text' ||
    value === 'number' ||
    value === 'boolean' ||
    value === 'enum' ||
    value === 'date'
  );
}

export function isFieldSchemaDto(value: unknown): value is FieldSchemaDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.key === 'string' &&
    typeof value.label === 'string' &&
    isFieldSchemaType(value.type) &&
    (value.options === undefined ||
      (Array.isArray(value.options) && value.options.every((o) => typeof o === 'string'))) &&
    typeof value.required === 'boolean' &&
    (value.description === undefined || typeof value.description === 'string') &&
    typeof value.order === 'number'
  );
}

export function parseReplaceFieldSchemasRequest(
  input: unknown,
): ParseResult<ReplaceFieldSchemasRequest> {
  if (!isRecord(input) || !Array.isArray(input.items)) {
    return parseErr('items must be an array');
  }
  const items: FieldSchemaInput[] = [];
  for (const raw of input.items) {
    if (!isRecord(raw)) return parseErr('each field schema item must be an object');
    if (typeof raw.key !== 'string' || !raw.key.trim()) return parseErr('field schema key required');
    if (typeof raw.label !== 'string' || !raw.label.trim()) {
      return parseErr('field schema label required');
    }
    if (!isFieldSchemaType(raw.type)) return parseErr(`invalid field schema type for ${raw.key}`);
    if (typeof raw.required !== 'boolean') return parseErr(`required flag missing for ${raw.key}`);
    if (
      raw.options !== undefined &&
      !(Array.isArray(raw.options) && raw.options.every((o) => typeof o === 'string'))
    ) {
      return parseErr(`options must be a string array for ${raw.key}`);
    }
    const item: FieldSchemaInput = {
      key: raw.key,
      label: raw.label,
      type: raw.type,
      required: raw.required,
    };
    if (typeof raw.id === 'string') item.id = raw.id;
    if (raw.options !== undefined) item.options = [...(raw.options as string[])];
    if (raw.default !== undefined) item.default = raw.default;
    if (typeof raw.description === 'string') item.description = raw.description;
    if (typeof raw.order === 'number') item.order = raw.order;
    items.push(item);
  }
  return parseOk({ items });
}

export function isFieldSchemaListChangedLivePayload(
  value: unknown,
): value is FieldSchemaListChangedLivePayload {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.schemas) &&
    value.schemas.every(isFieldSchemaDto) &&
    value.reason === 'replaced'
  );
}

export function isFieldSchemaListChangedLiveEvent(
  value: unknown,
): value is FieldSchemaListChangedLiveEvent {
  return (
    isLiveEvent(value) &&
    value.type === 'field-schema.list.changed' &&
    value.entity === 'field-schema' &&
    value.scope === 'project' &&
    typeof value.projectId === 'string' &&
    typeof value.entityId === 'string' &&
    isFieldSchemaListChangedLivePayload(value.payload)
  );
}

export function buildFieldSchemasChangedRefetchEnvelope(input: {
  projectId: ULID;
  schemas: FieldSchemaDto[];
}): FieldSchemasChangedRefetchEnvelope {
  return { type: 'field-schemas-changed', projectId: input.projectId, schemas: input.schemas };
}

export function toFieldSchemasChangedRefetchEnvelope(
  event: FieldSchemaListChangedLiveEvent,
): FieldSchemasChangedRefetchEnvelope {
  return buildFieldSchemasChangedRefetchEnvelope({
    projectId: event.projectId,
    schemas: event.payload.schemas,
  });
}

// Re-export the frame guard helper for callers that wrap field-schema events.
export function isFieldSchemaListChangedLiveEventFrame(value: unknown): boolean {
  return isLiveEventFrame(value) && isFieldSchemaListChangedLiveEvent(value.event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
