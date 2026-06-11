// Connector-auth Slice 3 (pc-pty-chat-400.4) — vault-backed OAuthClientProvider.
//
// This module lives in packages/mcp and has NO direct DB/vault dependency so
// it stays testable in isolation.  It defines:
//   OAuthProviderStorage  — the storage seam injected by callers
//   VaultOAuthProvider    — OAuthClientProvider implementation
//   InMemoryOAuthStorage  — in-process storage for unit tests
//
// Production wiring: apps/server/src/services/oauth-provider.ts provides
// VaultOAuthStorage (vault-backed) + createOAuthProvider() factory.
//
// Approach: one canonical OAuthClientProvider, not a parallel OAuth state
// machine.  The SDK auth() / StreamableHTTPClientTransport drive discovery,
// DCR, PKCE, token exchange, and refresh — we only persist state.

import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';

// Re-export SDK OAuth types so apps/server can import them via
// @pc/mcp/oauth/provider without a direct @modelcontextprotocol/sdk dep.
export type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
export type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';

// ── Storage seam ──────────────────────────────────────────────────────────────

/**
 * Pluggable storage for all OAuth state associated with one MCP server.
 *
 * Durable (vault-backed in production):
 *   tokens            — access + refresh tokens
 *   clientInformation — DCR result or pre-registered creds
 *
 * Ephemeral (in-memory is fine):
 *   codeVerifier    — PKCE verifier, discarded after token exchange
 *   discoveryState  — RFC 9728 discovery cache; re-fetched on miss
 *
 * Note: Slice 4 (loopback callback broker) will need the codeVerifier to
 * survive across two HTTP requests; at that point the vault-backed impl
 * should persist it too.
 */
export interface OAuthProviderStorage {
  loadTokens(): Promise<OAuthTokens | undefined>;
  storeTokens(tokens: OAuthTokens): Promise<void>;

  loadClientInformation(): Promise<OAuthClientInformationMixed | undefined>;
  storeClientInformation(info: OAuthClientInformationMixed): Promise<void>;

  /** Must be called before loadCodeVerifier. */
  storeCodeVerifier(verifier: string): Promise<void>;
  /** Throws if no verifier is stored — saveCodeVerifier must precede this. */
  loadCodeVerifier(): Promise<string>;

  loadDiscoveryState(): Promise<OAuthDiscoveryState | undefined>;
  storeDiscoveryState(state: OAuthDiscoveryState): Promise<void>;

  /**
   * Selectively clear stored state.  Called by VaultOAuthProvider.invalidateCredentials()
   * which the SDK triggers on certain auth-server error responses.
   */
  invalidate(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void>;
}

// ── Pre-registered client config ──────────────────────────────────────────────

/**
 * Static client credentials for providers that do not support DCR (e.g. Google).
 * When provided, clientInformation() returns these directly and
 * saveClientInformation() is a no-op.
 */
export interface PreRegisteredClientConfig {
  client_id: string;
  client_secret?: string;
}

// ── Provider config ───────────────────────────────────────────────────────────

export interface VaultOAuthProviderConfig {
  /**
   * Loopback callback URL — port is resolved at runtime, do not hardcode.
   * Pattern: `http://127.0.0.1:${port}/api/oauth/callback`
   */
  redirectUrl: string | URL;

  /** OAuth client metadata sent during DCR (RFC 7591). */
  clientMetadata: OAuthClientMetadata;

  /**
   * Pre-registered client credentials.
   * When set, clientInformation() returns these statically and
   * saveClientInformation() is a no-op.  Use for providers without DCR support.
   */
  preRegisteredClient?: PreRegisteredClientConfig;

  /**
   * Called when the SDK determines the user must authorize in a browser.
   * Slice 3: callers treat this as an emitted "open URL" intent.
   * Slice 4 wires this to shell.openExternal via the Electron IPC relay.
   */
  onRedirectToAuthorization: (url: URL) => void | Promise<void>;

  /** Backing storage — inject InMemoryOAuthStorage for tests. */
  storage: OAuthProviderStorage;
}

// ── Provider ──────────────────────────────────────────────────────────────────

/**
 * OAuthClientProvider for MCP OAuth 2.1 + PKCE flows.
 *
 * One instance per MCP server connection.  Create via createOAuthProvider() in
 * apps/server for production (vault-backed storage) or directly with an
 * InMemoryOAuthStorage for unit tests.
 */
export class VaultOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string | URL;
  readonly clientMetadata: OAuthClientMetadata;

  private readonly _cfg: VaultOAuthProviderConfig;

  constructor(cfg: VaultOAuthProviderConfig) {
    this._cfg = cfg;
    this.redirectUrl = cfg.redirectUrl;
    this.clientMetadata = cfg.clientMetadata;
  }

  // --- clientInformation / saveClientInformation ----------------------------

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this._cfg.preRegisteredClient) {
      const { client_id, client_secret } = this._cfg.preRegisteredClient;
      return client_secret !== undefined ? { client_id, client_secret } : { client_id };
    }
    return this._cfg.storage.loadClientInformation();
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    // No-op for pre-registered clients — never overwrite static creds.
    if (this._cfg.preRegisteredClient) return;
    await this._cfg.storage.storeClientInformation(info);
  }

  // --- tokens / saveTokens --------------------------------------------------

  async tokens(): Promise<OAuthTokens | undefined> {
    return this._cfg.storage.loadTokens();
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this._cfg.storage.storeTokens(tokens);
  }

  // --- redirectToAuthorization ---------------------------------------------

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this._cfg.onRedirectToAuthorization(authorizationUrl);
  }

  // --- codeVerifier / saveCodeVerifier -------------------------------------

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this._cfg.storage.storeCodeVerifier(codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    return this._cfg.storage.loadCodeVerifier();
  }

  // --- discoveryState / saveDiscoveryState ---------------------------------

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this._cfg.storage.loadDiscoveryState();
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this._cfg.storage.storeDiscoveryState(state);
  }

  // --- invalidateCredentials -----------------------------------------------

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    await this._cfg.storage.invalidate(scope);
  }
}

// ── In-memory storage (tests + future non-vault paths) ───────────────────────

/**
 * Simple in-memory OAuthProviderStorage — no persistence, no DB.
 * Ideal for unit tests.
 */
export class InMemoryOAuthStorage implements OAuthProviderStorage {
  private _tokens: OAuthTokens | undefined;
  private _clientInfo: OAuthClientInformationMixed | undefined;
  private _codeVerifier: string | undefined;
  private _discoveryState: OAuthDiscoveryState | undefined;

  async loadTokens(): Promise<OAuthTokens | undefined> { return this._tokens; }
  async storeTokens(t: OAuthTokens): Promise<void> { this._tokens = t; }

  async loadClientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this._clientInfo;
  }
  async storeClientInformation(i: OAuthClientInformationMixed): Promise<void> {
    this._clientInfo = i;
  }

  async storeCodeVerifier(v: string): Promise<void> { this._codeVerifier = v; }
  async loadCodeVerifier(): Promise<string> {
    if (this._codeVerifier === undefined) {
      throw new Error('No code verifier stored for this auth session');
    }
    return this._codeVerifier;
  }

  async loadDiscoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this._discoveryState;
  }
  async storeDiscoveryState(s: OAuthDiscoveryState): Promise<void> {
    this._discoveryState = s;
  }

  async invalidate(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'tokens') this._tokens = undefined;
    if (scope === 'all' || scope === 'client') this._clientInfo = undefined;
    if (scope === 'all' || scope === 'verifier') this._codeVerifier = undefined;
    if (scope === 'all' || scope === 'discovery') this._discoveryState = undefined;
  }
}
