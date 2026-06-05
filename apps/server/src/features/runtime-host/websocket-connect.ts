import type { OrchestratorSession, ULID } from '@pc/domain';

import { sendQueueSnapshotPayload } from '../../services/orchestrator-send-queue-delivery.ts';
import type { PublicRuntimeSnapshot } from '../../services/orchestrator-runtime-snapshot.ts';
import { loadRuntimeSessionReplay, sessionReplayPayload } from './routes.ts';

export interface RuntimeHostConnectRuntime<TPty extends { getState(): string }> {
  activeSession(): OrchestratorSession | null;
  ptySession(): TPty | null;
  sessionDataPath(sessionId: string): string;
}

export interface RuntimeHostConnectInput<
  TPty extends { getState(): string },
  TRuntime extends RuntimeHostConnectRuntime<TPty>,
> {
  projectId: ULID;
  runtime: TRuntime;
  /** True for the focused chat socket (`?intent=chat`): if a live PTY already
   *  exists (reconnect to an in-progress chat), re-attach to it. It NEVER
   *  starts one — spawning is explicit now (Start Chat / Resume / send), which
   *  is what lets a project boot to the launcher instead of auto-spawning an
   *  orchestrator per WS connect. Activity sockets pass false and get only the
   *  read-only snapshot. */
  chatIntent: boolean;
  send(envelope: Record<string, unknown>): void;
  attachPtyHandlers(projectId: ULID, runtime: TRuntime, session: TPty): void;
  runtimeSnapshotPayload(projectId: ULID, runtime: TRuntime): PublicRuntimeSnapshot;
}

/** Send the deterministic reconnect/refresh checkpoint for a project WS.
 *  Connecting NEVER mints a session or spawns claude.exe — it reports the
 *  active session if one already exists (else null → client shows the
 *  launcher), and a focused chat socket re-attaches to a still-live PTY. */
export function sendRuntimeHostConnectSnapshot<
  TPty extends { getState(): string },
  TRuntime extends RuntimeHostConnectRuntime<TPty>,
>(input: RuntimeHostConnectInput<TPty, TRuntime>): OrchestratorSession | null {
  const {
    attachPtyHandlers,
    chatIntent,
    projectId,
    runtime,
    runtimeSnapshotPayload,
    send,
  } = input;
  const session = runtime.activeSession();

  send({ projectId, type: 'session-changed', session });

  if (chatIntent) {
    const liveSession = runtime.ptySession();
    if (liveSession) {
      attachPtyHandlers(projectId, runtime, liveSession);
      send({ projectId, type: 'state', state: liveSession.getState() });
    }
  }

  send({ projectId, ...runtimeSnapshotPayload(projectId, runtime) });

  if (session) {
    const replay = loadRuntimeSessionReplay(session.id);
    send({ projectId, ...sessionReplayPayload(replay) });
    send({ projectId, ...sendQueueSnapshotPayload(session.id) });
  }

  return session;
}
