// Shared test scaffolding for the MCP slice-011 golden + typed-client tests.

import assert from 'node:assert/strict';
import type { ServerResponse, ToolContext, ToolResult } from '../src/tools/context.ts';
import { TypedLocalhostClient } from '../src/client/typed-client.ts';

export interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface FakeContextOptions {
  projectId?: string;
  sessionId?: string;
  dispatcherSessionId?: string;
  agentRunId?: string;
  agentParentWorkItemId?: string;
  agentSessionId?: string;
  /** Map a path (or method+path key) → canned response. Falls back to `default`. */
  responder: (method: RecordedCall['method'], path: string, body: unknown) => ServerResponse;
  /** Optional resolver override for resolveWorkItemIdViaServer. */
  resolveWorkItemId?: (ref: string) => Promise<string | null>;
}

const RICH_LINK_HINT =
  '[system formatting reminder] When you mention any of these in your reply, ' +
  'wrap as markdown links: `[<callsign>](pc://work-item/<callsign>)` for work ' +
  'items (use the callsign string, not the ULID), `[<path>](pc://file/<path>)` ' +
  'for files, `[<name>](pc://attachment/<id>)` for attachments. The user can ' +
  'hover + click these pills. Bare text and backticks are unclickable — never ' +
  'use them for these refs. Applies in lists too: every reference in every row.';

/** Build a fake ToolContext that records HTTP calls and returns canned bodies,
 *  with the SAME `withRichLinkHint` / `projectPath` behavior as the real
 *  context so golden-string assertions are faithful. */
export function makeFakeContext(opts: FakeContextOptions): {
  ctx: ToolContext;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const projectId = opts.projectId ?? 'P01';

  const record =
    (method: RecordedCall['method']) =>
    async (path: string, body?: unknown): Promise<ServerResponse> => {
      calls.push({ method, path, body });
      return opts.responder(method, path, body);
    };

  const getServer = async (path: string): Promise<ServerResponse> => {
    calls.push({ method: 'GET', path });
    return opts.responder('GET', path, undefined);
  };

  const postServer = record('POST');
  const putServer = record('PUT');
  const patchServer = record('PATCH');
  const deleteServer = async (path: string): Promise<ServerResponse> => {
    calls.push({ method: 'DELETE', path });
    return opts.responder('DELETE', path, undefined);
  };

  const client = new TypedLocalhostClient({
    postServer,
    putServer,
    getServer,
    patchServer,
    deleteServer,
  });

  const ctx: ToolContext = {
    projectId,
    agentSessionId: opts.agentSessionId ?? '',
    sessionId: opts.sessionId ?? '',
    dispatcherSessionId: opts.dispatcherSessionId ?? '',
    agentRunId: opts.agentRunId,
    agentParentWorkItemId: opts.agentParentWorkItemId,
    agentInvokeDepth: 0,
    projectPath: (suffix: string) => {
      if (!projectId) throw new Error('PC_PROJECT_ID is required for project-scoped calls');
      return `/api/projects/${projectId}/${suffix.replace(/^\//, '')}`;
    },
    postServer,
    putServer,
    getServer,
    patchServer,
    deleteServer,
    resolveWorkItemIdViaServer:
      opts.resolveWorkItemId ?? (async (ref: string) => ref),
    withRichLinkHint: (text: string): ToolResult => ({
      content: [{ type: 'text', text }, { type: 'text', text: RICH_LINK_HINT }],
    }),
    client,
  };

  return { ctx, calls };
}

export function ok(body: unknown, status = 200): ServerResponse {
  return { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

export function err(status: number, body: unknown): ServerResponse {
  return { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

/** Extract the flat text from a ToolResult's content (first text block). */
export function firstText(result: ToolResult | null): string {
  assert(result, 'expected a ToolResult, got null');
  return result.content[0]?.text ?? '';
}
