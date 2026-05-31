import type { Hono } from 'hono';
import type { OrchestratorSession, ULID } from '@pc/domain';
import {
  cancelOpenOrchestratorSendsForSession,
  getActiveOrchestratorSession,
  getOrchestratorSendQueueRow,
  getOrchestratorSession,
  hasOpenOrchestratorSendsForSession,
  listOrchestratorSessionsForProject,
} from '@pc/db';

import { publicSendQueueItem } from '../../services/orchestrator-send-queue-delivery.ts';
import { conversationSendServiceFor } from '../../services/conversation-send.ts';
import type {
  PublicRuntimeSnapshot,
  RuntimeSnapshotRuntime,
} from '../../services/orchestrator-runtime-snapshot.ts';
import {
  normalizeTerminalTranscriptTailBytes,
  readTerminalTranscriptTail,
  type TerminalTranscriptRuntime,
} from '../../services/terminal-mode.ts';
import { type SessionReplayCheckpoint } from '../../services/session-replay.ts';
import { parseTranscriptAfterSeqQuery } from '@pc/contracts';
import {
  loadConversationReplayCheckpoint,
  loadConversationReplayCheckpointAfter,
} from '../../services/conversation-replay.ts';

export interface RuntimeHostPtySession {
  getState(): string;
  send(text: string): Promise<string | void> | string | void;
}

export interface RuntimeHostRuntime extends TerminalTranscriptRuntime {
  project: { id: ULID; slug: string };
  folderPath: string;
  orchestratorPtyState: RuntimeSnapshotRuntime['orchestratorPtyState'];
  orchestratorRuntimeSnapshot: RuntimeSnapshotRuntime['orchestratorRuntimeSnapshot'];
  startNewSession(): OrchestratorSession;
  resumeSession(targetId: ULID): OrchestratorSession;
  closeSession(): boolean;
  killOrchestratorForSmoke(): boolean;
  ptySession(): RuntimeHostPtySession | null;
  hasLiveTransientSession(sessionId: string): boolean;
}

export interface RuntimeHostRoutesDeps {
  resolveProject(projectId: string): RuntimeHostRuntime | null;
  runtimeSnapshotPayload(projectId: ULID, runtime: RuntimeHostRuntime): PublicRuntimeSnapshot;
  broadcastTo(projectId: ULID, msg: unknown): void;
  broadcastRuntimeSnapshot(projectId: ULID, runtime: RuntimeHostRuntime): void;
  broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void;
  ensureOrchestratorPty(projectId: ULID, runtime: RuntimeHostRuntime): RuntimeHostPtySession;
  startOrchestratorPtyInBackground(projectId: ULID, runtime: RuntimeHostRuntime): void;
}

export function loadRuntimeSessionReplay(
  runtime: Pick<RuntimeHostRuntime, 'sessionDataPath'>,
  sessionId: ULID,
): SessionReplayCheckpoint {
  return loadConversationReplayCheckpoint(runtime, sessionId);
}

export function sessionReplayPayload(replay: SessionReplayCheckpoint): {
  type: 'session-replay';
  sessionId: string;
  highWaterSeq: number;
  events: SessionReplayCheckpoint['events'];
} {
  return {
    type: 'session-replay',
    sessionId: replay.sessionId,
    highWaterSeq: replay.highWaterSeq,
    events: replay.events,
  };
}

function broadcastSessionReplay(
  deps: RuntimeHostRoutesDeps,
  projectId: ULID,
  replay: SessionReplayCheckpoint,
): void {
  deps.broadcastTo(projectId, sessionReplayPayload(replay));
}

/** Build the slice-006 send facade for the cancel/retry routes. These routes
 *  never ensure a session (the guards run first), so `ensureActiveSession` is a
 *  throwing stub. The PTY is reached through the runtime's `ptySession()`. */
function sendServiceFor(
  deps: RuntimeHostRoutesDeps,
  projectId: ULID,
  runtime: RuntimeHostRuntime,
) {
  return conversationSendServiceFor({
    runtime: {
      ensureActiveSession: () => {
        throw new Error('cancel/retry does not ensure a session');
      },
      ptySession: () => runtime.ptySession(),
    },
    ensurePort: () => deps.ensureOrchestratorPty(projectId, runtime),
    broadcastSendQueueSnapshot: deps.broadcastSendQueueSnapshot,
  });
}

export function registerRuntimeHostRoutes(app: Hono, deps: RuntimeHostRoutesDeps): void {
  /** Active orchestrator session for the project (the one the chat is bound
   *  to). Returns null if no session exists yet — first ensurePty mints one. */
  app.get('/api/projects/:projectId/session', (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const session = getActiveOrchestratorSession(id);
    return c.json({ ok: true, session });
  });

  /** Current orchestrator runtime snapshot. This endpoint is intentionally
   *  no-spawn: it reports whether Claude is live, busy, exited, respawnable,
   *  or inaccessible without creating a child process as a side effect. */
  app.get('/api/projects/:projectId/orchestrator/runtime', (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    return c.json({ ok: true, runtime: deps.runtimeSnapshotPayload(id, runtime) });
  });

  /** Smoke-only PTY control. Guarded by a header and the pc-smoke project
   *  prefix so browser tests can pin process-exit recovery without exposing a
   *  normal destructive control for user projects. */
  app.post('/api/projects/:projectId/orchestrator/smoke/kill-pty', (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    if (
      c.req.header('x-pc-smoke-control') !== '1' ||
      !runtime.project.slug.startsWith('pc-smoke')
    ) {
      return c.json({ ok: false, error: 'smoke control is not available' }, 404);
    }
    const killed = runtime.killOrchestratorForSmoke();
    deps.broadcastRuntimeSnapshot(id, runtime);
    return c.json({
      ok: true,
      killed,
      runtime: deps.runtimeSnapshotPayload(id, runtime),
    });
  });

  /** Full history of orchestrator sessions for the project (most recent
   *  first). Feeds the "previous sessions" rail tab. */
  app.get('/api/projects/:projectId/sessions', (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    return c.json({ ok: true, sessions: listOrchestratorSessionsForProject(id) });
  });

  /** Replay a specific session's normalized event log. Used by the Sessions
   *  tab to render past chats in read-only mode. Returns envelope-shape
   *  objects so the client can demux on `type` (jsonl vs legacy hook event). */
  app.get('/api/projects/:projectId/sessions/:sessionId/events', (c) => {
    const id = c.req.param('projectId') as ULID;
    const sessionId = c.req.param('sessionId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    // Additive ?afterSeq=&limit= read: returns only rows with seq > afterSeq
    // using the per-session transcript seq cursor (NOT the global live-outbox
    // cursor). With no afterSeq the response is the unchanged full checkpoint.
    const afterSeqQuery = parseTranscriptAfterSeqQuery({
      afterSeq: c.req.query('afterSeq'),
      limit: c.req.query('limit'),
    });
    const replay = afterSeqQuery
      ? loadConversationReplayCheckpointAfter(
          runtime,
          sessionId,
          afterSeqQuery.afterSeq,
          afterSeqQuery.limit,
        )
      : loadRuntimeSessionReplay(runtime, sessionId);
    return c.json({
      ok: true,
      sessionId: replay.sessionId,
      highWaterSeq: replay.highWaterSeq,
      events: replay.events,
    });
  });

  /** Tail of the raw PTY transcript for the terminal renderer. This is a
   *  debug terminal surface only; chat replay remains jsonl-events.jsonl. */
  app.get('/api/projects/:projectId/sessions/:sessionId/terminal-transcript', (c) => {
    const id = c.req.param('projectId') as ULID;
    const sessionId = c.req.param('sessionId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const persistedSession = getOrchestratorSession(sessionId);
    const transientSession =
      !persistedSession && runtime.hasLiveTransientSession(sessionId)
        ? { id: sessionId, projectId: id }
        : null;
    const result = readTerminalTranscriptTail({
      projectId: id,
      sessionId,
      session: persistedSession ?? transientSession,
      runtime,
      tailBytes: normalizeTerminalTranscriptTailBytes(c.req.query('tailBytes')),
    });
    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json(result);
  });

  /** Start a fresh session: end the active row, kill the PTY, return the
   *  empty replay checkpoint immediately, then respawn Claude in the
   *  background. */
  app.post('/api/projects/:projectId/sessions/new', (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const previous = getActiveOrchestratorSession(id);
    if (previous) {
      cancelOpenOrchestratorSendsForSession(previous.id, 'session replaced by new session');
      deps.broadcastSendQueueSnapshot(id, previous.id);
    }
    const session = runtime.startNewSession();
    const replay = loadRuntimeSessionReplay(runtime, session.id);
    deps.broadcastTo(id, { type: 'session-changed', transition: 'new-session', session });
    broadcastSessionReplay(deps, id, replay);
    deps.broadcastSendQueueSnapshot(id, session.id);
    deps.startOrchestratorPtyInBackground(id, runtime);
    return c.json({
      ok: true,
      transition: 'new-session',
      session,
      replay: replay.events,
      highWaterSeq: replay.highWaterSeq,
    });
  });

  /** Resume a past orchestrator session. Re-activates the target row, respawns
   *  the PTY with --resume so claude.exe loads the prior context, then sends
   *  an atomic replay snapshot so the chat panel re-populates immediately. */
  app.post('/api/projects/:projectId/sessions/:targetId/resume', (c) => {
    const id = c.req.param('projectId') as ULID;
    const targetId = c.req.param('targetId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const previous = getActiveOrchestratorSession(id);
    let session;
    try {
      session = runtime.resumeSession(targetId);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    if (previous && previous.id !== session.id) {
      cancelOpenOrchestratorSendsForSession(previous.id, 'session replaced by resume');
      deps.broadcastSendQueueSnapshot(id, previous.id);
    }
    const replay = loadRuntimeSessionReplay(runtime, session.id);
    deps.broadcastTo(id, { type: 'session-changed', transition: 'resume-session', session });
    broadcastSessionReplay(deps, id, replay);
    deps.broadcastSendQueueSnapshot(id, session.id);
    deps.startOrchestratorPtyInBackground(id, runtime);
    return c.json({
      ok: true,
      transition: 'resume-session',
      session,
      replay: replay.events,
      highWaterSeq: replay.highWaterSeq,
    });
  });

  /** Close the live chat back to the launcher: end the active session + kill
   *  the PTY, mint nothing. Broadcasts session-changed with `session: null` so
   *  every connected client drops to the Start-Chat screen. Idempotent — a
   *  no-op success when there's no active session. */
  app.post('/api/projects/:projectId/sessions/close', (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const previous = getActiveOrchestratorSession(id);
    const closed = runtime.closeSession();
    if (previous) {
      cancelOpenOrchestratorSendsForSession(previous.id, 'session closed');
      deps.broadcastSendQueueSnapshot(id, previous.id);
    }
    deps.broadcastTo(id, { type: 'session-changed', transition: 'close-session', session: null });
    return c.json({ ok: true, transition: 'close-session', closed });
  });

  app.post('/api/projects/:projectId/send-queue/:sendId/cancel', (c) => {
    const id = c.req.param('projectId') as ULID;
    const sendId = c.req.param('sendId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const active = getActiveOrchestratorSession(id);
    if (!active) return c.json({ ok: false, error: 'No active orchestrator session' }, 404);

    const existing = getOrchestratorSendQueueRow(sendId);
    if (!existing || existing.projectId !== id || existing.sessionId !== active.id) {
      return c.json({ ok: false, error: 'Queued prompt not found' }, 404);
    }

    const sendService = sendServiceFor(deps, id, runtime);
    const cancelled = sendService.cancelQueuedTurn({
      sendId,
      sessionId: active.id,
      reason: 'user cancelled',
    });
    if (!cancelled) {
      return c.json({
        ok: false,
        error: `Queued prompt is already ${existing.status}`,
      }, 409);
    }

    deps.broadcastSendQueueSnapshot(id, active.id);
    return c.json({ ok: true, item: publicSendQueueItem(cancelled) });
  });

  app.post('/api/projects/:projectId/send-queue/:sendId/retry', (c) => {
    const id = c.req.param('projectId') as ULID;
    const sendId = c.req.param('sendId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const active = getActiveOrchestratorSession(id);
    if (!active) return c.json({ ok: false, error: 'No active orchestrator session' }, 404);

    const existing = getOrchestratorSendQueueRow(sendId);
    if (!existing || existing.projectId !== id || existing.sessionId !== active.id) {
      return c.json({ ok: false, error: 'Queued prompt not found' }, 404);
    }
    if (existing.status !== 'failed') {
      return c.json({
        ok: false,
        error: `Queued prompt is ${existing.status}, not failed`,
      }, 409);
    }

    let live = runtime.ptySession();
    if (!live) {
      try {
        live = deps.ensureOrchestratorPty(id, runtime);
      } catch (err) {
        return c.json({
          ok: false,
          error: err instanceof Error ? err.message : 'Failed to restart Claude',
        }, 409);
      }
    }

    const state = live.getState();
    const hasBacklog = hasOpenOrchestratorSendsForSession(active.id);
    const sendService = sendServiceFor(deps, id, runtime);
    const retried = sendService.retryFailedTurn({
      sendId,
      sessionId: active.id,
      state,
      hasBacklog,
    });
    if (!retried) {
      return c.json({ ok: false, error: 'Failed prompt could not be retried' }, 409);
    }

    deps.broadcastSendQueueSnapshot(id, active.id);
    if (state === 'ready') {
      sendService.deliverNextQueuedTurn(id);
    }
    return c.json({ ok: true, item: publicSendQueueItem(retried) });
  });
}
