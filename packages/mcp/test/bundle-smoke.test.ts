import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

import { TOOLS } from '../src/server.ts';

// 11G bundle smoke — the esbuild bundle (dist/server.mjs) is the REAL boot
// artifact. Spawn it as a stdio MCP server with a fake PC_* env, drive the
// JSON-RPC initialize + tools/list handshake, and assert ListTools returns the
// SAME tool names IN THE SAME ORDER as the TOOLS source. A contracts-import
// boot failure (or a reorder) fails here. Run `pnpm --filter @pc/mcp build`
// first (the package `prepare`/`dev` rebuild it; CI runs build before test).

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(__dirname, '..', 'dist', 'server.mjs');

function rpc(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

test('dist/server.mjs boots and ListTools returns TOOLS names in TOOLS order', async () => {
  assert.ok(
    existsSync(BUNDLE),
    `bundle not found at ${BUNDLE} — run \`pnpm --filter @pc/mcp build\` first`,
  );

  const child = spawn(process.execPath, [BUNDLE], {
    env: {
      ...process.env,
      PC_PROJECT_ID: '01SMOKESMOKESMOKESMOKESMOK',
      PC_SERVER_PORT: '4040',
      PC_DATA_DIR: resolve(__dirname, '..', 'dist', '.smoke-data'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const toolNames = await new Promise<string[]>((resolveP, rejectP) => {
    let buf = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectP(new Error('timed out waiting for tools/list response'));
    }, 15_000);

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { tools?: Array<{ name: string }> } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2 && msg.result?.tools) {
          clearTimeout(timer);
          resolveP(msg.result.tools.map((t) => t.name));
        }
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      rejectP(e);
    });

    // initialize handshake, then tools/list
    child.stdin.write(
      rpc(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0' },
      }),
    );
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(rpc(2, 'tools/list', {}));
  });

  child.kill('SIGKILL');

  assert.deepEqual(toolNames, TOOLS.map((t) => t.name));
});
