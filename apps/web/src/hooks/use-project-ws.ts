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
  materializeTerminalRawEvents,
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

const INBOUND_DIAGNOSTICS_MIN_INTERVAL_MS = 250;
const RAW_FRAME_BATCH_MS = 50;

interface UseProjectWsResult {
  events: WsEnvelope[];
  /** Raw PTY frame envelopes only — separated from `events` so the chat
   *  timeline's events[] reference stays stable across 50 ms terminal batches.
   *  Pass this prop down to TerminalModePanel; do NOT merge it into events. */
  rawEvents: WsEnvelope[];
  aggregates: ChatSessionAggregates;
  /** T3.1 — ticks on every session-changed (new OR resume). The sessions rail
   *  keys its lifecycle refetch off this instead of scanning `events[]`. */
  sessionChangedNonce: number;
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

export function shouldPublishInboundDiagnostics(
  lastPublishedAt: number,
  nextInboundAt: number,
  inboundType: string,
): boolean {
  return (
    inboundType === 'server-pong' ||
    lastPublishedAt === 0 ||
    nextInboundAt - lastPublishedAt >= INBOUND_DIAGNOSTICS_MIN_INTERVAL_MS
  );
}

export function useProjectWs(project: Project | null): UseProjectWsResult {
  // Identify everything by the project *id* (a stable string), never the
  // `project` object. The list refetch upstream (App.tsx) hands back a fresh
  // `projects` array — and thus a fresh `activeProject` object with the same
  // id — on every WS frame; keying the socket/events on the object recreated
  // the socket each refetch, which pushed a new snapshot → another refetch →
  // an infinite reconnect/render storm (max-update-depth). The id is stable
  // across refetches, so a same-project refetch is now a no-op here.
  const projectId = project?.id ?? null;
  const [sessionState, dispatchSession] = useReducer(
    chatSessionReducer,
    null,
    () => createChatSessionState(null),
  );
  const events = useMemo(
    () =>
      projectId && sessionState.projectId === projectId
        ? materializeChatSessionEvents(sessionState)
        : [],
    [projectId, sessionState],
  );
  // Keyed on terminalRaw only — changes when raw batches arrive, not when chat
  // events land. Keeps the TerminalModePanel update path decoupled from the chat
  // timeline fold, which is the entire point of Option A.
  const rawEvents = useMemo(
    () =>
      projectId && sessionState.projectId === projectId
        ? materializeTerminalRawEvents(sessionState)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, sessionState.terminalRaw],
  );
  const aggregates = useMemo(
    () =>
      projectId && sessionState.projectId === projectId
        ? sessionState.aggregates
        : EMPTY_AGGREGATES,
    [projectId, sessionState],
  );
  const [status, setStatus] = useState<WsStatus>('idle');
  const [diagnostics, setDiagnostics] = useState<WsDiagnostics>(() => emptyWsDiagnostics());
  const wsRef = useRef<WebSocket | null>(null);
  const seenTsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    dispatchSession({ type: 'reset-project', projectId });
    seenTsRef.current.clear();
    setDiagnostics(emptyWsDiagnostics());
    if (!projectId) {
      setStatus('idle');
      return;
    }
    // Narrowed for the nested closures below (TS won't carry the guard's
    // narrowing of the outer const across a function boundary).
    const pid: string = projectId;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let activeHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let delay: number = RECONNECT_SCHEDULE_MS[0];
    // Lifted to effect scope so the wake handler (visibilitychange / online)
    // can judge socket freshness across reconnects, not just within one socket.
    let lastInboundAt = Date.now();
    let lastDiagnosticsPublishedAt = 0;
    let rawFrameBatch: WsEnvelope[] = [];
    let rawFrameFlushTimer: ReturnType<typeof setTimeout> | null = null;

    function flushRawFrames(): void {
      if (rawFrameFlushTimer !== null) {
        clearTimeout(rawFrameFlushTimer);
        rawFrameFlushTimer = null;
      }
      if (rawFrameBatch.length === 0) return;
      const envs = rawFrameBatch;
      rawFrameBatch = [];
      if (cancelled) return;
      dispatchSession({ type: 'envelopes', envs });
    }

    function dispatchRuntimeEnvelope(env: WsEnvelope): void {
      if (env.type !== 'raw') {
        flushRawFrames();
        dispatchSession({ type: 'envelope', env });
        return;
      }
      rawFrameBatch.push(env);
      if (rawFrameFlushTimer !== null) return;
      rawFrameFlushTimer = setTimeout(() => {
        rawFrameFlushTimer = null;
        flushRawFrames();
      }, RAW_FRAME_BATCH_MS);
    }

    function connect(): void {
      if (cancelled) return;
      setStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      // intent=chat → the server spawns/attaches the orchestrator for this
      // focused socket. Activity sockets omit it and never spawn.
      const url = `${proto}://${window.location.host}/ws?projectId=${encodeURIComponent(pid)}&intent=chat`;
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
        useWsEpoch.getState().bump(pid);
        // Slice 015a — WS subscribe handshake. Send our stored `lastVersion`
        // (the global `seq` cursor) so the relay replays `(lastVersion,
        // snapshot]` for this project; live rows then arrive via the same
        // socket. The epoch bump above is the belt-and-suspenders full reload;
        // the cursor catch-up is the precise replay on top. A below-floor
        // cursor comes back as a `live-reset` frame (handled below).
        {
          const lastVersion = readLiveCursor(liveCursorScopeForProject(pid));
          try {
            ws.send(JSON.stringify({ type: 'subscribe', lastVersion, projectId: pid }));
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
        if (!shouldAcceptProjectWsEnvelope(env, pid)) return;
        // Diagnostics are display/debug metadata only. Keep the local
        // lastInboundAt variable exact for heartbeat correctness, but don't
        // force a whole-app React update for every raw/jsonl burst frame.
        if (shouldPublishInboundDiagnostics(lastDiagnosticsPublishedAt, lastInboundAt, env.type)) {
          lastDiagnosticsPublishedAt = lastInboundAt;
          setDiagnostics((prev) => ({
            ...prev,
            lastInboundAt,
            lastInboundType: env.type,
            lastPongAt: env.type === 'server-pong' ? lastInboundAt : prev.lastPongAt,
          }));
        }
        if (env.type === 'server-pong') return;
        // Slice 015a — advance the global `seq` cursor on every live-event frame
        // so the next (re)connect handshake replays only what we haven't seen.
        // Resource-list stores already dedupe by per-entity `version`, so we do
        // not re-route the frame here — we only persist the cursor.
        if (env.type === 'live-event') {
          const cursor = (env as { event?: { cursor?: unknown } }).event?.cursor;
          if (typeof cursor === 'string') {
            advanceLiveCursor(liveCursorScopeForProject(pid), cursor);
          }
          // Slice 018 / T3.3 — feed the single identity-keyed live store from the
          // socket, then STOP. The store is the SOLE live path for relay frames;
          // they never reach the chat-timeline reducer. Every resource view reads
          // the store (T3.1/T3.2/T3.2b/T3.2c migrated all consumers).
          useLiveStore.getState().applyEnvelope(env);
          return;
        }
        // Slice 015a — gap signal: our cursor predated the pruned outbox floor,
        // so a complete replay was impossible. Drop the cursor and force a full
        // reload (epoch bump) so resource lists refetch HTTP truth.
        if (env.type === 'live-reset') {
          clearLiveCursor(liveCursorScopeForProject(pid));
          // Slice 018 — drop the identity-keyed store too so a stale frame can
          // never re-merge over the freshly reseeded HTTP truth; the epoch bump
          // forces resource lists to refetch.
          useLiveStore.getState().clearAll();
          useWsEpoch.getState().bump(pid);
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
          dispatchRuntimeEnvelope(final);
          return;
        }
        if (final.type === 'session-replay') {
          flushRawFrames();
          const replay = replayEventsFromEnvelope(final, pid);
          const seenTs = seenTsRef.current;
          seenTs.clear();
          for (const replayEnv of replay) {
            const ts = eventTimestamp(replayEnv);
            if (ts) seenTs.add(ts);
          }
          dispatchSession({ type: 'envelope', env: final });
          return;
        }
        dispatchRuntimeEnvelope(final);
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
      flushRawFrames();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try { ws.close(); } catch { /* best-effort */ }
      }
    };
  }, [projectId]);

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
    rawEvents,
    aggregates,
    sessionChangedNonce: sessionState.sessionChangedNonce,
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
