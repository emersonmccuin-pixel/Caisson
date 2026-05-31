// ConversationReplayService (slice 006).
//
// Maps `TranscriptRepository` reads to the EXISTING replay shapes. The
// session-events route + connect snapshot + new/resume routes delegate here;
// responses stay byte-identical to the current `{ ok, sessionId, highWaterSeq,
// events }` body and the `session-replay` envelope `{ sessionId, highWaterSeq,
// events }`. The optional `afterSeq` uses the transcript `seq` cursor.

import type { TranscriptReplayResponse } from '@pc/contracts';
import {
  toTranscriptReplayResponse,
  type SessionReplayCheckpointLike,
} from './adapters.ts';
import type {
  TranscriptAfterSeqArgs,
  TranscriptCheckpointQuery,
  TranscriptRepository,
} from './transcript-repository.ts';

export class ConversationReplayService {
  private readonly repo: TranscriptRepository;

  constructor(repo: TranscriptRepository) {
    this.repo = repo;
  }

  /** Raw checkpoint (for callers that build the legacy `session-replay`
   *  envelope themselves and need the same in-memory shape). */
  loadCheckpoint(query: TranscriptCheckpointQuery): SessionReplayCheckpointLike {
    return this.repo.loadCheckpoint(query);
  }

  /** Full-checkpoint replay response, byte-identical to the route body. */
  loadReplay(query: TranscriptCheckpointQuery): TranscriptReplayResponse {
    return toTranscriptReplayResponse(this.repo.loadCheckpoint(query));
  }

  /** After-seq replay response (additive `?afterSeq=` path). Same envelope;
   *  only rows with `seq > afterSeq`. `afterSeq <= 0` == full checkpoint. */
  loadReplayAfter(args: TranscriptAfterSeqArgs): TranscriptReplayResponse {
    return toTranscriptReplayResponse(this.repo.listAfter(args));
  }
}
