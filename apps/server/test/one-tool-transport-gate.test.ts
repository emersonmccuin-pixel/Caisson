// FD-2 (Step-4 Slice 0) — ONE-TOOL-TRANSPORT gate.
//
// The pc-rig baseline every PC-spawned session receives is the shared HTTP
// endpoint with signed identity headers — NEVER a `command:'node' …
// dist/server.mjs` stdio child. A resurrected stdio entry would be a silent
// dual transport (sessions would "work" while bypassing token identity).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PC_MCP_CLAIM_HEADERS, PC_MCP_TOKEN_HEADER } from '@pc/mcp/http-endpoint';

import { prepareClaudeRuntimeFiles } from '../src/services/claude-runtime-bundle.ts';
import { mcpAuthSecret, verifyMcpToken } from '../src/services/mcp-http-auth.ts';

const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const TRUNK = resolve(SRC, '..', '..', '..');

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('baseline pc-rig entry is the shared HTTP endpoint with verifiable identity', () => {
  const dataDir = tempDir('pc-ott-data-');
  const scratch = tempDir('pc-ott-scratch-');
  try {
    const files = prepareClaudeRuntimeFiles({
      scratchDir: scratch,
      worktreeDir: scratch,
      projectId: null,
      projectSlug: 'gate-test',
      identity: {
        sessionId: 'sess-1',
        agentSessionId: 'cc-1',
        agentRunId: 'run-1',
        dispatcherSessionId: 'disp-1',
        parentWorkItemId: 'wi-1',
        invokeDepth: 2,
      },
      dataDir,
      templatesDir: resolve(TRUNK, 'templates'),
      serverPort: 4999,
    });
    try {
      const entry = files.baselineMcpServers['pc-rig']!;
      assert.equal(entry.type, 'http');
      assert.equal(entry.url, 'http://127.0.0.1:4999/api/mcp');
      assert.equal(entry.command, undefined, 'NO stdio command — one transport');
      assert.equal(entry.args, undefined);

      const headers = entry.headers!;
      assert.equal(headers[PC_MCP_CLAIM_HEADERS.sessionId], 'sess-1');
      assert.equal(headers[PC_MCP_CLAIM_HEADERS.agentSessionId], 'cc-1');
      assert.equal(headers[PC_MCP_CLAIM_HEADERS.agentRunId], 'run-1');
      assert.equal(headers[PC_MCP_CLAIM_HEADERS.dispatcherSessionId], 'disp-1');
      assert.equal(headers[PC_MCP_CLAIM_HEADERS.parentWorkItemId], 'wi-1');
      assert.equal(headers[PC_MCP_CLAIM_HEADERS.invokeDepth], '2');

      // The token verifies against the headers as written — and ONLY those.
      const secret = mcpAuthSecret(dataDir);
      const claims = {
        projectId: headers[PC_MCP_CLAIM_HEADERS.projectId]!,
        sessionId: 'sess-1',
        agentSessionId: 'cc-1',
        agentRunId: 'run-1',
        dispatcherSessionId: 'disp-1',
        parentWorkItemId: 'wi-1',
        invokeDepth: 2,
      };
      const token = headers[PC_MCP_TOKEN_HEADER]!;
      assert.equal(verifyMcpToken(secret, claims, token), true);
      assert.equal(
        verifyMcpToken(secret, { ...claims, sessionId: 'someone-else' }, token),
        false,
        'a session cannot rewrite its claims onto its own token',
      );

      // The on-disk mcp.json carries the same entry (what claude.exe reads).
      const onDisk = JSON.parse(readFileSync(files.mcpConfigPath, 'utf8')) as {
        mcpServers: Record<string, { type?: string; command?: string }>;
      };
      assert.equal(onDisk.mcpServers['pc-rig']!.type, 'http');
      assert.equal(onDisk.mcpServers['pc-rig']!.command, undefined);
    } finally {
      files.cleanup();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('two sessions get distinct tokens (identity is per-spawn, not shared)', () => {
  const dataDir = tempDir('pc-ott-data2-');
  const scratchA = tempDir('pc-ott-a-');
  const scratchB = tempDir('pc-ott-b-');
  try {
    const mk = (scratch: string, sessionId: string) =>
      prepareClaudeRuntimeFiles({
        scratchDir: scratch,
        worktreeDir: scratch,
        projectId: null,
        identity: { sessionId },
        dataDir,
        templatesDir: resolve(TRUNK, 'templates'),
        serverPort: 4999,
      });
    const a = mk(scratchA, 'session-A');
    const b = mk(scratchB, 'session-B');
    try {
      const tokenA = a.baselineMcpServers['pc-rig']!.headers![PC_MCP_TOKEN_HEADER];
      const tokenB = b.baselineMcpServers['pc-rig']!.headers![PC_MCP_TOKEN_HEADER];
      assert.notEqual(tokenA, tokenB);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratchA, { recursive: true, force: true });
    rmSync(scratchB, { recursive: true, force: true });
  }
});

test('STATIC: the stdio transport stays dead in @pc/mcp server.ts', () => {
  const src = readFileSync(resolve(TRUNK, 'packages', 'mcp', 'src', 'server.ts'), 'utf8');
  assert.ok(
    !src.includes('StdioServerTransport'),
    'packages/mcp/src/server.ts must not re-grow the stdio transport (FD-2: HTTP endpoint is the one transport)',
  );
});
