// Connector-auth Slice 1 (pc-pty-chat-400.2) — AES-256-GCM secrets vault.
//
// The master key is a 32-byte Buffer held in memory only. In the deployed
// topology it arrives from Electron main via a dedicated stdio init message
// (see apps/desktop/src/main.ts — `PC_VAULT_USE_STDIN=1`). In tests, inject
// a key directly via `new SecretsVault(key)`.
//
// Design decisions:
// - AES-256-GCM: authenticated encryption, 12-byte random IV per operation,
//   16-byte auth tag. Wrong key or tampered ciphertext → `decrypt` throws.
// - Ciphertext, IV, and auth tag are base64-encoded text in the DB row.
// - The module exposes a singleton for production via `initVault`/`getSecretsVault`.
//   Tests bypass the singleton and construct SecretsVault directly.
// - `PC_VAULT_USE_STDIN=1` env var + not-a-TTY stdin guard prevents dev-mode
//   hang when the server is started without the Electron supervisor.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CredentialAuthState, CredentialKind, CredentialRow, ULID } from '@pc/domain';
import {
  createCredential,
  deleteCredential,
  getCredential,
  getCredentialByServer,
  getCredentialByServerAndKind,
  updateCredentialAuthState,
} from '@pc/db';

// ── Core vault class ──────────────────────────────────────────────────────────

export class SecretsVault {
  private readonly key: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error(`SecretsVault: master key must be 32 bytes, got ${masterKey.length}`);
    }
    // Copy to prevent external mutation.
    this.key = Buffer.from(masterKey);
  }

  // --- Crypto layer ----------------------------------------------------------

  /** Encrypt any JSON-serialisable value. Returns base64-encoded parts. */
  encrypt(plaintext: unknown): { ciphertext: string; iv: string; authTag: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.from(JSON.stringify(plaintext), 'utf8');
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  /** Decrypt and parse. Throws `Error` if the key is wrong or data is tampered. */
  decrypt(ciphertext: string, iv: string, authTag: string): unknown {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
  }

  // --- Vault operations (DB-backed) ------------------------------------------

  /** Encrypt `plaintext` and write a new credential row. */
  store(input: {
    ownerScope: 'global' | 'project';
    ownerServerId?: ULID | null;
    kind: CredentialKind;
    plaintext: unknown;
    expiresAt?: number | null;
  }): CredentialRow {
    const { ciphertext, iv, authTag } = this.encrypt(input.plaintext);
    return createCredential({
      ownerScope: input.ownerScope,
      ownerServerId: input.ownerServerId ?? null,
      kind: input.kind,
      ciphertext,
      iv,
      authTag,
      expiresAt: input.expiresAt ?? null,
    });
  }

  /** Load and decrypt a credential. Returns `null` if the row is missing.
   *  Throws if decryption fails (wrong key or tampered data). */
  get(credentialId: ULID): unknown | null {
    const row = getCredential(credentialId);
    if (!row) return null;
    return this.decrypt(row.ciphertext, row.iv, row.authTag);
  }

  /** Load credential by server id and decrypt it. */
  getByServer(ownerServerId: ULID): unknown | null {
    const row = getCredentialByServer(ownerServerId);
    if (!row) return null;
    return this.decrypt(row.ciphertext, row.iv, row.authTag);
  }

  delete(credentialId: ULID): void {
    deleteCredential(credentialId);
  }

  /** Load and decrypt the credential matching (ownerServerId, kind).
   *  Returns `null` when no matching row exists. */
  getByServerAndKind(ownerServerId: ULID, kind: CredentialKind): unknown | null {
    const row = getCredentialByServerAndKind(ownerServerId, kind);
    if (!row) return null;
    return this.decrypt(row.ciphertext, row.iv, row.authTag);
  }

  /**
   * Upsert a credential for (ownerServerId, kind): replaces any existing row
   * with a freshly encrypted one.  Uses delete + insert to keep the crypto
   * path simple (avoids an in-place update of ciphertext/iv/authTag).
   */
  upsertForServer(
    ownerServerId: ULID,
    kind: CredentialKind,
    ownerScope: 'global' | 'project',
    plaintext: unknown,
    expiresAt?: number | null,
  ): CredentialRow {
    const existing = getCredentialByServerAndKind(ownerServerId, kind);
    if (existing) deleteCredential(existing.id);
    return this.store({ ownerScope, ownerServerId, kind, plaintext, expiresAt });
  }

  /** Persist a new auth state (+ optional error message). Bumps rev. */
  updateAuthState(
    credentialId: ULID,
    state: CredentialAuthState,
    lastError?: string | null,
  ): CredentialRow | null {
    return updateCredentialAuthState(credentialId, state, lastError ?? null);
  }
}

// ── Module-level singleton (production path) ─────────────────────────────────

let _vault: SecretsVault | null = null;

/** Initialize the module-level singleton from a pre-loaded key.
 *  Used in production after `initVaultFromStdin`, and in integration tests. */
export function initVault(key: Buffer): void {
  _vault = new SecretsVault(key);
}

/** Return the singleton, throwing if it was never initialized. */
export function getSecretsVault(): SecretsVault {
  if (!_vault) {
    throw new Error(
      'SecretsVault not initialized — call initVaultFromStdin() at server boot or initVault(key) in tests.',
    );
  }
  return _vault;
}

/** Return the singleton, or null when the vault is not yet initialized.
 *  Use when vault operations are optional (e.g. legacy non-authed paths). */
export function tryGetSecretsVault(): SecretsVault | null {
  return _vault;
}

// ── Boot initializer (production) ────────────────────────────────────────────

/**
 * Read the vault master key from stdin and initialize the singleton.
 *
 * Called at server boot when `PC_VAULT_USE_STDIN=1` is set — meaning the
 * Electron main process will write a one-line JSON init message to the API
 * child's stdin pipe before closing it:
 *
 *   `{ "type": "vault-init", "masterKey": "<32-bytes-as-hex>" }\n`
 *
 * Why stdin (not an env var):
 *   - Stdin is a private OS pipe between the two processes.
 *   - Env vars are visible in `ps`, `/proc/<pid>/environ`, crash dumps, and
 *     subprocesses that inherit the env.
 *   - Stdin data is consumed once at read time and is never observable again.
 *
 * No-ops (returns without initializing) when:
 *   - `PC_VAULT_USE_STDIN` is not set (dev mode, tsx, tests).
 *   - stdin is a TTY (interactive terminal — never happens in production).
 */
export function initVaultFromStdin(): void {
  if (!process.env.PC_VAULT_USE_STDIN) return;
  // Guard: skip if stdin is a terminal (dev mode / accidental direct launch).
  if (process.stdin.isTTY) {
    console.warn('[vault] PC_VAULT_USE_STDIN set but stdin is a TTY — vault not initialized');
    return;
  }
  try {
    const raw = (readFileSync(0, 'utf8') as string).trim();
    if (!raw) {
      console.error('[vault] stdin was empty — vault not initialized');
      return;
    }
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (msg.type !== 'vault-init' || typeof msg.masterKey !== 'string') {
      console.error('[vault] stdin init message has unexpected shape — vault not initialized');
      return;
    }
    const key = Buffer.from(msg.masterKey, 'hex');
    initVault(key);
    console.log('[vault] master key received via stdin init channel');
  } catch (err) {
    console.error('[vault] failed to read stdin init message:', (err as Error).message);
  }
}
