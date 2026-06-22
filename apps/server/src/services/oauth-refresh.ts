// pc-pty-chat-459 OB — pre-spawn OAuth token refresh + single-flight lock.
//
// refreshOAuthTokenIfNeeded(serverId, serverUrl, ownerScope, vault[, redirectPort][, deps])
//   Checks whether the oauth_tokens credential for serverId is near expiry
//   (within REFRESH_THRESHOLD_MS). If so, runs the MCP SDK auth() refresh grant
//   via VaultOAuthProvider. Stores updated tokens via VaultOAuthStorage.
//
//   Per-server single-flight lock: concurrent spawns for the same server queue
//   behind one refresh, preventing a double-rotation race on the refresh token.
//
//   On expired/missing refresh token (redirect required): marks authState='needs-auth'
//   and throws { message, cause: 'oauth-token-expired' }. buildRegistryMcpConfig's
//   try/catch will then skip the server for this spawn.

import { getCredentialByServerAndKind } from '@pc/db';
import type { ULID } from '@pc/domain';
import {
  auth,
  VaultOAuthStorage,
  VaultOAuthProvider,
  type VaultOAuthProviderConfig,
} from './oauth-provider.ts';
import type { OAuthClientMetadata } from '@pc/mcp/oauth/provider';
import type { SecretsVault } from './secrets-vault.ts';

const REFRESH_THRESHOLD_MS = 60_000; // refresh when within 60s of expiry

// ── Types ──────────────────────────────────────────────────────────────────────

export type OAuthRefreshAuthFn = typeof auth;

/** Deps injection seam — lets tests supply a mock auth() without redefining
 *  the ESM named export (node:test mock.method cannot redefine ESM exports). */
export interface OAuthRefreshDeps {
  authFn?: OAuthRefreshAuthFn;
}

// ── Single-flight lock ────────────────────────────────────────────────────────

/** Per-server in-process lock. Prevents concurrent spawns from double-rotating
 *  the refresh token (read-check-refresh-store is not DB-atomic). */
const _inflight = new Map<ULID, Promise<void>>();

// ── Public API ────────────────────────────────────────────────────────────────

/** Refresh the OAuth access token for `serverId` if it is near expiry.
 *
 *  No-op when:
 *  - No oauth_tokens credential exists for the server.
 *  - expiresAt is null (server did not supply expires_in, no expiry tracking).
 *  - Token has > REFRESH_THRESHOLD_MS of life remaining.
 *
 *  Throws with `.cause === 'oauth-token-expired'` when:
 *  - The refresh grant fails (token endpoint error).
 *  - The SDK redirects to browser (expired or absent refresh_token).
 *    The credential row is marked authState='needs-auth' in both cases. */
export async function refreshOAuthTokenIfNeeded(
  serverId: ULID,
  serverUrl: string,
  ownerScope: 'global' | 'project',
  vault: SecretsVault,
  redirectPort = Number(process.env.PORT ?? 4040),
  deps: OAuthRefreshDeps = {},
): Promise<void> {
  const credRow = getCredentialByServerAndKind(serverId, 'oauth_tokens');
  if (!credRow) return; // No token stored — nothing to refresh.

  const { expiresAt } = credRow;
  // null = no expiry tracking (server omitted expires_in) → skip.
  // Future expiresAt with plenty of buffer → skip.
  if (expiresAt === null || expiresAt > Date.now() + REFRESH_THRESHOLD_MS) return;

  // Single-flight: queue behind an already-running refresh for this server.
  const inflight = _inflight.get(serverId);
  if (inflight) return inflight;

  const p = _doRefresh(serverId, serverUrl, ownerScope, vault, redirectPort, deps);
  _inflight.set(serverId, p);
  try {
    await p;
  } finally {
    _inflight.delete(serverId);
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _doRefresh(
  serverId: ULID,
  serverUrl: string,
  ownerScope: 'global' | 'project',
  vault: SecretsVault,
  redirectPort: number,
  deps: OAuthRefreshDeps,
): Promise<void> {
  const authFn = deps.authFn ?? auth;
  let needsAuth = false;

  // Build the loopback callback URL (mirrors createOAuthProvider factory).
  const redirectUrl = `http://127.0.0.1:${redirectPort}/api/oauth/callback`;
  const clientMetadata: OAuthClientMetadata = {
    redirect_uris: [redirectUrl],
    client_name: 'Caisson',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
  };

  const cfg: VaultOAuthProviderConfig = {
    redirectUrl,
    clientMetadata,
    onRedirectToAuthorization: () => {
      needsAuth = true;
    },
    storage: new VaultOAuthStorage(vault, serverId, ownerScope),
  };
  const provider = new VaultOAuthProvider(cfg);

  let result: string;
  try {
    result = await authFn(provider, { serverUrl });
  } catch (err) {
    _markNeedsAuth(serverId, vault, (err as Error).message);
    throw Object.assign(
      new Error(`OAuth token refresh failed for server "${serverId}": ${(err as Error).message}`),
      { cause: 'oauth-token-expired' as const },
    );
  }

  if (result !== 'AUTHORIZED' || needsAuth) {
    _markNeedsAuth(serverId, vault, null);
    throw Object.assign(
      new Error(`OAuth token requires re-authorization for server "${serverId}"`),
      { cause: 'oauth-token-expired' as const },
    );
  }
}

function _markNeedsAuth(
  serverId: ULID,
  vault: SecretsVault,
  lastError: string | null,
): void {
  try {
    const row = getCredentialByServerAndKind(serverId, 'oauth_tokens');
    if (row) vault.updateAuthState(row.id, 'needs-auth', lastError);
  } catch {
    // Best-effort — auth-state update is not critical path.
  }
}
