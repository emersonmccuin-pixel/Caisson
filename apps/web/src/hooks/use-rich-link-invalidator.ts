// Walks the project's WS envelope stream and evicts matching rich-link cache
// entries on:
//   - `work-item-changed`      → invalidateByWorkItemId(workItem.id)
//   - `attachment-changed`     → invalidateByAttachmentId(attachment.id)
//
// Mount once at App / Shell level alongside the WS subscription.

import { useEffect, useRef } from 'react';

import { isWorkItemChangedLiveEventFrame } from '@pc/contracts';

import type { WsEnvelope } from '@/features/runtime/ws-types';
import {
  invalidateByAttachmentId,
  invalidateByWorkItemId,
} from '@/hooks/use-rich-link-data';

export function useRichLinkInvalidator(events: WsEnvelope[]): void {
  const lastIdx = useRef(0);
  useEffect(() => {
    for (let i = lastIdx.current; i < events.length; i++) {
      const env = events[i];
      if (!env || typeof env !== 'object') continue;
      // Slice 015b — canonical relay `work-item.changed` frame.
      if (isWorkItemChangedLiveEventFrame(env)) {
        const wiId = env.event.payload.workItem?.id ?? env.event.entityId;
        if (wiId) invalidateByWorkItemId(wiId);
      } else if (env.type === 'attachment-changed') {
        const att = (env as { attachment?: { id?: string } }).attachment;
        if (att?.id) invalidateByAttachmentId(att.id);
      }
    }
    lastIdx.current = events.length;
  }, [events]);
}
