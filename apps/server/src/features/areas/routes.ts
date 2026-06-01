// Slice 010 — Area route adapters. CRUD over project-scoped Areas. Every
// mutation goes through the AreaService, which writes an `area.changed`
// live_outbox row in-txn; the live-relay delivers it. ZERO broadcast/fanout
// calls live here (the no-bypass gate enforces this).

import type { Hono } from 'hono';
import {
  parseCreateAreaRequest,
  parsePatchAreaRequest,
  parseReorderAreasRequest,
} from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { AreaService } from '@pc/app-services';

export interface AreaRoutesDeps {
  /** Resolves a project runtime by id; null → 404. Reused from the work-item
   *  route deps shape (only existence + project.id are needed here). */
  resolveProject(projectId: string): { project: { id: ULID } } | null;
  /** Defaults to a fresh AreaService (live DB). Tests may inject one. */
  areaService?: AreaService;
}

export function registerAreaRoutes(app: Hono, deps: AreaRoutesDeps): void {
  const service = deps.areaService ?? new AreaService();

  app.get('/api/projects/:projectId/areas', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    return c.json({ areas: service.list(runtime.project.id) });
  });

  app.post('/api/projects/:projectId/areas', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const parsed = parseCreateAreaRequest(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const area = service.create({
      projectId: runtime.project.id,
      name: parsed.value.name,
      ...(parsed.value.summary !== undefined ? { summary: parsed.value.summary } : {}),
    });
    return c.json({ ok: true, area });
  });

  app.patch('/api/projects/:projectId/areas/:areaId', async (c) => {
    const id = c.req.param('projectId');
    const areaId = c.req.param('areaId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const parsed = parsePatchAreaRequest(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const existing = service.list(runtime.project.id).find((a) => a.id === areaId);
    if (!existing) return c.json({ ok: false, error: `unknown area: ${areaId}` }, 404);
    if (existing.version !== parsed.value.expectedVersion) {
      return c.json({ ok: false, error: 'version conflict', current: existing }, 409);
    }
    const area = service.patch({
      projectId: runtime.project.id,
      id: areaId,
      ...(parsed.value.name !== undefined ? { name: parsed.value.name } : {}),
      ...(parsed.value.summary !== undefined ? { summary: parsed.value.summary } : {}),
    });
    if (!area) return c.json({ ok: false, error: `unknown area: ${areaId}` }, 404);
    return c.json({ ok: true, area });
  });

  app.post('/api/projects/:projectId/areas/reorder', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const parsed = parseReorderAreasRequest(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const areas = service.reorder({
      projectId: runtime.project.id,
      orderedIds: parsed.value.orderedIds,
    });
    return c.json({ ok: true, areas });
  });

  app.delete('/api/projects/:projectId/areas/:areaId', (c) => {
    const id = c.req.param('projectId');
    const areaId = c.req.param('areaId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const area = service.softDelete({ projectId: runtime.project.id, id: areaId });
    if (!area) return c.json({ ok: false, error: `unknown area: ${areaId}` }, 404);
    return c.json({ ok: true });
  });
}
