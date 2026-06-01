// Per-project WebSocket subscription.
//
// Server contract: `/ws?projectId=<ULID>`. Each tab/view subscribes to the
// project's broadcast stream independently; the server no longer supersedes
// same-project sockets. The per-project scope means events are pre-filtered:
// if you only want one project's events, you only get that project's events.
//
// "All projects" mode (ActivityPanel toggle, Q12) is handled by a sibling
// hook (useAllProjectsWs) that opens one socket per non-active project.
//
// Q13 hardening: exponential backoff on reconnect (2 → 5 → 15 → 30s cap), a
// single status-update per disconnect (the WsStatus state only flips once
// per close), and seenTs dedup so legacy hook events don't double-render
// around reconnects. Active-session history now arrives as one
// `session-replay` checkpoint instead of a burst of individual WS messages.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import { shouldAcceptProjectWsEnvelope } from '@/features/projects/live-events';
import type { SessionTransitionKind, SessionTransitionResponse } from '@/features/runtime/client';
import type {
  SessionChangedEnvelope,
  WsDiagnostics,
  WsEnvelope,
  WsOutbound,
  WsStatus,
} from '@/features/runtime/ws-types';
import {
  createHeartbeatPing,
  heartbeatTimedOut,
  nextBackoffMs,
  RECONNECT_SCHEDULE_MS,
  WS_HEARTBEAT_INTERVAL_MS,
} from './ws-heartbeat';
import {
  chatSessionReducer,
  createChatSessionState,
  EMPTY_AGGREGATES,
  materializeChatSessionEvents,
  replayEventsFromEnvelope,
  replayEventsFromItems,
  type ChatSessionAggregates,
} from '@/hooks/chat-session-reducer';
import { useWsEpoch } from '@/store/ws-epoch';
import { useLiveStore } from '@/store/live-store';
import {
  advanceLiveCursor,
  clearLiveCursor,
  liveCursorScopeForProject,
  readLiveCursor,
} from '@/features/live/hooks';

interface UseProjectWsResult {
  events: WsEnvelope[];
  aggregates: ChatSessionAggregates;
  status: WsStatus;
  diagnostics: WsDiagnostics;
  clear: () => void;
  send: (msg: WsOutbound) => boolean;
  applySessionTransition: (transition: SessionTransitionResponse) => void;
}

function eventTimestamp(env: WsEnvelope): string | null {
  if (env.type !== 'event') return null;
  const inner = (env.event as { ts?: unknown } | undefined) ?? {};
  return typeof inner.ts === 'string' ? inner.ts : null;
}

function sessionTransitionKind(env: WsEnvelope): SessionTransitionKind | null {
  if (env.type !== 'session-changed') return null;
  const transition = (env as Partial<SessionChangedEnvelope>).transition;
  return transition === 'new-session' || transition === 'resume-session'
    ? transition
    : null;
}

function emptyWsDiagnostics(): WsDiagnostics {
  return {
    reconnectCount: 0,
    lastOpenAt: null,
    lastCloseAt: null,
    lastInboundAt: null,
    lastInboundType: null,
    lastHeartbeatSentAt: null,
    lastPongAt: null,
    lastHeartbeatTimeoutAt: null,
  };
}

export function useProjectWs(project: Project | null): UseProjectWsResult {
  const [sessionState, dispatchSession] = useReducer(
    chatSessionReducer,
    null,
    () => createChatSessionState(null),
  );
  const events = useMemo(
    () =>
      project && sessionState.projectId === project.id
        ? materializeChatSessionEvents(sessionState)
        : [],
    [project, sessionState],
  );
  const aggregates = useMemo(
    () =>
      project && sessionState.projectId === project.id
        ? sessionState.aggregates
        : EMPTY_AGGREGATES,
    [project, sessionState],
  );
  const [status, setStatus] = useState<WsStatus>('idle');
  const [diagnostics, setDiagnostics] = useState<WsDiagnostics>(() => emptyWsDiagnostics());
  const wsRef = useRef<WebSocket | null>(null);
  const seenTsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    dispatchSession({ type: 'reset-project', projectId: project?.id ?? null });
    seenTsRef.current.clear();
    setDiagnostics(emptyWsDiagnostics());
    if (!project) {
      setStatus('idle');
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let activeHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let delay: number = RECONNECT_SCHEDULE_MS[0];
    // Lifted to effect scope so the wake handler (visibilitychange / online)
    // can judge socket freshness across reconnects, not just within one socket.
    let lastInboundAt = Date.now();

    function connect(): void {
      if (cancelled) return;
      setStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      // intent=chat → the server spawns/attaches the orchestrator for this
      // focused socket. Activity sockets omit it and never spawn.
      const url = `${proto}://${window.location.host}/ws?projectId=${encodeURIComponent(project!.id)}&intent=chat`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      let disconnected = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      function clearHeartbeat(): void {
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          if (activeHeartbeatTimer === heartbeatTimer) activeHeartbeatTimer = null;
          heartbeatTimer = null;
        }
      }

      function scheduleReconnect(): void {
        if (cancelled || disconnected) return;
        disconnected = true;
        clearHeartbeat();
        if (wsRef.current === ws) wsRef.current = null;
        setStatus('closed');
        setDiagnostics((prev) => ({
          ...prev,
          reconnectCount: prev.reconnectCount + 1,
          lastCloseAt: Date.now(),
        }));
        const wait = delay;
        delay = nextBackoffMs(delay);
        retryTimer = setTimeout(connect, wait);
      }

      function forceReconnect(): void {
        setDiagnostics((prev) => ({
          ...prev,
          lastHeartbeatTimeoutAt: Date.now(),
        }));
        try { ws.close(4000, 'heartbeat-timeout'); } catch { /* best-effort */ }
        scheduleReconnect();
      }

      function startHeartbeat(): void {
        clearHeartbeat();
        heartbeatTimer = setInterval(() => {
          if (cancelled || disconnected) return;
          if (ws.readyState !== WebSocket.OPEN) {
            scheduleReconnect();
            return;
          }
          if (heartbeatTimedOut(lastInboundAt)) {
            forceReconnect();
            return;
          }
          try {
            const ping = createHeartbeatPing();
            setDiagnostics((prev) => ({
              ...prev,
              lastHeartbeatSentAt: ping.sentAt,
            }));
            ws.send(JSON.stringify(ping));
          } catch {
            forceReconnect();
          }
        }, WS_HEARTBEAT_INTERVAL_MS);
        activeHeartbeatTimer = heartbeatTimer;
      }

      ws.addEventListener('open', () => {
        if (cancelled) return;
        lastInboundAt = Date.now();
        setStatus('open');
        setDiagnostics((prev) => ({
          ...prev,
          lastOpenAt: lastInboundAt,
          lastInboundAt,
          lastInboundType: 'open',
        }));
        delay = RECONNECT_SCHEDULE_MS[0];
        startHeartbeat();
        // Reconcile-on-(re)connect: the hub has no catch-up, so anything created
        // while this socket was down/half-open (server restart, blip) was never
        // delivered. Bump the epoch so resource-list hooks refetch the truth —
        // this is what removes the "manual refresh to see new agents/workflows".
        if (project) useWsEpoch.getState().bump(project.id);
        // Slice 015a — WS subscribe handshake. Send our stored `lastVersion`
        // (the global `seq` cursor) so the relay replays `(lastVersion,
        // snapshot]` for this project; live rows then arrive via the same
        // socket. The epoch bump above is the belt-and-suspenders full reload;
        // the cursor catch-up is the precise replay on top. A below-floor
        // cursor comes back as a `live-reset` frame (handled below).
        if (project) {
          const lastVersion = readLiveCursor(liveCursorScopeForProject(project.id));
          try {
            ws.send(JSON.stringify({ type: 'subscribe', lastVersion, projectId: project.id }));
          } catch {
            /* best-effort; the epoch bump already triggered a full reload */
          }
        }
      });

      ws.addEventListener('close', () => {
        scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        // `close` fires too — handle the retry there.
      });

      ws.addEventListener('message', (e) => {
        if (cancelled) return;
        lastInboundAt = Date.now();
        let env: WsEnvelope | null = null;
        try {
          env = JSON.parse(typeof e.data === 'string' ? e.data : '') as WsEnvelope;
        } catch {
          return;
        }
        if (!shouldAcceptProjectWsEnvelope(env, project!.id)) return;
        setDiagnostics((prev) => ({
          ...prev,
          lastInboundAt,
          lastInboundType: env.type,
          lastPongAt: env.type === 'server-pong' ? lastInboundAt : prev.lastPongAt,
        }));
        if (env.type === 'server-pong') return;
        // Slice 015a — advance the global `seq` cursor on every live-event frame
        // so the next (re)connect handshake replays only what we haven't seen.
        // Resource-list stores already dedupe by per-entity `version`, so we do
        // not re-route the frame here — we only persist the cursor.
        if (env.type === 'live-event' && project) {
          const cursor = (env as { event?: { cursor?: unknown } }).event?.cursor;
          if (typeof cursor === 'string') {
            advanceLiveCursor(liveCursorScopeForProject(project.id), cursor);
          }
          // Slice 018 — feed the single identity-keyed live store directly from
          // the socket, independent of the chat-timeline reducer below. Every
          // resource view reads the store; the chat-timeline retention of these
          // frames is the reconcile-first fallback, removed once verified.
          useLiveStore.getState().applyEnvelope(env);
        }
        // Slice 015a — gap signal: our cursor predated the pruned outbox floor,
        // so a complete replay was impossible. Drop the cursor and force a full
        // reload (epoch bump) so resource lists refetch HTTP truth.
        if (env.type === 'live-reset' && project) {
          clearLiveCursor(liveCursorScopeForProject(project.id));
          // Slice 018 — drop the identity-keyed store too so a stale frame can
          // never re-merge over the freshly reseeded HTTP truth; the epoch bump
          // forces resource lists to refetch.
          useLiveStore.getState().clearAll();
          useWsEpoch.getState().bump(project.id);
          return;
        }
        if (env.type === 'event') {
          const ts = eventTimestamp(env);
          if (ts) {
            const seenTs = seenTsRef.current;
            if (seenTs.has(ts)) return;
            seenTs.add(ts);
          }
        }
        const final = env;
        if (final.type === 'session-changed') {
          const transition = sessionTransitionKind(final);
          if (transition === 'new-session') {
            seenTsRef.current.clear();
          }
          dispatchSession({ type: 'envelope', env: final });
          return;
        }
        if (final.type === 'session-replay') {
          const replay = replayEventsFromEnvelope(final, project!.id);
          const seenTs = seenTsRef.current;
          seenTs.clear();
          for (const replayEnv of replay) {
            const ts = eventTimestamp(replayEnv);
            if (ts) seenTs.add(ts);
          }
          dispatchSession({ type: 'envelope', env: final });
          return;
        }
        dispatchSession({ type: 'envelope', env: final });
      });
    }

    connect();

    // Returning to the window or regaining network is the moment a silently
    // half-dead socket is most likely — Chromium throttles the in-socket
    // heartbeat timer while the renderer is backgrounded, so it can take
    // minutes to notice on its own. On wake, if the socket isn't demonstrably
    // fresh, drop it and reconnect immediately instead of waiting on backoff.
    function reconnectIfStale(): void {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const ws = wsRef.current;
      const fresh =
        ws &&
        ws.readyState === WebSocket.OPEN &&
        !heartbeatTimedOut(lastInboundAt);
      if (fresh) return;
      // Make the next reconnect attempt fast regardless of accrued backoff.
      delay = RECONNECT_SCHEDULE_MS[0];
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        // close() fires the socket's own close handler → scheduleReconnect.
        try { ws.close(); } catch { /* best-effort */ }
      } else if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
        connect();
      } else if (!wsRef.current) {
        connect();
      }
    }

    const hasWindow = typeof window !== 'undefined';
    if (hasWindow) {
      document.addEventListener('visibilitychange', reconnectIfStale);
      window.addEventListener('online', reconnectIfStale);
      window.addEventListener('focus', reconnectIfStale);
    }

    return () => {
      cancelled = true;
      if (hasWindow) {
        document.removeEventListener('visibilitychange', reconnectIfStale);
        window.removeEventListener('online', reconnectIfStale);
        window.removeEventListener('focus', reconnectIfStale);
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (activeHeartbeatTimer !== null) {
        clearInterval(activeHeartbeatTimer);
        activeHeartbeatTimer = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try { ws.close(); } catch { /* best-effort */ }
      }
    };
  }, [project]);

  const send = useCallback((msg: WsOutbound): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }, []);

  const applySessionTransition = useCallback(
    (transition: SessionTransitionResponse): void => {
      if (!project || transition.session.projectId !== project.id) return;

      const replay = replayEventsFromItems(
        transition.replay,
        project.id,
        transition.session.id,
      );
      const seenTs = seenTsRef.current;
      seenTs.clear();
      for (const replayEnv of replay) {
        const ts = eventTimestamp(replayEnv);
        if (ts) seenTs.add(ts);
      }
      dispatchSession({
        type: 'session-transition',
        projectId: project.id,
        transition,
      });
    },
    [project],
  );

  return {
    events,
    aggregates,
    status,
    diagnostics,
    clear: () => {
      seenTsRef.current.clear();
      dispatchSession({ type: 'reset-project', projectId: project?.id ?? null });
    },
    send,
    applySessionTransition,
  };
}
