// Compatibility adapters for the agent-run family (slice 005).
//
// Pure mappers between the @pc/domain AgentRunRow / PendingAskRow shapes and
// the shared @pc/contracts DTOs. The legacy `agent-run-changed` record had no
// pod-row model lookup — it hard-coded `'opus'`; the DTO mirrors that so the
// legacy adapter stays lossless. Boundary purity: @pc/contracts + @pc/domain.

import type { AgentRunDto, PendingAskDto } from '@pc/contracts';
import type { AgentRunRow, PendingAskRow } from '@pc/domain';

export class AgentRunAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunAdapterError';
  }
}

/** v1 Activity-Panel card model pill — the row carries no model, so mirror the
 *  legacy pod-less-spawn fallback. */
const DEFAULT_MODEL = 'opus';

/** AgentRunRow → AgentRunDto. `startedAt` mirrors the v1 record's use of the
 *  queue timestamp; `worktreeDir` is supplied by the caller (the row does not
 *  persist it). */
export function toAgentRunDto(
  row: AgentRunRow,
  opts: { worktreeDir?: string; startedAt?: number } = {},
): AgentRunDto {
  if (!row || typeof row.id !== 'string') {
    throw new AgentRunAdapterError('invalid agent run row: missing id');
  }
  return {
    runId: row.id,
    sessionId: row.ccSessionId,
    agentName: row.podName,
    model: DEFAULT_MODEL,
    projectId: row.projectId,
    parentWorkItemId: row.parentWorkItemId,
    dispatcherSessionId: row.dispatcherSessionId,
    worktreeDir: opts.worktreeDir ?? '',
    startedAt: opts.startedAt ?? row.queuedAt,
    status: row.status,
    result: row.result ?? '',
    failureReason: row.failureReason,
    failureCause: row.failureCause,
    endedAt: row.completedAt,
    rev: row.rev,
  };
}

export function toPendingAskDto(row: PendingAskRow): PendingAskDto {
  if (!row || typeof row.id !== 'string') {
    throw new AgentRunAdapterError('invalid pending-ask row: missing id');
  }
  return {
    id: row.id,
    agentRunId: row.agentRunId,
    ccSessionId: row.ccSessionId,
    projectId: row.projectId,
    parentWorkItemId: row.parentWorkItemId,
    kind: row.kind,
    promptBody: row.promptBody,
    context: row.context,
    options: row.options ? row.options.map((o) => ({ label: o.label, value: o.value })) : null,
    status: row.status,
    answeredBy: row.answeredBy,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    cancelledAt: row.cancelledAt,
  };
}
