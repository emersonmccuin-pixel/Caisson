// Slice 007 — mailbox inbox feeder. Fetches the project (or global single-user)
// inbox and refetches whenever a canonical mailbox/pending-interaction live
// frame arrives (refetch-on-event; patching can come later per spec §9).
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
  useLiveGlobalSignature,
} from '@/store/live-store';

export interface UseMailboxInboxResult {
  items: MailboxInboxItem[];
  loading: boolean;
  refetch: () => void;
}

/** `scope` selects the project inbox (`projectId`) or the global single-user
 *  inbox (`null`). Live updates come from the store signatures below. */
export function useMailboxInbox(
  scope: { projectId: string } | { global: true },
): UseMailboxInboxResult {
  const [items, setItems] = useState<MailboxInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const projectId = 'projectId' in scope ? scope.projectId : null;

  // Project scope keys on both the message fact and pending-interaction (the
  // latter is project-scoped by contract). The global inbox keys only on the
  // global message signature (pending-interaction is never global).
  const msgSig = useLiveEntitySignature('mailbox-message', projectId);
  const piSig = useLiveEntitySignature('pending-interaction', projectId);
  const globalMsgSig = useLiveGlobalSignature(projectId ? null : 'mailbox-message');

  const refetch = useCallback(() => {
    const promise = projectId
      ? mailboxApi.listProjectInbox(projectId)
      : mailboxApi.listGlobalInbox();
    setLoading(true);
    promise
      .then((next) => setItems(next))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Initial load + reset when the scope changes, then refetch on any genuine
  // change to the in-scope signatures.
  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, msgSig, piSig, globalMsgSig]);

  // Exclude dismissed rows client-side so they vanish immediately on dismiss
  // and stay gone after the next refetch (the server returns them with a
  // dismissedAt timestamp but no excludeDismissed query param exists yet).
  return { items: items.filter((i) => i.recipient.dismissedAt === null), loading, refetch };
}
