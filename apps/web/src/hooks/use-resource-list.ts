// Section 18.10 — generic resource-list hook for Activity Panel regions.
//
// Slice 018 — this hook NO LONGER scans the chat-timeline `events` array with a
// positional index cursor (the root cause of live-UI staleness: the timeline
// re-derives on session-replay/snapshot during active sessions, so an integer
// cursor silently skips frames). Records are now DERIVED from two sources:
//   1. The HTTP list = the seed (mount / project switch / WS (re)connect).
//   2. The identity-keyed live store (`useLiveEvents`) = the live overlay,
//      applied on top by id with per-entity `version` dedup.
// The derive is stateless and idempotent — it rebuilds the full record set each
// time the seed or the store changes, so there is no cursor to fall out of sync.
//
// `dropOnTerminal` resources (e.g. running-agents, whose list endpoint excludes
// terminal rows) drop a record the moment a terminal frame for it lands; the
// seed already omits them. Relay frames carry the FULL DTO, so no per-frame
// refetch is needed — the store snapshot is authoritative.

import { useEffect, useMemo, useState } from 'react';

import type { LiveEvent, LiveEventEntity } from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useWsEpoch } from '@/store/ws-epoch';
import { useLiveEvents } from '@/store/live-store';

export interface ResourceListConfig<T> {
  /** Canonical `{type:'live-event', event}` entity this resource consumes. The
   *  relay-delivered live store is filtered by it; `extractFromLiveEvent` turns
   *  a matching frame into a record. */
  liveEventEntity?: LiveEventEntity;
  /** Extract the record from a matching canonical live-event. Return null to
   *  skip (wrong project / unusable payload). Required when `liveEventEntity`
   *  is set. */
  extractFromLiveEvent?: (event: LiveEvent, projectId: string) => T | null;
  /** Stable id for the record — used as the map key. */
  getId: (record: T) => string;
  /** Terminal-status predicate. With `dropOnTerminal`, a terminal frame removes
   *  the record from the rendered set. */
  isTerminal: (record: T) => boolean;
  /** When true, terminal records are dropped from the rendered set (the seed
   *  endpoint also excludes them). Use for resources whose list endpoint excludes
   *  terminal rows. */
  dropOnTerminal: boolean;
  /** Optional monotonic version extractor. When supplied, a live frame whose
   *  version is strictly older than the record already held (seed or earlier
   *  frame) is discarded — guards against out-of-order delivery. */
  getVersion?: (record: T) => number;
  /** Fetch the project's current full list. Called on mount, on project
   *  switch, and on WS (re)connect (epoch bump). */
  list: (projectId: string) => Promise<T[]>;
}

/** Resource list = HTTP seed + identity-keyed live-store overlay, keyed by id. */
export function useResourceList<T>(
  project: Project | null,
  // Retained for signature stability while the chat-timeline still carries
  // live-event frames (reconcile-first). No longer read — records come from the
  // live store, not this array.
  _events: WsEnvelope[],
  config: ResourceListConfig<T>,
): { records: T[]; refetch: () => void } {
  const [seed, setSeed] = useState<Map<string, T>>(() => new Map());
  // Bumped whenever the focused project socket (re)connects. Keying the fetch
  // effect off this reconciles the seed to server truth on every reconnect.
  const wsEpoch = useWsEpoch((s) => (project ? (s.byProject[project.id] ?? 0) : 0));

  // Initial fetch + project switch + WS (re)connect.
  useEffect(() => {
    if (!project) {
      setSeed(new Map());
      return;
    }
    let cancelled = false;
    void config.list(project.id).then((list) => {
      if (cancelled) return;
      setSeed(new Map(list.map((r) => [config.getId(r), r])));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, wsEpoch]);

  const liveEvents = useLiveEvents(config.liveEventEntity ?? null, project?.id ?? null);

  // Derive the rendered set: seed, then the live overlay applied by id. Stateless
  // and idempotent — fully rebuilt whenever the seed or the store changes.
  const records = useMemo(() => {
    if (!project) return [] as T[];
    const merged = new Map(seed);
    for (const ev of liveEvents) {
      const record = config.extractFromLiveEvent?.(ev, project.id);
      if (!record) continue;
      const id = config.getId(record);
      if (config.isTerminal(record) && config.dropOnTerminal) {
        merged.delete(id);
        continue;
      }
      const existing = merged.get(id);
      if (
        existing &&
        config.getVersion &&
        config.getVersion(record) < config.getVersion(existing)
      ) {
        continue;
      }
      merged.set(id, record);
    }
    return Array.from(merged.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, liveEvents, project?.id]);

  return {
    records,
    refetch: () => {
      if (!project) return;
      void config.list(project.id).then((list) => {
        setSeed(new Map(list.map((r) => [config.getId(r), r])));
      });
    },
  };
}
