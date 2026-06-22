// Connector-auth Slice 2 (pc-pty-chat-400.3) — secret-ref resolver +
// plaintext-to-vault migration.
//
// Two exports:
//   resolveTransportSecrets(transport, vault) → PodMcpServerConfig
//     Swaps every { $secretRef: credId } in transport.headers / transport.env
//     for the live plaintext string from the vault. Non-ref values pass through.
//     Returns a fully-resolved PodMcpServerConfig safe to pass to buildTransport.
//
//   migrateTransportPlaintextToVault(vault) → number
//     Scans all non-deleted registry servers. For each server whose transport
//     has ANY plain-string values in headers or env, encrypts each value in the
//     vault (kind='static'), replaces the string with { $secretRef: credId },
//     and writes the updated transport back via replaceTransportOnly (which does
//     NOT clear discoveryStatus — the probe result stays valid). Idempotent:
//     values that are already refs are left untouched. Returns the count of
//     individual values migrated.

import type { McpServerTransport, PodMcpServerConfig, SecretRef, TransportValue, ULID } from '@pc/domain';
import { listMcpServersRegistry, replaceTransportOnly } from '@pc/db';
import type { SecretsVault } from './secrets-vault.ts';

// ── Type guard ────────────────────────────────────────────────────────────────

/** True when `v` is a `{ $secretRef: string }` vault reference. */
export function isSecretRef(v: TransportValue): v is SecretRef {
  return typeof v === 'object' && v !== null && typeof (v as SecretRef).$secretRef === 'string';
}

// ── Resolver ─────────────────────────────────────────────────────────────────

function resolveValue(key: string, v: TransportValue, vault: SecretsVault): string {
  if (!isSecretRef(v)) return v;
  const credId = v.$secretRef as ULID;
  const payload = vault.get(credId);
  if (payload === null) {
    throw new Error(`resolveTransportSecrets: credential "${credId}" not found (key="${key}")`);
  }
  // OAuth tokens are stored as OAuthTokens objects — extract access_token and
  // wrap with the "Bearer" scheme so the header is ready for HTTP use.
  if (typeof payload === 'object' && payload !== null) {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.access_token === 'string') {
      return `Bearer ${obj.access_token}`;
    }
  }
  if (typeof payload !== 'string') {
    throw new Error(
      `resolveTransportSecrets: credential "${credId}" payload is not a string (key="${key}")`,
    );
  }
  return payload;
}

/** Return a copy of `transport` with every `$secretRef` value resolved to the
 *  live plaintext string from the vault. Plain-string values pass through.
 *
 *  Throws if a referenced credential is missing or its stored payload is not
 *  a string. */
export function resolveTransportSecrets(
  transport: McpServerTransport,
  vault: SecretsVault,
): PodMcpServerConfig {
  const resolved: PodMcpServerConfig = {
    ...(transport.command !== undefined ? { command: transport.command } : {}),
    ...(transport.args !== undefined ? { args: transport.args } : {}),
    ...(transport.cwd !== undefined ? { cwd: transport.cwd } : {}),
    ...(transport.type !== undefined ? { type: transport.type } : {}),
    ...(transport.url !== undefined ? { url: transport.url } : {}),
  };

  if (transport.headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(transport.headers)) {
      headers[k] = resolveValue(k, v, vault);
    }
    resolved.headers = headers;
  }

  if (transport.env) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(transport.env)) {
      env[k] = resolveValue(k, v, vault);
    }
    resolved.env = env;
  }

  return resolved;
}

// ── Migration ─────────────────────────────────────────────────────────────────

/** Migrate every plaintext string value in transport.headers / transport.env
 *  for all non-deleted registry servers.
 *
 *  For each plain string found:
 *  1. Stores the value in the vault as `kind: 'static'`.
 *  2. Replaces the inline string with `{ $secretRef: credentialId }`.
 *  3. Persists the updated transport via replaceTransportOnly (discovery state
 *     unchanged — only the storage form of the credential changes).
 *
 *  Already-migrated refs are skipped. Safe to call multiple times (idempotent).
 *  Returns the count of individual plaintext values migrated. */
export function migrateTransportPlaintextToVault(vault: SecretsVault): number {
  let migratedCount = 0;

  for (const server of listMcpServersRegistry({})) {
    const transport = server.transport;
    let changed = false;
    const newTransport: McpServerTransport = {
      ...(transport.command !== undefined ? { command: transport.command } : {}),
      ...(transport.args !== undefined ? { args: transport.args } : {}),
      ...(transport.cwd !== undefined ? { cwd: transport.cwd } : {}),
      ...(transport.type !== undefined ? { type: transport.type } : {}),
      ...(transport.url !== undefined ? { url: transport.url } : {}),
    };

    if (transport.headers) {
      const newHeaders: Record<string, TransportValue> = {};
      for (const [k, v] of Object.entries(transport.headers)) {
        if (isSecretRef(v)) {
          newHeaders[k] = v; // already migrated — leave as-is
        } else {
          const cred = vault.store({
            ownerScope: server.scope,
            ownerServerId: server.id,
            kind: 'static',
            plaintext: v,
          });
          newHeaders[k] = { $secretRef: cred.id };
          changed = true;
          migratedCount++;
        }
      }
      newTransport.headers = newHeaders;
    }

    if (transport.env) {
      const newEnv: Record<string, TransportValue> = {};
      for (const [k, v] of Object.entries(transport.env)) {
        if (isSecretRef(v)) {
          newEnv[k] = v; // already migrated — leave as-is
        } else {
          const cred = vault.store({
            ownerScope: server.scope,
            ownerServerId: server.id,
            kind: 'static',
            plaintext: v,
          });
          newEnv[k] = { $secretRef: cred.id };
          changed = true;
          migratedCount++;
        }
      }
      newTransport.env = newEnv;
    }

    if (changed) {
      replaceTransportOnly(server.id, newTransport);
    }
  }

  return migratedCount;
}
