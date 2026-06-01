import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Hono } from 'hono';
import type { ULID } from '@pc/domain';
import { getDb, getProjectById, insertLiveEvent } from '@pc/db';

import { listCustomCommands as defaultListCustomCommands } from '../../services/custom-commands.ts';
import {
  type MemoryScope,
  readMemoryFile as defaultReadMemoryFile,
  writeMemoryFile as defaultWriteMemoryFile,
} from '../../services/memory-files.ts';

export interface ProjectContextRuntime {
  folderPath: string;
}

export interface ProjectContextRouteDeps {
  resolveProject(projectId: string): ProjectContextRuntime | null;
  getProjectFolderPath?: (projectId: ULID) => string | null;
  listCustomCommands?: typeof defaultListCustomCommands;
  readMemoryFile?: typeof defaultReadMemoryFile;
  writeMemoryFile?: typeof defaultWriteMemoryFile;
}

function defaultGetProjectFolderPath(projectId: ULID): string | null {
  return getProjectById(projectId)?.folderPath ?? null;
}

function parseMemoryScope(scope: string): MemoryScope | null {
  return scope === 'user' || scope === 'project' || scope === 'workspace' ? scope : null;
}

export function registerProjectContextRoutes(app: Hono, deps: ProjectContextRouteDeps): void {
  const services = {
    getProjectFolderPath: deps.getProjectFolderPath ?? defaultGetProjectFolderPath,
    listCustomCommands: deps.listCustomCommands ?? defaultListCustomCommands,
    readMemoryFile: deps.readMemoryFile ?? defaultReadMemoryFile,
    writeMemoryFile: deps.writeMemoryFile ?? defaultWriteMemoryFile,
  };

  /** Custom commands for the Abilities tray. Scans project and user command dirs. */
  app.get('/api/projects/:projectId/commands', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    return c.json({ ok: true, commands: services.listCustomCommands(runtime.folderPath) });
  });

  /** Memory file (`CLAUDE.md`) read for one scope. */
  app.get('/api/projects/:projectId/memory/:scope', (c) => {
    const id = c.req.param('projectId');
    const scope = c.req.param('scope');
    const parsedScope = parseMemoryScope(scope);
    if (!parsedScope) return c.json({ ok: false, error: `invalid scope: ${scope}` }, 400);
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    return c.json({ ok: true, file: services.readMemoryFile(parsedScope, runtime.folderPath) });
  });

  /** Memory file write. Body: `{ content: string }`. */
  app.put('/api/projects/:projectId/memory/:scope', async (c) => {
    const id = c.req.param('projectId');
    const scope = c.req.param('scope');
    const parsedScope = parseMemoryScope(scope);
    if (!parsedScope) return c.json({ ok: false, error: `invalid scope: ${scope}` }, 400);
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{ content?: string }>();
    if (typeof body.content !== 'string') {
      return c.json({ ok: false, error: 'content required' }, 400);
    }
    const file = services.writeMemoryFile(parsedScope, runtime.folderPath, body.content);
    return c.json({ ok: true, file });
  });

  /** D82 detection: is the project's CLAUDE.md missing or effectively empty? */
  app.get('/api/projects/:projectId/claude-md-status', (c) => {
    const id = c.req.param('projectId') as ULID;
    const folderPath = services.getProjectFolderPath(id);
    if (!folderPath) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const path = resolve(folderPath, 'CLAUDE.md');
    if (!existsSync(path)) return c.json({ ok: true, exists: false, empty: true });
    try {
      const content = readFileSync(path, 'utf-8');
      return c.json({ ok: true, exists: true, empty: content.trim().length === 0 });
    } catch (err) {
      return c.json({ ok: false, error: `read failed: ${(err as Error).message}` }, 500);
    }
  });

  /** D82 write -- backs the `pc_write_claude_md` MCP tool. */
  app.put('/api/projects/:projectId/claude-md', async (c) => {
    const id = c.req.param('projectId') as ULID;
    const folderPath = services.getProjectFolderPath(id);
    if (!folderPath) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{ content?: string }>();
    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      return c.json({ ok: false, error: 'content required (non-empty)' }, 400);
    }
    const path = resolve(folderPath, 'CLAUDE.md');
    try {
      writeFileSync(path, body.content, 'utf-8');
    } catch (err) {
      return c.json({ ok: false, error: `write failed: ${(err as Error).message}` }, 500);
    }
    // Slice 015b — announce through the durable door; the relay delivers the
    // canonical project.claude-md.changed frame. No hand-fanout. The fact is a
    // refetch signal (the file content lives on disk, re-probed via HTTP).
    getDb().transaction((tx) => {
      insertLiveEvent(tx, {
        scope: 'project',
        projectId: id,
        type: 'project.claude-md.changed',
        entity: 'project-claude-md',
        entityId: id,
        version: null,
        payload: {},
      });
    });
    return c.json({ ok: true });
  });
}
