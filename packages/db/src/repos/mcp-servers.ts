// pc-pty-chat-359 P1 — Repository for the mcp_servers registry table.
//
// Mirrors the pods.ts pattern: CRUD + scope-aware list, soft-delete, no audit
// table in P1 (discovery + attachment audit live in P2/P3). Routes reuse
// parsePodMcpServerConfig for transport validation; this layer just persists.

import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { McpDiscoveryStatus, McpServerRegistryRow, PodMcpServerConfig, PodScope, ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { mcpServers } from '../schema.ts';

function rowToRegistry(row: typeof mcpServers.$inferSelect): McpServerRegistryRow {
  return {
    id: row.id as ULID,
    scope: row.scope,
    projectId: row.projectId as ULID | null ?? null,
    name: row.name,
    description: row.description,
    transport: row.transport,
    discoveredTools: row.discoveredTools ?? null,
    discoveryStatus: row.discoveryStatus,
    rev: row.rev,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

// --- create ------------------------------------------------------------------

export interface CreateMcpServerRegistryInput {
  id?: ULID;
  scope: PodScope;
  /** Required when `scope === 'project'`. */
  projectId?: ULID | null;
  name: string;
  description?: string;
  transport: PodMcpServerConfig;
}

export function createMcpServerRegistry(input: CreateMcpServerRegistryInput): McpServerRegistryRow {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('createMcpServerRegistry: projectId is required when scope === "project"');
  }
  const now = Date.now();
  const id = (input.id ?? newId()) as ULID;
  const row = {
    id,
    scope: input.scope,
    projectId: input.scope === 'project' ? (input.projectId ?? null) : null,
    name: input.name,
    description: input.description ?? '',
    transport: input.transport,
    discoveredTools: null,
    discoveryStatus: 'stale' as McpDiscoveryStatus,
    rev: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  getDb().insert(mcpServers).values(row).run();
  return rowToRegistry(row as typeof mcpServers.$inferSelect);
}

// --- read --------------------------------------------------------------------

export function getMcpServerRegistry(id: ULID): McpServerRegistryRow | null {
  const row = getDb()
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), isNull(mcpServers.deletedAt)))
    .get();
  return row ? rowToRegistry(row) : null;
}

export interface ListMcpServersRegistryOptions {
  scope?: PodScope;
  projectId?: ULID;
  /** When true alongside projectId, returns BOTH project-scope rows for this
   *  project AND all global-scope rows. */
  includeGlobals?: boolean;
}

export function listMcpServersRegistry(opts: ListMcpServersRegistryOptions = {}): McpServerRegistryRow[] {
  const conditions = [isNull(mcpServers.deletedAt)];
  if (opts.projectId !== undefined) {
    if (opts.includeGlobals) {
      conditions.push(
        or(
          eq(mcpServers.scope, 'global'),
          and(eq(mcpServers.scope, 'project'), eq(mcpServers.projectId, opts.projectId)),
        )!,
      );
    } else {
      conditions.push(eq(mcpServers.scope, 'project'));
      conditions.push(eq(mcpServers.projectId, opts.projectId));
    }
  } else if (opts.scope !== undefined) {
    conditions.push(eq(mcpServers.scope, opts.scope));
  }
  const rows = getDb()
    .select()
    .from(mcpServers)
    .where(and(...conditions))
    .orderBy(asc(mcpServers.name))
    .all();
  return rows.map(rowToRegistry);
}

// --- patch -------------------------------------------------------------------

export interface PatchMcpServerRegistryInput {
  name?: string;
  description?: string;
  transport?: PodMcpServerConfig;
}

export function patchMcpServerRegistry(
  id: ULID,
  patch: PatchMcpServerRegistryInput,
): McpServerRegistryRow | null {
  const existing = getMcpServerRegistry(id);
  if (!existing) return null;
  const set: Record<string, unknown> = {};
  let changed = false;
  if (patch.name !== undefined && patch.name !== existing.name) {
    set.name = patch.name;
    changed = true;
  }
  if (patch.description !== undefined && patch.description !== existing.description) {
    set.description = patch.description;
    changed = true;
  }
  if (patch.transport !== undefined && JSON.stringify(patch.transport) !== JSON.stringify(existing.transport)) {
    set.transport = patch.transport;
    changed = true;
  }
  if (!changed) return existing;
  const now = Date.now();
  set.updatedAt = now;
  set.rev = existing.rev + 1;
  getDb().update(mcpServers).set(set).where(eq(mcpServers.id, id)).run();
  return getMcpServerRegistry(id);
}

// --- soft-delete -------------------------------------------------------------

export function softDeleteMcpServerRegistry(id: ULID): McpServerRegistryRow | null {
  const existing = getMcpServerRegistry(id);
  if (!existing) return null;
  const now = Date.now();
  getDb()
    .update(mcpServers)
    .set({ deletedAt: now, updatedAt: now, rev: existing.rev + 1 })
    .where(eq(mcpServers.id, id))
    .run();
  return { ...existing, deletedAt: now, updatedAt: now, rev: existing.rev + 1 };
}
