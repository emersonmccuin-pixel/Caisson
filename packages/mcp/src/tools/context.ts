import { request as httpRequest } from 'node:http';
import { TypedLocalhostClient } from '../client/typed-client.ts';
import { withConnRetry } from './retry.ts';

export interface ServerResponse {
  status: number;
  body: string;
  /** Populated from the `retry-after` response header when present. A 503 that
   *  carries this field is explicit server backpressure on a safe-to-retry-identical
   *  request; the retry transport gates on its presence. Absent = not set. */
  retryAfter?: string | null;
}

export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: ToolContent[];
  isError?: true;
  /**
   * CONVENTION — A1 (next_valid_actions): optional list of tool names the
   * caller should consider invoking next, derived from the current state.
   *
   * Populate on:
   *   • ERROR returns — tools that help recover from or diagnose the failure.
   *     Do NOT repeat the tool that just errored (loop-prevention).
   *   • HIGH-VALUE SUCCESS returns — the most likely follow-on operations
   *     given what the tool just did (e.g. after creating a work item →
   *     invoke an agent or move it; after a dispatch → inspect the run).
   *
   * Rules for follow-up tool authors:
   *   • Keep the list short (2–4 names); prefer the most actionable.
   *   • Derive from actual state where possible (e.g. omit pc_invoke_agent
   *     when PC_PROJECT_ID is unset); fall back to a static best-guess.
   *   • Do NOT attempt exhaustive coverage — omit entirely rather than add
   *     noise. Only populate when it materially helps the caller decide.
   *   • Field is OPTIONAL. Callers must treat its absence as "no hint".
   */
  next_valid_actions?: string[];
}

export interface ToolContext {
  projectId: string;
  agentSessionId: string;
  sessionId: string;
  dispatcherSessionId: string;
  agentRunId?: string;
  agentParentWorkItemId?: string;
  agentInvokeDepth?: number;
  projectPath: (suffix: string) => string;
  postServer: (path: string, body: unknown) => Promise<ServerResponse>;
  putServer: (path: string, body: unknown) => Promise<ServerResponse>;
  getServer: (path: string) => Promise<ServerResponse>;
  patchServer: (path: string, body: unknown) => Promise<ServerResponse>;
  deleteServer: (path: string) => Promise<ServerResponse>;
  resolveWorkItemIdViaServer: (idOrCallsign: string) => Promise<string | null>;
  withRichLinkHint: (text: string) => ToolResult;
  /** Slice 011 — typed localhost client over the raw helpers above. Parses
   *  responses through `@pc/contracts` DTO guards; always preserves the raw
   *  `{ status, body }` so handlers emit byte-identical text. */
  client: TypedLocalhostClient;
}

interface ToolContextOptions {
  projectId: string;
  agentSessionId: string;
  sessionId: string;
  dispatcherSessionId: string;
  agentRunId: string;
  agentParentWorkItemId: string;
  agentInvokeDepth: number;
  serverPort: number;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const RICH_LINK_HINT =
  '[system formatting reminder] When you mention any of these in your reply, ' +
  'wrap as markdown links: `[<callsign>](pc://work-item/<callsign>)` for work ' +
  'items (use the callsign string, not the ULID), `[<path>](pc://file/<path>)` ' +
  'for files, `[<name>](pc://attachment/<id>)` for attachments. The user can ' +
  'hover + click these pills. Bare text and backticks are unclickable — never ' +
  'use them for these refs. Applies in lists too: every reference in every row.';

function httpWithBodyOnce(
  serverPort: number,
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  body: unknown,
): Promise<ServerResponse> {
  const payload = JSON.stringify(body);
  return new Promise((res, rej) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: serverPort,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          res({
            status: r.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            retryAfter: (r.headers['retry-after'] as string | undefined) ?? null,
          }),
        );
      },
    );
    req.on('error', rej);
    req.write(payload);
    req.end();
  });
}

function httpWithoutBodyOnce(
  serverPort: number,
  method: 'GET' | 'DELETE',
  path: string,
): Promise<ServerResponse> {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: serverPort, method, path },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          res({
            status: r.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            retryAfter: (r.headers['retry-after'] as string | undefined) ?? null,
          }),
        );
      },
    );
    req.on('error', rej);
    req.end();
  });
}

// T2.1 — bounded retry over the localhost call so an agent's tool request
// survives the ~1s API-restart window (ECONNREFUSED / 503) instead of failing.
function httpWithBody(
  serverPort: number,
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  body: unknown,
): Promise<ServerResponse> {
  return withConnRetry(() => httpWithBodyOnce(serverPort, method, path, body));
}

function httpWithoutBody(
  serverPort: number,
  method: 'GET' | 'DELETE',
  path: string,
): Promise<ServerResponse> {
  return withConnRetry(() => httpWithoutBodyOnce(serverPort, method, path));
}

export function createToolContext(options: ToolContextOptions): ToolContext {
  const projectPath = (suffix: string): string => {
    if (!options.projectId) throw new Error('PC_PROJECT_ID is required for project-scoped calls');
    return `/api/projects/${options.projectId}/${suffix.replace(/^\//, '')}`;
  };

  const getServer = (path: string) => httpWithoutBody(options.serverPort, 'GET', path);

  const resolveWorkItemIdViaServer = async (idOrCallsign: string): Promise<string | null> => {
    const ref = idOrCallsign.trim();
    if (!ref) return null;
    if (ULID_RE.test(ref)) return ref;
    try {
      const res = await getServer(projectPath(`work-items/${encodeURIComponent(ref)}`));
      if (res.status < 200 || res.status >= 300) return null;
      const parsed = JSON.parse(res.body) as { ok?: boolean; workItem?: { id?: string } };
      return parsed.ok && typeof parsed.workItem?.id === 'string' ? parsed.workItem.id : null;
    } catch {
      return null;
    }
  };

  const postServer = (path: string, body: unknown) =>
    httpWithBody(options.serverPort, 'POST', path, body);
  const putServer = (path: string, body: unknown) =>
    httpWithBody(options.serverPort, 'PUT', path, body);
  const patchServer = (path: string, body: unknown) =>
    httpWithBody(options.serverPort, 'PATCH', path, body);
  const deleteServer = (path: string) => httpWithoutBody(options.serverPort, 'DELETE', path);

  const client = new TypedLocalhostClient({
    postServer,
    putServer,
    getServer,
    patchServer,
    deleteServer,
  });

  return {
    projectId: options.projectId,
    agentSessionId: options.agentSessionId,
    sessionId: options.sessionId,
    dispatcherSessionId: options.dispatcherSessionId,
    agentRunId: options.agentRunId,
    agentParentWorkItemId: options.agentParentWorkItemId,
    agentInvokeDepth: options.agentInvokeDepth,
    projectPath,
    postServer,
    putServer,
    getServer,
    patchServer,
    deleteServer,
    resolveWorkItemIdViaServer,
    withRichLinkHint: (text) => ({
      content: [{ type: 'text', text }, { type: 'text', text: RICH_LINK_HINT }],
    }),
    client,
  };
}
