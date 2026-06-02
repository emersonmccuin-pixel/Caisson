// Section 16b.7 — Agent-comms audit trail writer.
//
// One function per agent-comms event kind. Each builds a
// `WorkItemHistoryEntry` and appends it to the parent work item via the
// repo's `appendWorkItemHistory` writer.
//
// Audit rows are informational, not load-bearing for the primary tool
// effect (the pending-ask is already minted, the run is already spawned).
// Every writer below is best-effort: NOOPs when `workItemId` is null,
// swallows DB errors so a write failure can't break an MCP tool call.
// The work-item Activity tab consumes these via the public WorkItem shape
// (see packages/db/src/repos/work-items.ts → toDomain).

import { appendWorkItemHistory } from '@pc/db';
import type { ULID, WorkItemHistoryEntry } from '@pc/domain';

const SUMMARY_MAX = 200;

function clip(text: string, max: number = SUMMARY_MAX): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + '…';
}

function safeAppend(workItemId: ULID, entry: WorkItemHistoryEntry): void {
  try {
    appendWorkItemHistory(workItemId, entry);
  } catch (err) {
    // Audit failures must not break the primary tool effect. Log + swallow.
    console.warn(
      `[agent-audit] append failed for work item ${workItemId} (${entry.kind}):`,
      (err as Error).message,
    );
  }
}

function ts(now: number): string {
  return new Date(now).toISOString();
}

export interface RecordInvokeInput {
  workItemId: ULID | null;
  agentName: string;
  sessionId: string;
  runId: ULID;
  mode: 'sync' | 'async';
  input: string;
  now: number;
}

export function recordAgentInvoke(input: RecordInvokeInput): void {
  if (!input.workItemId) return;
  const note =
    input.mode === 'sync'
      ? `Invoked ${input.agentName} (sync) — ${clip(input.input)}`
      : `Dispatched ${input.agentName} (async) — ${clip(input.input)}`;
  safeAppend(input.workItemId, {
    ts: ts(input.now),
    kind: 'agent-invoke',
    agentName: input.agentName,
    sessionId: input.sessionId,
    runId: input.runId,
    invokeMode: input.mode,
    note,
  });
}

