// Connector-auth Slice 3 (pc-pty-chat-400.4) — vault-backed OAuth storage + provider factory.
//
// VaultOAuthStorage wires OAuthProviderStorage to SecretsVault:
//   tokens (kind='oauth_tokens') and client info (kind='static') are persisted
//   via AES-256-GCM through the vault.
//   codeVerifier and discoveryState are held in memory (ephemeral).
//
// Note: Slice 4 (loopback callback broker) will need the codeVerifier to survive
// across two HTTP requests; VaultOAuthStorage should be enhanced to persist it
// at that point.
//
// Factory: createOAuthProvider(input) builds a ready-to-use VaultOAuthProvider
// for a registered MCP server.

import type { ULID } from '@pc/domain';
import { getCredentialByServerAndKind } from '@pc/db';
import {
  InMemoryOAuthStorage,
  VaultOAuthProvider,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthDiscoveryState,
  type OAuthProviderStorage,
  type OAuthTokens,
  type PreRegisteredClientConfig,
  type VaultOAuthProviderConfig,
} from '@pc/mcp/oauth/provider';
import { getSecretsVault, type SecretsVault } from './secrets-vault.ts';

// ── Vault-backed storage ──────────────────────────────────────────────────────

/** OAuthProviderStorage backed by the AES-256-GCM vault for durable state. */
export class VaultOAuthStorage implements OAuthProviderStorage {
  private readonly _vault: SecretsVault;
  private readonly _serverId: ULID;
  private readonly _ownerScope: 'global' | 'project';

  // Ephemeral — does not survive process restart.
  private _codeVerifier: string | undefined;
  private _discoveryState: OAuthDiscoveryState | undefined;

  constructor(vault: SecretsVault, serverId: ULID, ownerScope: 'global' | 'project') {
    this._vault = vault;
    this._serverId = serverId;
    this._ownerScope = ownerScope;
  }

  // --- tokens ---------------------------------------------------------------

  async loadTokens(): Promise<OAuthTokens | undefined> {
    const raw = this._vault.getByServerAndKind(this._serverId, 'oauth_tokens');
    if (raw == null) return undefined;
    // Safe cast: vault only stores what storeTokens wrote.
    return raw as OAuthTokens;
  }

  async storeTokens(tokens: OAuthTokens): Promise<void> {
    const expiresAt = tokens.expires_in != null
      ? Date.now() + tokens.expires_in * 1000
      : null;
    this._vault.upsertForServer(this._serverId, 'oauth_tokens', this._ownerScope, tokens, expiresAt);
  }

  // --- client information ---------------------------------------------------

  async loadClientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const raw = this._vault.getByServerAndKind(this._serverId, 'static');
    if (raw == null) return undefined;
    return raw as OAuthClientInformationMixed;
  }

  async storeClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this._vault.upsertForServer(this._serverId, 'static', this._ownerScope, info);
  }

  // --- code verifier (ephemeral) -------------------------------------------

  async storeCodeVerifier(verifier: string): Promise<void> {
    this._codeVerifier = verifier;
  }

  async loadCodeVerifier(): Promise<string> {
    if (this._codeVerifier === undefined) {
      throw new Error(
        'No code verifier stored — VaultOAuthStorage instances must be reused ' +
        'across the full auth flow (first auth() call through token exchange)',
      );
    }
    return this._codeVerifier;
  }

  // --- discovery state (ephemeral cache) -----------------------------------

  async loadDiscoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this._discoveryState;
  }

  async storeDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this._discoveryState = state;
  }

  // --- invalidate ----------------------------------------------------------

  async invalidate(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'tokens') {
      const row = getCredentialByServerAndKind(this._serverId, 'oauth_tokens');
      if (row) this._vault.delete(row.id);
    }
    if (scope === 'all' || scope === 'client') {
      const row = getCredentialByServerAndKind(this._serverId, 'static');
      if (row) this._vault.delete(row.id);
    }
    if (scope === 'all' || scope === 'verifier') this._codeVerifier = undefined;
    if (scope === 'all' || scope === 'discovery') this._discoveryState = undefined;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface CreateOAuthProviderInput {
  /** Registry server ID — credentials are scoped to this server. */
  serverId: ULID;
  ownerScope: 'global' | 'project';
  /**
   * Port the API server is listening on.
   * The loopback redirect URL is built as:
   *   http://127.0.0.1:{redirectPort}/api/oauth/callback
   * (wired in Slice 4 — not yet registered as a route).
   */
  redirectPort: number;
  /** Merge into the default OAuthClientMetadata sent during DCR. */
  clientMetadata?: Partial<OAuthClientMetadata>;
  /** Pre-registered creds for servers that do not support DCR. */
  preRegisteredClient?: PreRegisteredClientConfig;
  /**
   * Called when the SDK requests browser authorization.
   * Slice 4 wires this to shell.openExternal via the Electron IPC relay.
   */
  onRedirectToAuthorization: (url: URL) => void | Promise<void>;
  /** Override the vault singleton (useful in tests). */
  vault?: SecretsVault;
}

/**
 * Build a VaultOAuthProvider for a registered MCP server.
 * Uses the module-level SecretsVault singleton by default.
 */
export function createOAuthProvider(input: CreateOAuthProviderInput): VaultOAuthProvider {
  const vault = input.vault ?? getSecretsVault();
  const redirectUrl = `http://127.0.0.1:${input.redirectPort}/api/oauth/callback`;

  const storage = new VaultOAuthStorage(vault, input.serverId, input.ownerScope);

  const clientMetadata: OAuthClientMetadata = {
    redirect_uris: [redirectUrl],
    client_name: 'Caisson',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    ...input.clientMetadata,
  };

  return new VaultOAuthProvider({
    redirectUrl,
    clientMetadata,
    preRegisteredClient: input.preRegisteredClient,
    onRedirectToAuthorization: input.onRedirectToAuthorization,
    storage,
  });
}

// Re-export from @pc/mcp for server-internal convenience
export { InMemoryOAuthStorage, VaultOAuthProvider };
export type { OAuthProviderStorage, VaultOAuthProviderConfig };
