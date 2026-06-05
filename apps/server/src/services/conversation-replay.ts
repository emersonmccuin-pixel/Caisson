// Server composition for the conversation replay seam (slice 006 · M3b).
//
// M3b: replay reads come from the `conversation_events` table through the
// app-services `DbTranscriptRepository` — replay is a query. ☠ the byte-
// identical file reader (`session-replay.ts`) + `FileTranscriptRepository`;
// the on-disk jsonl-events.jsonl files were imported once at boot
// (conversation-backfill.ts) and renamed `*.imported`. The runtime-host routes
// + connect snapshot + new/resume routes keep delegating here; the
// `{ ok, sessionId, highWaterSeq, events }` shapes are unchanged.

import {
  ConversationReplayService,
  DbTranscriptRepository,
} from '@pc/app-services';

// The replay envelope/checkpoint types survive the file reader they used to
// live beside (session-replay.ts, ☠ M3b) — every replay surface still speaks
// this shape; only the store moved.
export interface ReplaySource {
  kind: 'claude-jsonl' | 'legacy-events-jsonl';
  cursor: number | null;
}

export interface ReplayEnvelope {
  id: string;
  sessionId: string;
  seq: number;
  type: 'jsonl' | 'event';
  kind: string | null;
  event: unknown;
  source: ReplaySource;
}

export interface SessionReplayCheckpoint {
  sessionId: string;
  highWaterSeq: number;
  events: ReplayEnvelope[];
}

const service = new ConversationReplayService(new DbTranscriptRepository());

/** Full checkpoint for a session — ordered events + the session high water. */
export function loadConversationReplayCheckpoint(sessionId: string): SessionReplayCheckpoint {
  return service.loadCheckpoint({ projectId: '', sessionId }) as SessionReplayCheckpoint;
}

/** After-seq checkpoint: rows with `seq > afterSeq`, stable `highWaterSeq`. */
export function loadConversationReplayCheckpointAfter(
  sessionId: string,
  afterSeq: number,
  limit?: number,
): SessionReplayCheckpoint {
  const response = service.loadReplayAfter({ projectId: '', sessionId, afterSeq, limit });
  return {
    sessionId: response.sessionId,
    highWaterSeq: response.highWaterSeq,
    events: response.events as SessionReplayCheckpoint['events'],
  };
}
