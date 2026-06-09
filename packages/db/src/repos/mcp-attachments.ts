// pc-pty-chat-359 P3 — Repository for the agent_mcp_attachments link table.
//
// Links an agent to a registered MCP server with a per-tool selection.
// enabled_tools is stored as the literal string '*' (all tools) or a JSON-
// encoded string[] (specific subset). PUT routes call upsertMcpAttachment,
// which creates or replaces the row in-place (UNIQUE on agentId+mcpServerId).

import { and, eq } from 'drizzle-orm';
import type { AgentMcpAttachmentRow, ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { agentMcpAttachments } from '../schema.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function deserializeEnabledTools(raw: string): string[] | '*' {
  if (raw === '*') return '*';
  return JSON.parse(raw) as string[];
}

function serializeEnabledTools(tools: string[] | '*'): string {
  if (tools === '*') return '*';
  return JSON.stringify(tools);
}

function rowToAttachment(row: typeof agentMcpAttachments.$inferSelect): AgentMcpAttachmentRow {
  return {
    id: row.id as ULID,
    agentId: row.agentId as ULID,
    mcpServerId: row.mcpServerId as ULID,
    enabledTools: deserializeEnabledTools(row.enabledTools),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── create / upsert ───────────────────────────────────────────────────────────

export interface UpsertMcpAttachmentInput {
  agentId: ULID;
  mcpServerId: ULID;
  enabledTools: string[] | '*';
}

/** Create or replace an attachment. If the (agentId, mcpServerId) pair already
 *  exists the row is updated in-place (enabledTools + updatedAt). Returns the
 *  live row after the write. */
export function upsertMcpAttachment(input: UpsertMcpAttachmentInput): AgentMcpAttachmentRow {
  const db = getDb();
  const now = Date.now();
  const serialized = serializeEnabledTools(input.enabledTools);

  // Check for existing row to decide insert vs update.
  const existing = db
    .select()
    .from(agentMcpAttachments)
    .where(
      and(
        eq(agentMcpAttachments.agentId, input.agentId),
        eq(agentMcpAttachments.mcpServerId, input.mcpServerId),
      ),
    )
    .get();

  if (existing) {
    db.update(agentMcpAttachments)
      .set({ enabledTools: serialized, updatedAt: now })
      .where(eq(agentMcpAttachments.id, existing.id))
      .run();
    return rowToAttachment({ ...existing, enabledTools: serialized, updatedAt: now });
  }

  const id = newId() as ULID;
  const row = { id, agentId: input.agentId, mcpServerId: input.mcpServerId, enabledTools: serialized, createdAt: now, updatedAt: now };
  db.insert(agentMcpAttachments).values(row).run();
  return rowToAttachment(row);
}

// ── read ──────────────────────────────────────────────────────────────────────

export function getMcpAttachment(id: ULID): AgentMcpAttachmentRow | null {
  const row = getDb()
    .select()
    .from(agentMcpAttachments)
    .where(eq(agentMcpAttachments.id, id))
    .get();
  return row ? rowToAttachment(row) : null;
}

export function getMcpAttachmentByPair(
  agentId: ULID,
  mcpServerId: ULID,
): AgentMcpAttachmentRow | null {
  const row = getDb()
    .select()
    .from(agentMcpAttachments)
    .where(
      and(
        eq(agentMcpAttachments.agentId, agentId),
        eq(agentMcpAttachments.mcpServerId, mcpServerId),
      ),
    )
    .get();
  return row ? rowToAttachment(row) : null;
}

export function listMcpAttachmentsForAgent(agentId: ULID): AgentMcpAttachmentRow[] {
  const rows = getDb()
    .select()
    .from(agentMcpAttachments)
    .where(eq(agentMcpAttachments.agentId, agentId))
    .all();
  return rows.map(rowToAttachment);
}

// ── delete ────────────────────────────────────────────────────────────────────

/** Hard-delete by (agentId, mcpServerId) pair. Returns true when a row was
 *  removed, false when no matching row existed. */
export function deleteMcpAttachmentByPair(agentId: ULID, mcpServerId: ULID): boolean {
  const existing = getMcpAttachmentByPair(agentId, mcpServerId);
  if (!existing) return false;
  getDb()
    .delete(agentMcpAttachments)
    .where(eq(agentMcpAttachments.id, existing.id))
    .run();
  return true;
}
