// Runtime hook-ask contract family (slice 006). Browser-safe, zero runtime deps.
//
// Parse-only mirror of the EXISTING `/api/ask` request body + `{ answer }`
// response. The in-memory resolver is the one authority (☠ M8/FD-7: the
// pending-interaction shadow row this once reserved a field for is gone).

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
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
