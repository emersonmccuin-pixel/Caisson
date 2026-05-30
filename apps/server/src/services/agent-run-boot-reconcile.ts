import { existsSync } from 'node:fs';

import {
  AGENT_RUN_FAILURE_CAUSES,
  type AgentRunFailureCause,
  type AgentRunRow,
  type ULID,
} from '@pc/domain';
import type { AgentHostRunSnapshot } from '@pc/runtime';
import { jsonlPathFor } from '@pc/runtime';

import { announceAgentRunChange } from './agent-run-writer.ts';
import {
  getProjectById as defaultGetProjectById,
  hasOpenPendingAskForRun as defaultHasOpenPendingAskForRun,
  listAndReconcileOrphanedRuns as defaultListAndReconcile,
  listNonTerminalAgentRuns as defaultListNonTerminalAgentRuns,
  markAgentRunTerminal as defaultMarkAgentRunTerminal,
  reconcileOrphanedRunningRuns as defaultLegacyReconcile,
  updateAgentRunStatus as defaultUpdateAgentRunStatus,
} from '@pc/db';

export interface AgentRunHostSnapshotClient {
  listRuns(): readonly AgentHostRunSnapshot[];
}

export interface AgentRunBootReconcileDeps {
  now?: () => number;
  hostClient?: AgentRunHostSnapshotClient | null;
  legacyReconcile?: (now: number) => number;
  /** Announcing variant of the legacy reconcile — lists rows, bulk-updates,
   *  reads them back, and returns updated rows for announcement. When supplied,
   *  the legacy path broadcasts `agent-run-changed` for each affected row. */
  listAndReconcile?: (now: number) => AgentRunRow[];
  listNonTerminalRuns?: () => AgentRunRow[];
  hasOpenPendingAskForRun?: (runId: ULID) => boolean;
  resolveJsonlPath?: (row: AgentRunRow) => string | null;
  jsonlExists?: (path: string) => boolean;
  markTerminal?: typeof defaultMarkAgentRunTerminal;
  updateStatus?: typeof defaultUpdateAgentRunStatus;
  /** Broadcast hook — receives `agent-run-changed` envelopes for reconciled
   *  rows so the right rail shows the failure without a client refresh. */
  broadcast?: (projectId: ULID, msg: unknown) => void;
}

export interface AgentRunBootReconcileResult {
  mode: 'legacy' | 'host';
  hostRuns: number;
  checked: number;
  kept: number;
  failed: number;
  updated: number;
  reconciled: number;
}

const HOST_LOST_REASON = 'agent host no longer owns this non-terminal run';
const HOST_PROTOCOL_REASON = 'agent host snapshot did not match the database run row';

/**
 * Boot-time agent-run reconciliation.
 *
 * Current production has no out-of-process host, so the default path preserves
 * the legacy blanket sweep. When a host client is supplied, this reconciles DB
 * rows against host-owned live PTYs instead of assuming every non-terminal row
 * is dead.
 */
export function reconcileAgentRunsOnBoot(
  deps: AgentRunBootReconcileDeps = {},
): AgentRunBootReconcileResult {
  const now = (deps.now ?? Date.now)();
  const hostClient = deps.hostClient ?? null;

  if (!hostClient) {
    const listAndReconcile = deps.listAndReconcile ?? defaultListAndReconcile;
    const legacyReconcile = deps.legacyReconcile;

    if (deps.broadcast) {
      // Announcing path: list rows, bulk-update, then announce each through the
      // gateway (slice 005) so the durable agent.run.changed (reason:'reconciled')
      // fact lands in the live_outbox + the right rail reflects the
      // server-restart failure without a refresh. The row flip already happened
      // in `listAndReconcile`; `announceAgentRunChange` re-reads for the rev.
      const affectedRows = listAndReconcile(now);
      const broadcast = deps.broadcast;
      for (const row of affectedRows) {
        announceAgentRunChange(
          { runId: row.id, reason: 'reconciled', startedAt: row.queuedAt },
          (event) => broadcast(row.projectId, event),
        );
      }
      const reconciled = affectedRows.length;
      return {
        mode: 'legacy',
        hostRuns: 0,
        checked: 0,
        kept: 0,
        failed: reconciled,
        updated: 0,
        reconciled,
      };
    }

    // No broadcast dep — use plain count-only reconcile.
    const reconciled = (legacyReconcile ?? defaultLegacyReconcile)(now);
    return {
      mode: 'legacy',
      hostRuns: 0,
      checked: 0,
      kept: 0,
      failed: reconciled,
      updated: 0,
      reconciled,
    };
  }

  const hostRuns = hostClient.listRuns();
  const hostByRunId = new Map(hostRuns.map((run) => [run.runId, run]));
  const rows = (deps.listNonTerminalRuns ?? defaultListNonTerminalAgentRuns)();
  const hasOpenAsk = deps.hasOpenPendingAskForRun ?? defaultHasOpenPendingAskForRun;
  const resolveJsonlPath = deps.resolveJsonlPath ?? defaultResolveJsonlPath;
  const jsonlExists = deps.jsonlExists ?? existsSync;
  const markTerminal = deps.markTerminal ?? defaultMarkAgentRunTerminal;
  const updateStatus = deps.updateStatus ?? defaultUpdateAgentRunStatus;

  let kept = 0;
  let failed = 0;
  let updated = 0;

  for (const row of rows) {
    const hostRun = hostByRunId.get(row.id);
    if (hostRun) {
      if (!hostSnapshotMatchesRow(row, hostRun)) {
        markTerminal({
          id: row.id,
          status: 'failed',
          result: null,
          failureCause: 'host-protocol-error',
          failureReason: HOST_PROTOCOL_REASON,
          completedAt: now,
        });
        failed += 1;
        continue;
      }

      if (isTerminalState(hostRun.state)) {
        const terminal = hostRun.terminalResult;
        const terminalStatus = terminal?.status ?? hostRun.state;
        markTerminal({
          id: row.id,
          status: terminalStatus,
          result: terminalStatus === 'completed' ? terminal?.result ?? '' : null,
          failureCause:
            terminalStatus === 'completed'
              ? null
              : coerceFailureCause(terminal?.failureCause) ?? 'host-protocol-error',
          failureReason:
            terminalStatus === 'completed'
              ? null
              : terminal?.failureReason ?? terminal?.failureCause ?? HOST_PROTOCOL_REASON,
          completedAt: hostRun.terminalAt ?? now,
        });
        updated += 1;
        continue;
      }

      kept += 1;
      if (shouldUpdateFromHost(row, hostRun)) {
        updateStatus({
          id: row.id,
          status: hostRun.state,
          ...(hostRun.spawnedAt !== null ? { spawnedAt: hostRun.spawnedAt } : {}),
          ...(hostRun.readyAt !== null ? { readyAt: hostRun.readyAt } : {}),
        });
        updated += 1;
      }
      continue;
    }

    // Paused runs are allowed to have no live PTY: Claude exits cleanly while
    // waiting on a pending ask, then resumes from JSONL when answered.
    const jsonlPath = row.status === 'paused' ? resolveJsonlPath(row) : null;
    if (
      row.status === 'paused' &&
      hasOpenAsk(row.id) &&
      jsonlPath !== null &&
      jsonlExists(jsonlPath)
    ) {
      kept += 1;
      continue;
    }

    markTerminal({
      id: row.id,
      status: 'failed',
      result: null,
      failureCause: 'host-lost',
      failureReason: HOST_LOST_REASON,
      completedAt: now,
    });
    failed += 1;
  }

  return {
    mode: 'host',
    hostRuns: hostRuns.length,
    checked: rows.length,
    kept,
    failed,
    updated,
    reconciled: failed + updated,
  };
}

function defaultResolveJsonlPath(row: AgentRunRow): string | null {
  const project = defaultGetProjectById(row.projectId);
  return project ? jsonlPathFor(project.folderPath, row.ccSessionId) : null;
}

function hostSnapshotMatchesRow(
  row: AgentRunRow,
  hostRun: AgentHostRunSnapshot,
): boolean {
  return (
    hostRun.runId === row.id &&
    hostRun.projectId === row.projectId &&
    hostRun.dispatcherSessionId === row.dispatcherSessionId &&
    hostRun.ccSessionId === row.ccSessionId &&
    hostRun.podName === row.podName
  );
}

function shouldUpdateFromHost(
  row: AgentRunRow,
  hostRun: AgentHostRunSnapshot,
): boolean {
  return (
    row.status !== hostRun.state ||
    (hostRun.spawnedAt !== null && row.spawnedAt !== hostRun.spawnedAt) ||
    (hostRun.readyAt !== null && row.readyAt !== hostRun.readyAt)
  );
}

function isTerminalState(
  state: AgentHostRunSnapshot['state'],
): state is 'completed' | 'failed' | 'cancelled' {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function coerceFailureCause(value: string | null | undefined): AgentRunFailureCause | null {
  if (!value) return null;
  return (AGENT_RUN_FAILURE_CAUSES as readonly string[]).includes(value)
    ? (value as AgentRunFailureCause)
    : null;
}
