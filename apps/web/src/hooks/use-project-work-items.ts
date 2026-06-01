// UI Spine step 3 / Slice 015b — version-aware id-keyed store slice for work items.
//
// Now consumes the canonical relay `live-event` frame (entity `work-item`,
// `work-item.changed`) instead of the legacy `work-item-changed` envelope. The
// frame's payload carries the full work-item snapshot + a `reason`; the work
// item's `version` doubles as the per-entity rev so out-of-order / duplicate
// deliveries are discarded. Whole-list refetch fires only on mount, project
// switch, or when an unknown id arrives (new item) or a deleted item is observed.

import { isWorkItemChangedLivePayload } from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import { workItemsApi, type WorkItem } from '@/features/work-items/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useResourceList } from '@/hooks/use-resource-list';

export function useProjectWorkItems(
  project: Project | null,
  events: WsEnvelope[],
): { workItems: WorkItem[]; refetch: () => void } {
  const { records, refetch } = useResourceList<WorkItem>(project, events, {
    liveEventEntity: 'work-item',
    extractFromLiveEvent: (event, projectId) => {
      if (event.projectId !== projectId) return null;
      if (!isWorkItemChangedLivePayload(event.payload)) return null;
      const wi = event.payload.workItem;
      if (!wi || wi.projectId !== projectId) return null;
      // Cast: server WorkItem is a superset of the frontend WorkItem type.
      return wi as unknown as WorkItem;
    },
    getId: (r) => r.id,
    // Deleted items have deletedAt set; treat them as "terminal" so the list
    // refetches (which returns only live rows) and cleans them up.
    isTerminal: (r) => r.deletedAt != null,
    // Deleted items should be dropped from the local map immediately.
    dropOnTerminal: true,
    getVersion: (r) => r.version,
    list: (projectId) => workItemsApi.workItems(projectId),
  });

  return { workItems: records, refetch };
}
