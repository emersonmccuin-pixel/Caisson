import type { OrchestratorSession, ULID } from '@pc/domain';

import {
  publicSendQueueItem,
  type PublicSendQueueItem,
} from '../../services/orchestrator-send-queue-delivery.ts';
import { conversationSendServiceFor } from '../../services/conversation-send.ts';
import { forwardTerminalInput } from '../../services/terminal-mode.ts';
import { loadRuntimeSessionReplay, sessionReplayPayload } from './routes.ts';

export type SendAckStatus =
  | 'received'
  | 'queued'
  | 'invalid-message'
  | 'no-session'
  | 'error';

export interface RuntimeHostMessagePtySession {
  getState(): string;
  send(text: string): Promise<string | void> | string | void;
  interrupt(): void;
  writeRaw(bytes: string): boolean;
}

export interface RuntimeHostMessageRuntime {
  ensureActiveSession(): OrchestratorSession;
  ptySession(): RuntimeHostMessagePtySession | null;
  resizeOrchestrator(cols: number, rows: number): void;
  sessionDataPath(sessionId: string): string;
}

export interface RuntimeHostWsMessageInput<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostMessageRuntime,
> {
  projectId: ULID;
  runtime: TRuntime;
  raw: string;
  send(envelope: Record<string, unknown>): void;
  broadcastTo(projectId: ULID, msg: unknown): void;
  broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void;
  ensureOrchestratorPty(projectId: ULID, runtime: TRuntime): TPty;
  resolvePendingAsk(toolUseId: string, answer: string): void;
  /** Slice 015a — WS subscribe handshake. The client sends its stored
   *  `lastVersion` (the global `seq` cursor) on (re)connect; the relay replays
   *  `(lastVersion, snapshot]` to THIS socket then live rows flow from the
   *  already-attached hub subscription. Optional so existing tests/callers that
   *  don't wire it stay valid. */
  onSubscribe?(lastVersion: string | undefined): void;
}

interface RuntimeHostWireMessage {
  type?: string;
  text?: string;
  data?: unknown;
  clientMessageId?: unknown;
  cols?: number;
  rows?: number;
  nonce?: unknown;
  sentAt?: unknown;
  toolUseId?: string;
  answer?: string;
  lastVersion?: unknown;
}

export async function handleRuntimeHostWsMessage<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostMessageRuntime,
>(input: RuntimeHostWsMessageInput<TPty, TRuntime>): Promise<void> {
  const {
    broadcastSendQueueSnapshot,
    broadcastTo,
    ensureOrchestratorPty,
    onSubscribe,
    projectId,
    raw,
    resolvePendingAsk,
    runtime,
    send,
  } = input;
  let msg: RuntimeHostWireMessage;
  try {
    msg = JSON.parse(raw) as RuntimeHostWireMessage;
  } catch {
    return;
  }

  const sendAck = (
    clientMessageId: unknown,
    ack: {
      ok: boolean;
      status: SendAckStatus;
      error?: string;
      queueItem?: PublicSendQueueItem;
    },
  ) => {
    if (typeof clientMessageId !== 'string' || !clientMessageId) return;
    send({ projectId, type: 'send-ack', clientMessageId, ...ack });
  };

  switch (msg.type) {
    case 'client-ping':
      send({
        projectId,
        type: 'server-pong',
        nonce: typeof msg.nonce === 'string' ? msg.nonce : undefined,
        sentAt: typeof msg.sentAt === 'number' ? msg.sentAt : undefined,
        serverTime: Date.now(),
      });
      break;
    case 'send':
      await handlePromptSend({
        broadcastSendQueueSnapshot,
        broadcastTo,
        ensureOrchestratorPty,
        msg,
        projectId,
        runtime,
        sendAck,
      });
      break;
    case 'interrupt':
      runtime.ptySession()?.interrupt();
      break;
    case 'terminal-input': {
      const result = forwardTerminalInput(runtime, msg.data);
      if (!result.ok) {
        send({
          projectId,
          type: 'terminal-input-ack',
          ok: false,
          status: result.status,
          error: result.error,
        });
      }
      break;
    }
    case 'resize':
      if (
        typeof msg.cols === 'number' &&
        Number.isFinite(msg.cols) &&
        typeof msg.rows === 'number' &&
        Number.isFinite(msg.rows)
      ) {
        try {
          runtime.resizeOrchestrator(msg.cols, msg.rows);
        } catch {
          /* Stale browser resize events must not crash the websocket server. */
        }
      }
      break;
    case 'ask-reply': {
      const id = msg.toolUseId;
      const answer = msg.answer ?? '';
      if (id) resolvePendingAsk(id, answer);
      break;
    }
    case 'subscribe': {
      // Slice 015a — cursor catch-up handshake. `lastVersion` is the global
      // `seq` cursor; a valid non-negative integer string or omitted (cold
      // load → no replay). The relay validates/clamps; we only pass it through.
      const lastVersion =
        typeof msg.lastVersion === 'string' && /^(0|[1-9]\d*)$/.test(msg.lastVersion)
          ? msg.lastVersion
          : undefined;
      onSubscribe?.(lastVersion);
      break;
    }
  }
}

async function handlePromptSend<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostMessageRuntime,
>(input: {
  projectId: ULID;
  runtime: TRuntime;
  msg: RuntimeHostWireMessage;
  sendAck: (
    clientMessageId: unknown,
    ack: {
      ok: boolean;
      status: SendAckStatus;
      error?: string;
      queueItem?: PublicSendQueueItem;
    },
  ) => void;
  broadcastTo(projectId: ULID, msg: unknown): void;
  broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void;
  ensureOrchestratorPty(projectId: ULID, runtime: TRuntime): TPty;
}): Promise<void> {
  const {
    broadcastSendQueueSnapshot,
    broadcastTo,
    ensureOrchestratorPty,
    msg,
    projectId,
    runtime,
    sendAck,
  } = input;
  if (typeof msg.text !== 'string') {
    sendAck(msg.clientMessageId, {
      ok: false,
      status: 'invalid-message',
      error: 'send.text must be a string',
    });
    return;
  }

  // The handlePromptSend policy (ensure session, direct-vs-enqueue, drain) now
  // lives in the ConversationSendService facade. The WS adapter keeps owning the
  // send-ack wire shape + the session-ensured envelopes (session-changed /
  // session-replay), which are emitted via onSessionEnsured below.
  const service = conversationSendServiceFor({
    runtime,
    ensurePort: () => ensureOrchestratorPty(projectId, runtime),
    broadcastSendQueueSnapshot,
    onSessionEnsured: (id, session) => {
      broadcastTo(id, { type: 'session-changed', session });
      broadcastTo(id, sessionReplayPayload(loadRuntimeSessionReplay(session.id)));
    },
  });

  const result = await service.sendUserTurn({
    projectId,
    clientMessageId: typeof msg.clientMessageId === 'string' ? msg.clientMessageId : undefined,
    text: msg.text,
  });

  if (result.ok) {
    sendAck(msg.clientMessageId, {
      ok: true,
      status: result.status,
      queueItem: publicSendQueueItem(result.row),
    });
    return;
  }
  sendAck(msg.clientMessageId, {
    ok: false,
    status: result.status,
    error: result.error,
  });
}
