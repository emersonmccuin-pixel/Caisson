// Step 2 — THE one agent-run reconciler (north-star §5: one control loop, all
// states; boot is the same loop).
//
// One owner for every "what state is this run actually in?" answer:
//   • boot          = the FIRST TICK of the loop (plus handle registration +
//                     JSONL backfill, which the sweep self-heals on any tick)
//   • every 15s     = the same tick
//   • HOLD          = an unreachable / unrefreshed host NEVER finalizes a run;
//                     the absence signal + consecutive-tick counters are the
//                     only path to `host-lost` (T1.4)
//   • paused        = NEVER finalized by this loop, any mode, boot included
//                     (FD-14 law — only the ask flow may end a paused run)
//   • every verdict = through `applyAgentRunTerminalEffects` (the Step-1
//                     terminal authority) — zero direct `markTerminal` writes
//
// This module replaces: the boot-only reconcile (`agent-run-boot-reconcile.ts`,
// deleted — it bulk-failed paused runs and bypassed the terminal authority),
// the boot reattach wrapper (`agent-run-server-boot.ts`, deleted), and the
// inline watchdog interval in `index.ts`. There is exactly ONE interval owner
// for run liveness in the codebase: `start()` below (ONE-RECONCILER guard).

import type { ULID } from '@pc/domain';

import {
  getActiveRunRegistry,
  HostBackedActiveRunHandle,
  type ActiveRunRegistry,
} from './agent-active-runs.ts';
import {
  applyAgentHostEvent,
  reconcileAgentRunsAgainstHost,
  type AgentHostReattachClient,
  type ReconcileSweepResult,
} from './agent-host-reattach.ts';
import { sweepStallWarn, type StallWarnResult } from './agent-run-stall-warn.ts';
import {
  onWorkerTurnEndWithoutDeliverable,
  type DeliverableNudgeOutcome,
} from './agent-run-deliverable-nudge.ts';
import type { MailboxEnqueuePort } from './agent-delivery.ts';
import {
  clearPtyActivity,
  getPtyActivityAt,
  recordPtyActivity,
} from './pty-activity-store.ts';
import {
  getAgentRunRow as defaultGetAgentRunRow,
  listNonTerminalAgentRuns as defaultListNonTerminalRuns,
} from '@pc/db';
import { applyAgentRunTerminalEffects } from './agent-run-terminal-effects.ts';

/** What the reconciler needs from the host connection (host mode). The real
 *  `HostConnection` satisfies this; tests fake it. */
export interface ReconcilerHostPort extends AgentHostReattachClient {
  /** Pull a FRESH list-runs. Throwing ⇒ this tick withholds the absence signal
   *  (HOLD: nothing can finalize host-lost on stale information). */
  refreshRuns(): Promise<unknown>;
  /** Health AFTER the refresh attempt — gates the authoritative-absence signal. */
  isConnected(): boolean;
}

export interface AgentRunReconcilerDeps {
  // ☠ P9: the 'in-process' mode + its liveness sweep (pid-check + 10min
  // idle-kill) are DELETED — dead code since P2 removed the in-process spawn
  // path (index.ts only ever constructed 'host'). The agent host owns every
  // process; this loop reconciles against it. One path.
  host: ReconcilerHostPort;
  activeRunRegistry?: ActiveRunRegistry;
  broadcast?: (projectId: ULID, msg: unknown) => void;
  mailboxEnqueue?: MailboxEnqueuePort | null;
  intervalMs?: number;
  /** `running` row missing from a reachable host → host-lost after this many
   *  consecutive ticks (default 2 ≈ 30s; env PC_HOST_LOST_TICKS). */
  hostLostAfterTicks?: number;
  /** `queued`/`spawning` row the host never reports → host-lost after this many
   *  consecutive ticks (default 8 ≈ 2min; env PC_SPAWN_LOST_TICKS). */
  spawnLostAfterTicks?: number;
  now?: () => number;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  onHostCommandError?: (error: Error) => void;
  onTerminalError?: (error: Error) => void;
  /** Issue 3 — forwarded to terminal effects so an immediate mailbox drain can
   *  be triggered after the completion envelope is enqueued. */
  onMailboxEnqueued?: () => void;
  /** Test seams — default to the real sweeps. */
  reconcileHost?: typeof reconcileAgentRunsAgainstHost;
  stallWarn?: typeof sweepStallWarn;
  applyHostEvent?: typeof applyAgentHostEvent;
  nudge?: typeof onWorkerTurnEndWithoutDeliverable;
  getAgentRun?: typeof defaultGetAgentRunRow;
  /** Audit #3 — delivered-watchdog feeder + terminal door. Test seams. */
  listNonTerminalRuns?: typeof defaultListNonTerminalRuns;
  applyTerminalEffects?: typeof applyAgentRunTerminalEffects;
  /** Grace after `deliveredAt` before the watchdog re-sends the complete-run
   *  relay; local finalize follows after a second grace window. */
  deliveredGraceMs?: number;
  /** Threaded into the sweeps (S3 envelope replay). Test seam. */
  replayEnvelopes?: AgentHostReattachDepsReplay;
}

type AgentHostReattachDepsReplay = NonNullable<
  Parameters<typeof reconcileAgentRunsAgainstHost>[0]['replayEnvelopes']
>;

export interface ReconcileTickResult {
  /** True when the host could not be reached this tick, so the destructive
   *  (finalizing) half was withheld. */
  held: boolean;
  hostReconcile: ReconcileSweepResult | null;
  stallWarn: StallWarnResult;
}

export interface AgentRunReconciler {
  /** Boot = the first tick (with JSONL backfill on newly registered handles) +
   *  the ONE persistent host event subscription. Await before serving routes. */
  boot(): Promise<ReconcileTickResult>;
  /** One pass of the loop. Exposed for tests; production uses start().
   *  (M3a: the `boot` opt died with the boot-only backfill gate — boot IS the
   *  same tick, now with zero behavioral differences.) */
  tick(): Promise<ReconcileTickResult>;
  /** Start THE interval (the only liveness interval in the codebase). */
  start(): void;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 15_000;

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
}

export function createAgentRunReconciler(deps: AgentRunReconcilerDeps): AgentRunReconciler {
  if (!deps.host) {
    throw new Error('agent-run-reconciler: a host port is required');
  }
  const registry = deps.activeRunRegistry ?? getActiveRunRegistry();
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const hostLostAfterTicks = deps.hostLostAfterTicks ?? envInt('PC_HOST_LOST_TICKS', 2);
  const spawnLostAfterTicks = deps.spawnLostAfterTicks ?? envInt('PC_SPAWN_LOST_TICKS', 8);
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const warn = deps.warn ?? ((msg: string) => console.warn(msg));

  // Loop-owned state (persists across ticks; the false-positive guards).
  const hostMissingTicks = new Map<string, number>();
  const stalledRuns = new Set<string>();
  // P9 ladder rung 2 — runs already orchestrator-notified this stall episode.
  const notifiedRuns = new Set<string>();
  // P9 deliverable-skip nudge — strikes per run (1 = nudged, 2 = escalated).
  const nudgeStrikes = new Map<string, number>();
  // Audit #3 — delivered-watchdog: runs whose complete-run relay was re-sent.
  const deliveredRelayRetried = new Set<string>();
  const deliveredGraceMs = deps.deliveredGraceMs ?? envInt('PC_DELIVERED_GRACE_MS', 60_000);

  let interval: NodeJS.Timeout | null = null;
  let subscribed = false;
  let unsubscribeHostEvents: (() => void) | null = null;

  /** The ONE persistent host event consumer (rides the multiplexed
   *  HostConnection emitter, survives host respawns). Latency path only — the
   *  tick is the correctness path that converges anything this drops. */
  function subscribeHostEvents(): void {
    if (subscribed || !deps.host.onEvent) return;
    subscribed = true;
    const maybeUnsubscribe = deps.host.onEvent((event) => {
      try {
        // PTY-activity heartbeat: run-chunk events arrive on every PTY byte
        // (spinner redraws, output, thinking UI). Record the timestamp (throttled
        // to PTY_ACTIVITY_THROTTLE_MS per run) so the stall sweep's computeIdleMs
        // sees fresh activity even when the JSONL transcript has not yet been
        // flushed (CC only flushes at turn-end). On terminal, clear the entry so
        // the map stays bounded.
        if (event.type === 'run-chunk') {
          recordPtyActivity(event.runId, (deps.now ?? Date.now)());
        } else if (event.type === 'run-terminal') {
          clearPtyActivity(event.run.runId);
        }

        (deps.applyHostEvent ?? applyAgentHostEvent)(event, {
          activeRunRegistry: registry,
          broadcast: deps.broadcast,
          mailboxEnqueue: deps.mailboxEnqueue,
          now: deps.now,
          onTerminalError: deps.onTerminalError,
          onMailboxEnqueued: deps.onMailboxEnqueued,
        });
        if (event.type === 'run-state' || event.type === 'run-terminal') {
          const handle = registry.get(event.run.runId)?.run;
          if (handle instanceof HostBackedActiveRunHandle) handle.applySnapshot(event.run);
        }
        // P9 deliverable-skip nudge — event-driven (the marco case corrects in
        // seconds, not at a poll boundary). A live turn-end on a contract-first
        // run with nothing delivered → reminder into the run; twice → ONE
        // orchestrator escalation. Never a kill.
        if (event.type === 'run-terminal') {
          nudgeStrikes.delete(event.run.runId);
          deliveredRelayRetried.delete(event.run.runId);
        } else if (event.type === 'run-jsonl' && event.kind === 'jsonl-turn-end') {
          const row = (deps.getAgentRun ?? defaultGetAgentRunRow)(event.runId);
          if (row) {
            const outcome: DeliverableNudgeOutcome = (
              deps.nudge ?? onWorkerTurnEndWithoutDeliverable
            )(row, {
              strikes: nudgeStrikes,
              sendToRun: (runId, text) => {
                Promise.resolve(
                  deps.host.sendCommand({ type: 'send', runId, text }),
                ).catch((err) =>
                  warn(`[agent-runs] deliverable-nudge send failed: ${(err as Error).message}`),
                );
              },
              mailboxEnqueue: deps.mailboxEnqueue,
              now: deps.now,
            });
            if (outcome === 'nudged' || outcome === 'notified') {
              log(`[agent-runs] deliverable-nudge: ${outcome} run=${event.runId}`);
            }
          }
        }
      } catch (err) {
        warn(`[agent-runs] host event apply failed: ${(err as Error).message}`);
      }
    });
    if (typeof maybeUnsubscribe === 'function') unsubscribeHostEvents = maybeUnsubscribe;
  }

  /** Audit #3 — the deliverable watchdog. A run whose deliverable landed
   *  (`deliveredAt` stamped — a DURABLE positive receipt) but that is still
   *  `running` past the grace window means the route's detached complete-run
   *  relay was dropped AND the host's own terminal never arrived. Step 1:
   *  re-send the relay (the host also kills the claude.exe child properly).
   *  Step 2 (a further grace later): finalize locally through the ONE terminal
   *  authority — completion on a positive receipt is exempt from HOLD, which
   *  only forbids finalizing on ABSENCE of information. */
  function sweepDeliveredUnfinalized(reachable: boolean): number {
    const now = (deps.now ?? Date.now)();
    let finalized = 0;
    for (const row of (deps.listNonTerminalRuns ?? defaultListNonTerminalRuns)()) {
      if (row.status !== 'running') continue; // FD-14: never touch paused
      if (!row.deliveredAt) continue;
      const sinceDelivered = now - row.deliveredAt;
      if (sinceDelivered < deliveredGraceMs) continue;

      if (!deliveredRelayRetried.has(row.id) && reachable) {
        deliveredRelayRetried.add(row.id);
        log(
          `[agent-runs] delivered-watchdog: run ${row.id} delivered ${Math.round(sinceDelivered / 1000)}s ago, still running — re-sending complete-run`,
        );
        Promise.resolve(
          deps.host.sendCommand({ type: 'complete-run', runId: row.id, result: '' }),
        ).catch((err) =>
          warn(
            `[agent-runs] delivered-watchdog: complete-run re-send failed for ${row.id}: ${(err as Error).message}`,
          ),
        );
        continue;
      }

      if (sinceDelivered < deliveredGraceMs * 2) continue;
      log(
        `[agent-runs] delivered-watchdog: run ${row.id} still unfinalized ${Math.round(sinceDelivered / 1000)}s after delivery — finalizing locally (completed)`,
      );
      (deps.applyTerminalEffects ?? applyAgentRunTerminalEffects)(
        {
          runId: row.id,
          ccSessionId: row.ccSessionId,
          podName: row.podName,
          projectId: row.projectId,
          dispatcherSessionId: row.dispatcherSessionId,
          parentWorkItemId: row.parentWorkItemId,
          worktreeDir: row.worktreeDir ?? '',
          status: 'completed',
          result: row.result ?? '',
          completedAt: now,
          startedAt: row.queuedAt,
          workItemId: row.parentWorkItemId,
          contractId: row.contractId,
        },
        {
          activeRunRegistry: registry,
          mailboxEnqueue: deps.mailboxEnqueue,
          broadcast: deps.broadcast,
          getAgentRun: deps.getAgentRun,
          now: deps.now,
          onError: deps.onTerminalError,
          onMailboxEnqueued: deps.onMailboxEnqueued,
        },
      );
      deliveredRelayRetried.delete(row.id);
      finalized += 1;
    }
    return finalized;
  }

  async function tick(): Promise<ReconcileTickResult> {
    const host = deps.host;
    // HOLD principle — a refresh that THROWS withholds the absence signal AND
    // the counters, so nothing can finalize on stale/no information. The
    // non-destructive half (terminal snapshots from cache, status drift)
    // still runs: positive receipts are safe from any snapshot.
    let refreshed = true;
    try {
      await host.refreshRuns();
    } catch {
      refreshed = false;
    }
    const reachable = refreshed && host.isConnected();
    const held = !reachable;

    const hostReconcile = (deps.reconcileHost ?? reconcileAgentRunsAgainstHost)({
      hostClient: host,
      activeRunRegistry: registry,
      broadcast: deps.broadcast,
      mailboxEnqueue: deps.mailboxEnqueue,
      now: deps.now,
      onTerminalError: deps.onTerminalError,
      onHostCommandError: deps.onHostCommandError,
      // Authoritative absence = we are CONNECTED to a host whose fresh
      // list-runs we just pulled AND the row is absent from it.
      hostAuthoritativelyAbsent: reachable,
      missingFromHostTicks: refreshed ? hostMissingTicks : undefined,
      hostLostAfterTicks,
      spawnLostAfterTicks,
      // Self-healing reattach: only against a freshly confirmed host list.
      registerMissingHandles: reachable,
      // M3a — backfill on ANY registration, not just the boot tick (the P4
      // refute gap: a boot HELD on an unreachable host registered handles on a
      // later tick WITHOUT backfill, so events the Engine emitted before the
      // restart never reached the UI). Registration is once-per-handle, so the
      // backlog can't re-broadcast.
      backfillOnRegister: true,
      ...(deps.replayEnvelopes ? { replayEnvelopes: deps.replayEnvelopes } : {}),
      ...(deps.onMailboxEnqueued ? { onMailboxEnqueued: deps.onMailboxEnqueued } : {}),
    });

    // The P9/FD-17 stall ladder: badge (rung 1) + verify-alive→orchestrator
    // notify (rung 2). Never terminal — kills are wall-clock or confirmed-dead.
    // ptyActivityAt feeds the PTY-chunk last-active signal from the reconciler's
    // run-chunk handler (via pty-activity-store) so a long thinking turn never
    // triggers a false-stall alert.
    const stallWarnRes = (deps.stallWarn ?? sweepStallWarn)({
      stalledRuns,
      notifiedRuns,
      mailboxEnqueue: deps.mailboxEnqueue,
      broadcast: deps.broadcast,
      now: deps.now,
      ptyActivityAt: getPtyActivityAt,
    });

    // Audit #3 — delivered-but-unfinalized watchdog (positive-receipt path;
    // exempt from HOLD, see the sweep's doc comment). Isolated: a watchdog
    // failure (e.g. transient DB error) must not take down the tick.
    try {
      const deliveredFinalized = sweepDeliveredUnfinalized(reachable);
      if (deliveredFinalized > 0) {
        log(`[agent-runs] delivered-watchdog: finalized=${deliveredFinalized}`);
      }
    } catch (err) {
      warn(`[agent-runs] delivered-watchdog sweep failed: ${(err as Error).message}`);
    }

    return { held, hostReconcile, stallWarn: stallWarnRes };
  }

  async function boot(): Promise<ReconcileTickResult> {
    subscribeHostEvents();
    const res = await tick();
    if (res.held) {
      warn(
        '[agent-runs] boot: host not reachable; HOLDING (no finalize on no-information) — the loop converges when it returns',
      );
    } else if (res.hostReconcile) {
      const r = res.hostReconcile;
      if (r.registered + r.backfilledEvents + r.terminalApplied + r.statusUpdated > 0) {
        log(
          `[agent-runs] boot reconcile: registered=${r.registered}, backfilled=${r.backfilledEvents}, terminal=${r.terminalApplied}, status=${r.statusUpdated}`,
        );
      }
    }
    return res;
  }

  function start(): void {
    if (interval) return;
    interval = setInterval(() => {
      void tick()
        .then((res) => {
          const r = res.hostReconcile;
          if (
            r &&
            (r.terminalApplied > 0 ||
              r.statusUpdated > 0 ||
              r.hostLost > 0 ||
              r.registered > 0 ||
              r.ghostCancelled > 0)
          ) {
            log(
              `[agent-runs] reconcile: terminal=${r.terminalApplied}, status=${r.statusUpdated}, hostLost=${r.hostLost}, registered=${r.registered}, ghostCancelled=${r.ghostCancelled}, checked=${r.checked}`,
            );
          }
          if (
            res.stallWarn.warned > 0 ||
            res.stallWarn.cleared > 0 ||
            res.stallWarn.notified > 0
          ) {
            log(
              `[agent-runs] stall-ladder: warned=${res.stallWarn.warned}, cleared=${res.stallWarn.cleared}, notified=${res.stallWarn.notified}`,
            );
          }
        })
        .catch((err) => {
          warn(`[agent-runs] reconciler tick failed: ${(err as Error).message}`);
        });
    }, intervalMs);
    // Don't let the loop keep the process alive on shutdown.
    if (typeof interval.unref === 'function') interval.unref();
  }

  function stop(): void {
    if (interval) clearInterval(interval);
    interval = null;
    unsubscribeHostEvents?.();
    unsubscribeHostEvents = null;
    subscribed = false;
  }

  return { boot, tick, start, stop };
}
