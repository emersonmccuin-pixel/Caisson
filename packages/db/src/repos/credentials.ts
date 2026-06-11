// Connector-auth Slice 1 (pc-pty-chat-400.2) — Credentials vault repo.
//
// CRUD over the `credentials` table. The service layer (secrets-vault.ts) owns
// the crypto; this repo just persists and retrieves opaque base64 blobs.
// No audit table in Slice 1 — auth-state transitions are surfaced via the
// mcp_servers UI badge (Slice 6).

import { and, eq, isNull } from 'drizzle-orm';
import type { CredentialAuthState, CredentialKind, CredentialRow, ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { credentials } from '../schema.ts';

function rowToCredential(row: typeof credentials.$inferSelect): CredentialRow {
  return {
    id: row.id as ULID,
    ownerScope: row.ownerScope as 'global' | 'project',
    ownerServerId: (row.ownerServerId as ULID | null) ?? null,
    kind: row.kind as CredentialKind,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
    authState: row.authState as CredentialAuthState,
    lastError: row.lastError ?? null,
    expiresAt: row.expiresAt ?? null,
    rev: row.rev,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// --- create ------------------------------------------------------------------

export interface CreateCredentialInput {
  id?: ULID;
  ownerScope: 'global' | 'project';
  ownerServerId?: ULID | null;
  kind: CredentialKind;
  /** Base64-encoded ciphertext (AES-256-GCM output). */
  ciphertext: string;
  /** Base64-encoded 12-byte IV. */
  iv: string;
  /** Base64-encoded 16-byte GCM auth tag. */
  authTag: string;
  authState?: CredentialAuthState;
  expiresAt?: number | null;
}

export function createCredential(input: CreateCredentialInput): CredentialRow {
  const now = Date.now();
  const id = (input.id ?? newId()) as ULID;
  const row = {
    id,
    ownerScope: input.ownerScope,
    ownerServerId: input.ownerServerId ?? null,
    kind: input.kind,
    ciphertext: input.ciphertext,
    iv: input.iv,
    authTag: input.authTag,
    authState: (input.authState ?? 'none') as CredentialAuthState,
    lastError: null,
    expiresAt: input.expiresAt ?? null,
    rev: 1,
    createdAt: now,
    updatedAt: now,
  };
  getDb().insert(credentials).values(row).run();
  return rowToCredential(row as typeof credentials.$inferSelect);
}

// --- read --------------------------------------------------------------------

export function getCredential(id: ULID): CredentialRow | null {
  const row = getDb()
    .select()
    .from(credentials)
    .where(eq(credentials.id, id))
    .get();
  return row ? rowToCredential(row) : null;
}

export function getCredentialByServer(ownerServerId: ULID): CredentialRow | null {
  const row = getDb()
    .select()
    .from(credentials)
    .where(eq(credentials.ownerServerId, ownerServerId))
    .get();
  return row ? rowToCredential(row) : null;
}

export function listCredentialsByScope(ownerScope: 'global' | 'project'): CredentialRow[] {
  const rows = getDb()
    .select()
    .from(credentials)
    .where(eq(credentials.ownerScope, ownerScope))
    .all();
  return rows.map(rowToCredential);
}

// --- update auth state -------------------------------------------------------

export function updateCredentialAuthState(
  id: ULID,
  authState: CredentialAuthState,
  lastError: string | null,
): CredentialRow | null {
  const existing = getCredential(id);
  if (!existing) return null;
  const now = Date.now();
  getDb()
    .update(credentials)
    .set({
      authState,
      lastError: lastError ?? null,
      updatedAt: now,
      rev: existing.rev + 1,
    })
    .where(eq(credentials.id, id))
    .run();
  return getCredential(id);
}

// --- delete ------------------------------------------------------------------

export function deleteCredential(id: ULID): void {
  getDb().delete(credentials).where(eq(credentials.id, id)).run();
}

// --- lookup by server + kind (Slice 3 — connector-auth) ----------------------

/** Return the first credential row matching (ownerServerId, kind), or null. */
export function getCredentialByServerAndKind(
  ownerServerId: ULID,
  kind: CredentialKind,
): CredentialRow | null {
  const row = getDb()
    .select()
    .from(credentials)
    .where(and(eq(credentials.ownerServerId, ownerServerId), eq(credentials.kind, kind)))
    .get();
  return row ? rowToCredential(row) : null;
}
