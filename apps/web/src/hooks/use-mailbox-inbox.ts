// Slice 007 — mailbox inbox feeder. Fetches the project (or global single-user)
// inbox and refetches whenever a canonical mailbox live frame arrives
// (refetch-on-event; patching can come later per spec §9).
//
// T3.1 — keyed off the identity-keyed live store's per-entity signatures, NOT a
// positional scan of the chat `events[]` (which missed frames after a
// chat-timeline rebuild during an active session). The signature flips exactly
// once per genuine change for that entity in scope, so the refetch effect fires
// exactly once and never on an unrelated entity's frame.

import { useCallback, useEffect, useState } from 'react';

import { mailboxApi } from '@/features/mailbox/client';
import type { MailboxInboxItem } from '@/features/mailbox/types';
import {
  useLiveEntitySignature,
  useLiveEntitySignatureAllProjects,
  useLiveGlobalSignature,
} from '@/store/live-store';

export interface UseMailboxInboxResult {
  items: MailboxInboxItem[];
  loading: boolean;
  refetch: () => void;
}

/** `scope` selects the project inbox (`projectId`), the global single-user
 *  inbox (`global`), or — M8 (FD-7) — THE cross-project human inbox (`all`:
 *  every user-inbox recipient across all projects, the Inbox bell's feed).
 *  Live updates come from the store signatures below. */
export function useMailboxInbox(
  scope: { projectId: string } | { global: true } | { all: true },
): UseMailboxInboxResult {
  const [items, setItems] = useState<MailboxInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const projectId = 'projectId' in scope ? scope.projectId : null;
  const all = 'all' in scope;

  // Project scope keys on the message fact; the global inbox keys only on the
  // global message signature; the all-projects inbox keys on every mailbox
  // frame (the Q12 background sockets feed inactive projects' frames too).
  const msgSig = useLiveEntitySignature('mailbox-message', projectId);
  const globalMsgSig = useLiveGlobalSignature(projectId || all ? null : 'mailbox-message');
  const allMsgSig = useLiveEntitySignatureAllProjects(all ? 'mailbox-message' : null);

  const refetch = useCallback(() => {
    // actionableOnly=true: the inbox shows only open, unactioned, undismissed
    // actionable items (the approve/reject decisions). Historical/actioned/
    // dismissed items are excluded at the server; the inbox is not a history
    // view.
    const promise = all
      ? mailboxApi.listAllInbox({ actionableOnly: true })
      : projectId
        ? mailboxApi.listProjectInbox(projectId, { actionableOnly: true })
        : mailboxApi.listGlobalInbox({ actionableOnly: true });
    setLoading(true);
    promise
      .then((next) => setItems(next))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [projectId, all]);

  // Initial load + reset when the scope changes, then refetch on any genuine
  // change to the in-scope signatures.
  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, all, msgSig, globalMsgSig, allMsgSig]);

  // Server already excludes actioned/dismissed rows via actionableOnly=true.
  // The client filter guards against any race where a stale response sneaks
  // through before the next refetch clears it.
  return { items: items.filter((i) => i.recipient.dismissedAt === null && i.recipient.actionedAt === null), loading, refetch };
}
