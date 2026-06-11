// Q12 multi-project WS subscription.
//
// Opens one WebSocket per project in `projects` when `enabled` is true.
// Subscribes to ALL projects with intent=activity (broadcast-only; never
// spawns an orchestrator). The active project's chat events come via a
// separate intent=chat socket in useProjectWs; the activity socket for the
// same project carries only broadcast frames so there is no double-processing
// concern. Crucially, NOT excluding the active project means the eligible set
// is stable across project switches — switching focus never tears down and
// reopens any of these sockets.
//
// Returns a single merged event list (newest at end, matching useProjectWs)
// plus an aggregate status: 'open' if every socket is open, 'connecting' if
// any are still handshaking with none closed, 'closed' if any are closed,
// 'idle' if disabled or no eligible projects.
//
// Q13: per-socket exponential backoff (2 → 5 → 15 → 30s cap), per-socket
// seenTs dedup so the server's events.jsonl replay on reconnect doesn't
// double-render.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import {
  projectWsTargetIds,
  projectWsTargetIdsFromKey,
  projectWsTargetKeyFromIds,
  shouldAcceptProjectWsEnvelope,
} from '@/features/projects/live-events';
import {
  advanceLiveCursor,
  clearLiveCursor,
  liveCursorScopeForProject,
} from '@/features/live/hooks';
import { useLiveStore } from '@/store/live-store';
import {
  createHeartbeatPing,
  heartbeatTimedOut,
  nextBackoffMs,
  RECONNECT_SCHEDULE_MS,
  WS_HEARTBEAT_INTERVAL_MS,
} from './ws-heartbeat';
import type {
  WsEnvelope,
  WsStatus,
} from '@/features/runtime/ws-types';

const MAX_BUFFERED = 500;

interface UseAllProjectsWsResult {
  events: WsEnvelope[];
  status: WsStatus;
}

interface ConnectionHandle {
  close: () => void;
}

export function useAllProjectsWs(
  projects: Project[],
  enabled: boolean,
): UseAllProjectsWsResult {
  const [events, setEvents] = useState<WsEnvelope[]>([]);
  const [statuses, setStatuses] = useState<Record<string, WsStatus>>({});
  const connectionsRef = useRef<Map<string, ConnectionHandle>>(new Map());

  // Stable key: re-open sockets only when the eligible project ID set changes,
  // not when a project.changed refetch returns new Project object identities.
  // Passing null for excludeProjectId subscribes to all projects — the set is
  // then stable across project switches (pc-pty-chat-403 Part A).
  const targetIds = useMemo(
    () => projectWsTargetIds(projects, null, enabled),
    [projects, enabled],
  );
  const targetKey = projectWsTargetKeyFromIds(targetIds);

  useEffect(() => {
    const effectTargetIds = projectWsTargetIdsFromKey(targetKey);
    setEvents([]);
    setStatuses({});

    if (effectTargetIds.length === 0) {
      for (const handle of connectionsRef.current.values()) handle.close();
      connectionsRef.current.clear();
      return;
    }

    const connections = new Map<string, ConnectionHandle>();
    connectionsRef.current = connections;

    for (const projectId of effectTargetIds) {
      connections.set(
        projectId,
        openWithBackoff(projectId, (next) =>
          setStatuses((prev) => ({ ...prev, [projectId]: next })),
        (env) =>
          setEvents((prev) => {
            const next = [...prev, env];
            return next.length > MAX_BUFFERED ? next.slice(next.length - MAX_BUFFERED) : next;
          }),
        ),
      );
    }

    return () => {
      for (const handle of connections.values()) handle.close();
      connections.clear();
    };
  }, [targetKey]);

  const status = aggregateStatus(targetIds, statuses, enabled);

  return { events, status };
}

/** Open a WS for `projectId`, retrying with the Q13 backoff schedule on
 *  close. Returns a handle whose `close()` cancels any pending retry and
 *  closes the live socket. */
function openWithBackoff(
  projectId: string,
  onStatus: (s: WsStatus) => void,
  onEvent: (env: WsEnvelope) => void,
): ConnectionHandle {
  let cancelled = false;
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let delay: number = RECONNECT_SCHEDULE_MS[0];
  const seenTs = new Set<string>();

  function clearHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function connect(): void {
    if (cancelled) return;
    onStatus('connecting');
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // No intent=chat → activity/unread fan-out: subscribe for broadcasts only,
    // never spawn an orchestrator (this fan-out was the boot connect storm).
    const url = `${proto}://${window.location.host}/ws?projectId=${encodeURIComponent(projectId)}&intent=activity`;
    const sock = new WebSocket(url);
    ws = sock;
    let disconnected = false;
    let lastInboundAt = Date.now();

    function scheduleReconnect(): void {
      if (cancelled || disconnected) return;
      disconnected = true;
      clearHeartbeat();
      if (ws === sock) ws = null;
      onStatus('closed');
      const wait = delay;
      delay = nextBackoffMs(delay);
      retryTimer = setTimeout(connect, wait);
    }

    function forceReconnect(): void {
      try { sock.close(4000, 'heartbeat-timeout'); } catch { /* best-effort */ }
      scheduleReconnect();
    }

    sock.addEventListener('open', () => {
      if (cancelled) return;
      lastInboundAt = Date.now();
      onStatus('open');
      delay = RECONNECT_SCHEDULE_MS[0];
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (cancelled || disconnected) return;
        if (sock.readyState !== WebSocket.OPEN) {
          scheduleReconnect();
          return;
        }
        if (heartbeatTimedOut(lastInboundAt)) {
          forceReconnect();
          return;
        }
        try {
          sock.send(JSON.stringify(createHeartbeatPing()));
        } catch {
          forceReconnect();
        }
      }, WS_HEARTBEAT_INTERVAL_MS);
    });

    sock.addEventListener('close', () => {
      scheduleReconnect();
    });

    sock.addEventListener('error', () => {
      // `close` fires too — handle retry there.
    });

    sock.addEventListener('message', (e) => {
      if (cancelled) return;
      lastInboundAt = Date.now();
      let env: WsEnvelope | null = null;
      try {
        env = JSON.parse(typeof e.data === 'string' ? e.data : '') as WsEnvelope;
      } catch {
        return;
      }
      if (!shouldAcceptProjectWsEnvelope(env, projectId)) return;
      if (env.type === 'server-pong') return;
      // T3.2 — feed the single identity-keyed live store from the BACKGROUND
      // fleet too (use-project-ws does this for the active socket). Global
      // `project.changed` frames from a non-active project now reach the store,
      // so the App's signature-driven refetch sees them.
      if (env.type === 'live-event') {
        const cursor = (env as { event?: { cursor?: unknown } }).event?.cursor;
        if (typeof cursor === 'string') {
          advanceLiveCursor(liveCursorScopeForProject(projectId), cursor);
        }
        useLiveStore.getState().applyEnvelope(env);
      }
      if (env.type === 'live-reset') {
        // Open Q1 — the fleet has no epoch wiring; lowest-risk reset is to clear
        // the store + this socket's cursor and let the App's HTTP catch-up effect
        // reconcile against fresh truth (no useWsEpoch on the background fleet).
        clearLiveCursor(liveCursorScopeForProject(projectId));
        useLiveStore.getState().clearAll();
        return;
      }
      if (env.type === 'event') {
        const inner = (env.event as { ts?: unknown } | undefined) ?? {};
        if (typeof inner.ts === 'string') {
          if (seenTs.has(inner.ts)) return;
          seenTs.add(inner.ts);
        }
      }
      onEvent(env);
    });
  }

  connect();

  return {
    close() {
      cancelled = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      clearHeartbeat();
      if (ws) {
        try { ws.close(); } catch { /* best-effort */ }
        ws = null;
      }
    },
  };
}

function aggregateStatus(
  targetIds: string[],
  statuses: Record<string, WsStatus>,
  enabled: boolean,
): WsStatus {
  if (!enabled || targetIds.length === 0) return 'idle';
  let anyConnecting = false;
  let anyClosed = false;
  let openCount = 0;
  for (const id of targetIds) {
    const s = statuses[id];
    if (s === 'open') openCount += 1;
    else if (s === 'closed') anyClosed = true;
    else anyConnecting = true;
  }
  if (anyClosed) return 'closed';
  if (anyConnecting) return 'connecting';
  return openCount === targetIds.length ? 'open' : 'connecting';
}
