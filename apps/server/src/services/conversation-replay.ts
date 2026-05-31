// Server composition for the slice-006 conversation replay seam.
//
// Wraps the @pc/app-services `ConversationReplayService` over the EXISTING
// byte-identical reader (`loadSessionReplayCheckpoint`). The runtime-host routes
// + connect snapshot + new/resume routes delegate here so every `session-replay`
// surface flows through the service while staying byte-identical. The repository
// is read-only over files; nothing is persisted.

import {
  ConversationReplayService,
  FileTranscriptRepository,
} from '@pc/app-services';
import {
  loadSessionReplayCheckpoint,
  type SessionReplayCheckpoint,
} from './session-replay.ts';

interface SessionDataPathRuntime {
  sessionDataPath(sessionId: string): string;
}

/** Bind the byte-identical reader + the runtime's session-data resolver into a
 *  replay service. Cheap to build per call; reads are synchronous file reads. */
function serviceFor(runtime: SessionDataPathRuntime): ConversationReplayService {
  const repository = new FileTranscriptRepository({
    readCheckpoint: (path, sessionId) =>
      loadSessionReplayCheckpoint(path, sessionId) as SessionReplayCheckpoint,
    resolveSessionDataPath: ({ sessionId }) => runtime.sessionDataPath(sessionId),
  });
  return new ConversationReplayService(repository);
}

/** Full checkpoint via the service, byte-identical to `loadSessionReplayCheckpoint`. */
export function loadConversationReplayCheckpoint(
  runtime: SessionDataPathRuntime,
  sessionId: string,
): SessionReplayCheckpoint {
  return serviceFor(runtime).loadCheckpoint({ projectId: '', sessionId }) as SessionReplayCheckpoint;
}

/** After-seq checkpoint: rows with `seq > afterSeq`, stable `highWaterSeq`. */
export function loadConversationReplayCheckpointAfter(
  runtime: SessionDataPathRuntime,
  sessionId: string,
  afterSeq: number,
  limit?: number,
): SessionReplayCheckpoint {
  const response = serviceFor(runtime).loadReplayAfter({
    projectId: '',
    sessionId,
    afterSeq,
    limit,
  });
  return {
    sessionId: response.sessionId,
    highWaterSeq: response.highWaterSeq,
    events: response.events as SessionReplayCheckpoint['events'],
  };
}
