// FileTranscriptRepository (slice 006).
//
// A read-only seam over the EXISTING on-disk JSONL replay. It does NOT own the
// read logic itself: the byte-identical `loadSessionReplayCheckpoint` (server
// session-replay.ts) is INJECTED as `readCheckpoint`, so this repository cannot
// drift from the live replay parser (jsonl-events.jsonl with legacy
// events.jsonl fallback, malformed-row skipping, per-session seq/highWaterSeq).
//
// It adds only the after-seq trim on top: `listAfter({ afterSeq, limit })`
// returns rows with `seq > afterSeq` while keeping `highWaterSeq` derived from
// the FULL checkpoint (stable across reconnect). This is the transcript `seq`
// cursor — NOT the slice-002 global outbox cursor.
//
// It writes NOTHING — no JSONL append, no SQLite, no InteractiveSession touch.
// Only `'orchestrator-session'` is wired to a live read this slice.

import type { SessionReplayCheckpointLike } from './adapters.ts';

/** Injected byte-identical reader. The server passes `loadSessionReplayCheckpoint`. */
export type ReadSessionCheckpoint = (
  sessionDataPath: string,
  sessionId?: string,
) => SessionReplayCheckpointLike;

/** Resolves a conversation to its on-disk session-data path. The server passes
 *  `runtime.sessionDataPath(sessionId)`. */
export type ResolveSessionDataPath = (input: {
  projectId: string;
  sessionId: string;
}) => string;

export interface TranscriptCheckpointQuery {
  projectId: string;
  sessionId: string;
}

export interface TranscriptAfterSeqArgs extends TranscriptCheckpointQuery {
  /** Only rows with `seq > afterSeq` are returned. `0` == the full checkpoint. */
  afterSeq: number;
  /** Optional cap on the returned row count (oldest-first). */
  limit?: number;
}

export interface TranscriptRepository {
  loadCheckpoint(query: TranscriptCheckpointQuery): SessionReplayCheckpointLike;
  listAfter(args: TranscriptAfterSeqArgs): SessionReplayCheckpointLike;
}

export interface FileTranscriptRepositoryDeps {
  readCheckpoint: ReadSessionCheckpoint;
  resolveSessionDataPath: ResolveSessionDataPath;
}

export class FileTranscriptRepository implements TranscriptRepository {
  private readonly readCheckpoint: ReadSessionCheckpoint;
  private readonly resolveSessionDataPath: ResolveSessionDataPath;

  constructor(deps: FileTranscriptRepositoryDeps) {
    this.readCheckpoint = deps.readCheckpoint;
    this.resolveSessionDataPath = deps.resolveSessionDataPath;
  }

  /** Full checkpoint — byte-identical to the injected reader's output. */
  loadCheckpoint(query: TranscriptCheckpointQuery): SessionReplayCheckpointLike {
    const path = this.resolveSessionDataPath(query);
    return this.readCheckpoint(path, query.sessionId);
  }

  /** After-seq read: rows with `seq > afterSeq`, oldest-first, optional cap.
   *  `highWaterSeq` stays the FULL checkpoint's high water (stable for
   *  reconnect); `afterSeq <= 0` returns the full checkpoint unchanged. */
  listAfter(args: TranscriptAfterSeqArgs): SessionReplayCheckpointLike {
    const checkpoint = this.loadCheckpoint(args);
    if (!Number.isSafeInteger(args.afterSeq) || args.afterSeq <= 0) {
      return applyLimit(checkpoint, args.limit);
    }
    const trimmed = checkpoint.events.filter((e) => e.seq > args.afterSeq);
    return applyLimit(
      { sessionId: checkpoint.sessionId, highWaterSeq: checkpoint.highWaterSeq, events: trimmed },
      args.limit,
    );
  }
}

function applyLimit(
  checkpoint: SessionReplayCheckpointLike,
  limit?: number,
): SessionReplayCheckpointLike {
  if (limit === undefined || !Number.isSafeInteger(limit) || limit <= 0) return checkpoint;
  if (checkpoint.events.length <= limit) return checkpoint;
  return {
    sessionId: checkpoint.sessionId,
    highWaterSeq: checkpoint.highWaterSeq,
    events: checkpoint.events.slice(0, limit),
  };
}
