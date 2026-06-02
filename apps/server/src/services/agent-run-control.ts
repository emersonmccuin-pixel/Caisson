// Operator controls for in-process agent runs: inspect (peek) + hard-kill.
//
// Both work off the persisted DB row (+ pid), NOT the in-memory registry, so
// they function on a PHANTOM run whose handle was lost — the gap that made the
// old /cancel route 404 on dead runs (pc-pty-chat-114). Hard-kill: best-effort
// graceful cancel through the registry if present, force-kill the persisted pid
// regardless, then finalize the row to `cancelled` via the shared terminal
// effects (idempotent; emits agent-failed + rail broadcast).

import { existsSync, statSync } from 'node:fs';

import type { AgentRunRow, AgentRunStatus, ULID } from '@pc/domain';
import {
  getAgentRunRow as defaultGetAgentRunRow,
  getProjectById as defaultGetProjectById,
} from '@pc/db';
import { AgentRunJsonlTailer, jsonlPathFor, type AgentRunJsonlEvent } from '@pc/runtime';

import type { ActiveRunRegistry } from './agent-active-runs.ts';
import type { MailboxEnqueuePort } from './agent-delivery.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';
import { applyAgentRunTerminalEffects } from './agent-run-terminal-effects.ts';
import {
  isProcessAlive as defaultIsAlive,
  killProcessTree as defaultKill,
} from './process-control.ts';

export interface AgentRunControlDeps {
  activeRunRegistry?: ActiveRunRegistry;
  /** Mailbox enqueue port — a force-killed run delivers its terminal envelope
   *  to the orchestrator through it. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  /** T1.3 — the live HostConnection. When present, kill issues the awaited host
   *  cancel that actually terminates the host child (host-backed runs persist no
   *  server-side pid, so the local pid-kill is a no-op for them). */
  host?: AgentHostReattachClient | null;
  broadcast?: (projectId: ULID, msg: unknown) => void;
  now?: () => number;
  getAgentRun?: (id: ULID) => AgentRunRow | null;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
  resolveJsonlPath?: (row: AgentRunRow) => string | null;
  applyTerminalEffects?: typeof applyAgentRunTerminalEffects;
}

export type HardKillResult =
  | {
      ok: true;
      status: AgentRunStatus;
      alreadyTerminal: boolean;
      /** A real local OS-process tree kill happened (in-process runs). */
      processKilled: boolean;
      /** T1.3 — the host accepted a `cancel` / `cancel-workflow-subagent`. For a
       *  host-backed run (pid null) this — not `processKilled` — is the signal
       *  that compute was actually stopped. */
      hostCancelled: boolean;
    }
  | { ok: false; error: string };

/** A workflow-spawned subagent's `agent_runs` row carries its `pcSessionId` as
 *  the dispatcherSessionId (`dag-run-service.ts` — `wf-<run>-<node>-<rand>`). It
 *  is NEVER in the active-run registry and the host tracks it by `pcSessionId`,
 *  so the right host stop is `cancel-workflow-subagent`, not `cancel runId`. */
function isWorkflowSubagentRow(row: AgentRunRow): boolean {
  return row.dispatcherSessionId.startsWith('wf-');
}

const TERMINAL: AgentRunStatus[] = ['completed', 'failed', 'cancelled'];

/** Force-end a run: kill the real OS process (if any) AND finalize the row to
 *  `cancelled`. Idempotent — a second call on an already-terminal run is a
 *  no-op success. Works on phantoms (no registry entry / dead process). */
export async function hardKillAgentRun(
  runId: ULID,
  deps: AgentRunControlDeps = {},
): Promise<HardKillResult> {
  const getRow = deps.getAgentRun ?? defaultGetAgentRunRow;
  const row = getRow(runId);
  if (!row) return { ok: false, error: `unknown run: ${runId}` };
  if (TERMINAL.includes(row.status)) {
    return {
      ok: true,
      status: row.status,
      alreadyTerminal: true,
      processKilled: false,
      hostCancelled: false,
    };
  }

  // 1. Graceful: if the live handle is still registered, let it tear down its
  //    own spawn (Ctrl-C + grace). Best-effort.
  const entry = deps.activeRunRegistry?.get(runId);
  if (entry) {
    try {
      entry.run.cancel();
    } catch {
      /* fall through to force-kill */
    }
  }

  // 1b. T1.3 — AWAIT the host stop. This is what actually terminates host-backed
  //     compute (those runs persist no server-side pid, so step 2 is a no-op for
  //     them). Workflow subagents are tracked by pcSessionId → cancel-workflow-
  //     subagent; all other host runs → cancel runId. Errors are swallowed: the
  //     local kill + idempotent finalize remain the net.
  let hostCancelled = false;
  if (deps.host) {
    try {
      const command = isWorkflowSubagentRow(row)
        ? ({ type: 'cancel-workflow-subagent', pcSessionId: row.dispatcherSessionId } as const)
        : ({ type: 'cancel', runId } as const);
      const response = await Promise.resolve(deps.host.sendCommand(command));
      hostCancelled = !response || response.ok === true;
    } catch {
      /* swallow — local kill + finalize below converge the row regardless */
    }
  }

  // 2. Force: kill the persisted pid's process tree regardless. This is what
  //    makes kill real for a wedged/handle-lost in-process run. Host runs have a
  //    null pid (host owns the child) so this is a harmless no-op for them.
  const kill = deps.killProcess ?? defaultKill;
  let processKilled = false;
  if (row.pid !== null) {
    kill(row.pid);
    processKilled = true;
  }

  // 3. Finalize the row to cancelled with full effects (idempotent). Skip
  //    verification (workItemId null). slug derived from project inside.
  (deps.applyTerminalEffects ?? applyAgentRunTerminalEffects)(
    {
      runId: row.id,
      ccSessionId: row.ccSessionId,
      podName: row.podName,
      projectId: row.projectId,
      dispatcherSessionId: row.dispatcherSessionId,
      parentWorkItemId: row.parentWorkItemId,
      worktreeDir: '',
      status: 'cancelled',
      failureCause: 'cancelled',
      completedAt: (deps.now ?? Date.now)(),
      startedAt: row.queuedAt,
      workItemId: null,
      slug: null,
    },
    {
      activeRunRegistry: deps.activeRunRegistry,
      mailboxEnqueue: deps.mailboxEnqueue,
      broadcast: deps.broadcast,
      now: deps.now,
    },
  );

  return { ok: true, status: 'cancelled', alreadyTerminal: false, processKilled, hostCancelled };
}

export interface AgentRunInspection {
  runId: ULID;
  status: AgentRunStatus;
  pid: number | null;
  processAlive: boolean | null;
  lastActivityAt: number | null;
  idleMs: number | null;
  queuedAt: number;
  spawnedAt: number | null;
  readyAt: number | null;
  failureCause: string | null;
  failureReason: string | null;
  /** Last JSONL event kind + short text, or null if no transcript yet. */
  lastAction: { kind: string; at: number | null; text: string | null } | null;
  jsonlPath: string | null;
}

export type InspectResult =
  | { ok: true; inspection: AgentRunInspection }
  | { ok: false; error: string };

/** Peek: current status + pid liveness + how long since last activity + the
 *  last thing the agent did. The "is it working or wedged?" read. */
export function inspectAgentRun(runId: ULID, deps: AgentRunControlDeps = {}): InspectResult {
  const getRow = deps.getAgentRun ?? defaultGetAgentRunRow;
  const row = getRow(runId);
  if (!row) return { ok: false, error: `unknown run: ${runId}` };

  const now = (deps.now ?? Date.now)();
  const isAlive = deps.isProcessAlive ?? defaultIsAlive;
  const jsonlPath = (deps.resolveJsonlPath ?? defaultResolveJsonlPath)(row);

  const mtime = jsonlPath && existsSync(jsonlPath) ? safeMtime(jsonlPath) : null;
  const lastActivityAt = maxOrNull([
    row.lastActivityAt,
    row.readyAt,
    row.spawnedAt,
    row.queuedAt,
    mtime,
  ]);

  const lastAction = jsonlPath ? lastJsonlAction(jsonlPath) : null;

  return {
    ok: true,
    inspection: {
      runId: row.id,
      status: row.status,
      pid: row.pid,
      processAlive: row.pid !== null ? isAlive(row.pid) : null,
      lastActivityAt,
      idleMs: lastActivityAt !== null ? now - lastActivityAt : null,
      queuedAt: row.queuedAt,
      spawnedAt: row.spawnedAt,
      readyAt: row.readyAt,
      failureCause: row.failureCause,
      failureReason: row.failureReason,
      lastAction,
      jsonlPath,
    },
  };
}

function lastJsonlAction(
  jsonlPath: string,
): { kind: string; at: number | null; text: string | null } | null {
  if (!existsSync(jsonlPath)) return null;
  const events: AgentRunJsonlEvent[] = [];
  const tailer = new AgentRunJsonlTailer({ filePath: jsonlPath, pollIntervalMs: 60_000 });
  tailer.on('event', (e: AgentRunJsonlEvent) => events.push(e));
  tailer.drainAvailable();
  tailer.stop();
  tailer.removeAllListeners();
  const last = events.at(-1);
  if (!last) return null;
  const rec = last as unknown as Record<string, unknown>;
  const kind = String(rec.kind ?? rec.type ?? 'event');
  const at = typeof rec.ts === 'number' ? rec.ts : null;
  const text = typeof rec.text === 'string' ? rec.text.slice(0, 200) : null;
  return { kind, at, text };
}

function defaultResolveJsonlPath(row: AgentRunRow): string | null {
  try {
    const project = defaultGetProjectById(row.projectId);
    return project ? jsonlPathFor(project.folderPath, row.ccSessionId) : null;
  } catch {
    return null;
  }
}

function safeMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function maxOrNull(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number');
  return nums.length ? Math.max(...nums) : null;
}
