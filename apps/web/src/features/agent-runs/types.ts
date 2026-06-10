import type { ULID } from '@/features/projects/types';

// Slice 005 — the canonical browser-safe agent-run DTO now lives in
// @pc/contracts. Re-exported here so components can migrate imports gradually;
// the local AgentRunRecord shape below stays the legacy `agent-run-changed`
// envelope record (used by the existing useResourceList hook).
export type { AgentRunDto } from '@pc/contracts';

export type AgentRunStatus =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunFailureCause =
  | 'spawn-stuck'
  | 'timeout'
  | 'idle-timeout'
  | 'wall-clock-timeout'
  | 'ready-timeout'
  | 'spawn-failed'
  | 'spawn-error'
  | 'send-failed'
  | 'spawn-exit'
  | 'unexpected-exit'
  | 'cancel-while-queued'
  | 'cancelled'
  | 'unknown-agent'
  | 'mcp-handshake-never'
  | 'kill-during-spawn'
  | 'server-restart'
  | 'host-unavailable'
  | 'host-lost'
  | 'host-crashed'
  | 'host-protocol-error'
  | 'host-rejected';

export type PendingAskKind = 'ask-orchestrator' | 'ask-user' | 'approval';
export type PendingAskStatus = 'waiting' | 'answered' | 'cancelled';

export interface PendingAskOption {
  value: string;
  label: string;
}

export interface PendingAsk {
  id: ULID;
  sessionId: string;
  agentName: string;
  projectId: ULID;
  runId: ULID | null;
  parentWorkItemId: ULID | null;
  kind: PendingAskKind;
  question: string;
  context: string | null;
  options: PendingAskOption[] | null;
  status: PendingAskStatus;
  answer: string | null;
  answeredBy: 'orchestrator' | 'user' | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
}

export interface AgentRunRecord {
  runId: ULID;
  sessionId: string;
  agentName: string;
  projectId: ULID;
  parentWorkItemId: ULID | null;
  wait: boolean;
  worktreeDir: string;
  startedAt: number;
  status: AgentRunStatus;
  result: string;
  failureReason: string | null;
  failureCause: AgentRunFailureCause | null;
  endedAt: number | null;
  /** Monotonic write counter. Carried in WS deltas so the frontend can discard
   *  out-of-order / duplicate deliveries. Defaults to 0 on old-server envelopes. */
  rev?: number;
  /** T2.2 — client-only flag stamped from a live `reason:'stalled'` frame: the
   *  run is quiet past the warn window but not yet killed. Cleared by any later
   *  non-stalled frame. Not on the HTTP seed (a cold reload clears it until the
   *  next live signal). */
  stalled?: boolean;
}

/** Liveness snapshot returned by the inspect route. Mirrors the server's
 *  AgentRunInspection. */
export interface AgentRunInspection {
  runId: string;
  status: string;
  pid: number | null;
  processAlive: boolean | null;
  lastActivityAt: number | null;
  idleMs: number | null;
  queuedAt: number;
  spawnedAt: number | null;
  readyAt: number | null;
  failureCause: string | null;
  failureReason: string | null;
  lastAction: { kind: string; at: number | null; text: string | null } | null;
  jsonlPath: string | null;
}

export type AgentRunTranscriptStatus = 'ready' | 'empty' | 'missing';

export interface AgentRunEventsResponse {
  ok: true;
  runId: ULID;
  status: AgentRunStatus;
  jsonlPath: string;
  transcriptStatus: AgentRunTranscriptStatus;
  events: unknown[];
}
