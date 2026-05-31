// Server composition for the slice-006 send facade.
//
// Builds a @pc/app-services `ConversationSendService` from the per-call runtime
// + broadcast deps so the WS send path + cancel/retry routes + the JSONL
// observe correlation delegate to ONE facade instead of re-implementing the
// policy. The facade reaches the PTY only through the injected `RuntimeTurnPort`
// (getState/send) — no PTY class crosses the package boundary. Wire shapes
// (`send-ack`, `send-queue-snapshot`, status codes) stay in the route/WS adapter
// and are unchanged.

import {
  ConversationSendService,
  type RuntimeTurnPort,
} from '@pc/app-services';
import type { OrchestratorSession, ULID } from '@pc/domain';

export interface ConversationSendRuntimeLike {
  ensureActiveSession(): OrchestratorSession;
  ptySession(): RuntimeTurnPort | null;
}

export interface ConversationSendComposition {
  runtime: ConversationSendRuntimeLike;
  ensurePort(): RuntimeTurnPort;
  broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void;
  onSessionEnsured?(projectId: ULID, session: OrchestratorSession): void;
}

/** Build a send facade bound to a single project's runtime + broadcast deps. */
export function conversationSendServiceFor(
  comp: ConversationSendComposition,
): ConversationSendService {
  return new ConversationSendService({
    getPort: () => comp.runtime.ptySession(),
    ensurePort: () => comp.ensurePort(),
    ensureActiveSession: () => comp.runtime.ensureActiveSession(),
    broadcastSendQueueSnapshot: comp.broadcastSendQueueSnapshot,
    onSessionEnsured: comp.onSessionEnsured,
  });
}
