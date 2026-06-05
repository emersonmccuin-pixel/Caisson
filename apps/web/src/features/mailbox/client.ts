// Slice 007 — web mailbox client. The ONLY place that holds mailbox route
// strings (components/hooks never embed them; spec §4 boundary rule).

import { getJson, postJson } from '@/api/http';
import type { ULID } from '@/features/projects/types';
import type { MailboxInboxItem } from './types';

export const mailboxApi = {
  /** Project inbox (recipients addressed to the project). */
  listProjectInbox: (projectId: ULID, opts: { unreadOnly?: boolean; actionableOnly?: boolean } = {}) =>
    getJson<{ ok: true; items: MailboxInboxItem[] }>(
      `/api/projects/${projectId}/mailbox${query(opts)}`,
    ).then((r) => r.items),

  /** Global single-user inbox (project-less user-inbox messages). */
  listGlobalInbox: (opts: { unreadOnly?: boolean; actionableOnly?: boolean } = {}) =>
    getJson<{ ok: true; items: MailboxInboxItem[] }>(`/api/mailbox${query(opts)}`).then((r) => r.items),

  /** M8 (FD-7) — THE human inbox: every user-inbox recipient across ALL
   *  projects. Powers the cross-project Inbox bell. */
  listAllInbox: (opts: { unreadOnly?: boolean; actionableOnly?: boolean } = {}) =>
    getJson<{ ok: true; items: MailboxInboxItem[] }>(`/api/inbox${query(opts)}`).then((r) => r.items),

  markRead: (projectId: ULID, recipientId: string) =>
    postJson<{ ok: boolean }>(
      `/api/projects/${projectId}/mailbox/recipients/${recipientId}/read`,
      {},
    ),

  markActioned: (projectId: ULID, recipientId: string) =>
    postJson<{ ok: boolean }>(
      `/api/projects/${projectId}/mailbox/recipients/${recipientId}/action`,
      {},
    ),

  dismiss: (projectId: ULID, recipientId: string) =>
    postJson<{ ok: boolean }>(
      `/api/projects/${projectId}/mailbox/recipients/${recipientId}/dismiss`,
      {},
    ),

  // ── M8 (FD-7) — decision doors the inbox cards call. The server's
  //    decided-elsewhere resolution actions the card; these never touch
  //    recipient state directly. ──────────────────────────────────────────────

  /** Workflow review gate decision (POST workflow-v2/review). */
  decideWorkflowReview: (
    projectId: ULID,
    runId: string,
    nodeId: string,
    decision: 'approve' | 'reject',
    notes?: string,
    instanceToken?: string,
  ) =>
    postJson<{ ok: boolean; error?: string }>(`/api/projects/${projectId}/workflow-v2/review`, {
      runId,
      nodeId,
      decision,
      ...(notes ? { notes } : {}),
      ...(instanceToken ? { instanceToken } : {}),
    }),

  /** Verification hold approve (contract human-review tier). */
  approveVerification: (projectId: ULID, workItemId: string, notes?: string) =>
    postJson<{ ok: boolean; error?: string }>(
      `/api/projects/${projectId}/work-items/${workItemId}/approve`,
      { actor: 'user', ...(notes ? { notes } : {}) },
    ),

  /** Verification hold reject — feedback required; the producer agent is woken
   *  back up with it (the continuation inherits the run's dispatcher). */
  rejectVerification: (projectId: ULID, workItemId: string, feedback: string) =>
    postJson<{ ok: boolean; error?: string }>(
      `/api/projects/${projectId}/work-items/${workItemId}/reject`,
      { actor: 'user', feedback },
    ),

  // ── M4b (FD-8) — the escalated-ask card's doors (the EXISTING pending-ask
  //    answer/cancel surfaces; the server clears the card resolve-by-source). ──

  /** Answer a paused agent's question as the human. Resumes the agent. */
  answerPendingAsk: (projectId: ULID, pendingAskId: string, answer: string) =>
    postJson<{ ok: boolean; error?: string }>(
      `/api/projects/${projectId}/agent-pending-asks/${pendingAskId}/answer`,
      { answer, answeredBy: 'user' },
    ),

  /** Cancel a paused agent (drops the ask AND the run). */
  cancelPendingAsk: (projectId: ULID, pendingAskId: string) =>
    postJson<{ ok: boolean; error?: string }>(
      `/api/projects/${projectId}/agent-pending-asks/${pendingAskId}/cancel`,
      {},
    ),
};

function query(opts: { unreadOnly?: boolean; actionableOnly?: boolean }): string {
  const parts: string[] = [];
  if (opts.unreadOnly) parts.push('unreadOnly=1');
  if (opts.actionableOnly) parts.push('actionableOnly=1');
  return parts.length ? `?${parts.join('&')}` : '';
}

export * from './types';
