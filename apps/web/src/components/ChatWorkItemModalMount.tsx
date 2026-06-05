// Section 1.5.6 — Shell-level WorkItemDetailModal mount driven by the chat
// rich-link click store. Fetches the project's work items lazily (only when
// the store transitions to a non-null id) and forwards to WorkItemDetailModal.
//
// Distinct from KanbanBoard's local modal; both can technically be open at
// once but the user has to actively click in both places to trigger it.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { Project } from '@/features/projects/client';
import { workItemsApi, type WorkItem } from '@/features/work-items/client';
import { useChatWorkItemModal } from '@/store/chat-work-item-modal';
import { useLiveEntitySignature } from '@/store/live-store';
import { WorkItemDetailModal } from './work-items/WorkItemDetailModal';

interface ChatWorkItemModalMountProps {
  project: Project;
}

export function ChatWorkItemModalMount({ project }: ChatWorkItemModalMountProps) {
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

  // T3.2b — live refresh of the open item off the identity-keyed live store
  // signature (rebuild-proof), gated on the modal being open. Refetches the full
  // list once per genuine work-item change.
  const wiSig = useLiveEntitySignature('work-item', project.id);
  useEffect(() => {
    if (!workItemId || !wiSig) return;
    workItemsApi.workItems(project.id)
      .then(setItems)
      .catch(() => {});
  }, [wiSig, workItemId, project.id]);

  if (!workItemId) return null;

  // createPortal renders to document.body, outside the Panel/Group stacking
  // context in Shell, so z-[60] on WorkItemDetailModal reliably beats any
  // z-50 modal (e.g. AreaDetailModal) regardless of ancestor transforms.
  if (error) {
    return createPortal(
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
      </div>,
      document.body,
    );
  }

  if (!items) {
    return createPortal(
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/80">
        <div className="text-xs italic text-muted-foreground">Loading…</div>
      </div>,
      document.body,
    );
  }

  // Section 35 — chat rich-links may carry a callsign (`example-project-4`) as
  // the ref instead of the canonical ULID. Match either shape against the
  // local list so callsign clicks land on the right row.
  const item = items.find((i) => i.id === workItemId || i.callsign === workItemId);
  if (!item) {
    return createPortal(
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
      </div>,
      document.body,
    );
  }

  return createPortal(
    <WorkItemDetailModal
      workItem={item}
      project={project}
      items={items}
      // T3.2b — this mount no longer threads the chat events array; the modal's
      // own live reads (field-schema/work-item history) now come from the live
      // store. Its remaining transient `events` scans (attachment refresh) are
      // migrated in T3.3; pass an empty array until then.
      events={[]}
      onClose={close}
      onSwitchItem={(id) => open(id)}
      onItemCreated={(wi) =>
        setItems((prev) =>
          prev && !prev.some((p) => p.id === wi.id) ? [...prev, wi] : prev,
        )
      }
    />,
    document.body,
  );
}
