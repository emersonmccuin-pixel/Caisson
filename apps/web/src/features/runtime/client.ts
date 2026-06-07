import { getJson, getJsonOr404, postJson } from '@/api/http';
import type { ULID } from '@/features/projects/types';
import type {
  OrchestratorRuntimeSnapshot,
  OrchestratorSession,
  SessionReplayItem,
  SessionTransitionResponse,
  TerminalTranscriptResponse,
} from './types';

export * from './types';

export const runtimeApi = {
  // Returns null (no throw) when the server has no runtime for the project or
  // no transcript for the session (expected 404 for inactive/stale sessions).
  getTerminalTranscript: (projectId: ULID, sessionId: ULID, tailBytes = 1024 * 1024) =>
    getJsonOr404<TerminalTranscriptResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/terminal-transcript?tailBytes=${encodeURIComponent(String(tailBytes))}`,
    ),

  getActiveSession: (projectId: ULID) =>
    getJson<{ ok: true; session: OrchestratorSession | null }>(
      `/api/projects/${projectId}/session`,
    ).then((r) => r.session),

  getOrchestratorRuntime: (projectId: ULID) =>
    getJson<{ ok: true; runtime: OrchestratorRuntimeSnapshot }>(
      `/api/projects/${projectId}/orchestrator/runtime`,
    ).then((r) => r.runtime),

  startNewSession: (projectId: ULID) =>
    postJson<{ ok: true } & SessionTransitionResponse>(
      `/api/projects/${projectId}/sessions/new`,
      {},
    ),

  resumeSession: (projectId: ULID, targetSessionId: ULID) =>
    postJson<{ ok: true } & SessionTransitionResponse>(
      `/api/projects/${projectId}/sessions/${targetSessionId}/resume`,
      {},
    ),

  /** Close the live chat back to the launcher: ends the active session + kills
   *  the PTY server-side. Broadcasts session-changed { session: null }. */
  closeSession: (projectId: ULID) =>
    postJson<{ ok: true; transition: 'close-session'; closed: boolean }>(
      `/api/projects/${projectId}/sessions/close`,
      {},
    ),

  listSessions: (projectId: ULID) =>
    getJson<{ ok: true; sessions: OrchestratorSession[] }>(
      `/api/projects/${projectId}/sessions`,
    ).then((r) => r.sessions),

  getStatuslineSnapshot: (projectId: ULID) =>
    getJson<{ ok: true; snapshot: unknown | null }>(
      `/api/projects/${projectId}/statusline`,
    ).then((r) => r.snapshot),

  getUsageAggregate: (
    bucket: 'day' | 'week' | 'month',
    windowDays: number,
  ) =>
    getJson<{
      ok: true;
      bucket: string;
      windowDays: number;
      rows: Array<{
        bucket: string;
        costUsd: number;
        sessions: number;
        inputTokens: number;
        outputTokens: number;
      }>;
    }>(`/api/usage/aggregate?bucket=${bucket}&windowDays=${windowDays}`),

  getSessionEvents: (projectId: ULID, sessionId: ULID) =>
    getJson<{ ok: true; sessionId?: ULID; highWaterSeq?: number; events: SessionReplayItem[] }>(
      `/api/projects/${projectId}/sessions/${sessionId}/events`,
    ).then((r) => r.events),

  /** Additive after-seq replay: fetch only transcript rows with seq > afterSeq
   *  (the per-session transcript cursor, NOT the global live-outbox cursor).
   *  Used to catch a chat up after a reconnect without re-pulling the full
   *  checkpoint. Rows dedupe by `id`/`seq` in the chat reducer. */
  getSessionEventsAfter: (
    projectId: ULID,
    sessionId: ULID,
    afterSeq: number,
    limit?: number,
  ) => {
    const params = new URLSearchParams({ afterSeq: String(afterSeq) });
    if (limit !== undefined) params.set('limit', String(limit));
    return getJson<{
      ok: true;
      sessionId?: ULID;
      highWaterSeq?: number;
      events: SessionReplayItem[];
    }>(
      `/api/projects/${projectId}/sessions/${sessionId}/events?${params.toString()}`,
    );
  },
};
