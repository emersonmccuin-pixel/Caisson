// Section 18.10 — generic resource-list hook for Activity Panel regions.
//
// Topics 4 + 5 architecture-review locks (2026-05-21):
//   - One generic `useResourceList<T>` replaces the three near-duplicates
//     (`useProjectWorkflowRuns`, `useProjectAgentRuns`, future region hooks).
//   - WS envelopes carry full snapshots. Local Map is a CACHE keyed by id;
//     refetch on terminal-status transitions or whenever a snapshot lands
//     for an unknown id (covers WS-batched / out-of-order arrivals).
//   - Hooks never reduce over the event stream alone. B5's "only inspect
//     last event in buffer" anti-pattern is structurally impossible here:
//     the per-envelope branch scans EVERY new envelope since the last
//     processed index, and refetch fires on any terminal observation or
//     unknown-id snapshot. Bury the terminal envelope under fifty
//     orchestrator-reply envelopes in a single React batch and we still
//     catch it.

import { useEffect, useMemo, useRef, useState } from 'react';

import { isLiveEventFrame, type LiveEvent, type LiveEventEntity } from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useWsEpoch } from '@/store/ws-epoch';

export interface ResourceListConfig<T> {
  /** Legacy WS envelope kind that carries snapshots for this resource. Optional
   *  once a subsystem has migrated to the canonical `live-event` frame path
   *  (set `liveEventEntity` + `extractFromLiveEvent` instead). When omitted, the
   *  legacy-envelope branch is skipped entirely. */
  envelopeKind?: string;
  /** Slice 015b — canonical `{type:'live-event', event}` frame consumption. When
   *  set, the scan ALSO matches generic live-event frames whose
   *  `event.entity === liveEventEntity` and applies `extractFromLiveEvent`. This
   *  is the relay-delivered path; the per-entity `event.version`/record `rev`
   *  drives the same out-of-order dedup. */
  liveEventEntity?: LiveEventEntity;
  /** Extract the record from a matching canonical live-event. Return null to
   *  skip (wrong project / unusable payload). Required when `liveEventEntity`
   *  is set. */
  extractFromLiveEvent?: (event: LiveEvent, projectId: string) => T | null;
  /** Extract the record from a matching legacy envelope. Return null to skip
   *  (e.g., envelope is for a different project, missing snapshot field,
   *  or otherwise doesn't apply). The hook passes the active project id
   *  so the extractor can do its own project-match check against the
   *  envelope's `projectId` (the per-project WS is already scoped, but
   *  the defensive guard keeps the hook safe if that ever changes). Only
   *  consulted when `envelopeKind` is set. */
  extractSnapshot?: (env: WsEnvelope, projectId: string) => T | null;
  /** Stable id for the record — used as the map key. */
  getId: (record: T) => string;
  /** Terminal-status predicate. Terminal transitions trigger a wholesale
   *  refetch — the server's list endpoint may filter terminal rows out
   *  (agent-run case), or carry fields the envelope omits (workflow-run's
   *  completedAt). Cache stays honest. */
  isTerminal: (record: T) => boolean;
  /** When true, terminal records are removed from the local map on the
   *  per-envelope branch (and the subsequent refetch confirms). Use for
   *  resources whose list endpoint excludes terminal rows. */
  dropOnTerminal: boolean;
  /** Optional monotonic version extractor. When supplied, an incoming
   *  record whose version ≤ the stored record's version is silently
   *  discarded — guards against out-of-order or duplicate WS delivery. */
  getVersion?: (record: T) => number;
  /** Fetch the project's current full list. Called on mount, on project
   *  switch, and on every terminal-status / unknown-id envelope. */
  list: (projectId: string) => Promise<T[]>;
}

/** Cache-keyed-by-id resource list driven by snapshot WS envelopes. */
export function useResourceList<T>(
  project: Project | null,
  events: WsEnvelope[],
  config: ResourceListConfig<T>,
): { records: T[]; refetch: () => void } {
  const [map, setMap] = useState<Map<string, T>>(() => new Map());
  /** Index into `events` we've already processed. Lets us scan only new
   *  envelopes per render — O(new events), not O(total events). Resets on
   *  project switch and on any apparent buffer reset (length shrank). */
  const lastProcessedIdx = useRef<number>(0);
  // Bumped whenever the focused project socket (re)connects. Keying the fetch
  // effect off this reconciles the list to server truth on every reconnect —
  // the hub has no catch-up, so anything created while the socket was down is
  // otherwise missed until a manual refresh.
  const wsEpoch = useWsEpoch((s) => (project ? (s.byProject[project.id] ?? 0) : 0));

  // Initial fetch + project switch + WS (re)connect.
  useEffect(() => {
    if (!project) {
      setMap(new Map());
      lastProcessedIdx.current = 0;
      return;
    }
    let cancelled = false;
    void config.list(project.id).then((list) => {
      if (cancelled) return;
      setMap(new Map(list.map((r) => [config.getId(r), r])));
    });
    // Fresh list = fresh scan window for new envelopes.
    lastProcessedIdx.current = events.length;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, wsEpoch]);

  // Scan all NEW envelopes (since last processed index) for matching kind.
  // Apply each matching snapshot in order; if any was terminal OR
  // introduced an unknown id, fire a refetch as the source of truth.
  useEffect(() => {
    if (!project || events.length === 0) {
      lastProcessedIdx.current = events.length;
      return;
    }
    // If the buffer shrank (rare — generally only on full reconnect /
    // replay reset), restart the scan from 0 to avoid skipping anything.
    if (events.length < lastProcessedIdx.current) {
      lastProcessedIdx.current = 0;
    }
    const start = lastProcessedIdx.current;
    if (start >= events.length) return;

    let sawTerminal = false;
    let sawUnknown = false;
    const updates: Array<{ id: string; record: T; drop: boolean }> = [];

    for (let i = start; i < events.length; i++) {
      const env = events[i];
      if (!env) continue;
      const record = extractRecord(env, project.id, config);
      if (!record) continue;
      const id = config.getId(record);
      const terminal = config.isTerminal(record);
      if (terminal) sawTerminal = true;
      updates.push({ id, record, drop: terminal && config.dropOnTerminal });
    }
    lastProcessedIdx.current = events.length;

    if (updates.length > 0) {
      setMap((prev) => {
        const next = new Map(prev);
        for (const u of updates) {
          // Version-aware discard: if the incoming record's version is ≤ the
          // stored record's version, it's stale (out-of-order delivery) — skip.
          if (config.getVersion) {
            const stored = prev.get(u.id);
            if (stored && config.getVersion(u.record) <= config.getVersion(stored)) continue;
          }
          if (!next.has(u.id) && !u.drop) sawUnknown = true;
          if (u.drop) next.delete(u.id);
          else next.set(u.id, u.record);
        }
        return next;
      });
    }

    if (sawTerminal || sawUnknown) {
      void config.list(project.id).then((list) => {
        setMap(new Map(list.map((r) => [config.getId(r), r])));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, project?.id]);

  const records = useMemo(() => Array.from(map.values()), [map]);

  return {
    records,
    refetch: () => {
      if (!project) return;
      void config.list(project.id).then((list) => {
        setMap(new Map(list.map((r) => [config.getId(r), r])));
      });
    },
  };
}

/** Pull a record out of one WS frame: the canonical relay `live-event` frame
 *  (preferred, matched by `event.entity`) or the legacy typed envelope. Returns
 *  null when the frame doesn't apply to this resource/project. */
function extractRecord<T>(
  env: WsEnvelope,
  projectId: string,
  config: ResourceListConfig<T>,
): T | null {
  if (config.liveEventEntity && config.extractFromLiveEvent && isLiveEventFrame(env)) {
    if (env.event.entity !== config.liveEventEntity) return null;
    return config.extractFromLiveEvent(env.event, projectId);
  }
  if (config.envelopeKind && config.extractSnapshot && env.type === config.envelopeKind) {
    return config.extractSnapshot(env, projectId);
  }
  return null;
}
