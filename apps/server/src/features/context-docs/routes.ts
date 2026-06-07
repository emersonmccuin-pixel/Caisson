// Slice 2 (Areas + context model) — ContextDoc route adapters.
//
// Slice 1: persistence only. Slice 2: adds `context-doc.changed` live-outbox
// rows on create/update so the area detail page updates without refresh.
// Every mutation goes through the repo directly (no app-service layer needed
// for this thin feature). Mirrors the areas feature shape.

import type { Hono } from 'hono';
import type { ULID } from '@pc/domain';
import {
  createContextDoc,
  getContextDoc,
  getDb,
  insertLiveEvent,
  listContextChainDocs,
  listContextDocsForScope,
  searchContextDocs,
  updateContextDoc,
  type ContextDocRow,
  type ContextDocScope,
} from '@pc/db';

export interface ContextDocRoutesDeps {
  /** Resolves a project runtime by id; null → 404. */
  resolveProject(projectId: string): { project: { id: ULID } } | null;
}

/** Emit a project-scoped `context-doc.changed` outbox row (fire-and-forget;
 *  non-fatal on error so the mutation response still reaches the client). */
function emitContextDocChanged(projectId: ULID, doc: ContextDocRow): void {
  try {
    insertLiveEvent(getDb(), {
      scope: 'project',
      projectId,
      type: 'context-doc.changed',
      entity: 'context-doc',
      entityId: doc.id,
      version: doc.updatedAt,
      payload: { doc },
    });
  } catch {
    /* non-fatal — the HTTP response already carries the fresh doc */
  }
}

export function registerContextDocRoutes(app: Hono, deps: ContextDocRoutesDeps): void {
  // ── GET /api/projects/:projectId/context-docs?scope=<project|area|work-item>&scopeId=<id>
  // Returns the doc index (title + one-liner summary + age) for a scope or chain.
  // Query params:
  //   scope      = 'project' | 'area' | 'work-item' | 'chain'
  //   scopeId    = ULID (required for area/work-item/chain)
  //   indexOnly  = '1' to omit body (default '0')
  app.get('/api/projects/:projectId/context-docs', (c) => {
    const projectId = c.req.param('projectId');
    const runtime = deps.resolveProject(projectId);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const scopeParam = c.req.query('scope') ?? 'project';
    const scopeId = (c.req.query('scopeId') ?? '') as ULID;

    if (scopeParam === 'chain') {
      if (!scopeId) return c.json({ ok: false, error: 'scopeId required for chain scope' }, 400);
      const docs = listContextChainDocs({ workItemId: scopeId, projectId: runtime.project.id });
      return c.json({ ok: true, docs });
    }

    let scope: ContextDocScope;
    if (scopeParam === 'area') {
      if (!scopeId) return c.json({ ok: false, error: 'scopeId required for area scope' }, 400);
      scope = { areaId: scopeId };
    } else if (scopeParam === 'work-item') {
      if (!scopeId) return c.json({ ok: false, error: 'scopeId required for work-item scope' }, 400);
      scope = { workItemId: scopeId };
    } else {
      scope = { projectId: runtime.project.id };
    }

    try {
      const docs = listContextDocsForScope({ scope });
      return c.json({ ok: true, docs });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  // ── GET /api/projects/:projectId/context-docs/search?q=<query>&areaId=&scope=
  // FTS5 search across the project's context docs.
  // MUST be registered before the /:docId param route — Hono matches in
  // registration order and the literal segment "search" would otherwise bind
  // to :docId, returning "unknown context doc: search".
  app.get('/api/projects/:projectId/context-docs/search', (c) => {
    const projectId = c.req.param('projectId');
    const runtime = deps.resolveProject(projectId);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const query = c.req.query('q') ?? '';
    const areaId = c.req.query('areaId') as ULID | undefined;
    const scopeKind = c.req.query('scope') as 'project' | 'area' | 'work-item' | undefined;

    try {
      const results = searchContextDocs({
        projectId: runtime.project.id,
        query,
        ...(areaId ? { areaId } : {}),
        ...(scopeKind ? { scopeKind } : {}),
      });
      return c.json({ ok: true, results });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // ── GET /api/projects/:projectId/context-docs/:docId
  // Returns the full body of a single doc.
  app.get('/api/projects/:projectId/context-docs/:docId', (c) => {
    const projectId = c.req.param('projectId');
    const docId = c.req.param('docId') as ULID;
    const runtime = deps.resolveProject(projectId);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const doc = getContextDoc(docId);
    if (!doc) return c.json({ ok: false, error: `unknown context doc: ${docId}` }, 404);
    return c.json({ ok: true, doc });
  });

  // ── POST /api/projects/:projectId/context-docs
  // Body: { scope: 'project'|'area'|'work-item', scopeId?: string, title, body?, author? }
  app.post('/api/projects/:projectId/context-docs', async (c) => {
    const projectId = c.req.param('projectId');
    const runtime = deps.resolveProject(projectId);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ ok: false, error: 'JSON body required' }, 400);
    }

    const { scope: scopeParam, scopeId, title, body: docBody, author } = body as Record<string, unknown>;

    if (typeof title !== 'string' || !title.trim()) {
      return c.json({ ok: false, error: 'title required' }, 400);
    }

    let scope: ContextDocScope;
    if (scopeParam === 'area') {
      if (typeof scopeId !== 'string') return c.json({ ok: false, error: 'scopeId required for area scope' }, 400);
      scope = { areaId: scopeId as ULID };
    } else if (scopeParam === 'work-item') {
      if (typeof scopeId !== 'string') return c.json({ ok: false, error: 'scopeId required for work-item scope' }, 400);
      scope = { workItemId: scopeId as ULID };
    } else {
      scope = { projectId: runtime.project.id };
    }

    try {
      const doc = createContextDoc({
        scope,
        title: title.trim(),
        ...(typeof docBody === 'string' ? { body: docBody } : {}),
        ...(typeof author === 'string' ? { author } : {}),
      });
      emitContextDocChanged(runtime.project.id, doc);
      return c.json({ ok: true, doc });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  // ── PATCH /api/projects/:projectId/context-docs/:docId
  // Body: { title?, body? }
  app.patch('/api/projects/:projectId/context-docs/:docId', async (c) => {
    const projectId = c.req.param('projectId');
    const docId = c.req.param('docId') as ULID;
    const runtime = deps.resolveProject(projectId);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ ok: false, error: 'JSON body required' }, 400);
    }

    const { title, body: docBody } = body as Record<string, unknown>;
    if (title === undefined && docBody === undefined) {
      return c.json({ ok: false, error: 'at least one of title or body required' }, 400);
    }

    const doc = updateContextDoc(docId, {
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof docBody === 'string' ? { body: docBody } : {}),
    });
    if (!doc) return c.json({ ok: false, error: `unknown context doc: ${docId}` }, 404);
    emitContextDocChanged(runtime.project.id, doc);
    return c.json({ ok: true, doc });
  });

}
