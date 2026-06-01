// Section 1.5.6 — Shell-level WorkItemDetailModal mount driven by the chat
// rich-link click store. Fetches the project's work items lazily (only when
// the store transitions to a non-null id) and forwards to WorkItemDetailModal.
//
// Distinct from KanbanBoard's local modal; both can technically be open at
// once but the user has to actively click in both places to trigger it.

import { useEffect, useRef, useState } from 'react';

import { isWorkItemChangedLiveEventFrame } from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import { workItemsApi, type WorkItem } from '@/features/work-items/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useChatWorkItemModal } from '@/store/chat-work-item-modal';
import { WorkItemDetailModal } from './work-items/WorkItemDetailModal';

interface ChatWorkItemModalMountProps {
  project: Project;
  events: WsEnvelope[];
}

export function ChatWorkItemModalMount({ project, events }: ChatWorkItemModalMountProps) {
  const workItemId = useChatWorkItemModal((s) => s.workItemId);
  const open = useChatWorkItemModal((s) => s.open);
  const close = useChatWorkItemModal((s) => s.close);
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch full list when the modal becomes active (modal needs siblings for
  // "+ New child" + parent breadcrumb context).
  useEffect(() => {
    if (!workItemId) {
      setItems(null);
      setError(null);
      return;
    }
    let cancelled = false;
    workItemsApi.workItems(project.id)
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [workItemId, project.id]);

  // Live refresh on work-item-changed envelopes while modal is open. Scan
  // every new envelope since the last processed index — not just the last
  // one — so a change buried in a batched flush isn't missed (UI spine).
  const lastIdxRef = useRef(0);
  useEffect(() => {
    if (events.length < lastIdxRef.current) lastIdxRef.current = 0;
    const start = lastIdxRef.current;
    lastIdxRef.current = events.length;
    if (!workItemId || start >= events.length) return;
    let changed = false;
    for (let i = start; i < events.length; i++) {
      // Slice 015b — canonical relay `work-item.changed` frame.
      if (isWorkItemChangedLiveEventFrame(events[i])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    workItemsApi.workItems(project.id)
      .then(setItems)
      .catch(() => {});
  }, [events, workItemId, project.id]);

  if (!workItemId) return null;

  if (error) {
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/80">
        <div className="border border-destructive bg-card px-4 py-3 text-xs">
          <div className="mb-2 text-destructive">Failed to load work item</div>
          <div className="mb-3 text-muted-foreground">{error}</div>
          <button
            type="button"
            className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            onClick={close}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  if (!items) {
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/80">
        <div className="text-xs italic text-muted-foreground">Loading…</div>
      </div>
    );
  }

  // Section 35 — chat rich-links may carry a callsign (`example-project-4`) as
  // the ref instead of the canonical ULID. Match either shape against the
  // local list so callsign clicks land on the right row.
  const item = items.find((i) => i.id === workItemId || i.callsign === workItemId);
  if (!item) {
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/80">
        <div className="border border-border bg-card px-4 py-3 text-xs">
          <div className="mb-2 text-muted-foreground">Work item not found</div>
          <button
            type="button"
            className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            onClick={close}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <WorkItemDetailModal
      workItem={item}
      project={project}
      items={items}
      events={events}
      onClose={close}
      onSwitchItem={(id) => open(id)}
      onItemCreated={(wi) =>
        setItems((prev) =>
          prev && !prev.some((p) => p.id === wi.id) ? [...prev, wi] : prev,
        )
      }
    />
  );
}
