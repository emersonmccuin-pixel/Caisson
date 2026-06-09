// pc-pty-chat-359 P2 — MCP server tool-discovery probe.
//
// Connects to a registered MCP server (stdio or HTTP streamable), calls
// tools/list, captures the result, and disconnects. A hard timeout ensures
// a broken or unresponsive server never causes a silent hang.
//
// Positive-receipt principle: every probe resolves to a TYPED ProbeResult —
// never rejects. Callers store the result (ok or failed) and surface it.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PodMcpServerConfig } from '@pc/domain';

export const PROBE_TIMEOUT_MS = 10_000;

export type ProbeOk = { status: 'ok'; tools: string[] };
export type ProbeFailed = { status: 'failed'; error: string; timedOut?: boolean };
export type ProbeResult = ProbeOk | ProbeFailed;

/**
 * Probe a single MCP server for its tool list.
 *
 * Always resolves — never rejects. Timeout or connection failure resolves to
 * a typed `ProbeFailed` result. The subprocess (stdio) or connection (HTTP)
 * is always torn down before resolution — no phantom processes.
 */
export async function probeMcpServer(
  config: PodMcpServerConfig,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  // We need to be able to close the transport/client from the timeout handler
  // so the subprocess doesn't linger after the timeout fires.
  let closeTransport: (() => Promise<void>) | null = null;

  const timeoutPromise = new Promise<ProbeFailed>((resolve) => {
    const timer = setTimeout(() => {
      // Best-effort close — may already be closed by the probe path.
      if (closeTransport) void closeTransport().catch(() => {});
      resolve({ status: 'failed', error: `probe timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);
    // Don't let the timer prevent Node from exiting.
    if (typeof timer.unref === 'function') timer.unref();
  });

  const probePromise = (async (): Promise<ProbeResult> => {
    const client = new Client({ name: 'pc-probe', version: '0.0.0' }, { capabilities: {} });
    let transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;

    try {
      if (config.command) {
        // stdio — spawn the server process
        const spawnEnv = config.env
          ? { ...getDefaultEnvironment(), ...config.env }
          : undefined;
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: spawnEnv,
          stderr: 'pipe',
        });
      } else if (config.url) {
        // HTTP streamable
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        });
      } else {
        return { status: 'failed', error: 'transport has neither command nor url' };
      }

      // Register close callback for the timeout path.
      closeTransport = () => client.close();

      await client.connect(transport);
      const result = await client.listTools();
      const tools = (result.tools ?? []).map((t) => t.name);
      return { status: 'ok', tools };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', error: msg };
    } finally {
      // Tear down regardless of outcome — kills the subprocess on stdio.
      try { await client.close(); } catch { /* best-effort */ }
    }
  })();

  return Promise.race([probePromise, timeoutPromise]);
}
