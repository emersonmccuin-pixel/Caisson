// Section 25 — runtime barrel (post-Phase-E bare names).
//
// ☠ Step 6 (P8, 2026-06-04) — PtySession DELETED (with terminalBufferLooksReady,
// stripAnsi, SessionState, the stop-marker/events file-watching, and the dead
// AgentRun reattach lane). ONE primitive remains: LowLevelSpawn + AgentRun
// (ReadyGate is the one ready-detector; JsonlTailer the one transcript reader).

export { JsonlTailer } from './jsonl-tailer.ts';
export type {
  JsonlEvent,
  JsonlEventMeta,
  JsonlReplayMeta,
  JsonlReplaySource,
  JsonlTailerOptions,
} from './jsonl-tailer.ts';

export {
  attachWorktree,
  createWorktree,
  destroyWorktree,
  ensureDevWorktree,
  gitMergeState,
  getWorktreeStatus,
  listWorktrees,
  mergeBranchIntoDev,
  pruneWorktrees,
  pushBranch,
} from './worktree.ts';
export type { GitMergeState, WorktreeEntry } from './worktree.ts';

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
export { resolveNodeLauncher, nodeShellCommand } from './node-launcher.ts';
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
// server's OrchestratorHostSession adapter. (The transient modals followed in
// P7, and PtySession itself in Step 6 — see header.)

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
