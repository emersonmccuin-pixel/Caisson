// Command focus — the one write surface for starring/unstarring things. The
// planner (and, later, UI affordances) POST here. Unified across entity kinds
// so the planner has a single tool: it knows an item's id from its
// cross-project reads and doesn't need to thread the owning project.
//
//   POST /api/focus { kind: 'project' | 'work_item', id, focused }
//
// project    → setProjectFocusWithLiveEvent (project.changed in-txn; relay fans).
// work_item  → resolve the item's project, route through that project's
//              WorkItemService.setFocus (work-item.changed via the write door).

import type { Hono } from 'hono';
import type { WorkItem } from '@pc/domain';
import { getWorkItem } from '@pc/db';
import { setProjectFocusWithLiveEvent } from '@pc/app-services';

export interface FocusRouteRuntime {
  workItemService(): { setFocus(id: string, focused: boolean): WorkItem };
}

export interface FocusRoutesDeps {
  /** Resolve a project's runtime (for the work-item write door). Null = unknown. */
  resolveProject(projectId: string): FocusRouteRuntime | null;
}

export function registerFocusRoutes(app: Hono, deps: FocusRoutesDeps): void {
  app.post('/api/focus', async (c) => {
    const body = (await c.req.json<unknown>().catch(() => null)) as {
      kind?: unknown;
      id?: unknown;
      focused?: unknown;
    } | null;
    const kind = body?.kind;
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    const focused = body?.focused !== false; // default true (star) unless explicit false
    if (!id || (kind !== 'project' && kind !== 'work_item')) {
      return c.json({ ok: false, error: "expected { kind: 'project' | 'work_item', id, focused }" }, 400);
    }

    if (kind === 'project') {
      const result = setProjectFocusWithLiveEvent(id, focused);
      if (!result.ok) return c.json({ ok: false, error: result.error }, 404);
      return c.json({ ok: true, project: result.project });
    }

    // work_item — find the owning project, then route through its write door.
    const wi = getWorkItem(id as never);
    if (!wi) return c.json({ ok: false, error: `unknown work item: ${id}` }, 404);
    const runtime = deps.resolveProject(wi.projectId);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${wi.projectId}` }, 404);
    try {
      const workItem = runtime.workItemService().setFocus(id, focused);
      return c.json({ ok: true, workItem });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });
}
