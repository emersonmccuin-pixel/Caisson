// Slice 007 — web mailbox client. The ONLY place that holds mailbox route
// strings (components/hooks never embed them; spec §4 boundary rule).

import { getJson, postJson } from '@/api/http';
import type { ULID } from '@/features/projects/types';
import type { MailboxDeliveryDto, MailboxInboxItem } from './types';

export const mailboxApi = {
  /** Project inbox (recipients addressed to the project). */
  listProjectInbox: (projectId: ULID, opts: { unreadOnly?: boolean; actionableOnly?: boolean } = {}) =>
    getJson<{ ok: true; items: MailboxInboxItem[] }>(
      `/api/projects/${projectId}/mailbox${query(opts)}`,
    ).then((r) => r.items),

  /** Global single-user inbox (project-less user-inbox messages). */
  listGlobalInbox: (opts: { unreadOnly?: boolean; actionableOnly?: boolean } = {}) =>
    getJson<{ ok: true; items: MailboxInboxItem[] }>(`/api/mailbox${query(opts)}`).then((r) => r.items),

  listDeliveries: (projectId: ULID) =>
    getJson<{ ok: true; deliveries: MailboxDeliveryDto[] }>(
      `/api/projects/${projectId}/mailbox/deliveries`,
    ).then((r) => r.deliveries),

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

  answerInteraction: (
    projectId: ULID,
    interactionId: string,
    answer: string,
    answeredBy: 'user' | 'orchestrator' = 'user',
  ) =>
    postJson<{ ok: boolean }>(
      `/api/projects/${projectId}/pending-interactions/${interactionId}/answer`,
      { answer, answeredBy },
    ),
};

function query(opts: { unreadOnly?: boolean; actionableOnly?: boolean }): string {
  const parts: string[] = [];
  if (opts.unreadOnly) parts.push('unreadOnly=1');
  if (opts.actionableOnly) parts.push('actionableOnly=1');
  return parts.length ? `?${parts.join('&')}` : '';
}

export * from './types';
