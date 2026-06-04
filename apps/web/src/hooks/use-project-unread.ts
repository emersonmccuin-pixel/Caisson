import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';

const STORAGE_KEY = 'pc.project-chat-unread.v1';
const MAX_FALLBACK_KEYS = 200;

interface ProjectReadState {
  initialized: boolean;
  seenSeqBySession: Record<string, number>;
  seenFallbackKeys: string[];
}

interface StoredUnreadState {
  projects: Record<string, ProjectReadState>;
  unreadProjectIds: string[];
}

interface ChatObservation {
  projectId: string;
  sessionId: string | null;
  seq: number | null;
  fallbackKey: string;
}

interface ObservationBatch {
  projectId: string | null;
  isReplay: boolean;
  observations: ChatObservation[];
}

interface UseProjectUnreadArgs {
  projects: Project[];
  projectsLoaded: boolean;
  activeProjectId: string | null;
  activeEvents: WsEnvelope[];
  backgroundEvents: WsEnvelope[];
}

const EMPTY_STORED: StoredUnreadState = {
  projects: {},
  unreadProjectIds: [],
};

export function useProjectUnread({
  projects,
  projectsLoaded,
  activeProjectId,
  activeEvents,
  backgroundEvents,
}: UseProjectUnreadArgs): ReadonlySet<string> {
  const [stored, setStored] = useState<StoredUnreadState>(() => readStoredState());
  const processedBackgroundKeysRef = useRef<Set<string>>(new Set());
  const projectIds = useMemo(
    () => projects.map((p) => p.id).sort(),
    [projects],
  );
  const projectIdsKey = projectIds.join(',');

  const updateStored = useCallback((apply: (prev: StoredUnreadState) => StoredUnreadState) => {
    setStored((prev) => {
      const next = apply(prev);
      if (next !== prev) writeStoredState(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!projectsLoaded) return;
    updateStored((prev) => pruneMissingProjects(prev, new Set(projectIds)));
  }, [projectIdsKey, projectIds, projectsLoaded, updateStored]);

  useEffect(() => {
    if (!activeProjectId) return;
    const observations: ChatObservation[] = [];
    for (const env of activeEvents) {
      const batch = observationsFromEnvelope(env);
      if (batch.projectId !== activeProjectId) continue;
      observations.push(...batch.observations);
    }
    updateStored((prev) => markProjectSeen(prev, activeProjectId, observations));
  }, [activeProjectId, activeEvents, updateStored]);

  useEffect(() => {
    const pending: WsEnvelope[] = [];
    const processed = processedBackgroundKeysRef.current;
    for (const env of backgroundEvents) {
      const key = processingKey(env);
      if (processed.has(key)) continue;
      processed.add(key);
      pending.push(env);
    }
    if (pending.length === 0) return;
    updateStored((prev) => {
      let next = prev;
      for (const env of pending) {
        next = applyBackgroundEnvelope(next, env, activeProjectId);
      }
      return next;
    });
  }, [activeProjectId, backgroundEvents, updateStored]);

  return useMemo(() => new Set(stored.unreadProjectIds), [stored.unreadProjectIds]);
}

function applyBackgroundEnvelope(
  state: StoredUnreadState,
  env: WsEnvelope,
  activeProjectId: string | null,
): StoredUnreadState {
  const batch = observationsFromEnvelope(env);
  const projectId = batch.projectId;
  if (!projectId) return state;
  if (projectId === activeProjectId) {
    return markProjectSeen(state, projectId, batch.observations);
  }

  const projectState = state.projects[projectId];
  if (!projectState?.initialized && batch.isReplay) {
    return markProjectSeen(state, projectId, batch.observations);
  }

  if (batch.observations.length === 0) {
    return batch.isReplay ? markProjectInitialized(state, projectId) : state;
  }

  const isUnread =
    !projectState?.initialized ||
    batch.observations.some((observation) =>
      observationIsNewerThanSeen(projectState, observation),
    );
  return isUnread ? markProjectUnread(state, projectId) : state;
}

function markProjectInitialized(
  state: StoredUnreadState,
  projectId: string,
): StoredUnreadState {
  const current = state.projects[projectId];
  if (current?.initialized) return state;
  return {
    ...state,
    projects: {
      ...state.projects,
      [projectId]: {
        initialized: true,
        seenSeqBySession: current?.seenSeqBySession ?? {},
        seenFallbackKeys: current?.seenFallbackKeys ?? [],
      },
    },
  };
}

function markProjectUnread(
  state: StoredUnreadState,
  projectId: string,
): StoredUnreadState {
  const projectState = state.projects[projectId] ?? {
    initialized: true,
    seenSeqBySession: {},
    seenFallbackKeys: [],
  };
  if (state.unreadProjectIds.includes(projectId) && projectState.initialized) return state;
  return {
    projects: {
      ...state.projects,
      [projectId]: {
        ...projectState,
        initialized: true,
      },
    },
    unreadProjectIds: state.unreadProjectIds.includes(projectId)
      ? state.unreadProjectIds
      : [...state.unreadProjectIds, projectId],
  };
}

function markProjectSeen(
  state: StoredUnreadState,
  projectId: string,
  observations: ChatObservation[],
): StoredUnreadState {
  const current = state.projects[projectId];
  const nextProject: ProjectReadState = {
    initialized: true,
    seenSeqBySession: { ...(current?.seenSeqBySession ?? {}) },
    seenFallbackKeys: [...(current?.seenFallbackKeys ?? [])],
  };
  let changed = current?.initialized !== true;

  for (const observation of observations) {
    if (observation.sessionId && observation.seq !== null) {
      const seen = nextProject.seenSeqBySession[observation.sessionId] ?? 0;
      if (observation.seq > seen) {
        nextProject.seenSeqBySession[observation.sessionId] = observation.seq;
        changed = true;
      }
      continue;
    }
    if (!nextProject.seenFallbackKeys.includes(observation.fallbackKey)) {
      nextProject.seenFallbackKeys.push(observation.fallbackKey);
      if (nextProject.seenFallbackKeys.length > MAX_FALLBACK_KEYS) {
        nextProject.seenFallbackKeys = nextProject.seenFallbackKeys.slice(-MAX_FALLBACK_KEYS);
      }
      changed = true;
    }
  }

  const unreadProjectIds = state.unreadProjectIds.filter((id) => id !== projectId);
  if (unreadProjectIds.length !== state.unreadProjectIds.length) changed = true;
  if (!changed) return state;
  return {
    projects: {
      ...state.projects,
      [projectId]: nextProject,
    },
    unreadProjectIds,
  };
}

function observationIsNewerThanSeen(
  projectState: ProjectReadState,
  observation: ChatObservation,
): boolean {
  if (observation.sessionId && observation.seq !== null) {
    return observation.seq > (projectState.seenSeqBySession[observation.sessionId] ?? 0);
  }
  return !projectState.seenFallbackKeys.includes(observation.fallbackKey);
}

function observationsFromEnvelope(env: WsEnvelope): ObservationBatch {
  if (env.type === 'session-replay') {
    const replay = env as WsEnvelope & { sessionId?: unknown; events?: unknown };
    const projectId = typeof replay.projectId === 'string' ? replay.projectId : null;
    const fallbackSessionId = typeof replay.sessionId === 'string' ? replay.sessionId : null;
    const observations: ChatObservation[] = [];
    if (Array.isArray(replay.events) && projectId) {
      for (const item of replay.events) {
        if (!item || typeof item !== 'object') continue;
        const row = item as {
          id?: unknown;
          sessionId?: unknown;
          seq?: unknown;
          type?: unknown;
          event?: unknown;
        };
        if (row.type !== 'jsonl' && row.type !== 'event') continue;
        if (!isUnreadChatEvent(row.type, row.event)) continue;
        const sessionId = typeof row.sessionId === 'string' ? row.sessionId : fallbackSessionId;
        const seq = typeof row.seq === 'number' && Number.isSafeInteger(row.seq)
          ? row.seq
          : null;
        observations.push({
          projectId,
          sessionId,
          seq,
          fallbackKey: fallbackKey(projectId, row.type, row.event, row.id, sessionId, seq),
        });
      }
    }
    return { projectId, isReplay: true, observations };
  }

  const projectId = typeof env.projectId === 'string' ? env.projectId : null;
  if (!projectId || !isUnreadChatEvent(env.type, env.event)) {
    return { projectId, isReplay: false, observations: [] };
  }
  const sessionId = typeof env.sessionId === 'string' ? env.sessionId : null;
  const seq = typeof env.seq === 'number' && Number.isSafeInteger(env.seq) ? env.seq : null;
  return {
    projectId,
    isReplay: false,
    observations: [
      {
        projectId,
        sessionId,
        seq,
        fallbackKey: fallbackKey(projectId, env.type, env.event, env.id, sessionId, seq),
      },
    ],
  };
}

function isUnreadChatEvent(type: unknown, event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const kind = eventKind(event);
  if (type === 'jsonl') {
    return kind === 'jsonl-turn-end' && hasText(event, 'text');
  }
  if (type !== 'event') return false;
  return (
    (kind === 'assistant' && hasText(event, 'text')) ||
    kind === 'subagent-failure' ||
    kind === 'stop-failure'
  );
}

function hasText(event: object, key: string): boolean {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0;
}

function eventKind(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const kind = (event as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}

function eventTimestamp(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const row = event as { ts?: unknown; timestamp?: unknown };
  if (typeof row.ts === 'string') return row.ts;
  if (typeof row.timestamp === 'string') return row.timestamp;
  return null;
}

function eventTextFingerprint(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const row = event as Record<string, unknown>;
  const value = row.text ?? row.message ?? row.surfaceError ?? row.title ?? '';
  return typeof value === 'string' ? value.slice(0, 160) : '';
}

function fallbackKey(
  projectId: string,
  type: unknown,
  event: unknown,
  id: unknown,
  sessionId: string | null,
  seq: number | null,
): string {
  if (typeof id === 'string' && id) return id;
  if (sessionId && seq !== null) return `${sessionId}:${seq}`;
  const kind = eventKind(event) ?? 'unknown';
  const ts = eventTimestamp(event);
  const typeStr = typeof type === 'string' ? type : 'unknown';
  if (ts) return `${projectId}:${typeStr}:${kind}:${ts}`;
  return `${projectId}:${typeStr}:${kind}:${eventTextFingerprint(event)}`;
}

function processingKey(env: WsEnvelope): string {
  if (env.type === 'session-replay') {
    const replay = env as WsEnvelope & { sessionId?: unknown; highWaterSeq?: unknown; events?: unknown };
    const sessionId = typeof replay.sessionId === 'string' ? replay.sessionId : '';
    const highWaterSeq = typeof replay.highWaterSeq === 'number' ? replay.highWaterSeq : 0;
    const count = Array.isArray(replay.events) ? replay.events.length : 0;
    return `${env.projectId}:session-replay:${sessionId}:${highWaterSeq}:${count}`;
  }
  const sessionId = typeof env.sessionId === 'string' ? env.sessionId : '';
  const seq = typeof env.seq === 'number' ? env.seq : '';
  const id = typeof env.id === 'string' ? env.id : '';
  const kind = eventKind(env.event) ?? '';
  const ts = eventTimestamp(env.event) ?? '';
  return `${env.projectId}:${env.type}:${sessionId}:${seq}:${id}:${kind}:${ts}`;
}

function pruneMissingProjects(
  state: StoredUnreadState,
  allowedProjectIds: Set<string>,
): StoredUnreadState {
  const projects: StoredUnreadState['projects'] = {};
  let changed = false;
  for (const [projectId, projectState] of Object.entries(state.projects)) {
    if (allowedProjectIds.has(projectId)) {
      projects[projectId] = projectState;
    } else {
      changed = true;
    }
  }
  const unreadProjectIds = state.unreadProjectIds.filter((id) => allowedProjectIds.has(id));
  if (unreadProjectIds.length !== state.unreadProjectIds.length) changed = true;
  return changed ? { projects, unreadProjectIds } : state;
}

function readStoredState(): StoredUnreadState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STORED;
    return normalizeStoredState(JSON.parse(raw) as unknown);
  } catch {
    return EMPTY_STORED;
  }
}

function writeStoredState(state: StoredUnreadState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

function normalizeStoredState(value: unknown): StoredUnreadState {
  if (!value || typeof value !== 'object') return EMPTY_STORED;
  const row = value as {
    projects?: unknown;
    unreadProjectIds?: unknown;
  };
  const projects: StoredUnreadState['projects'] = {};
  if (row.projects && typeof row.projects === 'object') {
    for (const [projectId, projectState] of Object.entries(row.projects)) {
      if (!projectState || typeof projectState !== 'object') continue;
      const candidate = projectState as {
        initialized?: unknown;
        seenSeqBySession?: unknown;
        seenFallbackKeys?: unknown;
      };
      projects[projectId] = {
        initialized: candidate.initialized === true,
        seenSeqBySession: normalizeSeqMap(candidate.seenSeqBySession),
        seenFallbackKeys: Array.isArray(candidate.seenFallbackKeys)
          ? candidate.seenFallbackKeys.filter((key): key is string => typeof key === 'string')
          : [],
      };
    }
  }
  return {
    projects,
    unreadProjectIds: Array.isArray(row.unreadProjectIds)
      ? row.unreadProjectIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

function normalizeSeqMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [sessionId, seq] of Object.entries(value)) {
    if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0) {
      out[sessionId] = seq;
    }
  }
  return out;
}
