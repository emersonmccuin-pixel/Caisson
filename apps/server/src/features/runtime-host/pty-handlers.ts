import type { OrchestratorSession, ULID } from '@pc/domain';
import type { JsonlReplayMeta } from '@pc/runtime';

import type {
  BroadcastSendQueueSnapshot,
  OrchestratorSendRuntime,
} from '../../services/orchestrator-send-queue-delivery.ts';
import {
  deliverNextQueuedPrompt as defaultDeliverNextQueuedPrompt,
  maybeAdvanceSendQueueConfirmation as defaultMaybeAdvanceSendQueueConfirmation,
} from '../../services/orchestrator-send-queue-delivery.ts';
import type { RuntimeSnapshotRuntime } from '../../services/orchestrator-runtime-snapshot.ts';

export interface RuntimeHostPtySession {
  on(event: 'raw', listener: (text: string) => void): unknown;
  on(event: 'state', listener: (state: string) => void): unknown;
  on(event: 'turn-end', listener: () => void): unknown;
  on(event: 'event', listener: (event: unknown) => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
  on(event: 'failed', listener: (reason: string) => void): unknown;
  on(event: 'jsonl-event', listener: (event: unknown, replay?: JsonlReplayMeta) => void): unknown;
  on(event: 'jsonl-path-resolved', listener: (jsonlPath: string) => void): unknown;
  on(event: 'jsonl-cursor-tick', listener: (path: string, cursor: number) => void): unknown;
  on(
    event: 'exit',
    listener: (code: number | undefined, signal: string | undefined) => void,
  ): unknown;
  getState(): string;
  getJsonlPath(): string | null;
  send(text: string): Promise<string | void> | string | void;
}

export interface RuntimeHostPtyRuntime<TPty extends RuntimeHostPtySession>
  extends OrchestratorSendRuntime,
    RuntimeSnapshotRuntime {
  ensurePty(): TPty;
  ptySession(): TPty | null;
}

export interface RuntimeHostPtyLifecycleSnapshots {
  noteActivity(projectId: ULID): void;
  noteJsonl(projectId: ULID): void;
  clearFailure(projectId: ULID): void;
  clearExit(projectId: ULID): void;
  noteFailure(projectId: ULID, err: unknown): void;
  noteExit(projectId: ULID, code: number | undefined, signal: string | undefined): void;
}

export interface RuntimeHostPtyHandlersDeps<
  TPty extends RuntimeHostPtySession,
  TRuntime extends RuntimeHostPtyRuntime<TPty>,
> {
  runtimeSnapshots: RuntimeHostPtyLifecycleSnapshots;
  getActiveOrchestratorSession(projectId: ULID): OrchestratorSession | null;
  setOrchestratorSessionJsonlCursor(sessionId: ULID, cursor: number): void;
  setOrchestratorSessionJsonlPath(sessionId: ULID, jsonlPath: string): void;
  broadcastTo(projectId: ULID, msg: unknown): void;
  broadcastRuntimeSnapshot(projectId: ULID, runtime: TRuntime): void;
  broadcastSendQueueSnapshot: BroadcastSendQueueSnapshot;
  maybeSetSessionTitle(projectId: ULID, event: unknown): void;
  maybeApplyAiTitle(projectId: ULID, event: unknown): void;
  maybePersistPostTurnSummary(projectId: ULID, event: unknown): void;
  deliverNextQueuedPrompt?: typeof defaultDeliverNextQueuedPrompt;
  maybeAdvanceSendQueueConfirmation?: typeof defaultMaybeAdvanceSendQueueConfirmation;
  /** Slice F — called on every `ready` transition. The implementation enqueues
   *  the session-open checklist sweep (idempotency is at the send-queue layer via
   *  a deterministic clientMessageId, so repeated ready→busy→ready cycles are safe). */
  enqueueSessionOpenSweep?: (projectId: ULID) => void;
  setImmediate?: (callback: () => void) => unknown;
  logger?: Pick<Console, 'error' | 'log'>;
}

export interface RuntimeHostPtyController<
  TPty extends RuntimeHostPtySession,
  TRuntime extends RuntimeHostPtyRuntime<TPty>,
> {
  attachPtyHandlers(projectId: ULID, runtime: TRuntime, session: TPty): void;
  ensureOrchestratorPty(projectId: ULID, runtime: TRuntime): TPty;
  startOrchestratorPtyInBackground(projectId: ULID, runtime: TRuntime): void;
}

export function replayMetaPayload(replay: JsonlReplayMeta | undefined): {
  id?: string;
  sessionId?: string;
  seq?: number;
  kind?: string;
  source?: JsonlReplayMeta['source'];
} {
  if (!replay) return {};
  return {
    id: replay.id,
    sessionId: replay.sessionId,
    seq: replay.seq,
    kind: replay.kind,
    source: replay.source,
  };
}

export function createRuntimeHostPtyController<
  TPty extends RuntimeHostPtySession,
  TRuntime extends RuntimeHostPtyRuntime<TPty>,
>(
  deps: RuntimeHostPtyHandlersDeps<TPty, TRuntime>,
): RuntimeHostPtyController<TPty, TRuntime> {
  const deliverNextQueuedPrompt =
    deps.deliverNextQueuedPrompt ?? defaultDeliverNextQueuedPrompt;
  const maybeAdvanceSendQueueConfirmation =
    deps.maybeAdvanceSendQueueConfirmation ?? defaultMaybeAdvanceSendQueueConfirmation;
  const defer = deps.setImmediate ?? setImmediate;
  const logger = deps.logger ?? console;

  const attachPtyHandlers = (projectId: ULID, runtime: TRuntime, session: TPty): void => {
    const flag = session as TPty & { __pcHandlersAttached?: boolean };
    if (flag.__pcHandlersAttached) return;
    const attachedSessionId = deps.getActiveOrchestratorSession(projectId)?.id ?? null;
    let terminalSeq = 0;
    session.on('raw', (text: string) => {
      deps.runtimeSnapshots.noteActivity(projectId);
      terminalSeq += 1;
      deps.broadcastTo(projectId, {
        type: 'raw',
        sessionId: attachedSessionId,
        terminalSeq,
        text,
      });
    });
    session.on('state', (state: string) => {
      deps.runtimeSnapshots.noteActivity(projectId);
      if (state === 'ready') {
        deps.runtimeSnapshots.clearFailure(projectId);
        deps.runtimeSnapshots.clearExit(projectId);
      }
      deps.broadcastTo(projectId, { type: 'state', state });
      deps.broadcastRuntimeSnapshot(projectId, runtime);
      if (state === 'ready') {
        deliverNextQueuedPrompt(projectId, runtime, deps.broadcastSendQueueSnapshot);
        deps.enqueueSessionOpenSweep?.(projectId);
      }
    });
    session.on('turn-end', () => {
      deps.runtimeSnapshots.noteActivity(projectId);
      deps.broadcastTo(projectId, { type: 'turn-end' });
      deps.broadcastRuntimeSnapshot(projectId, runtime);
    });
    session.on('event', (event: unknown) => {
      deps.runtimeSnapshots.noteActivity(projectId);
      deps.broadcastTo(projectId, { type: 'event', event });
      deps.broadcastRuntimeSnapshot(projectId, runtime);
    });
    session.on('error', (err: unknown) => {
      deps.runtimeSnapshots.noteFailure(projectId, err);
      deps.broadcastRuntimeSnapshot(projectId, runtime);
    });
    session.on('failed', (reason: string) => {
      deps.runtimeSnapshots.noteFailure(projectId, reason);
      deps.broadcastRuntimeSnapshot(projectId, runtime);
    });
    session.on('jsonl-event', (event: unknown, replay?: JsonlReplayMeta) => {
      deps.runtimeSnapshots.noteJsonl(projectId);
      // Correlate the send queue BEFORE broadcasting so the canonical jsonl-user
      // envelope can carry its originating clientMessageId — the client replaces
      // its optimistic placeholder by id (Stage 2), retiring fuzzy text-matching.
      // The DB mark is the single one-time correlation point; reconnect reconcile
      // rides the (already id-keyed) send-queue-snapshot, not the durable log.
      const observed = maybeAdvanceSendQueueConfirmation(
        projectId,
        attachedSessionId,
        event,
        runtime,
        deps.broadcastSendQueueSnapshot,
      );
      deps.broadcastTo(projectId, {
        type: 'jsonl',
        event,
        ...replayMetaPayload(replay),
        ...(observed ? { clientMessageId: observed.clientMessageId } : {}),
      });
      if (attachedSessionId && typeof replay?.source?.cursor === 'number') {
        deps.setOrchestratorSessionJsonlCursor(attachedSessionId, replay.source.cursor);
      }
      deps.broadcastRuntimeSnapshot(projectId, runtime);
      deps.maybePersistPostTurnSummary(projectId, event);
      deps.maybeSetSessionTitle(projectId, event);
      deps.maybeApplyAiTitle(projectId, event);
    });
    session.on('jsonl-path-resolved', (jsonlPath: string) => {
      const active = deps.getActiveOrchestratorSession(projectId);
      if (active) deps.setOrchestratorSessionJsonlPath(active.id, jsonlPath);
      deps.runtimeSnapshots.noteActivity(projectId);
      deps.broadcastRuntimeSnapshot(projectId, runtime);
    });
    session.on('jsonl-cursor-tick', (_path: string, cursor: number) => {
      const active = deps.getActiveOrchestratorSession(projectId);
      if (active) deps.setOrchestratorSessionJsonlCursor(active.id, cursor);
    });
    session.on('exit', (code: number | undefined, signal: string | undefined) => {
      deps.runtimeSnapshots.noteExit(projectId, code, signal);
      deps.broadcastTo(projectId, { type: 'exit', code, signal });
      deps.broadcastRuntimeSnapshot(projectId, runtime);
      logger.log(`[pc] ${projectId} session exited code=${code} signal=${signal}`);
    });
    const currentJsonlPath = session.getJsonlPath();
    if (currentJsonlPath) {
      const active = deps.getActiveOrchestratorSession(projectId);
      if (active) deps.setOrchestratorSessionJsonlPath(active.id, currentJsonlPath);
    }
    flag.__pcHandlersAttached = true;
  };

  const ensureOrchestratorPty = (projectId: ULID, runtime: TRuntime): TPty => {
    try {
      const pty = runtime.ensurePty();
      deps.runtimeSnapshots.clearFailure(projectId);
      if (pty.getState() === 'ready') deps.runtimeSnapshots.clearExit(projectId);
      deps.runtimeSnapshots.noteActivity(projectId);
      attachPtyHandlers(projectId, runtime, pty);
      deps.broadcastRuntimeSnapshot(projectId, runtime);
      return pty;
    } catch (err) {
      deps.runtimeSnapshots.noteFailure(projectId, err);
      deps.broadcastRuntimeSnapshot(projectId, runtime);
      throw err;
    }
  };

  const startOrchestratorPtyInBackground = (projectId: ULID, runtime: TRuntime): void => {
    defer(() => {
      try {
        ensureOrchestratorPty(projectId, runtime);
      } catch (err) {
        logger.error(
          `[pc] background orchestrator start failed for ${projectId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  };

  return {
    attachPtyHandlers,
    ensureOrchestratorPty,
    startOrchestratorPtyInBackground,
  };
}
