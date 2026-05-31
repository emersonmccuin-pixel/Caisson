// Conversation contract family (slice 006). Browser-safe, zero runtime deps.
//
// Owns `ConversationKind` (the read-surface discriminator across orchestrator
// sessions, agent runs, and subagent transcripts) and `ConversationSessionDto`
// (a browser-safe mirror of the @pc/domain `OrchestratorSession`). This slice
// wires only `'orchestrator-session'` to a live repository; the other kinds are
// reserved for the later cross-kind transcript convergence.
//
// The DTO mirrors the EXISTING wire exactly — `deletedAt` stays server-side and
// is NOT part of the rail DTO (the session routes never emit it).

import { type ULID } from './shared.ts';

export const CONVERSATION_KINDS = [
  'orchestrator-session',
  'agent-run',
  'subagent-transcript',
] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_SESSION_STATUSES = ['active', 'ended'] as const;
export type ConversationSessionStatus = (typeof CONVERSATION_SESSION_STATUSES)[number];

export const CONVERSATION_SESSION_ENDED_REASONS = [
  'user_ended',
  'provider_error',
  'provider_session_lost',
  'pty_exit',
  'archived',
] as const;
export type ConversationSessionEndedReason =
  (typeof CONVERSATION_SESSION_ENDED_REASONS)[number];

/** Browser-safe mirror of the @pc/domain `OrchestratorSession` (the shape the
 *  `GET /sessions` + `GET /session` routes already emit). `deletedAt` is
 *  intentionally omitted — the routes filter soft-deleted rows and never return
 *  it on the rail DTO. */
export interface ConversationSessionDto {
  id: ULID;
  projectId: ULID;
  provider: string;
  providerSessionId: string | null;
  model: string | null;
  title: string | null;
  status: ConversationSessionStatus;
  endedReason: ConversationSessionEndedReason | null;
  startedAt: number;
  endedAt: number | null;
  jsonlPath: string | null;
  jsonlLineCursor: number;
}

// ── Guards ───────────────────────────────────────────────────────────────────

export function isConversationKind(value: unknown): value is ConversationKind {
  return typeof value === 'string' && (CONVERSATION_KINDS as readonly string[]).includes(value);
}

export function isConversationSessionStatus(
  value: unknown,
): value is ConversationSessionStatus {
  return (
    typeof value === 'string' &&
    (CONVERSATION_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

export function isConversationSessionEndedReason(
  value: unknown,
): value is ConversationSessionEndedReason {
  return (
    typeof value === 'string' &&
    (CONVERSATION_SESSION_ENDED_REASONS as readonly string[]).includes(value)
  );
}

export function isConversationSessionDto(value: unknown): value is ConversationSessionDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.provider === 'string' &&
    (value.providerSessionId === null || typeof value.providerSessionId === 'string') &&
    (value.model === null || typeof value.model === 'string') &&
    (value.title === null || typeof value.title === 'string') &&
    isConversationSessionStatus(value.status) &&
    (value.endedReason === null || isConversationSessionEndedReason(value.endedReason)) &&
    typeof value.startedAt === 'number' &&
    (value.endedAt === null || typeof value.endedAt === 'number') &&
    (value.jsonlPath === null || typeof value.jsonlPath === 'string') &&
    typeof value.jsonlLineCursor === 'number'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
