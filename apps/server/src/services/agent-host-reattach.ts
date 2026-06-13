import { existsSync } from 'node:fs';

import {
  type AgentRunRow,
  type ULID,
} from '@pc/domain';
import type { AgentRunChangedReason } from '@pc/contracts';
import {
  getAgentRunRow as defaultGetAgentRunRow,
  getProjectById as defaultGetProjectById,
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
  HostBackedActiveRunHandle,
  type ActiveRunRegistry,
  type AgentHostCommandSender,
} from './agent-active-runs.ts';
import {
  applyAgentRunTerminalEffects,
  replayMissingTerminalEnvelopes,
} from './agent-run-terminal-effects.ts';
import { announceAgentRunChange as defaultAnnounceAgentRunChange } from './agent-run-writer.ts';
import type { MailboxEnqueuePort } from './agent-delivery.ts';
import {
  runVerificationOnTerminal,
  type VerificationDeps,
} from './agent-verification.ts';

export const HOST_LOST_REASON = 'agent host no longer owns this non-terminal run';
const HOST_LOST_NEVER_STARTED_REASON =
  'agent host never reported this run after dispatch (lost before it started)';
/** Ghost reaper — how long a DB row must have been terminal before a live host
 *  run with that id is cancelled (don't race in-flight terminal effects). */
const GHOST_CANCEL_GRACE_MS = 30_000;

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
  onTerminalError?: (error: Error) => void;
  onHostCommandError?: (error: Error) => void;
  /** Issue 3 — forwarded to terminal effects so the caller can drain the
   *  mailbox worker immediately after the envelope is enqueued. */
  onMailboxEnqueued?: () => void;
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
  /** Step 2 — a `queued`/`spawning` row missing from a reachable host finalizes
   *  after this many consecutive ticks (default 8 ≈ 2min). Longer than the
   *  running threshold because a slow spawn legitimately isn't listed yet;
   *  closes the stuck-forever gap (pre-Step-2 these rows NEVER finalized). */
  spawnLostAfterTicks?: number;
  /** Step 2 — self-healing reattach: a matched non-terminal host run with NO
   *  ActiveRunRegistry entry gets a HostBackedActiveRunHandle registered on any
   *  tick (not just boot), so pause/cancel/resume work after a held boot. */
  registerMissingHandles?: boolean;
  /** Broadcast the on-disk JSONL backlog when registering a handle. M3a: ANY
   *  registration (was boot-only — a held boot's late registration skipped the
   *  backlog and the pre-restart events never reached the UI). Registration is
   *  once-per-handle, so the backlog can't re-broadcast. */
  backfillOnRegister?: boolean;
  /** T1.4 — injectable terminal-effects seam (tests spy on it). Defaults to the
   *  real full-effects helper so the `failed` live-event + orchestrator notify
   *  fire through the gateway/outbox door (never a direct broadcast). */
  applyTerminalEffects?: typeof applyAgentRunTerminalEffects;
  /** S3 — replay the orchestrator envelope for any recently-terminal run whose
   *  notify tail threw before enqueuing it. Test seam; defaults to the real
   *  idempotent replay. */
  replayEnvelopes?: typeof replayMissingTerminalEnvelopes;
}

export interface ReconcileSweepResult {
  checked: number;
  terminalApplied: number;
  statusUpdated: number;
  /** T1.4 — non-terminal rows finalized `host-lost` this sweep (host gone). */
  hostLost: number;
  /** Step 2 — host-backed handles registered this sweep (self-healing reattach). */
  registered: number;
  /** Step 2 — JSONL backlog events broadcast for newly registered handles. */
  backfilledEvents: number;
  /** Ghost reaper (2026-06-10) — live host runs cancelled because their DB row
   *  was already terminal (e.g. a dispatch failed on a timed-out start receipt
   *  while the host had actually started the run). */
  ghostCancelled: number;
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
  const spawnLostAfter = deps.spawnLostAfterTicks ?? 8;

  let terminalApplied = 0;
  let statusUpdated = 0;
  let hostLost = 0;
  let registered = 0;
  let backfilledEvents = 0;

  for (const row of rows) {
    const hostRun = hostByRunId.get(row.id);
    // T1.4 — row absent from (or mismatched against) the host's live snapshots.
    if (!hostRun || !hostSnapshotMatchesRow(row, hostRun)) {
      hostLost += handleHostMissingRow(row, {
        deps,
        missingTicks,
        lostAfter,
        spawnLostAfter,
      });
      continue;
    }

    // Row IS owned by the host again — clear any standing missing-tick counter.
    missingTicks?.delete(row.id);

    if (isTerminalState(hostRun.state)) {
      terminalApplied += applyHostTerminalSnapshot(hostRun, deps);
      continue;
    }

    // Step 2 — self-healing reattach: a host-owned non-terminal run with no
    // live registry entry (server restarted, or boot was held on an unreachable
    // host) gets its HostBackedActiveRunHandle registered on THIS tick, so
    // pause / cancel / settle paths work again. Dispatch registers before
    // start, so a freshly dispatched run is never double-registered here.
    if (
      deps.registerMissingHandles &&
      deps.activeRunRegistry &&
      isNonTerminalState(hostRun.state) &&
      !deps.activeRunRegistry.get(row.id)
    ) {
      const handle = new HostBackedActiveRunHandle(hostRun, deps.hostClient, {
        now: deps.now,
        onCommandError: deps.onHostCommandError
          ? (error) => deps.onHostCommandError?.(error)
          : undefined,
      });
      deps.activeRunRegistry.register({
        run: handle,
        projectId: row.projectId,
        dispatcherSessionId: row.dispatcherSessionId,
        ccSessionId: row.ccSessionId,
        podName: row.podName,
        parentWorkItemId: row.parentWorkItemId,
        podRevisionAtDispatch: row.podRevisionAtDispatch,
        now: deps.now?.(),
      });
      registered += 1;
      if (deps.backfillOnRegister) {
        backfilledEvents += backfillAgentRunJsonl(row, hostRun, deps);
      }
    }

    if (shouldUpdateFromHost(row, hostRun)) {
      (deps.updateStatus ?? defaultUpdateAgentRunStatus)({
        id: row.id,
        status: hostRun.state,
        ...(hostRun.spawnedAt !== null ? { spawnedAt: hostRun.spawnedAt } : {}),
        ...(hostRun.readyAt !== null ? { readyAt: hostRun.readyAt } : {}),
        ...(hostRun.pid !== undefined ? { pid: hostRun.pid } : {}),
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

  // Ghost reaper (2026-06-10) — a NON-terminal host run whose DB row is already
  // terminal is compute the server has forgotten: the row loop above iterates
  // only non-terminal DB rows, so nothing else ever converges it. The canonical
  // producer was a dispatch whose start-run receipt timed out — failHostStart
  // marked the row failed while the host had actually started the run, which
  // then burned a concurrency slot until its wall-clock cap. Cancel only
  // against a freshly-confirmed host list, and only after the row has been
  // terminal past a grace window (never race the in-flight terminal effects of
  // a normally-completing run). Fire-and-forget; the next tick re-converges.
  let ghostCancelled = 0;
  if (deps.hostAuthoritativelyAbsent) {
    const now = deps.now?.() ?? Date.now();
    const nonTerminalRowIds = new Set(rows.map((row) => row.id));
    for (const hostRun of hostRuns) {
      if (isTerminalState(hostRun.state)) continue;
      if (nonTerminalRowIds.has(hostRun.runId)) continue;
      // A failed lookup is no-information — leave the run alone this tick
      // (never let one bad read abort the rest of the sweep).
      let row: AgentRunRow | null = null;
      try {
        row = (deps.getAgentRun ?? defaultGetAgentRunRow)(hostRun.runId);
      } catch {
        continue;
      }
      if (!row || !isDbTerminal(row.status)) continue;
      if (now - (row.completedAt ?? 0) < GHOST_CANCEL_GRACE_MS) continue;
      ghostCancelled += 1;
      Promise.resolve(
        deps.hostClient.sendCommand({ type: 'cancel', runId: hostRun.runId }),
      ).catch((err) => {
        deps.onHostCommandError?.(err instanceof Error ? err : new Error(String(err)));
      });
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

  return {
    checked: rows.length,
    terminalApplied,
    statusUpdated,
    hostLost,
    registered,
    backfilledEvents,
    ghostCancelled,
  };
}

/** T1.4 + Step 2 — decide a single host-missing row. Increments the
 *  consecutive-miss counter and finalizes `host-lost` once ALL of the
 *  false-positive guards pass:
 *  (1) the caller asserted authoritative host absence this tick (we are CONNECTED
 *  to a host whose fresh list-runs we just pulled, and this run is absent from
 *  it), (2) a counter is wired, (3) the row's status is eligible with its own
 *  threshold — `running` after `lostAfter` ticks; `queued`/`spawning` after the
 *  longer `spawnLostAfter` (a slow spawn legitimately isn't listed yet, but a
 *  row the host NEVER reports is genuinely lost — pre-Step-2 it stuck forever);
 *  `paused` NEVER (FD-14 law: a paused run is host-less by design while it
 *  waits on an ask — only the ask flow may end it), (4) the row has been
 *  missing for enough consecutive ticks. Else leaves the row untouched.
 *  Returns 1 if finalized, else 0. */
function handleHostMissingRow(
  row: AgentRunRow,
  ctx: {
    deps: AgentHostReattachDeps;
    missingTicks: Map<string, number> | undefined;
    lostAfter: number;
    spawnLostAfter: number;
  },
): number {
  const { deps, missingTicks, lostAfter, spawnLostAfter } = ctx;

  // Conservative gates: without the authoritative-absence signal or a counter,
  // we cannot trust that the run is genuinely gone — leave the row alone.
  if (!deps.hostAuthoritativelyAbsent || !missingTicks) return 0;

  // FD-14 law — the reconciler NEVER finalizes a paused run. Drop any standing
  // counter so it can never accrue toward finalize.
  if (row.status === 'paused') {
    missingTicks.delete(row.id);
    return 0;
  }

  const threshold = row.status === 'running' ? lostAfter : spawnLostAfter;

  const ticks = (missingTicks.get(row.id) ?? 0) + 1;
  missingTicks.set(row.id, ticks);
  if (ticks < threshold) return 0;

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
      failureReason: row.status === 'running' ? HOST_LOST_REASON : HOST_LOST_NEVER_STARTED_REASON,
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
      onMailboxEnqueued: deps.onMailboxEnqueued,
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
          ...(event.run.pid !== undefined ? { pid: event.run.pid } : {}),
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

  // NOTE: do NOT short-circuit when the row is already terminal. Fall through to
  // the one authority (`applyAgentRunTerminalEffects`), which detects the
  // already-terminal row, skips re-applying effects, but STILL fires the
  // run-keyed settlement waiter so a waiting dispatch `done` resolves even when
  // a rival listener / sweep finalized the row first. Only a missing row (the
  // event predates the DB insert, or the run was purged) has nothing to do.
  const row = (deps.getAgentRun ?? defaultGetAgentRunRow)(snapshot.runId);
  if (!row) return 0;

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
      onError: deps.onTerminalError,
      onMailboxEnqueued: deps.onMailboxEnqueued,
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
