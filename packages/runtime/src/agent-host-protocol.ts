import type { AgentRunStatus, ULID } from '@pc/domain';

export interface AgentHostIdentity {
  hostId: string;
  pid: number;
  startedAt: number;
  protocolVersion: 1;
}

export type AgentHostRunState = AgentRunStatus;

export interface AgentHostTerminalResult {
  status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled'>;
  result: string | null;
  failureCause: string | null;
  failureReason: string | null;
}

export interface AgentHostRunSnapshot {
  runId: ULID;
  projectId: ULID;
  dispatcherSessionId: string;
  ccSessionId: string;
  podName: string;
  worktreeDir: string;
  state: AgentHostRunState;
  jsonlPath: string | null;
  transcriptPath: string | null;
  queuedAt: number;
  spawnedAt: number | null;
  readyAt: number | null;
  updatedAt: number;
  terminalAt: number | null;
  terminalResult?: AgentHostTerminalResult;
}

export interface AgentHostStartRunRequest {
  runId: ULID;
  projectId: ULID;
  dispatcherSessionId: string;
  ccSessionId: string;
  podDefinition: {
    name: string;
    logicalName?: string;
  };
  worktreePath: string;
  env: Record<string, string | undefined>;
  initialInput: string;
  mcpConfigPath?: string;
  settingsPath?: string;
  settingSources?: string;
  pluginDirs?: readonly string[];
  transcriptPath?: string;
  /** Server-authoritative CC JSONL path. The server computes this with ITS
   *  normalized CLAUDE_CONFIG_DIR (the same env the spawned agent inherits) and
   *  the host threads it straight through to the AgentRun instead of recomputing
   *  it from its own (possibly divergent) env. Without this the host can tail a
   *  different folder than the agent writes to and never sees turn-end → the run
   *  false-fails idle-timeout at exactly readyAt+idleMs. */
  jsonlPath?: string;
  timeouts?: {
    spawnStuckMs?: number;
    idleMs?: number;
    wallClockMs?: number;
    handshakeTimeoutMs?: number;
    readyTimeoutMs?: number;
    cancelGraceMs?: number;
  };
}

export type AgentHostResumeRunRequest = AgentHostStartRunRequest & {
  mode: 'resume';
  continues: ULID;
};

export type AgentHostCommand =
  | { type: 'hello'; apiPid: number; protocolVersion: 1 }
  | { type: 'list-runs' }
  | { type: 'start-run'; request: AgentHostStartRunRequest }
  | { type: 'resume-run'; request: AgentHostResumeRunRequest }
  | { type: 'send'; runId: ULID; text: string }
  | { type: 'mark-paused'; runId: ULID; askId: string }
  | { type: 'answer-pending'; runId: ULID; text: string }
  | { type: 'cancel'; runId: ULID; reason?: string }
  // Workflow-engine redesign — delivery is the SOLE done-signal. The server's
  // deliverable route relays it here so the host's own AgentRun completes
  // (running→completed) on the ONE host-backed path — no in-process fallback.
  | { type: 'complete-run'; runId: ULID; result?: string }
  | { type: 'notify-mcp-handshake'; ccSessionId: string }
  | { type: 'shutdown'; mode: 'host-exit' | 'cancel-runs' };

export type AgentHostCommandErrorCode =
  | 'not-found'
  | 'protocol-error'
  | 'run-exists'
  | 'send-failed'
  | 'unsupported'
  | 'host-shutting-down'
  // Slice 009 OBJ-2 — answer-pending arrived but the host run was not in a
  // resumable state (`_resumeWithAnswer` no-op), so the answer was not threaded.
  | 'not-resumable';

export type AgentHostCommandResponse =
  | {
      ok: true;
      command: 'hello';
      identity: AgentHostIdentity;
      lastSeq: number;
    }
  | {
      ok: true;
      command: 'list-runs';
      runs: AgentHostRunSnapshot[];
      lastSeq: number;
    }
  | {
      ok: true;
      command:
        | 'start-run'
        | 'resume-run'
        | 'send'
        | 'mark-paused'
        | 'answer-pending'
        | 'cancel'
        | 'complete-run';
      run: AgentHostRunSnapshot;
      lastSeq: number;
    }
  | {
      ok: true;
      command: 'notify-mcp-handshake' | 'shutdown';
      lastSeq: number;
    }
  | {
      ok: false;
      command: AgentHostCommand['type'];
      code: AgentHostCommandErrorCode;
      error: string;
      lastSeq: number;
    };

export type AgentHostEvent =
  | { seq: number; type: 'host-ready'; identity: AgentHostIdentity }
  | { seq: number; type: 'run-state'; run: AgentHostRunSnapshot }
  | { seq: number; type: 'run-jsonl'; runId: ULID; event: unknown; cursor?: number }
  | { seq: number; type: 'run-chunk'; runId: ULID; text: string }
  | { seq: number; type: 'run-terminal'; run: AgentHostRunSnapshot }
  | { seq: number; type: 'run-error'; runId: ULID; error: string };
