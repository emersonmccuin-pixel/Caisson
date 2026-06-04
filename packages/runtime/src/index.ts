// Section 25 — runtime barrel (post-Phase-E bare names).
//
// PtySession + legacy JsonlTailer survive cutover (orchestrator + interview
// surfaces use them). The agent-system primitives (LowLevelSpawn, AgentRun,
// AgentRunJsonlTailer) sit alongside as named exports.

export {
  encodeCwdForClaude,
  PtySession,
  stripAnsi,
  terminalBufferLooksReady,
} from './pty-session.ts';
export type {
  JsonlReplayMeta,
  JsonlReplaySource,
  PtySessionOptions,
  SessionState,
} from './pty-session.ts';
export { JsonlTailer } from './jsonl-tailer.ts';
export type { JsonlEvent, JsonlEventMeta, JsonlTailerOptions } from './jsonl-tailer.ts';

export {
  attachWorktree,
  createWorktree,
  destroyWorktree,
  listWorktrees,
  pruneWorktrees,
} from './worktree.ts';
export type { WorktreeEntry } from './worktree.ts';

export {
  buildEnvMap,
  expandToolWildcards,
  materializePod,
  materializePodPlugin,
  renderAgentMd,
  renderMcpConfig,
} from './pod-materializer.ts';
export type {
  MaterializePodOptions,
  MaterializedPod,
  MaterializedPluginPod,
  PodWorkItemContext,
} from './pod-materializer.ts';

// ── Agent-system primitives (Section 25) ──────────────────────────────────

export {
  claudeConfigDir,
  claudeConfigDirFromJsonlPath,
  claudeProjectsRoot,
  projectDirFor,
  jsonlPathFor,
} from './path-resolver.ts';

export { IDE_INTEGRATION_ENV_KEYS, scrubIdeEnv } from './env-scrub.ts';

export {
  clearClaudeProbeCache,
  requireClaudeBinary,
  resolveClaudeBinary,
  setBundledClaudeExe,
  setConfiguredClaudeExe,
} from './claude-resolver.ts';
export type { ClaudeBinarySource, ClaudeResolution, ResolveOptions } from './claude-resolver.ts';
export { resolveNodeLauncher } from './node-launcher.ts';
export type { NodeLauncher } from './node-launcher.ts';

export {
  collapseAnsiToWhitespace,
  stripAnsiPreserveSpacing,
} from './ansi.ts';

export { ReadyGate } from './ready-gate.ts';
export type { ReadyTimestamps } from './ready-gate.ts';

export { sendBracketedPaste } from './send-protocol.ts';
export type { SendDeps, SendResult } from './send-protocol.ts';

export { LowLevelSpawn } from './low-level-spawn.ts';
export type {
  LowLevelSpawnInput,
  PodDescriptor,
  SpawnEvents,
  SpawnState,
} from './low-level-spawn.ts';

export { AgentRunRegistry } from './agent-run-registry.ts';
export type {
  AdmissionTicket,
  TicketState,
  AgentRunRegistryOptions,
} from './agent-run-registry.ts';

export { AgentRun } from './agent-run.ts';
export type {
  AgentRunState,
  AgentRunPolicy,
  AgentRunTurnState,
  AgentRunFailureCause,
  AgentRunRecord,
  AgentRunInput,
  AgentRunDeps,
  SpawnFactory,
  SpawnLike,
} from './agent-run.ts';

// ☠ Step-4 Slice 2 (2026-06-04) — InteractiveSession DELETED. The orchestrator
// chat is an Engine-owned `persistent-interactive` AgentRun behind the
// server's OrchestratorHostSession adapter; transient modals stay on
// PtySession until P7 deletes them (FD-21).

export { AgentRunJsonlTailer } from './agent-run-jsonl-tailer.ts';
export type {
  AgentRunJsonlEvent,
  AgentRunJsonlEventKind,
  JsonlTailerOptionsForAgentRun,
} from './agent-run-jsonl-tailer.ts';

// ── Out-of-process agent host (durable crash isolation) — v2 protocol ─────

export type {
  AgentHostCommand,
  AgentHostCommandErrorCode,
  AgentHostCommandResponse,
  AgentHostEvent,
  AgentHostIdentity,
  AgentHostResumeRunRequest,
  AgentHostRunSnapshot,
  AgentHostRunState,
  AgentHostStartRunRequest,
  AgentHostTerminalResult,
} from './agent-host-protocol.ts';

export {
  AGENT_HOST_LOCK_DIR,
  AGENT_HOST_LOCK_FILE,
  AGENT_HOST_PROTOCOL_VERSION,
  agentHostLockFilePath,
  agentHostLockFromIdentity,
  discoverAgentHostEndpoint,
  parseAgentHostLockFile,
  readAgentHostLockFile,
  removeAgentHostLockFile,
  writeAgentHostLockFile,
} from './agent-host-lock-file.ts';
export type {
  AgentHostEndpoint,
  AgentHostLockFile,
} from './agent-host-lock-file.ts';
