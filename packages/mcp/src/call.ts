// Workflow `call` nodes — invoke ONE tool on a registered MCP server.
//
// Mirrors probe.ts: connect (stdio or HTTP streamable), call the tool, capture
// the result, disconnect. A hard timeout ensures a broken or unresponsive
// server never causes a silent hang.
//
// Positive-receipt principle: every call resolves to a TYPED CallToolOutcome —
// never rejects. The workflow executor settles the node from it (ok →
// completed with output; failed → typed step failure).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { PodMcpServerConfig } from '@pc/domain';
import { buildTransport } from './transport.js';

export const CALL_TOOL_TIMEOUT_MS = 120_000;

export type CallToolOk = {
  status: 'ok';
  /** Flattened text rendering of the result: `structuredContent` JSON when the
   *  tool returned one, else the text content blocks joined. */
  output: string;
};
export type CallToolFailed = { status: 'failed'; error: string; timedOut?: boolean };
export type CallToolOutcome = CallToolOk | CallToolFailed;

/** Render an MCP CallToolResult into one output string. `structuredContent`
 *  (when present) wins — it round-trips through `$nodeId.output.field` refs;
 *  otherwise the text blocks are joined. */
function renderResult(result: Record<string, unknown>): string {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return JSON.stringify(result.structuredContent);
  }
  const blocks = Array.isArray(result.content) ? result.content : [];
  const texts = blocks
    .map((b: unknown) =>
      b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : '',
    )
    .filter((t: string) => t !== '');
  return texts.join('\n');
}

/**
 * Call a single tool on an MCP server.
 *
 * Always resolves — never rejects. A tool-level error (`isError: true`),
 * transport failure, or timeout resolves to a typed `CallToolFailed`. The
 * subprocess (stdio) or connection (HTTP) is always torn down before
 * resolution — no phantom processes.
 */
export async function callMcpTool(
  config: PodMcpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = CALL_TOOL_TIMEOUT_MS,
): Promise<CallToolOutcome> {
  let closeTransport: (() => Promise<void>) | null = null;

  const timeoutPromise = new Promise<CallToolFailed>((resolve) => {
    const timer = setTimeout(() => {
      if (closeTransport) void closeTransport().catch(() => {});
      resolve({
        status: 'failed',
        error: `tool call timed out after ${timeoutMs}ms`,
        timedOut: true,
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  const callPromise = (async (): Promise<CallToolOutcome> => {
    const client = new Client({ name: 'pc-workflow-call', version: '0.0.0' }, { capabilities: {} });

    try {
      const built = buildTransport(config);
      if (!built.ok) return { status: 'failed', error: built.error };
      const transport = built.transport;

      closeTransport = () => client.close();

      await client.connect(transport);
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: timeoutMs },
      );
      if (result.isError) {
        const message = renderResult(result) || 'tool returned an error with no message';
        return { status: 'failed', error: message };
      }
      return { status: 'ok', output: renderResult(result) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', error: msg };
    } finally {
      try { await client.close(); } catch { /* best-effort */ }
    }
  })();

  return Promise.race([callPromise, timeoutPromise]);
}
