// FD-2 — identity-token signing for the shared HTTP MCP endpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  mcpAuthSecret,
  signMcpClaims,
  verifyMcpToken,
  type PcMcpClaims,
} from '../src/services/mcp-http-auth.ts';

const CLAIMS: PcMcpClaims = {
  projectId: '01TESTPROJECT0000000000000',
  sessionId: '01TESTSESSION0000000000000',
  agentSessionId: 'cc-uuid-1',
  agentRunId: '01TESTRUN00000000000000000',
  dispatcherSessionId: 'dispatcher-1',
  parentWorkItemId: '01TESTWI000000000000000000',
  invokeDepth: 1,
};

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'pc-mcp-auth-'));
}

test('sign → verify round-trip', () => {
  const dir = tempDataDir();
  try {
    const secret = mcpAuthSecret(dir);
    const token = signMcpClaims(secret, CLAIMS);
    assert.equal(verifyMcpToken(secret, CLAIMS, token), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tampered claim fails verification (every field is covered)', () => {
  const dir = tempDataDir();
  try {
    const secret = mcpAuthSecret(dir);
    const token = signMcpClaims(secret, CLAIMS);
    for (const field of Object.keys(CLAIMS) as (keyof PcMcpClaims)[]) {
      const tampered = { ...CLAIMS, [field]: field === 'invokeDepth' ? 9 : 'evil' };
      assert.equal(
        verifyMcpToken(secret, tampered as PcMcpClaims, token),
        false,
        `tampering ${field} must invalidate the token`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty / wrong-length token rejected without throwing', () => {
  const dir = tempDataDir();
  try {
    const secret = mcpAuthSecret(dir);
    assert.equal(verifyMcpToken(secret, CLAIMS, ''), false);
    assert.equal(verifyMcpToken(secret, CLAIMS, 'short'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret persists on disk — tokens survive an API restart', () => {
  const dir = tempDataDir();
  try {
    const secret = mcpAuthSecret(dir);
    const onDisk = readFileSync(join(dir, 'mcp-auth-secret.key'), 'utf8').trim();
    assert.equal(onDisk, secret);
    // A "restarted" process re-reads the same secret (bypass the cache by
    // reading the file the way mcpAuthSecret does on a cold start).
    const token = signMcpClaims(onDisk, CLAIMS);
    assert.equal(verifyMcpToken(secret, CLAIMS, token), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
