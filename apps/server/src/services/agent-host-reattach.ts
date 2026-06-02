import { existsSync } from 'node:fs';

import {
  type AgentRunRow,
  type ULID,
} from '@pc/domain';
import type { AgentRunChangedReason } from '@pc/contracts';
import {
  getAgentRunRow as defaultGetAgentRunRow,
  getProjectById as defaultGetProjectById,
  hasOpenPendingAskForRun as defaultHasOpenPendingAskForRun,
  listNonTerminalAgentRuns as defaultListNonTerminalAgentRuns,
  markAgentRunTerminal as defaultMarkAgentRunTerminal,
  updateAgentRunStatus as defaultUpdateAgentRunStatus,
} from '@pc/db';
import {
  AgentRunJsonlTailer,
  jsonlPathFor,
  type AgentHostEvent,
  type AgentHostRunSnapshot,
} from '@pc/runtime';

import {
  getActiveRunRegistry,
  HostBackedActiveRunHandle,
  type ActiveRunRegistry,
  type AgentHostCommandSender,
} from './agent-active-runs.ts';
import {
  HOST_LOST_REASON,
  reconcileAgentRunsOnBoot,
  type AgentRunBootReconcileResult,
} from './agent-run-boot-reconcile.ts';
import {
  applyAgentRunTerminalEffects,
  replayMissingTerminalEnvelopes,
  type AgentRunTerminalEffectsDeps,
} from './agent-run-terminal-effects.ts';
import { announceAgentRunChange as defaultAnnounceAgentRunChange } from './agent-run-writer.ts';
import type { MailboxEnqueuePort } from './agent-delivery.ts';
import {
  runVerificationOnTerminal,
  type VerificationDeps,
} from './agent-verification.ts';

type NonTerminalAgentState = Extract<
  AgentHostRunSnapshot['state'],
  'queued' | 'spawning' | 'running' | 'paused'
>;

export interface AgentHostReattachClient extends AgentHostCommandSender {
  listRuns(): readonly AgentHostRunSnapshot[];
  onEvent?(listener: (event: AgentHostEvent) => void): (() => void) | void;
}

export interface AgentHostReattachDeps {
  hostClient: AgentHostReattachClient;
  activeRunRegistry?: ActiveRunRegistry;
  now?: () => number;
  listNonTerminalRuns?: () => AgentRunRow[];
  getAgentRun?: (id: ULID) => AgentRunRow | null;
  hasOpenPendingAskForRun?: (runId: ULID) => boolean;
  markTerminal?: typeof defaultMarkAgentRunTerminal;
  updateStatus?: typeof defaultUpdateAgentRunStatus;
  resolveJsonlPath?: (row: AgentRunRow) => string | null;
  jsonlExists?: (path: string) => boolean;
  broadcast?: (projectId: ULID, msg: unknown) => void;
  /** Slice 015b — durable announce for host-driven status flips. Writes the
   *  `live_outbox` row (relay delivers the canonical frame); replaces the old
   *  direct `agent-run-changed` hand-broadcast. Injectable so the in-memory
   *  reconcile tests (no real DB) can stub it. Defaults to the real gateway. */
  announce?: typeof defaultAnnounceAgentRunChange;
  /** Mailbox enqueue port — forwarded to the terminal-effects envelope so host
   *  completions are delivered. Boot-time recovery paths omit it (the port is
   *  not yet constructed at boot — see slice 009), so they skip the envelope. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  verifyOnTerminal?: typeof runVerificationOnTerminal;
  verificationDeps?: VerificationDeps;
  terminalCleanup?: () => void;
  /** Door-unification — forwarded to terminal-effects so a host-driven terminal
   *  resolves the dispatch's `done` promise (the workflow engine awaits it).
   *  Boot/reconcile paths omit it (no awaiting caller). */
  onSettled?: AgentRunTerminalEffectsDeps['onSettled'];
  onTerminalError?: (error: Error) => void;
  onHostCommandError?: (error: Error) => void;
  /** T1.4 (D1) — this tick the connection authoritatively could not reach a
   *  live host (`hostConnection.isConnected() === false` after a `refreshRuns`
   *  that COMPLETED). Required for the host-lost finalize; absent ⇒ no finalize
   *  (conservative). The caller MUST omit/skip it when `refreshRuns` THREW. */
  hostAuthoritativelyAbsent?: boolean;
  /** T1.4 — caller-owned consecutive-tick counter (run id → ticks missing from
   *  the host's `list-runs`). Persists across sweeps; reset when a row reappears
   *  or goes terminal. Absent ⇒ no finalize (counter is the false-positive guard). */
  missingFromHostTicks?: Map<string, number>;
  /** T1.4 (D1) — finalize host-lost only after this many CONSECUTIVE missing
   *  ticks (default 2 ≈ 30s at the 15s cadence; env `PC_HOST_LOST_TICKS`). */
  hostLostAfterTicks?: number;
  /** T1.4 — injectable terminal-effects seam (tests spy on it). Defaults to the
   *  real full-effects helper so the `failed` live-event + orchestrator notify
   *  fire through the gateway/outbox door (never a direct broadcast). */
  applyTerminalEffects?: typeof applyAgentRunTerminalEffects;
  /** S3 — replay the orchestrator envelope for any recently-terminal run whose
   *  notify tail threw before enqueuing it. Test seam; defaults to the real
   *  idempotent replay. */
  replayEnvelopes?: typeof replayMissingTerminalEnvelopes;
}

export interface AgentHostReattachResult {
  reconcile: AgentRunBootReconcileResult;
  registered: number;
  backfilledEvents: number;
  terminalReplayed: number;
}

export function reattachAgentRunsOnBoot(
  deps: AgentHostReattachDeps,
): AgentHostReattachResult {
  const rows = (deps.listNonTerminalRuns ?? defaultListNonTerminalAgentRuns)();
  const hostRuns = deps.hostClient.listRuns();
  const hostByRunId = new Map(hostRuns.map((run) => [run.runId, run]));

  const reconcile = reconcileAgentRunsOnBoot({
    now: deps.now,
    hostClient: { listRuns: () => hostRuns },
    listNonTerminalRuns: () => rows,
    hasOpenPendingAskForRun: deps.hasOpenPendingAskForRun,
    markTerminal: deps.markTerminal,
    updateStatus: deps.updateStatus,
    resolveJsonlPath: deps.resolveJsonlPath,
    jsonlExists: deps.jsonlExists,
  });

  const registry = deps.activeRunRegistry ?? getActiveRunRegistry();
  const handles = new Map<string, HostBackedActiveRunHandle>();
  let registered = 0;
  let backfilledEvents = 0;
  let terminalReplayed = 0;

  for (const row of rows) {
    const hostRun = hostByRunId.get(row.id);
    if (!hostRun || !hostSnapshotMatchesRow(row, hostRun)) continue;

    if (isTerminalState(hostRun.state)) {
      terminalReplayed += applyHostTerminalSnapshot(hostRun, deps);
      continue;
    }
    if (!isNonTerminalState(hostRun.state)) continue;

    const handle = new HostBackedActiveRunHandle(hostRun, deps.hostClient, {
      now: deps.now,
      onCommandError: deps.onHostCommandError
        ? (error) => deps.onHostCommandError?.(error)
        : undefined,
    });
    registry.register({
      run: handle,
      projectId: row.projectId,
      dispatcherSessionId: row.dispatcherSessionId,
      ccSessionId: row.ccSessionId,
      podName: row.podName,
      parentWorkItemId: row.parentWorkItemId,
      podRevisionAtDispatch: row.podRevisionAtDispatch,
      now: deps.now?.(),
    });
    handles.set(row.id, handle);
    registered += 1;
    backfilledEvents += backfillAgentRunJsonl(row, hostRun, deps);
  }

  deps.hostClient.onEvent?.((event) => {
    applyAgentHostEvent(event, {
      ...deps,
      activeRunRegistry: registry,
    });
    if (event.type === 'run-state' || event.type === 'run-terminal') {
      const handle = handles.get(event.run.runId);
      handle?.applySnapshot(event.run);
    }
  });

  return {
    reconcile,
    registered,
    backfilledEvents,
    terminalReplayed,
  };
}

export interface ReconcileSweepResult {
  checked: number;
  terminalApplied: number;
  statusUpdated: number;
  /** T1.4 — non-terminal rows finalized `host-lost` this sweep (host gone). */
  hostLost: number;
}

/**
 * Continuous post-boot reconcile sweep — Step 1 of the state-propagation
 * overhaul (`docs/state-propagation-decision.md`). Idempotent; safe to call on
 * an interval. Re-derives each non-terminal DB run from the host's live
 * snapshots, so a terminal transition the live event stream dropped still lands
 * — full effects via `applyHostTerminalSnapshot` (DB flip + orchestrator
 * `agent-completed`/`agent-failed` + rail broadcast) — within one sweep instead
 * of waiting for the next server restart. THE fix for phantom "still running"
 * runs.
 *
 * Caller MUST refresh the host snapshot first (a `list-runs` command) so we
 * reconcile against a fresh pull, not the client's stale cache. This does NOT
 * register live handles or subscribe to events — boot reattach owns that; the
 * sweep only catches transitions the stream missed.
 *
 * T1.4 — host-missing rows are no longer left forever-running. When the caller
 * passes the authoritative-absence signal (`hostAuthoritativelyAbsent`, set only
 * after a `refreshRuns()` that COMPLETED) plus a consecutive-tick counter, a
 * host-mode row absent from `list-runs` for `>= hostLostAfterTicks` ticks is
 * finalized terminal `host-lost` through the full-effects helper (DB flip +
 * orchestrator notify + `failed` live-event via the outbox door). Below the
 * threshold — or when the caller withholds the absence signal (e.g. a
 * `refreshRuns` blip) — the row is left untouched (the original conservatism),
 * so a just-dispatched run or a mid-respawn host never false-kills a live run.
 */
export function reconcileAgentRunsAgainstHost(
  deps: AgentHostReattachDeps,
): ReconcileSweepResult {
  const rows = (deps.listNonTerminalRuns ?? defaultListNonTerminalAgentRuns)();
  const hostRuns = deps.hostClient.listRuns();
  const hostByRunId = new Map(hostRuns.map((run) => [run.runId, run]));
  const missingTicks = deps.missingFromHostTicks;
  const lostAfter = deps.hostLostAfterTicks ?? 2;

  let terminalApplied = 0;
  let statusUpdated = 0;
  let hostLost = 0;

  for (const row of rows) {
    const hostRun = hostByRunId.get(row.id);
    // T1.4 — row absent from (or mismatched against) the host's live snapshots.
    if (!hostRun || !hostSnapshotMatchesRow(row, hostRun)) {
      hostLost += handleHostMissingRow(row, {
        deps,
        missingTicks,
        lostAfter,
      });
      continue;
    }

    // Row IS owned by the host again — clear any standing missing-tick counter.
    missingTicks?.delete(row.id);

    if (isTerminalState(hostRun.state)) {
      terminalApplied += applyHostTerminalSnapshot(hostRun, deps);
      continue;
    }

    if (shouldUpdateFromHost(row, hostRun)) {
      (deps.updateStatus ?? defaultUpdateAgentRunStatus)({
        id: row.id,
        status: hostRun.state,
        ...(hostRun.spawnedAt !== null ? { spawnedAt: hostRun.spawnedAt } : {}),
        ...(hostRun.readyAt !== null ? { readyAt: hostRun.readyAt } : {}),
      });
      // Slice 015b — durable outbox row (relay delivers) instead of a direct
      // `agent-run-changed` hand-broadcast. Re-reads the post-write row for rev.
      (deps.announce ?? defaultAnnounceAgentRunChange)(
        { runId: row.id, reason: hostStateToReason(hostRun.state) },
        deps.broadcast ? (event) => deps.broadcast?.(row.projectId, event) : undefined,
      );
      // OBJ-2A C-coherence — re-seed a registered host handle so display /
      // getState() readers + the OBJ-2 markPaused path see a fresh snapshot.
      // Convenience only; no gate reads the handle (those read the DB row).
      const h = deps.activeRunRegistry?.get(row.id)?.run;
      if (h instanceof HostBackedActiveRunHandle) h.applySnapshot(hostRun);
      statusUpdated += 1;
    }
  }

  // S3 — re-emit any terminal run's orchestrator envelope that the fire-and-
  // forget notify tail dropped. Idempotent on `agent:${runId}:${kind}`; runs
  // every reconcile tick. Detached: must not block (or fail) the reconcile.
  if (deps.mailboxEnqueue) {
    void (deps.replayEnvelopes ?? replayMissingTerminalEnvelopes)({
      mailboxEnqueue: deps.mailboxEnqueue,
      now: deps.now,
      onError: deps.onTerminalError,
    }).catch(() => {});
  }

  return { checked: rows.length, terminalApplied, statusUpdated, hostLost };
}

/** T1.4 — decide a single host-missing row. Increments the consecutive-miss
 *  counter and finalizes `host-lost` once ALL of the false-positive guards pass:
 *  (1) the caller asserted authoritative host absence this tick (we are CONNECTED
 *  to a host whose fresh list-runs we just pulled, and this run is absent from
 *  it), (2) a counter is wired, (3) the row is `running` — a confirmed-started
 *  run; `queued`/`spawning` may legitimately not be listed yet (slow spawn) and a
 *  `paused` run is host-less while it waits on an ask, so none of those are
 *  host-lost-eligible, (4) the row has been missing for `>= lostAfter` consecutive
 *  ticks. Else leaves the row untouched (counter standing for an eligible row,
 *  dropped for an ineligible one). Returns 1 if finalized, else 0. */
function handleHostMissingRow(
  row: AgentRunRow,
  ctx: {
    deps: AgentHostReattachDeps;
    missingTicks: Map<string, number> | undefined;
    lostAfter: number;
  },
): number {
  const { deps, missingTicks, lostAfter } = ctx;

  // Conservative gates: without the authoritative-absence signal or a counter,
  // we cannot trust that the run is genuinely gone — leave the row alone.
  if (!deps.hostAuthoritativelyAbsent || !missingTicks) return 0;

  // Only a confirmed-started `running` run is host-lost-eligible. A queued/
  // spawning run may not be in the host's list yet (slow spawn), and a paused
  // run is legitimately host-less while it waits on an ask. None are "lost" —
  // drop any standing counter so they never accrue toward finalize.
  if (row.status !== 'running') {
    missingTicks.delete(row.id);
    return 0;
  }

  const ticks = (missingTicks.get(row.id) ?? 0) + 1;
  missingTicks.set(row.id, ticks);
  if (ticks < lostAfter) return 0;

  const applied = (deps.applyTerminalEffects ?? applyAgentRunTerminalEffects)(
    {
      runId: row.id,
      ccSessionId: row.ccSessionId,
      podName: row.podName,
      projectId: row.projectId,
      dispatcherSessionId: row.dispatcherSessionId,
      parentWorkItemId: row.parentWorkItemId,
      worktreeDir: '',
      status: 'failed',
      result: null,
      failureCause: 'host-lost',
      failureReason: HOST_LOST_REASON,
      completedAt: deps.now?.() ?? Date.now(),
      startedAt: row.queuedAt,
      workItemId: row.parentWorkItemId,
      cleanup: deps.terminalCleanup,
    },
    {
      activeRunRegistry: deps.activeRunRegistry,
      mailboxEnqueue: deps.mailboxEnqueue,
      broadcast: deps.broadcast,
      getAgentRun: deps.getAgentRun,
      markTerminal: deps.markTerminal,
      verifyOnTerminal: deps.verifyOnTerminal,
      verificationDeps: deps.verificationDeps,
      now: deps.now,
      onError: deps.onTerminalError,
    },
  ).applied;

  // Finalized (or already terminal) — drop the counter either way.
  missingTicks.delete(row.id);
  return applied;
}

export interface ApplyAgentHostEventResult {
  statusUpdated: number;
  terminalApplied: number;
  jsonlBroadcast: number;
}

export function applyAgentHostEvent(
  event: AgentHostEvent,
  deps: Omit<AgentHostReattachDeps, 'hostClient'>,
): ApplyAgentHostEventResult {
  switch (event.type) {
    case 'run-state': {
      const row = (deps.getAgentRun ?? defaultGetAgentRunRow)(event.run.runId);
      if (!row || isDbTerminal(row.status) || isTerminalState(event.run.state)) {
        return emptyResult();
      }
      if (shouldUpdateFromHost(row, event.run)) {
        (deps.updateStatus ?? defaultUpdateAgentRunStatus)({
          id: row.id,
          status: event.run.state,
          ...(event.run.spawnedAt !== null ? { spawnedAt: event.run.spawnedAt } : {}),
          ...(event.run.readyAt !== null ? { readyAt: event.run.readyAt } : {}),
        });
        // Slice 015b — durable outbox row (relay delivers) instead of a direct
        // `agent-run-changed` hand-broadcast. Re-reads the post-write row.
        (deps.announce ?? defaultAnnounceAgentRunChange)(
          { runId: row.id, reason: hostStateToReason(event.run.state) },
          deps.broadcast ? (envt) => deps.broadcast?.(row.projectId, envt) : undefined,
        );
        // OBJ-2A C-coherence — re-seed a registered host handle (convenience).
        const h = deps.activeRunRegistry?.get(row.id)?.run;
        if (h instanceof HostBackedActiveRunHandle) h.applySnapshot(event.run);
        return { statusUpdated: 1, terminalApplied: 0, jsonlBroadcast: 0 };
      }
      return emptyResult();
    }
    case 'run-jsonl': {
      const row = (deps.getAgentRun ?? defaultGetAgentRunRow)(event.runId);
      if (!row) return emptyResult();
      deps.broadcast?.(row.projectId, {
        type: 'agent-jsonl-event',
        runId: row.id,
        event: event.event,
      });
      return { statusUpdated: 0, terminalApplied: 0, jsonlBroadcast: 1 };
    }
    case 'run-terminal': {
      const applied = applyHostTerminalSnapshot(event.run, deps);
      return { statusUpdated: 0, terminalApplied: applied, jsonlBroadcast: 0 };
    }
    default:
      return emptyResult();
  }
}

export function applyHostTerminalSnapshot(
  snapshot: AgentHostRunSnapshot,
  deps: Omit<AgentHostReattachDeps, 'hostClient'>,
): number {
  if (!isTerminalState(snapshot.state)) return 0;

  const row = (deps.getAgentRun ?? defaultGetAgentRunRow)(snapshot.runId);
  if (!row || isDbTerminal(row.status)) return 0;

  const terminal = snapshot.terminalResult;
  const status = terminal?.status ?? snapshot.state;
  return applyAgentRunTerminalEffects(
    {
      runId: snapshot.runId,
      ccSessionId: snapshot.ccSessionId,
      podName: snapshot.podName,
      projectId: snapshot.projectId,
      dispatcherSessionId: snapshot.dispatcherSessionId,
      parentWorkItemId: row.parentWorkItemId,
      worktreeDir: snapshot.worktreeDir,
      status,
      result: terminal?.result ?? '',
      failureCause: terminal?.failureCause ?? null,
      failureReason: terminal?.failureReason ?? null,
      defaultFailureCause: 'host-protocol-error',
      defaultFailureReason: 'agent host reported terminal run',
      completedAt: snapshot.terminalAt,
      startedAt: row.queuedAt,
      workItemId: row.parentWorkItemId,
      cleanup: deps.terminalCleanup,
    },
    {
      activeRunRegistry: deps.activeRunRegistry,
      mailboxEnqueue: deps.mailboxEnqueue,
      broadcast: deps.broadcast,
      getAgentRun: deps.getAgentRun,
      markTerminal: deps.markTerminal,
      verifyOnTerminal: deps.verifyOnTerminal,
      verificationDeps: deps.verificationDeps,
      now: deps.now,
      onSettled: deps.onSettled,
      onError: deps.onTerminalError,
    },
  ).applied;
}

function backfillAgentRunJsonl(
  row: AgentRunRow,
  snapshot: AgentHostRunSnapshot,
  deps: AgentHostReattachDeps,
): number {
  if (!deps.broadcast) return 0;
  const jsonlPath = snapshot.jsonlPath ?? resolveJsonlPath(row, deps);
  if (!jsonlPath || !(deps.jsonlExists ?? existsSync)(jsonlPath)) return 0;

  let count = 0;
  const tailer = new AgentRunJsonlTailer({
    filePath: jsonlPath,
    pollIntervalMs: 60_000,
  });
  tailer.on('event', (event) => {
    count += 1;
    deps.broadcast?.(row.projectId, {
      type: 'agent-jsonl-event',
      runId: row.id,
      event,
    });
  });
  tailer.drainAvailable();
  tailer.stop();
  tailer.removeAllListeners();
  return count;
}

function resolveJsonlPath(
  row: AgentRunRow,
  deps: Pick<AgentHostReattachDeps, 'resolveJsonlPath'>,
): string | null {
  if (deps.resolveJsonlPath) return deps.resolveJsonlPath(row);
  const project = defaultGetProjectById(row.projectId);
  return project ? jsonlPathFor(project.folderPath, row.ccSessionId) : null;
}

/** Slice 015b — map a host run state to the canonical `agent.run.changed`
 *  reason for the durable announce. Unknown → `reconciled`. */
function hostStateToReason(state: AgentHostRunSnapshot['state']): AgentRunChangedReason {
  switch (state) {
    case 'queued':
    case 'spawning':
    case 'running':
    case 'paused':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return state;
    default:
      return 'reconciled';
  }
}

function hostSnapshotMatchesRow(
  row: AgentRunRow,
  hostRun: AgentHostRunSnapshot,
): boolean {
  return (
    hostRun.runId === row.id &&
    hostRun.projectId === row.projectId &&
    hostRun.dispatcherSessionId === row.dispatcherSessionId &&
    hostRun.ccSessionId === row.ccSessionId &&
    hostRun.podName === row.podName
  );
}

function shouldUpdateFromHost(
  row: AgentRunRow,
  hostRun: AgentHostRunSnapshot,
): boolean {
  return (
    row.status !== hostRun.state ||
    (hostRun.spawnedAt !== null && row.spawnedAt !== hostRun.spawnedAt) ||
    (hostRun.readyAt !== null && row.readyAt !== hostRun.readyAt)
  );
}

function isNonTerminalState(
  state: AgentHostRunSnapshot['state'],
): state is NonTerminalAgentState {
  return state === 'queued' || state === 'spawning' || state === 'running' || state === 'paused';
}

function isTerminalState(
  state: AgentHostRunSnapshot['state'],
): state is 'completed' | 'failed' | 'cancelled' {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function isDbTerminal(status: AgentRunRow['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function emptyResult(): ApplyAgentHostEventResult {
  return { statusUpdated: 0, terminalApplied: 0, jsonlBroadcast: 0 };
}
