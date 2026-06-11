// Shared MCP transport builder — the single place that maps a PodMcpServerConfig
// (stdio or HTTP) to an SDK transport instance.  Slice 0 of the connector-auth
// build: kills the fork between probe.ts and call.ts so that authProvider (Slice 3+)
// is threaded in ONE location.

import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { PodMcpServerConfig } from '@pc/domain';

export type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

export interface BuildTransportOpts {
  /** Passed to StreamableHTTPClientTransport for OAuth flows (unused by callers
   *  this slice; wired here so later slices add auth in one place). */
  authProvider?: OAuthClientProvider;
}

/** Discriminated-union result: either a ready transport or a human-readable
 *  error string (config has neither command nor url). */
export type BuildTransportResult =
  | { ok: true; transport: McpTransport }
  | { ok: false; error: string };

/**
 * Build the appropriate MCP client transport for a registered server config.
 *
 * - stdio config (`command` present) → `StdioClientTransport`
 * - HTTP config  (`url` present)     → `StreamableHTTPClientTransport`
 * - neither                          → `{ ok: false, error: '...' }`
 *
 * Always returns, never throws.
 */
export function buildTransport(
  config: PodMcpServerConfig,
  opts?: BuildTransportOpts,
): BuildTransportResult {
  if (config.command) {
    const spawnEnv = config.env
      ? { ...getDefaultEnvironment(), ...config.env }
      : undefined;
    return {
      ok: true,
      transport: new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: spawnEnv,
        stderr: 'pipe',
      }),
    };
  }

  if (config.url) {
    return {
      ok: true,
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
        authProvider: opts?.authProvider,
      }),
    };
  }

  return { ok: false, error: 'transport has neither command nor url' };
}
