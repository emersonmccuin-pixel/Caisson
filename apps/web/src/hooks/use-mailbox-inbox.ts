// Slice 007 — mailbox inbox feeder. Fetches the project (or global single-user)
// inbox and refetches whenever a canonical mailbox/pending-interaction live
// frame arrives (refetch-on-event; patching can come later per spec §9). The
// global inbox replays with includeGlobal upstream; this hook just consumes the
// already-buffered WS events and refetches the right endpoint.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WsEnvelope } from '@/features/runtime/ws-types';
import { mailboxApi } from '@/features/mailbox/client';
import { scanMailboxLiveEvents } from '@/features/mailbox/live-events';
import type { MailboxInboxItem } from '@/features/mailbox/types';

export interface UseMailboxInboxResult {
  items: MailboxInboxItem[];
  loading: boolean;
  refetch: () => void;
}

/** `scope` selects the project inbox (`projectId`) or the global single-user
 *  inbox (`null`). `events` is the shared buffered WS event stream. */
export function useMailboxInbox(
  scope: { projectId: string } | { global: true },
  events: readonly WsEnvelope[],
): UseMailboxInboxResult {
  const [items, setItems] = useState<MailboxInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const seenRef = useRef<Set<string>>(new Set());
  const scanIndexRef = useRef(0);
  const projectId = 'projectId' in scope ? scope.projectId : null;

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

  // Initial load + reset when the scope changes.
  useEffect(() => {
    seenRef.current = new Set();
    scanIndexRef.current = events.length;
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Refetch on any newly-seen mailbox/interaction frame.
  useEffect(() => {
    const scan = scanMailboxLiveEvents(events, scanIndexRef.current, seenRef.current);
    scanIndexRef.current = events.length;
    if (scan.changed) refetch();
  }, [events, refetch]);

  return { items, loading, refetch };
}
