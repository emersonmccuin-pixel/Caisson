import { getJson } from '@/api/http';
import {
  liveEventRoutes,
  type LiveEvent,
  type ListLiveEventsQuery,
  type ListLiveEventsResponse,
} from '@pc/contracts';

export const liveEventsApi = {
  listEvents: (query: Partial<ListLiveEventsQuery> = {}) => {
    const params = new URLSearchParams();
    if (query.after) params.set('after', query.after);
    if (query.projectId) params.set('projectId', query.projectId);
    if (query.includeGlobal) params.set('includeGlobal', '1');
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.type) params.set('type', query.type);
    const qs = params.toString();
    return getJson<ListLiveEventsResponse>(
      qs ? `${liveEventRoutes.list}?${qs}` : liveEventRoutes.list,
    );
  },

  /** T2.3 — current host-health frame for the cold-load pill/banner seed. The
   *  replay route can't serve current state without a prior cursor, so the
   *  store is seeded from this snapshot endpoint instead. */
  hostHealthSeed: () =>
    getJson<{ ok: boolean; event: LiveEvent | null }>('/api/agent-host/health'),
};
