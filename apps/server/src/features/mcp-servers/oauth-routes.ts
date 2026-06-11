// Connector-auth Slice 4 (pc-pty-chat-400.5) — OAuth broker endpoints.
//
// POST /api/mcp-servers/:id/auth/start
//   Builds an OAuthClientProvider for the server, runs the SDK auth() orchestrator,
//   and returns:
//     { ok: true, status: 'authorized' }          — tokens present / refreshed
//     { ok: true, status: 'redirect',
//       authorizationUrl: string }                 — browser redirect required
//
// GET /api/oauth/callback
//   Receives ?code=&state= from the browser redirect after the user authorizes.
//   State is matched against the pending session (CSRF guard), token exchange
//   completes, tokens are stored in the vault, the server credential is marked
//   authState='connected', and a close-tab HTML page is returned.
//
// codeVerifier bridging:
//   The PKCE codeVerifier lives in-memory on the VaultOAuthProvider instance.
//   A module-level pendingAuthSessions map (keyed by OAuth state, TTL 10 min)
//   holds the provider alive across the two HTTP requests. Both requests hit the
//   same API process — in-memory bridging is correct for v1.

import type { Hono } from 'hono';
import type { ULID } from '@pc/domain';
import { getMcpServerRegistry, getCredentialByServerAndKind } from '@pc/db';
import {
  auth,
  createOAuthProvider,
  type AuthResult,
  type VaultOAuthProvider,
} from '../../services/oauth-provider.ts';
import { tryGetSecretsVault } from '../../services/secrets-vault.ts';

// ── Pending-auth session store ─────────────────────────────────────────────────

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface PendingAuthSession {
  serverId: ULID;
  serverUrl: string;
  ownerScope: 'global' | 'project';
  /** Provider instance — holds the in-memory PKCE codeVerifier. */
  provider: VaultOAuthProvider;
  createdAt: number;
}

// Keyed by the OAuth `state` query parameter embedded in the authorization URL.
// Module-level — survives across requests within one process run.
const pendingAuthSessions = new Map<string, PendingAuthSession>();

/** Remove sessions older than PENDING_TTL_MS. Call before every lookup/insert. */
function pruneExpired(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [state, session] of pendingAuthSessions) {
    if (session.createdAt < cutoff) pendingAuthSessions.delete(state);
  }
}

// ── Route deps ────────────────────────────────────────────────────────────────

export type AuthFn = (
  provider: VaultOAuthProvider,
  options: { serverUrl: string | URL; authorizationCode?: string },
) => Promise<AuthResult>;

export interface OAuthRoutesDeps {
  /** API server port — builds the loopback callback URL. */
  port: number;
  /**
   * Injectable auth orchestrator (defaults to the SDK auth()).
   * Tests inject a stub to avoid real network calls.
   */
  authFn?: AuthFn;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerOAuthRoutes(app: Hono, deps: OAuthRoutesDeps): void {
  const { port } = deps;
  const authFn: AuthFn = (deps.authFn ?? auth) as AuthFn;

  // ── POST /api/mcp-servers/:id/auth/start ──────────────────────────────────

  app.post('/api/mcp-servers/:id/auth/start', async (c) => {
    const id = c.req.param('id') as ULID;
    const server = getMcpServerRegistry(id);
    if (!server) return c.json({ ok: false, error: `unknown mcp server: ${id}` }, 404);

    const { transport, scope } = server;
    if (!transport.url) {
      return c.json(
        { ok: false, error: 'auth/start only applies to HTTP transport servers' },
        400,
      );
    }

    const serverUrl = transport.url;
    const ownerScope = scope as 'global' | 'project';
    // Use a ref object so TypeScript's closure narrowing doesn't treat the
    // variable as always-null after the callback assignment.
    const capture: { authorizationUrl: string | null } = { authorizationUrl: null };

    const provider = createOAuthProvider({
      serverId: id,
      ownerScope,
      redirectPort: port,
      onRedirectToAuthorization: (url) => {
        capture.authorizationUrl = url.toString();
        // Extract the OAuth `state` from the authorization URL and register the
        // provider instance in the pending-sessions map so the callback can reuse
        // the same instance (which holds the in-memory PKCE codeVerifier).
        const stateParam = url.searchParams.get('state');
        if (stateParam) {
          pruneExpired();
          pendingAuthSessions.set(stateParam, {
            serverId: id,
            serverUrl,
            ownerScope,
            provider,
            createdAt: Date.now(),
          });
        }
      },
    });

    let result: AuthResult;
    try {
      result = await authFn(provider, { serverUrl });
    } catch (err) {
      return c.json({ ok: false, error: `auth failed: ${(err as Error).message}` }, 502);
    }

    if (result === 'AUTHORIZED') {
      return c.json({ ok: true, status: 'authorized' });
    }

    // result === 'REDIRECT': provider.redirectToAuthorization was called.
    if (!capture.authorizationUrl) {
      return c.json(
        { ok: false, error: 'auth() returned REDIRECT but no authorization URL was captured' },
        500,
      );
    }

    return c.json({ ok: true, status: 'redirect', authorizationUrl: capture.authorizationUrl });
  });

  // ── GET /api/oauth/callback ───────────────────────────────────────────────

  app.get('/api/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const oauthError = c.req.query('error');

    if (oauthError) {
      return c.html(errorPage(`Authorization failed: ${oauthError}`), 400);
    }
    if (!code || !state) {
      return c.html(errorPage('Missing code or state parameter.'), 400);
    }

    pruneExpired();
    const session = pendingAuthSessions.get(state);
    if (!session) {
      // CSRF guard: unknown or expired state.
      return c.html(errorPage('State mismatch — this link has expired or is invalid.'), 400);
    }

    // Remove immediately — single-use.
    pendingAuthSessions.delete(state);

    const { provider, serverUrl, serverId } = session;

    let result: AuthResult;
    try {
      result = await authFn(provider, { serverUrl, authorizationCode: code });
    } catch (err) {
      return c.html(errorPage(`Token exchange failed: ${(err as Error).message}`), 502);
    }

    if (result !== 'AUTHORIZED') {
      return c.html(errorPage('Token exchange did not complete — unexpected redirect.'), 500);
    }

    // Mark the oauth_tokens credential as connected. Best-effort: tokens are
    // already stored by the SDK via provider.saveTokens(); the auth-state update
    // is for the UI badge (Slice 6).
    try {
      const vault = tryGetSecretsVault();
      if (vault) {
        const row = getCredentialByServerAndKind(serverId, 'oauth_tokens');
        if (row) vault.updateAuthState(row.id, 'connected', null);
      }
    } catch {
      // Non-fatal — tokens are stored; state update retried on next connect.
    }

    return c.html(completePage(), 200);
  });
}

// ── HTML page helpers ─────────────────────────────────────────────────────────

function completePage(): string {
  return (
    '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>Connected — Caisson</title>\n' +
    '<style>\n' +
    'body{font-family:system-ui,sans-serif;display:flex;align-items:center;' +
    'justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5;}\n' +
    '.card{text-align:center;padding:2rem;max-width:400px;}\n' +
    'h1{font-size:1.5rem;margin-bottom:.5rem;}\n' +
    'p{color:#a0a0a0;}\n' +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<div class="card">\n' +
    '  <h1>Authentication complete</h1>\n' +
    '  <p>You can close this tab and return to Caisson.</p>\n' +
    '</div>\n' +
    '</body>\n' +
    '</html>'
  );
}

function errorPage(message: string): string {
  const safeMsg = escapeHtml(message);
  return (
    '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>Error — Caisson</title>\n' +
    '<style>\n' +
    'body{font-family:system-ui,sans-serif;display:flex;align-items:center;' +
    'justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5;}\n' +
    '.card{text-align:center;padding:2rem;max-width:400px;}\n' +
    'h1{font-size:1.5rem;margin-bottom:.5rem;color:#f87171;}\n' +
    'p{color:#a0a0a0;}\n' +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<div class="card">\n' +
    '  <h1>Authorization error</h1>\n' +
    `  <p>${safeMsg}</p>\n` +
    '</div>\n' +
    '</body>\n' +
    '</html>'
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
