// pc-pty-chat-359 P1/P2 — HTTP routes for the MCP server registry.
//
// Mounted under two prefixes:
//   /api/mcp-servers          — global scope (list, create, get, patch, delete, probe)
//   /api/projects/:id/mcp-servers — project scope (list, create)
//
// Transport validation delegates to the existing parsePodMcpServerConfig
// (apps/server/src/services/pod-mcp-config.ts) — ONE path, no duplicate.
//
// P2 additions:
//   POST /api/mcp-servers/:id/probe  — trigger a discovery probe; returns updated row.
//   Auto-probe on create (fire-and-forget, does not delay the create response).
//   PATCH marks discoveryStatus='stale' when transport changes (handled in repo).

import type { Hono } from 'hono';
import type { McpServerRegistryRow, PodMcpServerConfig, PodScope, ULID } from '@pc/domain';
import {
  createMcpServerRegistry,
  getProjectById,
  getMcpServerRegistry,
  listMcpServersRegistry,
  patchMcpServerRegistry,
  resolveAgentForDispatch,
  setMcpServerDiscovery,
  softDeleteMcpServerRegistry,
} from '@pc/db';
import { COMMAND_PROJECT_SLUG } from '@pc/contracts';
import { COMMAND_PLANNER_POD_NAME } from '../../services/command-planner-pod-content.ts';
import { parsePodMcpServerConfig } from '../../services/pod-mcp-config.ts';

export type ProbeFn = (config: PodMcpServerConfig) => Promise<{ status: 'ok' | 'failed'; tools?: string[]; error?: string }>;

export interface McpServerRoutesDeps {
  /** Resolves a project runtime by id; null → 404. */
  resolveProject?: (projectId: string) => { project: { id: ULID } } | null;
  /**
   * P2: discovery probe function. When provided, auto-probe fires on create
   * and the POST .../probe route is enabled.
   * Injected so tests can stub it without launching real subprocesses.
   */
  probe?: ProbeFn;
}

export function registerMcpServerRoutes(app: Hono, deps: McpServerRoutesDeps = {}): void {

  // ── Shared helper: run probe + persist result ────────────────────────────────

  async function runAndStoreProbe(id: ULID, config: PodMcpServerConfig): Promise<McpServerRegistryRow | null> {
    const probeResult = await deps.probe!(config);
    return setMcpServerDiscovery(id, {
      status: probeResult.status,
      tools: probeResult.status === 'ok' ? (probeResult.tools ?? []) : null,
    });
  }

  // ── Global scope ────────────────────────────────────────────────────────────

  /** GET /api/mcp-servers — list global registry servers */
  app.get('/api/mcp-servers', (c) => {
    const servers = listMcpServersRegistry({ scope: 'global' });
    return c.json({ ok: true, servers });
  });

  /** POST /api/mcp-servers — create a global registry server */
  app.post('/api/mcp-servers', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { body = null; }
    const result = parseServerBody(body, 'global', null);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
    try {
      const server = createMcpServerRegistry(result.input);
      // P2: fire-and-forget auto-probe; does not delay the create response.
      if (deps.probe) {
        void runAndStoreProbe(server.id, server.transport).catch(() => {});
      }
      return c.json({ ok: true, server }, 201);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 422);
    }
  });

  /** GET /api/mcp-servers/:id — get a single registry server */
  app.get('/api/mcp-servers/:id', (c) => {
    const id = c.req.param('id') as ULID;
    const server = getMcpServerRegistry(id);
    if (!server) return c.json({ ok: false, error: `unknown mcp server: ${id}` }, 404);
    return c.json({ ok: true, server });
  });

  /** PATCH /api/mcp-servers/:id — update name / description / transport */
  app.patch('/api/mcp-servers/:id', async (c) => {
    const id = c.req.param('id') as ULID;
    const existing = getMcpServerRegistry(id);
    if (!existing) return c.json({ ok: false, error: `unknown mcp server: ${id}` }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { body = null; }
    const result = parsePatchBody(body);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
    try {
      const server = patchMcpServerRegistry(id, result.patch);
      return c.json({ ok: true, server });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 422);
    }
  });

  /** DELETE /api/mcp-servers/:id — soft-delete a registry server */
  app.delete('/api/mcp-servers/:id', (c) => {
    const id = c.req.param('id') as ULID;
    const row = softDeleteMcpServerRegistry(id);
    if (!row) return c.json({ ok: false, error: `unknown mcp server: ${id}` }, 404);
    return c.json({ ok: true });
  });

  /** POST /api/mcp-servers/:id/probe — run tool-discovery and store result.
   *
   * Synchronous: waits for the probe to complete (subject to the probe's own
   * timeout) and returns the updated server row. On timeout/failure the row is
   * updated with discoveryStatus='failed' and the error is reported. Never
   * hangs indefinitely — the probe function is responsible for its timeout.
   */
  app.post('/api/mcp-servers/:id/probe', async (c) => {
    if (!deps.probe) {
      return c.json({ ok: false, error: 'probe not available' }, 501);
    }
    const id = c.req.param('id') as ULID;
    const existing = getMcpServerRegistry(id);
    if (!existing) return c.json({ ok: false, error: `unknown mcp server: ${id}` }, 404);
    const updated = await runAndStoreProbe(id, existing.transport);
    return c.json({ ok: true, server: updated ?? existing });
  });

  // ── Project scope ───────────────────────────────────────────────────────────

  /** GET /api/projects/:projectId/mcp-servers — list project-scoped servers */
  app.get('/api/projects/:projectId/mcp-servers', (c) => {
    const projectId = c.req.param('projectId');
    if (deps.resolveProject) {
      const runtime = deps.resolveProject(projectId);
      if (!runtime) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
    }
    const servers = listMcpServersRegistry({ scope: 'project', projectId: projectId as ULID });
    return c.json({ ok: true, servers });
  });

  /** POST /api/projects/:projectId/mcp-servers — create a project-scoped server */
  app.post('/api/projects/:projectId/mcp-servers', async (c) => {
    const projectId = c.req.param('projectId');
    if (deps.resolveProject) {
      const runtime = deps.resolveProject(projectId);
      if (!runtime) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
    }
    let body: unknown;
    try { body = await c.req.json(); } catch { body = null; }
    const result = parseServerBody(body, 'project', projectId as ULID);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
    try {
      const server = createMcpServerRegistry(result.input);
      // P2: fire-and-forget auto-probe.
      if (deps.probe) {
        void runAndStoreProbe(server.id, server.transport).catch(() => {});
      }
      return c.json({ ok: true, server }, 201);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 422);
    }
  });

  // ── Orchestrator pod resolution (P4a) ────────────────────────────────────────

  /** GET /api/projects/:projectId/orchestrator-pod — resolve the pod that
   *  drives this project's chat session (orchestrator for regular projects;
   *  command-planner for the Command project). Returns `{ agentId }` so the
   *  UI can manage the orchestrator's MCP attachments without knowing which
   *  pod name is in play. */
  app.get('/api/projects/:projectId/orchestrator-pod', (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
    const podName =
      project.slug === COMMAND_PROJECT_SLUG ? COMMAND_PLANNER_POD_NAME : 'orchestrator';
    const agent = resolveAgentForDispatch(podName, projectId);
    if (!agent) return c.json({ ok: false, error: 'orchestrator pod not found' }, 404);
    return c.json({ ok: true, agentId: agent.id });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type ParseOk<T> = { ok: true } & T;
type ParseErr = { ok: false; error: string };

function parseServerBody(
  body: unknown,
  scope: PodScope,
  projectId: ULID | null,
): ParseOk<{ input: import('@pc/db').CreateMcpServerRegistryInput }> | ParseErr {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'request body must be an object' };
  }
  const b = body as Record<string, unknown>;
  if (!b.name || typeof b.name !== 'string' || !b.name.trim()) {
    return { ok: false, error: 'name is required and must be a non-empty string' };
  }
  let transport: ReturnType<typeof parsePodMcpServerConfig>;
  try {
    transport = parsePodMcpServerConfig(b.transport);
  } catch (err) {
    return { ok: false, error: `transport: ${(err as Error).message}` };
  }
  return {
    ok: true,
    input: {
      scope,
      projectId,
      name: b.name.trim(),
      description: typeof b.description === 'string' ? b.description : '',
      transport,
    },
  };
}

function parsePatchBody(
  body: unknown,
): ParseOk<{ patch: import('@pc/db').PatchMcpServerRegistryInput }> | ParseErr {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'request body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const patch: import('@pc/db').PatchMcpServerRegistryInput = {};
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) {
      return { ok: false, error: 'name must be a non-empty string' };
    }
    patch.name = b.name.trim();
  }
  if (b.description !== undefined) {
    if (typeof b.description !== 'string') {
      return { ok: false, error: 'description must be a string' };
    }
    patch.description = b.description;
  }
  if (b.transport !== undefined) {
    try {
      patch.transport = parsePodMcpServerConfig(b.transport);
    } catch (err) {
      return { ok: false, error: `transport: ${(err as Error).message}` };
    }
  }
  return { ok: true, patch };
}
