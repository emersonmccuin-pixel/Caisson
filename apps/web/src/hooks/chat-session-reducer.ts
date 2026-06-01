import { isLiveEventFrame } from '@pc/contracts';

import type { SessionReplayItem, SessionTransitionResponse } from '@/features/runtime/client';
import {
  isProjectChangedLiveEventFrame,
  isProjectChangedRefetchEnvelope,
} from '@/features/projects/live-events';
import type {
  JsonlEvent,
  RuntimeStateEnvelope,
  SendAckEnvelope,
  SendQueueSnapshotEnvelope,
  SessionChangedEnvelope,
  SessionReplayEnvelope,
  WsEnvelope,
} from '@/features/runtime/ws-types';

// Keep the long-lived chat comfort window from the legacy raw buffer while
// the reducer owns ordering/deduplication by session sequence.
const MAX_TIMELINE_ENTRIES = 10_000;
const MAX_TERMINAL_RAW_ENTRIES = 2_000;

type TimelineEntry =
  | { kind: 'env'; key: string }
  | { kind: 'seq'; key: string };

interface SequencedEntry {
  key: string;
  sessionId: string;
  seq: number;
  env: WsEnvelope;
}

interface EnvEntry {
  key: string;
  env: WsEnvelope;
}

// Incrementally-maintained stream projection. A pure derivation of the same
// event stream the reducer owns — running token totals + latest model /
// session-state / turn-duration. Maintained O(1)-amortized at the single
// append site so consumers never re-fold the whole timeline per frame.
export interface ChatSessionAggregates {
  usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number };
  latestModel: string | null;          // most-recent jsonl-usage.model (non-null)
  latestSessionState: string | null;   // most-recent jsonl-session-state.state
  lastTurnDurationMs: number | null;    // most-recent jsonl-turn-duration.durationMs (non-null)
}

export const EMPTY_AGGREGATES: ChatSessionAggregates = {
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  latestModel: null,
  latestSessionState: null,
  lastTurnDurationMs: null,
};

export interface ChatSessionReducerState {
  projectId: string | null;
  activeSessionId: string | null;
  highWaterSeq: number;
  nextOrdinal: number;
  timeline: TimelineEntry[];
  sequenced: SequencedEntry[];
  unsequenced: EnvEntry[];
  terminalRaw: EnvEntry[];
  aggregates: ChatSessionAggregates;
}

export type ChatSessionReducerAction =
  | { type: 'reset-project'; projectId: string | null }
  | { type: 'envelope'; env: WsEnvelope }
  | { type: 'session-transition'; projectId: string; transition: SessionTransitionResponse };

export function createChatSessionState(projectId: string | null): ChatSessionReducerState {
  return {
    projectId,
    activeSessionId: null,
    highWaterSeq: 0,
    nextOrdinal: 1,
    timeline: [],
    sequenced: [],
    unsequenced: [],
    terminalRaw: [],
    aggregates: EMPTY_AGGREGATES,
  };
}

// Pure: derive next aggregates from prev + one envelope. Returns prev (same
// reference) when the envelope contributes nothing → referential stability.
function foldAggregate(prev: ChatSessionAggregates, env: WsEnvelope): ChatSessionAggregates {
  if (env.type !== 'jsonl') return prev;
  const ev = (env as WsEnvelope & { event?: JsonlEvent }).event;
  if (!ev) return prev;
  switch (ev.kind) {
    case 'jsonl-usage':
      return {
        ...prev,
        usage: {
          inputTokens: prev.usage.inputTokens + ev.inputTokens,
          outputTokens: prev.usage.outputTokens + ev.outputTokens,
          cacheCreationTokens: prev.usage.cacheCreationTokens + ev.cacheCreationTokens,
          cacheReadTokens: prev.usage.cacheReadTokens + ev.cacheReadTokens,
        },
        latestModel: ev.model ?? prev.latestModel,
      };
    case 'jsonl-session-state':
      return prev.latestSessionState === ev.state ? prev : { ...prev, latestSessionState: ev.state };
    case 'jsonl-turn-duration':
      return ev.durationMs == null ? prev : { ...prev, lastTurnDurationMs: ev.durationMs };
    default:
      return prev;
  }
}

// Pure: full recompute from a materialized event list (used by snapshot/replay
// paths, where we rebuild `sequenced`/`timeline` wholesale). Deterministic.
export function aggregatesFromEvents(events: WsEnvelope[]): ChatSessionAggregates {
  let agg = EMPTY_AGGREGATES;
  for (const env of events) agg = foldAggregate(agg, env);
  return agg;
}

export function chatSessionReducer(
  state: ChatSessionReducerState,
  action: ChatSessionReducerAction,
): ChatSessionReducerState {
  switch (action.type) {
    case 'reset-project':
      return createChatSessionState(action.projectId);
    case 'session-transition':
      return applySessionTransition(state, action.projectId, action.transition);
    case 'envelope':
      return applyEnvelope(state, action.env);
  }
}

export function materializeChatSessionEvents(state: ChatSessionReducerState): WsEnvelope[] {
  const sequenced = new Map(state.sequenced.map((entry) => [entry.key, entry.env] as const));
  const unsequenced = new Map(state.unsequenced.map((entry) => [entry.key, entry.env] as const));
  const out: WsEnvelope[] = [];
  for (const entry of state.timeline) {
    const env = entry.kind === 'seq'
      ? sequenced.get(entry.key)
      : unsequenced.get(entry.key);
    if (env) out.push(env);
  }
  for (const entry of state.terminalRaw) {
    out.push(entry.env);
  }
  return out;
}

export function replayEventsFromEnvelope(env: WsEnvelope, projectId: string): WsEnvelope[] {
  if (env.type !== 'session-replay') return [];
  const replay = env as Partial<SessionReplayEnvelope>;
  return replayEventsFromItems(replay.events, projectId, replay.sessionId);
}

export function replayEventsFromItems(
  rawEvents: unknown,
  projectId: string,
  fallbackSessionId?: string,
): WsEnvelope[] {
  if (!Array.isArray(rawEvents)) return [];
  const out: WsEnvelope[] = [];
  const ordered = [...rawEvents].sort(compareReplayItems);
  for (const candidate of ordered) {
    if (!candidate || typeof candidate !== 'object') continue;
    const type = (candidate as { type?: unknown }).type;
    if (type !== 'jsonl' && type !== 'event') continue;
    out.push({
      projectId,
      id: (candidate as { id?: unknown }).id,
      sessionId: (candidate as { sessionId?: unknown }).sessionId ?? fallbackSessionId,
      seq: (candidate as { seq?: unknown }).seq,
      type,
      kind: (candidate as { kind?: unknown }).kind,
      event: (candidate as { event?: unknown }).event,
      source: (candidate as { source?: unknown }).source,
    });
  }
  return out;
}

function applyEnvelope(
  state: ChatSessionReducerState,
  env: WsEnvelope,
): ChatSessionReducerState {
  if (
    state.projectId &&
    env.projectId !== state.projectId &&
    !isProjectChangedRefetchEnvelope(env) &&
    !isProjectChangedLiveEventFrame(env) &&
    // Slice 015b — relay-delivered `live-event` frames carry their scope in
    // `event.projectId` (no top-level `projectId`). Keep any frame for this
    // project (or a global-scope frame) in the timeline so the resource-list
    // hooks can consume it; reject another project's rows.
    !(isLiveEventFrame(env) &&
      (env.event.projectId === null || env.event.projectId === state.projectId))
  ) {
    return state;
  }

  switch (env.type) {
    case 'session-changed':
      return applySessionChanged(state, env as SessionChangedEnvelope);
    case 'session-replay':
      return applySnapshot(state, env as SessionReplayEnvelope);
    case 'send-queue-snapshot':
      return applyQueueSnapshot(state, env as SendQueueSnapshotEnvelope);
    case 'runtime-state':
      return applyRuntimeSnapshot(state, env as RuntimeStateEnvelope);
    case 'send-ack':
      return appendUnsequenced(state, env, (candidate) => {
        if (candidate.type !== 'send-ack') return false;
        return (candidate as Partial<SendAckEnvelope>).clientMessageId ===
          (env as Partial<SendAckEnvelope>).clientMessageId;
      });
    case 'raw':
      return appendTerminalRaw(state, env);
    default:
      return applyDelta(state, env);
  }
}

export function applySnapshot(
  state: ChatSessionReducerState,
  snapshot: SessionReplayEnvelope,
): ChatSessionReducerState {
  const sessionId = snapshot.sessionId;
  const replayEvents = replayEventsFromItems(snapshot.events, snapshot.projectId, sessionId);
  const sequenced: SequencedEntry[] = [];
  const unsequencedReplay: WsEnvelope[] = [];

  for (const env of replayEvents) {
    const entry = sequencedEntryFromEnvelope(env, sessionId);
    if (entry) sequenced.push(entry);
    else unsequencedReplay.push(env);
  }

  sequenced.sort((a, b) => a.seq - b.seq);
  const highWaterSeq = typeof snapshot.highWaterSeq === 'number'
    ? snapshot.highWaterSeq
    : sequenced.reduce((max, entry) => Math.max(max, entry.seq), 0);
  const preserved = preserveAcrossSnapshot(state, sessionId);
  let next: ChatSessionReducerState = {
    ...state,
    activeSessionId: sessionId,
    highWaterSeq,
    sequenced,
    timeline: preserved.timeline,
    unsequenced: preserved.unsequenced,
    terminalRaw: preserveTerminalRaw(state, sessionId),
    // Re-seed wholesale from the replay set (NOT carry-forward) — a snapshot is
    // a full re-seed of the live timeline; carrying prior aggregates would
    // double-count a live jsonl-usage the snapshot also contains.
    aggregates: aggregatesFromEvents(replayEvents),
  };

  for (const entry of sequenced) {
    next = {
      ...next,
      timeline: [...next.timeline, { kind: 'seq', key: entry.key }],
    };
  }
  for (const env of unsequencedReplay) {
    next = appendUnsequenced(next, env);
  }
  return trimTimeline(next);
}

export function applyDelta(
  state: ChatSessionReducerState,
  env: WsEnvelope,
): ChatSessionReducerState {
  const scopedSessionId = sessionIdFromEnvelope(env);
  if (
    state.activeSessionId &&
    scopedSessionId &&
    scopedSessionId !== state.activeSessionId &&
    isActiveChatEnvelope(env)
  ) {
    return state;
  }

  const entry = sequencedEntryFromEnvelope(env, state.activeSessionId ?? undefined);
  if (!entry) return appendUnsequenced(state, env);

  const activeSessionId = state.activeSessionId ?? entry.sessionId;
  const existing = state.sequenced.find((candidate) => candidate.key === entry.key);
  if (existing) {
    // Dedupe/replace branch — the envelope was already folded on first arrival.
    // Do NOT fold again or a re-delivered jsonl-usage would double-count.
    return {
      ...state,
      activeSessionId,
      highWaterSeq: Math.max(state.highWaterSeq, entry.seq),
      sequenced: state.sequenced.map((candidate) =>
        candidate.key === entry.key ? entry : candidate,
      ),
    };
  }

  const sequenced = [...state.sequenced, entry].sort((a, b) => a.seq - b.seq);
  const timeline = insertSequencedTimelineEntry(state, entry, sequenced);
  return trimTimeline({
    ...state,
    activeSessionId,
    highWaterSeq: Math.max(state.highWaterSeq, entry.seq),
    timeline,
    sequenced,
    // Fold ONLY on the genuinely-new entry. foldAggregate returns the same
    // reference when the envelope contributes nothing → referential stability.
    aggregates: foldAggregate(state.aggregates, entry.env),
  });
}

export function applyQueueSnapshot(
  state: ChatSessionReducerState,
  snapshot: SendQueueSnapshotEnvelope,
): ChatSessionReducerState {
  if (
    state.activeSessionId &&
    snapshot.sessionId !== state.activeSessionId
  ) {
    return state;
  }
  return appendUnsequenced(
    {
      ...state,
      activeSessionId: state.activeSessionId ?? snapshot.sessionId,
    },
    snapshot,
    (candidate) => {
      if (candidate.type !== 'send-queue-snapshot') return false;
      return (candidate as Partial<SendQueueSnapshotEnvelope>).sessionId === snapshot.sessionId;
    },
  );
}

export function applyRuntimeSnapshot(
  state: ChatSessionReducerState,
  runtime: RuntimeStateEnvelope,
): ChatSessionReducerState {
  if (
    state.activeSessionId &&
    runtime.sessionId &&
    runtime.sessionId !== state.activeSessionId
  ) {
    return state;
  }
  return appendUnsequenced(
    {
      ...state,
      activeSessionId: state.activeSessionId ?? runtime.sessionId,
    },
    runtime,
    (candidate) => {
      if (candidate.type !== 'runtime-state') return false;
      const candidateSessionId = (candidate as Partial<RuntimeStateEnvelope>).sessionId;
      return candidateSessionId === runtime.sessionId;
    },
  );
}

function applySessionTransition(
  state: ChatSessionReducerState,
  projectId: string,
  transition: SessionTransitionResponse,
): ChatSessionReducerState {
  const sessionChanged: SessionChangedEnvelope = {
    projectId,
    type: 'session-changed',
    transition: transition.transition,
    session: transition.session,
  };
  const replay: SessionReplayEnvelope = {
    projectId,
    type: 'session-replay',
    sessionId: transition.session.id,
    highWaterSeq: transition.highWaterSeq,
    events: transition.replay,
  };
  return applySnapshot(applySessionChanged(state, sessionChanged), replay);
}

function applySessionChanged(
  state: ChatSessionReducerState,
  env: SessionChangedEnvelope,
): ChatSessionReducerState {
  const sessionId = sessionIdFromSessionEnvelope(env);
  if (env.transition === 'new-session') {
    const preserved = preserveProjectEventsForSessionReset(state);
    return appendUnsequenced(
      {
        ...state,
        activeSessionId: sessionId,
        highWaterSeq: 0,
        sequenced: [],
        timeline: preserved.timeline,
        unsequenced: preserved.unsequenced,
        terminalRaw: [],
        aggregates: EMPTY_AGGREGATES,
      },
      env,
      (candidate) => candidate.type === 'session-changed',
    );
  }
  return appendUnsequenced(
    {
      ...state,
      activeSessionId: sessionId ?? state.activeSessionId,
    },
    env,
    (candidate) => candidate.type === 'session-changed',
  );
}

function appendUnsequenced(
  state: ChatSessionReducerState,
  env: WsEnvelope,
  replace?: (candidate: WsEnvelope) => boolean,
): ChatSessionReducerState {
  const filteredUnsequenced = replace
    ? state.unsequenced.filter((entry) => !replace(entry.env))
    : state.unsequenced;
  const removedKeys = new Set(
    replace
      ? state.unsequenced
          .filter((entry) => replace(entry.env))
          .map((entry) => entry.key)
      : [],
  );
  const key = `env-${state.nextOrdinal}`;
  return trimTimeline({
    ...state,
    nextOrdinal: state.nextOrdinal + 1,
    timeline: [
      ...state.timeline.filter((entry) => entry.kind !== 'env' || !removedKeys.has(entry.key)),
      { kind: 'env', key },
    ],
    unsequenced: [...filteredUnsequenced, { key, env }],
  });
}

function appendTerminalRaw(
  state: ChatSessionReducerState,
  env: WsEnvelope,
): ChatSessionReducerState {
  const scopedSessionId = sessionIdFromEnvelope(env);
  if (
    state.activeSessionId &&
    scopedSessionId &&
    scopedSessionId !== state.activeSessionId
  ) {
    return state;
  }
  const sessionId = scopedSessionId ?? state.activeSessionId;
  const key = `raw-${state.nextOrdinal}`;
  const terminalRaw = [
    ...state.terminalRaw,
    {
      key,
      env: sessionId ? { ...env, sessionId } : env,
    },
  ].slice(-MAX_TERMINAL_RAW_ENTRIES);
  return {
    ...state,
    nextOrdinal: state.nextOrdinal + 1,
    activeSessionId: state.activeSessionId ?? sessionId ?? null,
    terminalRaw,
  };
}

function preserveAcrossSnapshot(
  state: ChatSessionReducerState,
  sessionId: string,
): {
  timeline: TimelineEntry[];
  unsequenced: EnvEntry[];
} {
  const keepKeys = new Set<string>();
  const unsequenced = state.unsequenced.filter((entry) => {
    const keep = shouldPreserveUnsequencedAcrossSnapshot(entry.env, sessionId);
    if (keep) keepKeys.add(entry.key);
    return keep;
  });
  return {
    timeline: state.timeline.filter((entry) => entry.kind === 'env' && keepKeys.has(entry.key)),
    unsequenced,
  };
}

function preserveProjectEventsForSessionReset(state: ChatSessionReducerState): {
  timeline: TimelineEntry[];
  unsequenced: EnvEntry[];
} {
  const keepKeys = new Set<string>();
  const unsequenced = state.unsequenced.filter((entry) => {
    const keep = shouldPreserveProjectEventAcrossSessionReset(entry.env);
    if (keep) keepKeys.add(entry.key);
    return keep;
  });
  return {
    timeline: state.timeline.filter((entry) => entry.kind === 'env' && keepKeys.has(entry.key)),
    unsequenced,
  };
}

function preserveTerminalRaw(
  state: ChatSessionReducerState,
  sessionId: string,
): EnvEntry[] {
  return state.terminalRaw.filter((entry) => sessionIdFromEnvelope(entry.env) === sessionId);
}

function shouldPreserveUnsequencedAcrossSnapshot(
  env: WsEnvelope,
  sessionId: string,
): boolean {
  if (env.type === 'runtime-state') {
    const runtimeSessionId = (env as Partial<RuntimeStateEnvelope>).sessionId;
    return !runtimeSessionId || runtimeSessionId === sessionId;
  }
  if (env.type === 'state') return true;
  return shouldPreserveProjectEventAcrossSessionReset(env);
}

function shouldPreserveProjectEventAcrossSessionReset(env: WsEnvelope): boolean {
  if (
    env.type === 'event' ||
    env.type === 'jsonl' ||
    env.type === 'raw' ||
    env.type === 'state' ||
    env.type === 'turn-end' ||
    env.type === 'exit' ||
    env.type === 'send-ack' ||
    env.type === 'send-queue-snapshot' ||
    env.type === 'runtime-state'
  ) {
    return false;
  }
  return true;
}

function insertSequencedTimelineEntry(
  state: ChatSessionReducerState,
  entry: SequencedEntry,
  sequenced: SequencedEntry[],
): TimelineEntry[] {
  const existingTimeline = state.timeline.filter(
    (candidate) => candidate.kind !== 'seq' || candidate.key !== entry.key,
  );
  const byKey = new Map(sequenced.map((candidate) => [candidate.key, candidate] as const));
  const insertAt = existingTimeline.findIndex((candidate) => {
    if (candidate.kind !== 'seq') return false;
    const existing = byKey.get(candidate.key);
    return Boolean(
      existing &&
        existing.sessionId === entry.sessionId &&
        existing.seq > entry.seq,
    );
  });
  const timelineEntry: TimelineEntry = { kind: 'seq', key: entry.key };
  if (insertAt === -1) return [...existingTimeline, timelineEntry];
  return [
    ...existingTimeline.slice(0, insertAt),
    timelineEntry,
    ...existingTimeline.slice(insertAt),
  ];
}

function sequencedEntryFromEnvelope(
  env: WsEnvelope,
  fallbackSessionId?: string,
): SequencedEntry | null {
  const seq = sequenceFromEnvelope(env);
  const sessionId = sessionIdFromEnvelope(env) ?? fallbackSessionId;
  if (!sessionId || seq === null) return null;
  const id = typeof env.id === 'string' ? env.id : `${sessionId}:${seq}`;
  return {
    key: `${sessionId}:${seq}`,
    sessionId,
    seq,
    env: {
      ...env,
      sessionId,
      seq,
      id,
    },
  };
}

function sequenceFromEnvelope(env: WsEnvelope): number | null {
  const seq = env.seq;
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0
    ? seq
    : null;
}

function sessionIdFromEnvelope(env: WsEnvelope): string | null {
  const sessionId = env.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

function sessionIdFromSessionEnvelope(env: WsEnvelope): string | null {
  const session = env.session;
  if (!session || typeof session !== 'object') return null;
  const id = (session as { id?: unknown }).id;
  return typeof id === 'string' && id ? id : null;
}

function isActiveChatEnvelope(env: WsEnvelope): boolean {
  return env.type === 'jsonl' || env.type === 'event';
}

function trimTimeline(state: ChatSessionReducerState): ChatSessionReducerState {
  if (state.timeline.length <= MAX_TIMELINE_ENTRIES) return state;
  const dropCount = state.timeline.length - MAX_TIMELINE_ENTRIES;
  const dropped = state.timeline.slice(0, dropCount);
  const droppedSeqKeys = new Set(
    dropped.filter((entry) => entry.kind === 'seq').map((entry) => entry.key),
  );
  const droppedEnvKeys = new Set(
    dropped.filter((entry) => entry.kind === 'env').map((entry) => entry.key),
  );
  // `aggregates` is carried forward UNTOUCHED (via ...state). Totals are
  // session-cumulative and decoupled from timeline retention; recomputing from
  // the trimmed (windowed) set would corrupt them.
  return {
    ...state,
    timeline: state.timeline.slice(dropCount),
    sequenced: state.sequenced.filter((entry) => !droppedSeqKeys.has(entry.key)),
    unsequenced: state.unsequenced.filter((entry) => !droppedEnvKeys.has(entry.key)),
  };
}

function compareReplayItems(a: unknown, b: unknown): number {
  const aSeq = a && typeof a === 'object' && typeof (a as Partial<SessionReplayItem>).seq === 'number'
    ? (a as Partial<SessionReplayItem>).seq!
    : null;
  const bSeq = b && typeof b === 'object' && typeof (b as Partial<SessionReplayItem>).seq === 'number'
    ? (b as Partial<SessionReplayItem>).seq!
    : null;
  if (aSeq !== null && bSeq !== null) return aSeq - bSeq;
  if (aSeq !== null) return -1;
  if (bSeq !== null) return 1;
  return 0;
}
