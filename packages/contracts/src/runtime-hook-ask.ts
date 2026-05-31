// Runtime hook-ask contract family (slice 006). Browser-safe, zero runtime deps.
//
// Parse-only mirror of the EXISTING `/api/ask` request body + `{ answer }`
// response. The optional `interactionId` is reserved for the durable
// pending-interaction shadow row — which is DEFERRED to slice 007 per the
// human scope decision (slice 006 ships zero migrations and does NOT change
// `/api/ask` semantics). The field is additive and ignorable by the hook; the
// route does NOT emit it this slice.

import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

export interface RuntimeHookAskRequest {
  projectId: ULID;
  sessionId: ULID | null;
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
}

export interface RuntimeHookAskResponse {
  answer: string;
  /** Reserved for the slice-007 durable shadow row. Omitted this slice. */
  interactionId?: ULID;
}

export function parseRuntimeHookAskRequest(
  input: unknown,
): ParseResult<RuntimeHookAskRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  if (!projectId) return parseErr('projectId required');
  const toolName = typeof input.toolName === 'string' ? input.toolName : '';
  if (!toolName) return parseErr('toolName required');
  const toolUseId = typeof input.toolUseId === 'string' ? input.toolUseId : '';
  if (!toolUseId) return parseErr('toolUseId required');
  const sessionId =
    typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null;
  return parseOk({
    projectId,
    sessionId,
    toolName,
    toolUseId,
    toolInput: input.toolInput,
  });
}

export function isRuntimeHookAskResponse(value: unknown): value is RuntimeHookAskResponse {
  if (!isRecord(value)) return false;
  if (typeof value.answer !== 'string') return false;
  if (value.interactionId !== undefined && typeof value.interactionId !== 'string') {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
