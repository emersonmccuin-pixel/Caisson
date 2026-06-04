// FD-2 — identity tokens for the shared HTTP MCP endpoint.
//
// Every PC-spawned Claude session gets its identity claims baked into its
// session-local mcp.json as X-PC-* headers, plus an X-PC-Token = HMAC of those
// claims. The endpoint recomputes the HMAC per request: headers carry the
// CLAIM, the token proves the server itself issued it (a session cannot
// impersonate another by editing headers it never saw signed).
//
// The secret is a file under the data dir so tokens survive API restarts —
// sessions outlive the API (host-owned agents keep running through
// /api/dev/restart) and their mcp.json is immutable after spawn.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { PcMcpClaims } from '@pc/mcp/http-endpoint';

export type { PcMcpClaims };

/** Canonical byte string the HMAC covers. Fixed field order — adding a field
 *  is a breaking change for outstanding sessions (they re-init on 401 anyway). */
function canonical(claims: PcMcpClaims): string {
  return [
    `projectId=${claims.projectId}`,
    `sessionId=${claims.sessionId}`,
    `agentSessionId=${claims.agentSessionId}`,
    `agentRunId=${claims.agentRunId}`,
    `dispatcherSessionId=${claims.dispatcherSessionId}`,
    `parentWorkItemId=${claims.parentWorkItemId}`,
    `invokeDepth=${claims.invokeDepth}`,
  ].join('\n');
}

const secretCache = new Map<string, string>();

/** Load (or mint once) the per-install signing secret. */
export function mcpAuthSecret(dataDir: string): string {
  const cached = secretCache.get(dataDir);
  if (cached) return cached;
  const file = resolve(dataDir, 'mcp-auth-secret.key');
  let secret: string;
  try {
    secret = readFileSync(file, 'utf8').trim();
    if (!secret) throw new Error('empty secret file');
  } catch {
    secret = randomBytes(32).toString('hex');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, secret + '\n', 'utf8');
  }
  secretCache.set(dataDir, secret);
  return secret;
}

export function signMcpClaims(secret: string, claims: PcMcpClaims): string {
  return createHmac('sha256', secret).update(canonical(claims)).digest('hex');
}

export function verifyMcpToken(secret: string, claims: PcMcpClaims, token: string): boolean {
  if (!token) return false;
  const expected = Buffer.from(signMcpClaims(secret, claims), 'utf8');
  const given = Buffer.from(token, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
