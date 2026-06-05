// M3b — one-time boot backfill: per-session replay FILES → conversation_events.
//
// Walks `<dataDir>/projects/*/sessions/*`; a session dir holding
// `jsonl-events.jsonl` (Section-23 normalized) or legacy `events.jsonl`
// (pre-23) imports into the table in one txn, then the file is renamed
// `*.imported` (forensics kept; the sweep self-extinguishes — renamed files
// are invisible to the next boot). A session that ALREADY has rows renames
// without importing (crash-between-import-and-rename is idempotent).
//
// The parser below is the ☠ `session-replay.ts` reader moved WHOLE — same
// malformed-line skipping, same max(count, maxSeq)+1 seq rules — so historical
// seq numbering survives the cutover byte-identically. It exists ONLY here:
// the live read path is a conversation_events query with NO file fallback.

import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
  appendConversationEvents,
  hasConversationEvents,
  type AppendConversationEventInput,
} from '@pc/db';

export interface ConversationBackfillResult {
  sessionsImported: number;
  eventsImported: number;
  filesRenamed: number;
}

export interface ConversationBackfillDeps {
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/** Run the sweep. Cheap when there is nothing to do (an existsSync per session
 *  dir); call once at boot after migrations. */
export function backfillConversationEvents(
  dataDir: string,
  deps: ConversationBackfillDeps = {},
): ConversationBackfillResult {
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? console;
  const result: ConversationBackfillResult = {
    sessionsImported: 0,
    eventsImported: 0,
    filesRenamed: 0,
  };

  const projectsDir = resolve(dataDir, 'projects');
  for (const projectId of listDirs(projectsDir)) {
    const sessionsDir = join(projectsDir, projectId, 'sessions');
    for (const sessionId of listDirs(sessionsDir)) {
      const sessionDir = join(sessionsDir, sessionId);
      for (const fileName of ['jsonl-events.jsonl', 'events.jsonl']) {
        const filePath = join(sessionDir, fileName);
        if (!existsSync(filePath)) continue;
        try {
          if (!hasConversationEvents(sessionId)) {
            const checkpoint = loadSessionReplayCheckpoint(sessionDir, sessionId, fileName);
            const rows: AppendConversationEventInput[] = checkpoint.events.map((e) => ({
              sessionId: e.sessionId,
              seq: e.seq,
              type: e.type,
              kind: e.kind,
              event: e.event,
              sourceKind: e.source.kind,
              sourceCursor: e.source.cursor,
              now: now(),
            }));
            result.eventsImported += appendConversationEvents(rows);
            if (rows.length > 0) result.sessionsImported += 1;
          }
          renameSync(filePath, `${filePath}.imported`);
          result.filesRenamed += 1;
        } catch (err) {
          // Leave the file in place — the next boot retries; never block boot.
          logger.warn(
            `[conversation-backfill] ${sessionId}/${fileName} failed: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  if (result.filesRenamed > 0) {
    logger.log(
      `[conversation-backfill] imported ${result.eventsImported} events from ` +
        `${result.sessionsImported} sessions (${result.filesRenamed} files renamed *.imported)`,
    );
  }
  return result;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ─── ☠ session-replay.ts — the file parser, moved whole (import-only) ────────

interface ReplaySource {
  kind: 'claude-jsonl' | 'legacy-events-jsonl';
  cursor: number | null;
}

interface ReplayEnvelope {
  id: string;
  sessionId: string;
  seq: number;
  type: 'jsonl' | 'event';
  kind: string | null;
  event: unknown;
  source: ReplaySource;
}

interface SessionReplayCheckpoint {
  sessionId: string;
  highWaterSeq: number;
  events: ReplayEnvelope[];
}

interface ReplayRow {
  id?: unknown;
  sessionId?: unknown;
  seq?: unknown;
  type?: unknown;
  kind?: unknown;
  event?: unknown;
  source?: unknown;
}

function fallbackSessionId(sessionDataPath: string): string {
  return basename(resolve(sessionDataPath));
}

function eventKind(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const kind = (event as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}

function safeSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function sourceFromRow(
  source: unknown,
  fallbackKind: ReplaySource['kind'],
  fallbackCursor: number | null,
): ReplaySource {
  if (source && typeof source === 'object') {
    const row = source as { kind?: unknown; cursor?: unknown };
    const kind = row.kind === 'claude-jsonl' || row.kind === 'legacy-events-jsonl'
      ? row.kind
      : fallbackKind;
    const cursor = row.cursor === null
      ? null
      : typeof row.cursor === 'number' && Number.isSafeInteger(row.cursor) && row.cursor > 0
        ? row.cursor
        : fallbackCursor;
    return { kind, cursor };
  }
  return { kind: fallbackKind, cursor: fallbackCursor };
}

function appendEnvelope(
  out: ReplayEnvelope[],
  input: {
    row: ReplayRow;
    type: 'jsonl' | 'event';
    fallbackSessionId: string;
    fallbackSourceKind: ReplaySource['kind'];
    fallbackCursor: number;
    nextSeq: number;
  },
): number {
  const event = input.row.event;
  if (!event || typeof event !== 'object') return input.nextSeq;

  const explicitSeq = safeSeq(input.row.seq);
  const seq = explicitSeq ?? input.nextSeq;
  const sessionId = typeof input.row.sessionId === 'string'
    ? input.row.sessionId
    : input.fallbackSessionId;
  const id = typeof input.row.id === 'string' ? input.row.id : `${sessionId}:${seq}`;
  const kind = typeof input.row.kind === 'string' ? input.row.kind : eventKind(event);
  const source = sourceFromRow(
    input.row.source,
    input.fallbackSourceKind,
    input.fallbackCursor,
  );

  out.push({ id, sessionId, seq, type: input.type, kind, event, source });
  return Math.max(input.nextSeq, seq + 1);
}

function normalizeReplay(
  events: ReplayEnvelope[],
  sessionId: string,
): SessionReplayCheckpoint {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const highWaterSeq = ordered.reduce((max, event) => Math.max(max, event.seq), 0);
  return { sessionId, highWaterSeq, events: ordered };
}

/** Parse one session's on-disk event log (the old reader, verbatim semantics).
 *  `fileName` picks which log this call imports; the caller iterates both. */
function loadSessionReplayCheckpoint(
  sessionDataPath: string,
  sessionId = fallbackSessionId(sessionDataPath),
  fileName: string,
): SessionReplayCheckpoint {
  if (fileName === 'jsonl-events.jsonl') {
    const jsonlEventsFile = resolve(sessionDataPath, 'jsonl-events.jsonl');
    try {
      const lines = readFileSync(jsonlEventsFile, 'utf-8').split('\n').filter(Boolean);
      const out: ReplayEnvelope[] = [];
      let nextSeq = 1;
      for (let i = 0; i < lines.length; i++) {
        let parsed: ReplayRow;
        try {
          parsed = JSON.parse(lines[i]!) as ReplayRow;
        } catch {
          continue;
        }
        if (!parsed || parsed.type !== 'jsonl') continue;
        nextSeq = appendEnvelope(out, {
          row: parsed,
          type: 'jsonl',
          fallbackSessionId: sessionId,
          fallbackSourceKind: 'claude-jsonl',
          fallbackCursor: i + 1,
          nextSeq,
        });
      }
      return normalizeReplay(out, sessionId);
    } catch {
      return { sessionId, highWaterSeq: 0, events: [] };
    }
  }

  const legacyFile = resolve(sessionDataPath, 'events.jsonl');
  try {
    const lines = readFileSync(legacyFile, 'utf-8').split('\n').filter(Boolean);
    const out: ReplayEnvelope[] = [];
    let nextSeq = 1;
    for (let i = 0; i < lines.length; i++) {
      let event: unknown;
      try {
        event = JSON.parse(lines[i]!);
      } catch {
        continue;
      }
      nextSeq = appendEnvelope(out, {
        row: { type: 'event', event },
        type: 'event',
        fallbackSessionId: sessionId,
        fallbackSourceKind: 'legacy-events-jsonl',
        fallbackCursor: i + 1,
        nextSeq,
      });
    }
    return normalizeReplay(out, sessionId);
  } catch {
    return { sessionId, highWaterSeq: 0, events: [] };
  }
}
