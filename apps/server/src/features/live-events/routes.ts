import type { Hono } from 'hono';
import type { ULID as DomainULID } from '@pc/domain';
import {
  parseListLiveEventsQuery,
  type ListLiveEventsResponse,
} from '@pc/contracts';
import { listLiveEventsAfter, LiveEventCursorError } from '@pc/db';

export function registerLiveEventRoutes(app: Hono): void {
  app.get('/api/live-events', (c) => {
    const parsed = parseListLiveEventsQuery({
      after: c.req.query('after'),
      projectId: c.req.query('projectId'),
      includeGlobal: c.req.query('includeGlobal'),
      limit: c.req.query('limit'),
      type: c.req.query('type'),
    });
    if (!parsed.ok) {
      return c.json({ ok: false, error: parsed.error }, 400);
    }

    try {
      const replay = listLiveEventsAfter({
        ...parsed.value,
        projectId: parsed.value.projectId as DomainULID | undefined,
      });
      const response: ListLiveEventsResponse = {
        ok: true,
        events: replay.events,
        nextCursor: replay.nextCursor,
        ...(replay.resetRequired ? { resetRequired: true } : {}),
      };
      return c.json(response);
    } catch (err) {
      if (err instanceof LiveEventCursorError) {
        return c.json({ ok: false, error: err.message }, 400);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });
}
