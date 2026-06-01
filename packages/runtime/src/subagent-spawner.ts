// Section 25 Session 10 — workflow runtime subagent spawner, v2.
//
// Drop-in replacement for v1 `spawnSubagent`. Public surface — `spawnSubagent`,
// `SubagentSpawnHandle`, `SubagentSpawnRequest`, `SubagentSpawnResult` —
// matches v1 byte-for-byte so the workflow-runtime swap is mechanical and
// every test fake in `workflow-firing-smoke.test.ts` keeps working unchanged.
//
// Internals: uses Session 5's `LowLevelSpawn` instead of `PtySession`. Gains
// the v2 ready gate (handshake + composer-ready), bracketed
// paste + echo-ack send, deterministic JSONL path (via --session-id), ANSI
// scrub. Workflow-specific concerns (pc_complete_node / pc_node_failed
// detection, idle + wall-clock timers, materialised pod cleanup) live here
// rather than in `AgentRun` — workflow nodes don't compete for the global
// AgentRun cap and don't surface in the Activity Panel, so reusing `AgentRun`
// would add coupling without benefit.
//
// MCP handshake: LowLevelSpawn's subagent ready gate requires an MCP handshake
// notification. Workflow subagents aren't in the v2 active-runs
// registry (that registry is scoped to dispatched agents the orchestrator
// owns), so they need an alternate routing path. The spawner accepts a
// `registerHandshakeListener` dep — the workflow-runtime layer wires it to
// the apps/server `workflow-subagent-handshake` module which the
// /api/internal/mcp-handshake route consults after v2 active-runs and
// before v1 fallback.
//
// At Phase D (Session 11) v1 `subagent-spawner.ts` + its tests die; this
// module survives. Filename keeps the `-v2` suffix until that cutover to
// make the parallel-build invariant obvious.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { EventEmitter } from 'node:events';
import { LowLevelSpawn, type LowLevelSpawnInput } from './low-level-spawn.ts';
import type { SpawnLike } from './agent-run.ts';
import type { JsonlEvent } from './jsonl-tailer.ts';
import type { SessionState } from './pty-session.ts';

export type SubagentSpawnFailureCause =
  | 'spawn-error'
  | 'idle-timeout'
  | 'wall-clock-timeout'
  | 'empty-turn'
  | 'mcp-tool-error'
  | 'killed';

export interface SubagentSpawnRequest {
  /** Agent name → `--agent <name>`. claude.exe reads frontmatter (tools,
   *  model, prompt) from `<worktree>/.claude/agents/<name>.md`. */
  agentName: string;
  /** Worktree path. cwd for the spawned helper. */
  worktreeDir: string;
  /** Initial input sent after the helper reaches banner-ready. */
  initialInput: string;
  /** Per-dispatch session data dir. Spawner writes stop-markers, events.jsonl,
   *  transcript.log inside. Caller mints + creates the dir. */
  sessionDataDir: string;
  /** PC_SESSION_ID env var. Stop / event-capture / ask-intercept hooks route
   *  writes back into `sessionDataDir/sessions/<pcSessionId>/…`. */
  pcSessionId: string;
  /** Optional override of the default `--model opus`. */
  model?: string;
  /** D47 idle cutoff. Default 300_000 (5 min). */
  idleTimeoutMs?: number;
  /** D47 wall-clock fail-safe. Default 7_200_000 (2 h). */
  wallClockTimeoutMs?: number;
  /** Override the claude.exe path. */
  claudeExe?: string;
  /** Extra env vars merged on top of PC_SESSION_ID. */
  extraEnv?: Record<string, string>;
  /** JSONL paths claimed by prior or sibling dispatches in the same worktree. */
  excludeJsonlPaths?: readonly string[];
  /** Override `--mcp-config` for the spawn. */
  mcpConfigPath?: string;
  /** Absolute path to PC's session-local Claude settings file. */
  settingsPath?: string;
  /** Passed to `--setting-sources`. */
  settingSources?: string;
  /** Session-local Claude plugin dirs. */
  pluginDirs?: readonly string[];
}

export interface SubagentSpawnSuccess {
  kind: 'success';
  /** Concatenated text blocks from the final assistant message. */
  lastAssistantText: string;
  /** Structured payload passed to pc_complete_node, if the helper called it. */
  pcCompletePayload: unknown | null;
  /** Absolute path to the transcript file on disk. */
  transcriptPath: string;
  /** Absolute path to the JSONL file claude.exe wrote into. */
  jsonlPath: string | null;
}

export interface SubagentSpawnFailure {
  kind: 'failure';
  cause: SubagentSpawnFailureCause;
  message: string;
  transcriptPath: string;
  jsonlPath: string | null;
  partialAssistantText: string;
}

export type SubagentSpawnResult = SubagentSpawnSuccess | SubagentSpawnFailure;

export interface SubagentSpawnHandle {
  /** Resolves once on success or failure. Never rejects. */
  done: Promise<SubagentSpawnResult>;
  /** Force-kill the dispatch. No-op if already resolved. */
  kill(reason?: string): void;
  /** Transcript path on disk. */
  transcriptPath(): string;
  /** JSONL path once discovery resolved; null until then. */
  jsonlPath(): string | null;
}

/** Minimal session shape used by legacy callers + tests. */
export interface SubagentSessionLike extends EventEmitter {
  send(text: string): void;
  kill(): void;
  getState(): SessionState;
}

/** Workflow-spawner deps. */
export interface SubagentSpawnerDeps {
  /** Override the LowLevelSpawn factory. Tests inject an EventEmitter
   *  that satisfies `SpawnLike` and synthesises lifecycle events. */
  createLowLevelSpawn?: (input: LowLevelSpawnInput) => SpawnLike;
  /** Wired by apps/server. Called once after the spawn starts; the returned
   *  unregister callback fires on dispatch resolution. Default = no-op so
   *  tests don't need to mock it. The HTTP-side `workflow-subagent-handshake`
   *  module owns the underlying map; this is just the injection seam. */
  registerHandshakeListener?: (
    ccSessionId: string,
    notify: () => void,
  ) => () => void;
  /** Override setTimeout for deterministic tests. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Override clearTimeout for deterministic tests. */
  clearTimeout?: (handle: unknown) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const PC_COMPLETE_NODE_TOOL = 'mcp__pc-rig__pc_complete_node';
const PC_NODE_FAILED_TOOL = 'mcp__pc-rig__pc_node_failed';

/** v2 workflow subagent spawn. Same public surface as v1 `spawnSubagent`. */
export function spawnSubagent(
  req: SubagentSpawnRequest,
  deps: SubagentSpawnerDeps = {},
): SubagentSpawnHandle {
  const createSpawn =
    deps.createLowLevelSpawn ??
    ((input: LowLevelSpawnInput) =>
      new LowLevelSpawn(input) as unknown as SpawnLike);
  const registerHandshake =
    deps.registerHandshakeListener ?? (() => () => {});
  const setTimeoutImpl: (cb: () => void, ms: number) => unknown =
    deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
  const clearTimeoutImpl: (handle: unknown) => void =
    deps.clearTimeout ??
    ((h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>));

  const idleTimeoutMs = req.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const wallClockTimeoutMs = req.wallClockTimeoutMs ?? DEFAULT_WALL_CLOCK_TIMEOUT_MS;

  const transcriptPath = resolve(req.sessionDataDir, 'transcript.log');
  // ccProviderSessionId is what LowLevelSpawn passes via --session-id; CC
  // writes its on-disk JSONL at the deterministic path keyed off this UUID.
  const ccProviderSessionId = randomUUID();

  let resolvedJsonlPath: string | null = null;
  let lastAssistantText = '';
  let pcCompletePayload: unknown | null = null;
  let pcNodeFailedReason: string | null = null;
  let resolved = false;
  let spawn: SpawnLike | null = null;
  let idleTimer: unknown = null;
  let wallClockTimer: unknown = null;
  let unregisterHandshake: (() => void) | null = null;

  let resolveDone!: (result: SubagentSpawnResult) => void;
  const done = new Promise<SubagentSpawnResult>((res) => {
    resolveDone = res;
  });

  const cleanup = (): void => {
    if (idleTimer) clearTimeoutImpl(idleTimer);
    if (wallClockTimer) clearTimeoutImpl(wallClockTimer);
    idleTimer = null;
    wallClockTimer = null;
    if (unregisterHandshake) {
      try { unregisterHandshake(); } catch { /* best-effort */ }
      unregisterHandshake = null;
    }
    if (spawn) {
      try { spawn.kill(); } catch { /* best-effort */ }
    }
  };

  const finalize = (result: SubagentSpawnResult): void => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolveDone(result);
  };

  const fail = (cause: SubagentSpawnFailureCause, message: string): void => {
    finalize({
      kind: 'failure',
      cause,
      message,
      transcriptPath,
      jsonlPath: resolvedJsonlPath,
      partialAssistantText: lastAssistantText,
    });
  };

  const succeedFromTurnEnd = (turnEndText: string): void => {
    lastAssistantText = turnEndText;
    if (pcNodeFailedReason !== null) {
      finalize({
        kind: 'failure',
        cause: 'mcp-tool-error',
        message: `helper called pc_node_failed: ${pcNodeFailedReason}`,
        transcriptPath,
        jsonlPath: resolvedJsonlPath,
        partialAssistantText: lastAssistantText,
      });
      return;
    }
    if (turnEndText.trim() === '' && pcCompletePayload === null) {
      fail('empty-turn', 'helper produced no output before turn end');
      return;
    }
    finalize({
      kind: 'success',
      lastAssistantText,
      pcCompletePayload,
      transcriptPath,
      jsonlPath: resolvedJsonlPath,
    });
  };

  const resetIdleTimer = (): void => {
    if (resolved) return;
    if (idleTimer) clearTimeoutImpl(idleTimer);
    idleTimer = setTimeoutImpl(() => {
      fail(
        'idle-timeout',
        `helper idle for ${Math.round(idleTimeoutMs / 1000)}s — likely hung`,
      );
    }, idleTimeoutMs);
  };

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(req.extraEnv ?? {}),
    PC_SESSION_ID: req.pcSessionId,
    // Section 22's ready-gate requires three signals incl. the MCP handshake.
    // pc-rig's `server.oninitialized` only POSTs to /api/internal/mcp-handshake
    // when BOTH `PC_PROJECT_ID` AND `PC_AGENT_SESSION_ID` are set in its env.
    // Setting this to `ccProviderSessionId` matches the value the spawner
    // registers in `registerWorkflowSubagentHandshake` (see below), so the
    // handshake routes back through `notifyWorkflowSubagentHandshake` →
    // `spawn.notifyMcpHandshake()` → gate opens. Without this, the gate hangs
    // until the ready-timeout (default 60s) and the workflow node fails with
    // `spawn-error: ready failed: ready-gate aborted (ready-timeout)`.
    // Surfaced by the Section 19.14 D39 agent-node live-fire smoke.
    PC_AGENT_SESSION_ID: ccProviderSessionId,
  };

  const llsInput: LowLevelSpawnInput = {
    podDefinition: { name: req.agentName },
    worktreePath: req.worktreeDir,
    env,
    ccProviderSessionId,
    mode: 'fresh',
    mcpConfigPath: req.mcpConfigPath,
    settingsPath: req.settingsPath,
    settingSources: req.settingSources,
    pluginDirs: req.pluginDirs,
    claudeExe: req.claudeExe,
    transcriptPath,
  };

  try {
    spawn = createSpawn(llsInput);
  } catch (err) {
    queueMicrotask(() => fail('spawn-error', errorMessage(err)));
    return {
      done,
      kill: (reason) => {
        if (resolved) return;
        fail('killed', reason ?? 'killed by runtime');
      },
      transcriptPath: () => transcriptPath,
      jsonlPath: () => null,
    };
  }

  // JSONL event handling — same workflow-specific signals as v1.
  spawn.on('jsonl-event', (ev: JsonlEvent) => {
    resetIdleTimer();
    if (ev.kind === 'jsonl-tool-call') {
      if (ev.name === PC_COMPLETE_NODE_TOOL) {
        const input = ev.input as Record<string, unknown> | null;
        if (input && 'output' in input) {
          pcCompletePayload = (input as { output: unknown }).output;
        } else {
          pcCompletePayload = null;
        }
      } else if (ev.name === PC_NODE_FAILED_TOOL) {
        const input = ev.input as Record<string, unknown> | null;
        if (input && typeof input.reason === 'string') {
          pcNodeFailedReason = input.reason;
        } else {
          pcNodeFailedReason = '(no reason given)';
        }
      }
      return;
    }
    if (ev.kind === 'jsonl-turn-end') {
      succeedFromTurnEnd(ev.text);
    }
  });

  // Reset the idle timer on ANY raw output, not only completed JSONL messages.
  // A long thinking / composing turn streams PTY output continuously but writes
  // no new transcript line for minutes; keying idle off jsonl-events alone
  // false-killed healthy agents mid-turn. The 2h wall-clock cap remains the hard
  // ceiling for genuinely-stuck runs that emit no output at all.
  spawn.on('raw', () => resetIdleTimer());

  spawn.on('exit', (code: number | null, signal: number | null) => {
    if (resolved) return;
    fail(
      'spawn-error',
      `helper exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
    );
  });

  // Wall-clock + idle timers before start — fires even if spawn hangs forever.
  wallClockTimer = setTimeoutImpl(() => {
    fail(
      'wall-clock-timeout',
      `helper exceeded wall-clock cap of ${Math.round(wallClockTimeoutMs / 1000)}s`,
    );
  }, wallClockTimeoutMs);
  resetIdleTimer();

  // JSONL path is deterministic — known up-front, before spawn even produces
  // any output. Snapshot it now so callers polling `jsonlPath()` see a
  // value the moment spawn returns. Falls back to null if the v1 fake
  // doesn't implement getJsonlPath (it's only on the v2 SpawnLike surface).
  try {
    resolvedJsonlPath = spawn.getJsonlPath();
  } catch {
    resolvedJsonlPath = null;
  }

  spawn.start();

  // Wire MCP handshake routing AFTER start. The HTTP-side registry forwards
  // /api/internal/mcp-handshake POSTs to spawn.notifyMcpHandshake().
  unregisterHandshake = registerHandshake(ccProviderSessionId, () => {
    try { spawn?.notifyMcpHandshake(); } catch { /* best-effort */ }
  });

  // Async chain: wait for ready, then deliver the initialInput. Errors funnel
  // into fail() — `done` never rejects.
  spawn
    .awaitReady()
    .then(async () => {
      if (resolved || !spawn) return;
      try {
        const result = await spawn.send(req.initialInput);
        if (result !== 'ok' && !resolved) {
          fail('spawn-error', `send initialInput returned ${result}`);
        }
      } catch (err) {
        if (resolved) return;
        fail('spawn-error', `send initialInput failed: ${errorMessage(err)}`);
      }
    })
    .catch((err) => {
      if (resolved) return;
      fail('spawn-error', `ready failed: ${errorMessage(err)}`);
    });

  return {
    done,
    kill: (reason) => {
      if (resolved) return;
      fail('killed', reason ?? 'killed by runtime');
    },
    transcriptPath: () => transcriptPath,
    jsonlPath: () => resolvedJsonlPath,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
