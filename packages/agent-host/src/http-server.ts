import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import {
  agentHostLockFromIdentity,
  removeAgentHostLockFile,
  writeAgentHostLockFile,
  type AgentHostCommand,
  type AgentHostEvent,
} from '@pc/runtime';

import { AgentHostService } from './agent-host-service.ts';

export interface HttpAgentHostServerOptions {
  service?: AgentHostService;
  host?: string;
  port?: number;
  lockFilePath?: string;
  /** Graceful-close deadline; past it the close resolves anyway (never hangs). */
  closeDeadlineMs?: number;
}

export interface HttpAgentHostServer {
  service: AgentHostService;
  server: Server;
  port: number;
  close(): Promise<void>;
  /** Resolves once the server has shut down — by close() OR a `shutdown
   *  host-exit` command. The CLI awaits this, then exits the process. */
  closed: Promise<void>;
}

// The host's graceful stop was a silent no-op (found live 2026-06-03, FD-15
// work): `server.close()` waits for open connections, but the API holds a
// PERSISTENT `/events` stream, so close never completed — the process stayed
// alive and the lock file stayed. A graceful stop must destroy live sockets
// and, past a deadline, resolve anyway — it escalates, it never hangs.
const DEFAULT_CLOSE_DEADLINE_MS = 2_000;

function closeDestroyingStreams(server: Server, deadlineMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = setTimeout(resolve, deadlineMs);
    deadline.unref?.();
    server.close(() => {
      clearTimeout(deadline);
      resolve();
    });
    server.closeAllConnections();
  });
}

export async function startHttpAgentHostServer(
  options: HttpAgentHostServerOptions = {},
): Promise<HttpAgentHostServer> {
  const service = options.service ?? new AgentHostService();
  const server = createServer();

  let closeStarted = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const requestClose = (): Promise<void> => {
    if (!closeStarted) {
      closeStarted = true;
      void closeDestroyingStreams(
        server,
        options.closeDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS,
      ).then(resolveClosed);
    }
    return closed;
  };

  server.on('request', (req, res) => {
    void handleRequest(service, requestClose, req, res);
  });
  if (options.lockFilePath) {
    server.once('close', () => {
      removeAgentHostLockFile(options.lockFilePath!);
    });
  }
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;

  server.listen(port, host);
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('agent host HTTP server did not bind to a TCP address');
  }

  service.emitReady();
  if (options.lockFilePath) {
    writeAgentHostLockFile(
      options.lockFilePath,
      agentHostLockFromIdentity(service.getIdentity(), address.port),
    );
  }

  return {
    service,
    server,
    port: address.port,
    close: requestClose,
    closed,
  };
}

async function handleRequest(
  service: AgentHostService,
  requestClose: () => Promise<void>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      identity: service.getIdentity(),
      // FD-15 — effective cap, so a set-config push is verifiable from outside.
      maxConcurrent: service.getMaxConcurrent(),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/command') {
    let command: AgentHostCommand;
    try {
      const body = parseCommand(await readRequestBody(req));
      command = body.command;
    } catch (err) {
      writeJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const response = await service.handleCommand(command);
    writeJson(res, 200, response);
    if (
      response.ok &&
      response.command === 'shutdown' &&
      command.type === 'shutdown' &&
      command.mode === 'host-exit'
    ) {
      // Close destroys live sockets — let THIS response flush to the kernel
      // first so the caller receives its ok before the teardown.
      const begin = (): void => {
        setImmediate(() => {
          void requestClose();
        });
      };
      if (res.writableFinished) begin();
      else res.once('finish', begin);
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    streamEvents(service, req, res, Number(url.searchParams.get('after') ?? '0'));
    return;
  }

  writeJson(res, 404, { ok: false, error: 'not found' });
}

function streamEvents(
  service: AgentHostService,
  req: IncomingMessage,
  res: ServerResponse,
  afterSeq: number,
): void {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });

  const writeEvent = (event: AgentHostEvent) => {
    res.write(`${JSON.stringify({ type: 'event', event })}\n`);
  };
  for (const event of service.getEventsAfter(Number.isFinite(afterSeq) ? afterSeq : 0)) {
    writeEvent(event);
  }
  service.on('event', writeEvent);
  // S4 — periodic bare-newline keepalive so an idle stream stays warm and a dead
  // socket surfaces (clients skip empty lines, so it's a safe no-op frame).
  const keepalive = setInterval(() => res.write('\n'), 15_000);
  keepalive.unref?.();
  req.on('close', () => {
    clearInterval(keepalive);
    service.off('event', writeEvent);
  });
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString('utf8');
  }
  return body;
}

function parseCommand(body: string): { command: AgentHostCommand } {
  const parsed = JSON.parse(body) as { command?: unknown; type?: unknown };
  const command = (parsed.command ?? parsed) as AgentHostCommand;
  if (!command || typeof command !== 'object' || typeof command.type !== 'string') {
    throw new Error('expected host command with type');
  }
  return { command };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(body)}\n`);
}
