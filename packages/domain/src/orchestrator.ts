// OrchestratorSession domain type. One per project; tracks the per-project
// chat-session lifecycle (an Engine-owned host run behind the server's
// OrchestratorHostSession adapter since Step 4).

import type { ULID } from './ulid.ts';

export type ProviderId = 'claude';

export type SessionStatus = 'active' | 'ended';

export type SessionEndedReason =
  | 'user_ended'
  | 'provider_error'
  | 'provider_session_lost'
  | 'pty_exit'
  | 'archived';

export interface OrchestratorSession {
  id: ULID;
  projectId: ULID;
  provider: ProviderId;
  /** Provider's own session ID. Null until the first `result` event lands. */
  providerSessionId: string | null;
  model: string | null;
  title: string | null;
  status: SessionStatus;
  endedReason: SessionEndedReason | null;
  startedAt: number;
  endedAt: number | null;
  deletedAt: number | null;
  /** Absolute path of CC's per-session JSONL file (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`).
   *  Discovered after the session spawns; persisted so resume can re-attach
   *  to the same file with the cursor below. */
  jsonlPath: string | null;
  /** Line count of CC's JSONL we've consumed. Persisted so a server restart
   *  followed by `--resume` doesn't re-broadcast already-processed events. */
  jsonlLineCursor: number;
}
