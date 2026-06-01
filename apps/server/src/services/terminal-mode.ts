import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const TERMINAL_INPUT_MAX_BYTES = 64 * 1024;
export const TERMINAL_TRANSCRIPT_MAX_TAIL_BYTES = 1024 * 1024;

export interface TerminalInputRuntime {
  ptySession(): { writeRaw(bytes: string): boolean } | null;
}

export interface TerminalTranscriptRuntime {
  dataPath: string;
  sessionDataPath(sessionId: string): string;
}

export interface TerminalTranscriptSession {
  id: string;
  projectId: string;
}

export type TerminalInputResult =
  | { ok: true; bytesWritten: number }
  | { ok: false; status: 'invalid-message' | 'no-session' | 'write-failed'; error: string };

export type TerminalTranscriptResult =
  | {
      ok: true;
      sessionId: string;
      bytes: string;
      truncated: boolean;
      mtimeMs: number | null;
    }
  | { ok: false; status: 400 | 404; error: string };

export function validateTerminalInputData(data: unknown): { ok: true; data: string } | { ok: false; error: string } {
  if (typeof data !== 'string') {
    return { ok: false, error: 'terminal-input.data must be a string' };
  }
  if (Buffer.byteLength(data, 'utf8') > TERMINAL_INPUT_MAX_BYTES) {
    return {
      ok: false,
      error: `terminal-input.data exceeds ${TERMINAL_INPUT_MAX_BYTES} bytes`,
    };
  }
  return { ok: true, data };
}

export function forwardTerminalInput(
  runtime: TerminalInputRuntime,
  data: unknown,
): TerminalInputResult {
  const validated = validateTerminalInputData(data);
  if (!validated.ok) {
    return { ok: false, status: 'invalid-message', error: validated.error };
  }
  const live = runtime.ptySession();
  if (!live) {
    return { ok: false, status: 'no-session', error: 'No live PTY is attached' };
  }
  if (!live.writeRaw(validated.data)) {
    return { ok: false, status: 'write-failed', error: 'PTY rejected raw input' };
  }
  return { ok: true, bytesWritten: Buffer.byteLength(validated.data, 'utf8') };
}

export function normalizeTerminalTranscriptTailBytes(raw: unknown): number {
  if (typeof raw !== 'string' || raw.trim() === '') return TERMINAL_TRANSCRIPT_MAX_TAIL_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return TERMINAL_TRANSCRIPT_MAX_TAIL_BYTES;
  return Math.max(0, Math.min(TERMINAL_TRANSCRIPT_MAX_TAIL_BYTES, Math.floor(parsed)));
}

export function readTerminalTranscriptTail(input: {
  projectId: string;
  sessionId: string;
  session: TerminalTranscriptSession | null;
  runtime: TerminalTranscriptRuntime;
  tailBytes: number;
}): TerminalTranscriptResult {
  const { projectId, sessionId, session, runtime } = input;
  if (!session) {
    // Unknown session — a stale/replaced id (e.g. after a project switch) or
    // one not persisted yet. The terminal surface has nothing to show, so
    // return empty (matching the missing-transcript case below) rather than a
    // 404 that spams the console. Live raw bytes still arrive via the WS.
    return { ok: true, sessionId, bytes: '', truncated: false, mtimeMs: null };
  }
  if (session.id !== sessionId || session.projectId !== projectId) {
    return { ok: false, status: 404, error: 'Session not found for project' };
  }

  const sessionsRoot = resolve(runtime.dataPath, 'sessions');
  const sessionRoot = resolve(runtime.sessionDataPath(session.id));
  if (!isContained(sessionsRoot, sessionRoot, true)) {
    return { ok: false, status: 400, error: 'Session path escapes project data root' };
  }

  const transcriptPath = resolve(sessionRoot, 'transcript.log');
  if (!isContained(sessionRoot, transcriptPath, false)) {
    return { ok: false, status: 400, error: 'Transcript path escapes session root' };
  }

  const tailBytes = Math.max(
    0,
    Math.min(TERMINAL_TRANSCRIPT_MAX_TAIL_BYTES, Math.floor(input.tailBytes)),
  );

  if (!existsSync(transcriptPath)) {
    return { ok: true, sessionId, bytes: '', truncated: false, mtimeMs: null };
  }

  const st = statSync(transcriptPath);
  if (!st.isFile()) {
    return { ok: true, sessionId, bytes: '', truncated: false, mtimeMs: st.mtimeMs };
  }

  const readBytes = Math.min(st.size, tailBytes);
  if (readBytes <= 0) {
    return {
      ok: true,
      sessionId,
      bytes: '',
      truncated: st.size > 0,
      mtimeMs: st.mtimeMs,
    };
  }

  const fd = openSync(transcriptPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(readBytes);
    readSync(fd, buffer, 0, readBytes, st.size - readBytes);
    return {
      ok: true,
      sessionId,
      bytes: buffer.toString('utf8'),
      truncated: st.size > readBytes,
      mtimeMs: st.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

function isContained(root: string, candidate: string, allowRoot: boolean): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return allowRoot;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}
