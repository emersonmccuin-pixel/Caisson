import type { AgentRunStatus, ULID } from '@pc/domain';
import type { AgentRunPolicy, AgentRunTurnState } from './agent-run.ts';

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
  /** Step-4 Slice 1 — lifecycle policy ('default' when absent; older hosts
   *  omit it). */
  policy?: AgentRunPolicy;
  /** G1 — turn-level ready⇌busy for interactive surfaces. Meaningful from
   *  `running` onward; the chat send-queue drains on 'ready'. */
  turnState?: AgentRunTurnState;
  jsonlPath: string | null;
  /** OS pid of the live claude.exe child, or null before spawn / after exit.
   *  Optional on the wire (older hosts omit it). Lets peek/kill and the runs
   *  list answer "is anything actually alive" for host-backed runs. */
  pid?: number | null;
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
  /** Step-4 Slice 1 — lifecycle policy. 'persistent-interactive' (the
   *  orchestrator chat) disarms idle/wall-clock/first-turn reaping and takes
   *  the cap-exempt admission lane. Omitted = 'default' (dispatched worker,
   *  unchanged). */
  policy?: AgentRunPolicy;
  // ── Step-4 Slice 2 — orchestrator spawn shaping ──────────────────────────
  /** Spawn mode on a plain start-run. The orchestrator resumes its OWN
   *  conversation (`--resume <uuid>`) without a continuation lineage, so it
   *  can't use `resume-run` (which requires `continues`). Omitted = 'fresh'. */
  mode?: 'fresh' | 'resume';
  /** Source JSONL line cursor handed to the spawn's tailer — a resume skips
   *  already-replayed lines so prior turns don't re-emit as fresh events. */
  jsonlStartLine?: number;
  /** Post-scrub env overrides (terminal color/capability env for the chat). */
  envOverrides?: Record<string, string | undefined>;
  /** `--model` override. The orchestrator pins 'opus'. */
  model?: string;
  /** Require CC's composer-ready UI marker in the ready gate. */
  requireReadySignal?: boolean;
  /** Gate readiness on the MCP handshake. The orchestrator disables this on
   *  resume (historical sessions may predate the current MCP config). */
  requireMcpHandshake?: boolean;
  /** Launch the session remote-ready (`--remote-control`). Orchestrator-only;
   *  dispatched agent workers omit it. */
  remoteControl?: boolean;
  /** Initial PTY geometry (the user's current chat panel size). */
  cols?: number;
  rows?: number;
  /** Server-authoritative CC JSONL path. The server computes this with ITS
   *  normalized CLAUDE_CONFIG_DIR (the same env the spawned agent inherits) and
   *  the host threads it straight through to the AgentRun instead of recomputing
   *  it from its own (possibly divergent) env. Without this the host can tail a
   *  different folder than the agent writes to and never sees turn-end → the
   *  run looks permanently quiet (blind turn-state, stall-ladder noise). */
  jsonlPath?: string;
  // ☠ Step 8 (P9/FD-17): `idleMs` is gone from the wire — idle-kill is
  // deleted. `wallClockMs` carries a workflow node's `timeout` (the one
  // sanctioned timer kill).
  timeouts?: {
    spawnStuckMs?: number;
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
  // Step-4 G2 — graceful interrupt (Escape, CC's stop-streaming key).
  // Non-destructive: the session stays alive at the composer; `cancel`
  // remains the kill path.
  | { type: 'interrupt'; runId: ULID }
  // Step-4 G6 — terminal-grade resize for interactive surfaces.
  | { type: 'resize'; runId: ULID; cols: number; rows: number }
  // Step-4 Slice 2 — raw terminal keystrokes (terminal-mode input). Bypasses
  // the chat send queue / bracketed paste / echo-ack, exactly like the old
  // PTY writeRaw.
  | { type: 'write-raw'; runId: ULID; data: string }
  | { type: 'mark-paused'; runId: ULID; askId: string }
  | { type: 'answer-pending'; runId: ULID; text: string }
  | { type: 'cancel'; runId: ULID; reason?: string }
  // Workflow-engine redesign — delivery is the SOLE done-signal. The server's
  // deliverable route relays it here so the host's own AgentRun completes
  // (running→completed) on the ONE host-backed path — no in-process fallback.
  | { type: 'complete-run'; runId: ULID; result?: string }
  | { type: 'notify-mcp-handshake'; ccSessionId: string }
  // FD-15 — live config push (settings → host). Today only the global
  // concurrency cap; the host applies it to its AgentRunRegistry without a
  // restart (a restart would kill live runs).
  | { type: 'set-config'; maxConcurrent: number }
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
        | 'interrupt'
        | 'resize'
        | 'write-raw'
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
      ok: true;
      command: 'set-config';
      /** Effective (clamped) cap after applying the push. */
      maxConcurrent: number;
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
  // G7 — replay meta rides the wire: `cursor` is the 1-based line in CC's
  // source JSONL that produced the event; `kind` mirrors event.kind so the
  // server-side replay writer needn't parse `unknown`; `source` names the
  // provenance (matches the jsonl-events.jsonl envelope's source.kind).
  | {
      seq: number;
      type: 'run-jsonl';
      runId: ULID;
      event: unknown;
      cursor?: number;
      kind?: string;
      source?: 'claude-jsonl';
    }
  | { seq: number; type: 'run-chunk'; runId: ULID; text: string }
  | { seq: number; type: 'run-terminal'; run: AgentHostRunSnapshot }
  | { seq: number; type: 'run-error'; runId: ULID; error: string };
