import type { Hono } from 'hono';
import type { ULID as DomainULID } from '@pc/domain';
import {
  parseListLiveEventsQuery,
  type ListLiveEventsResponse,
} from '@pc/contracts';
import { listLiveEventsAfter, LiveEventCursorError } from '@pc/db';
import { isTransient } from '../../services/failure-policy.ts';

export interface LiveEventRouteDeps {
  listLiveEventsAfter?: typeof listLiveEventsAfter;
}

export function registerLiveEventRoutes(app: Hono, deps: LiveEventRouteDeps = {}): void {
  const replayLiveEvents = deps.listLiveEventsAfter ?? listLiveEventsAfter;
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
      const replay = replayLiveEvents({
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
      // Transient (DB-busy / blip) → 503 + Retry-After so the client retries
      // instead of surfacing a cold-load error during the restart window.
      if (isTransient(err)) {
        c.header('Retry-After', '1');
        return c.json({ ok: false, error: 'service temporarily unavailable' }, 503);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });
}
