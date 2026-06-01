import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import type { OrchestratorSession, ULID } from '@pc/domain';

import type { PublicRuntimeSnapshot } from '../../services/orchestrator-runtime-snapshot.ts';
import {
  sendRuntimeHostConnectSnapshot,
  type RuntimeHostConnectInput,
  type RuntimeHostConnectRuntime,
} from './websocket-connect.ts';
import {
  handleRuntimeHostWsMessage,
  type RuntimeHostMessagePtySession,
  type RuntimeHostMessageRuntime,
  type RuntimeHostWsMessageInput,
} from './websocket-message.ts';

export interface RuntimeHostWebSocketLike {
  readonly OPEN: number;
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (raw: { toString(): string }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

export interface RuntimeHostWebSocketHub<TSocket> {
  subscribe(projectId: ULID, ws: TSocket): () => void;
}

export type RuntimeHostWebSocketRuntime<TPty extends RuntimeHostMessagePtySession> =
  RuntimeHostConnectRuntime<TPty> &
  Omit<RuntimeHostMessageRuntime, 'ptySession'> & {
    ptySession(): TPty | null;
  };

export interface RuntimeHostWebSocketConnectionDeps<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostWebSocketRuntime<TPty>,
  TSocket extends RuntimeHostWebSocketLike,
> {
  ws: TSocket;
  request: { url?: string | null };
  resolveProject(projectId: string): TRuntime | null;
  subscribe(projectId: ULID, ws: TSocket): () => void;
  attachPtyHandlers(projectId: ULID, runtime: TRuntime, session: TPty): void;
  runtimeSnapshotPayload(projectId: ULID, runtime: TRuntime): PublicRuntimeSnapshot;
  startOrchestratorPtyInBackground(projectId: ULID, runtime: TRuntime): void;
  broadcastTo(projectId: ULID, msg: unknown): void;
  broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void;
  ensureOrchestratorPty(projectId: ULID, runtime: TRuntime): TPty;
  resolvePendingAsk(toolUseId: string, answer: string): void;
  /** Slice 015a — per-socket subscribe-handshake catch-up. Replays the live
   *  outbox window `(lastVersion, snapshot]` to THIS socket. Optional so
   *  callers/tests that don't wire the relay stay valid. */
  catchUp?(socket: TSocket, lastVersion: string | undefined, projectId: ULID): void;
  sendConnectSnapshot?(input: RuntimeHostConnectInput<TPty, TRuntime>): OrchestratorSession;
  handleWsMessage?(input: RuntimeHostWsMessageInput<TPty, TRuntime>): Promise<void> | void;
}

export interface RuntimeHostWebSocketServerDeps<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostWebSocketRuntime<TPty>,
> extends Omit<
    RuntimeHostWebSocketConnectionDeps<TPty, TRuntime, RuntimeHostWebSocketLike>,
    'ws' | 'request' | 'subscribe'
  > {
  server: unknown;
  path?: string;
  wsHub: RuntimeHostWebSocketHub<RuntimeHostWebSocketLike>;
}

function closeBestEffort(ws: RuntimeHostWebSocketLike, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* best effort */
  }
}

export function handleRuntimeHostWsConnection<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostWebSocketRuntime<TPty>,
  TSocket extends RuntimeHostWebSocketLike,
>(
  deps: RuntimeHostWebSocketConnectionDeps<TPty, TRuntime, TSocket>,
): boolean {
  const {
    attachPtyHandlers,
    broadcastSendQueueSnapshot,
    broadcastTo,
    catchUp,
    ensureOrchestratorPty,
    request,
    resolvePendingAsk,
    resolveProject,
    runtimeSnapshotPayload,
    subscribe,
    ws,
  } = deps;
  const url = new URL(request.url ?? '/ws', 'http://127.0.0.1');
  const projectId = url.searchParams.get('projectId') as ULID | null;
  // Only the focused chat socket asks to spawn the orchestrator; the
  // all-projects activity fan-out connects without it (no spawn, no mint).
  const chatIntent = url.searchParams.get('intent') === 'chat';
  if (!projectId) {
    closeBestEffort(ws, 1008, 'projectId query param required');
    return false;
  }
  const runtime = resolveProject(projectId);
  if (!runtime) {
    closeBestEffort(ws, 1008, `unknown project: ${projectId}`);
    return false;
  }

  const detachSubscriber = subscribe(projectId, ws);
  const sendConnectSnapshot = deps.sendConnectSnapshot ?? sendRuntimeHostConnectSnapshot;
  sendConnectSnapshot({
    projectId,
    runtime,
    chatIntent,
    send: (envelope) => ws.send(JSON.stringify(envelope)),
    attachPtyHandlers,
    runtimeSnapshotPayload,
  });

  const handleWsMessage = deps.handleWsMessage ?? handleRuntimeHostWsMessage;
  ws.on('message', (raw) => {
    void handleWsMessage({
      projectId,
      runtime,
      raw: raw.toString(),
      send: (envelope) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(envelope));
      },
      broadcastTo,
      broadcastSendQueueSnapshot,
      ensureOrchestratorPty,
      resolvePendingAsk,
      onSubscribe: catchUp
        ? (lastVersion) => catchUp(ws, lastVersion, projectId)
        : undefined,
    });
  });

  ws.on('close', () => {
    detachSubscriber();
  });
  return true;
}

/** Server-side liveness sweep interval. Half-open sockets (laptop sleep, Wi-Fi
 *  roam, NAT/proxy idle-timeout) never deliver a TCP `close`, so without this
 *  the hub keeps a dead subscriber forever and `broadcast()` silently sends
 *  every chat/agent event into the void — the UI looks frozen until a manual
 *  refresh re-subscribes. The canonical `ws` pattern: ping each client every
 *  interval, terminate any that didn't pong since the last sweep. */
const WS_KEEPALIVE_INTERVAL_MS = 30_000;

export interface KeepaliveClient {
  isAlive?: boolean;
  ping(): void;
  terminate(): void;
}

type Liveness = WsWebSocket & { isAlive?: boolean };

/** One keepalive pass over the live client set. A client that hasn't ponged
 *  since the previous pass (`isAlive === false`) is terminated; everyone else
 *  is marked not-alive and pinged, so the next pass terminates them unless the
 *  pong listener flips `isAlive` back to true in the meantime. Exported for
 *  unit testing the terminate-vs-ping decision without a live socket. */
export function runWsKeepaliveSweep(clients: Iterable<KeepaliveClient>): void {
  for (const client of clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {
      /* best-effort; a failed ping means the next sweep terminates it */
    }
  }
}

export function registerRuntimeHostWebSocketServer<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostWebSocketRuntime<TPty>,
>(deps: RuntimeHostWebSocketServerDeps<TPty, TRuntime>): WebSocketServer {
  const wss = new WebSocketServer({
    server: deps.server as never,
    path: deps.path ?? '/ws',
  });
  wss.on('connection', (ws, req) => {
    // Browsers can't send protocol ping frames but auto-respond to ours with a
    // pong, so this `pong` listener is the reliable per-client liveness signal.
    const live = ws as Liveness;
    live.isAlive = true;
    live.on('pong', () => {
      live.isAlive = true;
    });
    const socket = ws as unknown as RuntimeHostWebSocketLike;
    handleRuntimeHostWsConnection({
      ...deps,
      ws: socket,
      request: req,
      subscribe: (projectId) => deps.wsHub.subscribe(projectId, socket),
    });
  });

  // Terminate fires `close` → the connection's detachSubscriber(), cleaning the
  // hub, and lets the browser observe the drop and reconnect.
  const sweep = setInterval(() => {
    runWsKeepaliveSweep(wss.clients as Iterable<Liveness>);
  }, WS_KEEPALIVE_INTERVAL_MS);
  // Don't let the sweep timer keep the process alive on shutdown.
  if (typeof sweep.unref === 'function') sweep.unref();
  wss.on('close', () => clearInterval(sweep));

  return wss;
}
