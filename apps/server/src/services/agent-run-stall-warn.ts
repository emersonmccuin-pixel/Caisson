// The P9/FD-17 stall ladder — silence escalates, it never executes.
//
// One sweep, two rungs, driven by THE reconciler tick:
//   rung 1 (WARN_MS, 3min)    → non-terminal `stalled` badge. Visible, never kills.
//   rung 2 (NOTIFY_MS, 5min)  → verify-alive read (last transcript action) +
//                               ONE durable mailbox notify to the project
//                               orchestrator. The old idle-KILL moment became
//                               the notify moment. Never kills.
//
// There is NO rung 3. Kills happen only on wall-clock (AgentRun, 2h default)
// or confirmed-dead (onSpawnExit unexpected-exit / the reconciler's host-lost
// counters). ☠ The 5min AgentRun idle-kill + the 10min in-process sweep kill
// died in P9 Slice A.
//
// Emit-once via caller-owned sets: `stalledRuns` (badge) + `notifiedRuns`
// (mailbox). Both clear when the run shows life again, so a NEW quiet spell is
// a new episode (new badge, new notify). The mailbox idempotency key embeds the
// episode's last-activity floor — stable across ticks AND API restarts, so a
// restart can't double-notify the same episode.

import { statSync } from 'node:fs';

import type { AgentRunRow, ULID } from '@pc/domain';
import { newId } from '@pc/db';
import {
  getProjectById as defaultGetProjectById,
  listNonTerminalAgentRuns as defaultListNonTerminalAgentRuns,
} from '@pc/db';
import { jsonlPathFor } from '@pc/runtime';

import {
  computeIdleMs,
  resolveStallNotifyMs,
  resolveStallWarnMs,
} from './agent-run-idle.ts';
import { announceAgentRunSignal as defaultAnnounceSignal } from './agent-run-writer.ts';
import { lastJsonlAction } from './agent-run-control.ts';
import type { MailboxEnqueuePort } from './agent-delivery.ts';

export interface StallWarnDeps {
  /** Caller-owned, persists across ticks — tracks which runs we've already
   *  badged so we emit exactly one frame per WARN crossing / un-stall. */
  stalledRuns: Set<string>;
  /** Caller-owned, persists across ticks — runs already mailbox-notified this
   *  stall episode (rung 2 emit-once). Cleared with the badge on un-stall. */
  notifiedRuns?: Set<string>;
  /** Rung 2's door — the durable mailbox enqueue. Absent ⇒ badge-only. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  broadcast?: (projectId: ULID, msg: unknown) => void;
  now?: () => number;
  warnMs?: number;
  notifyMs?: number;
  listNonTerminalRuns?: () => AgentRunRow[];
  resolveJsonlPath?: (row: AgentRunRow) => string | null;
  jsonlMtime?: (path: string) => number | null;
  /** Verify-alive read for the notify body — the last transcript action.
   *  Test seam; defaults to the inspect helper's tailer read. */
  lastAction?: (jsonlPath: string) => { kind: string; text: string | null } | null;
  /** Test seam — defaults to the real rev-bump + outbox announce. */
  announceSignal?: typeof defaultAnnounceSignal;
  /** PTY-chunk last-active timestamp for a run (from the host's run-chunk
   *  events, relayed by the reconciler's pty-activity-store). When present and
   *  newer than the JSONL mtime / row timestamps, prevents false-stall alerts
   *  during long thinking turns or long tool calls where CC has not yet flushed
   *  its JSONL transcript. */
  ptyActivityAt?: (runId: string) => number | null;
}

export interface StallWarnResult {
  checked: number;
  warned: number;
  cleared: number;
  /** Rung 2 — orchestrator mailbox notifies emitted this tick. */
  notified: number;
}

/** Only spawned, non-paused runs can be "quiet" in the sense we badge: a paused
 *  run waiting on an ask is legitimately idle (and already shows "paused"); a
 *  queued run hasn't spawned. */
function isStallCandidate(status: AgentRunRow['status']): boolean {
  return status === 'running' || status === 'spawning';
}

export function sweepStallWarn(deps: StallWarnDeps): StallWarnResult {
  const now = (deps.now ?? Date.now)();
  const warnMs = deps.warnMs ?? resolveStallWarnMs();
  const notifyMs = deps.notifyMs ?? resolveStallNotifyMs();
  const rows = (deps.listNonTerminalRuns ?? defaultListNonTerminalAgentRuns)();
  const resolveJsonlPath = deps.resolveJsonlPath ?? defaultResolveJsonlPath;
  const jsonlMtime = deps.jsonlMtime ?? defaultJsonlMtime;
  const announce = deps.announceSignal ?? defaultAnnounceSignal;
  const broadcast = deps.broadcast;
  const notifiedRuns = deps.notifiedRuns;

  const liveIds = new Set<string>();
  let warned = 0;
  let cleared = 0;
  let notified = 0;

  for (const row of rows) {
    if (!isStallCandidate(row.status)) continue;
    liveIds.add(row.id);

    const jsonlPath = resolveJsonlPath(row);
    const mtime = jsonlPath ? jsonlMtime(jsonlPath) : null;
    const ptyAt = deps.ptyActivityAt?.(row.id) ?? null;
    const idleMs = computeIdleMs(row, { now, jsonlMtime: mtime, ptyActivityAt: ptyAt });
    const quiet = idleMs > warnMs;

    if (quiet && !deps.stalledRuns.has(row.id)) {
      announce({ runId: row.id, reason: 'stalled' }, scoped(broadcast, row.projectId));
      deps.stalledRuns.add(row.id);
      warned += 1;
    } else if (!quiet && deps.stalledRuns.has(row.id)) {
      announce({ runId: row.id, reason: 'reconciled' }, scoped(broadcast, row.projectId));
      deps.stalledRuns.delete(row.id);
      cleared += 1;
    }

    // Rung 2 — verify-alive + ONE orchestrator notify per stall episode.
    if (
      idleMs > notifyMs &&
      deps.mailboxEnqueue &&
      notifiedRuns &&
      !notifiedRuns.has(row.id)
    ) {
      const action = jsonlPath ? (deps.lastAction ?? defaultLastAction)(jsonlPath) : null;
      enqueueStalledNotify(deps.mailboxEnqueue, {
        row,
        idleMs,
        lastActivityAt: now - idleMs,
        action,
        now,
      });
      notifiedRuns.add(row.id);
      notified += 1;
    }
    // Episode reset: any sign of life clears the notify latch with the badge.
    if (!quiet) notifiedRuns?.delete(row.id);
  }

  // Prune ids that have left the running set (terminal / paused / gone) so the
  // tracking sets can't grow without bound. A terminal frame already dropped
  // the card; a re-spawn mints a new ULID, so no stale carry-over.
  for (const id of deps.stalledRuns) {
    if (!liveIds.has(id)) deps.stalledRuns.delete(id);
  }
  if (notifiedRuns) {
    for (const id of notifiedRuns) {
      if (!liveIds.has(id)) notifiedRuns.delete(id);
    }
  }

  return { checked: liveIds.size, warned, cleared, notified };
}

/** Rung 2's envelope. Kind `agent-stalled` → active-orchestrator over the
 *  orchestrator-turn channel (the FD-3 marked injection door adds
 *  `[pc:system kind=agent-stalled]`). The idempotency key embeds the episode's
 *  last-activity floor: same episode ⇒ same key ⇒ a restarted API can't
 *  double-notify; new activity ⇒ new floor ⇒ a fresh episode may notify again. */
function enqueueStalledNotify(
  mailboxEnqueue: MailboxEnqueuePort,
  input: {
    row: AgentRunRow;
    idleMs: number;
    lastActivityAt: number;
    action: { kind: string; text: string | null } | null;
    now: number;
  },
): void {
  const { row, idleMs, action } = input;
  const quietMin = Math.round(idleMs / 60_000);
  const last = action
    ? `${action.kind}${action.text ? ` — "${action.text.slice(0, 160)}"` : ''}`
    : 'no transcript activity recorded';
  const body =
    `Agent ${row.podName} (run ${row.id}) has produced no output for ~${quietMin} minute(s). ` +
    `It has NOT been killed — silence escalates to you instead of executing the run. ` +
    `Last transcript action: ${last}. ` +
    `Decide: keep waiting (long tool calls and deep work look like this), ` +
    `peek with pc_inspect_agent_run, or pc_kill_agent_run and re-dispatch if it is truly wedged.`;

  mailboxEnqueue({
    message: {
      id: newId(),
      projectId: row.projectId,
      kind: 'agent-stalled',
      subject: `Agent ${row.podName} may be stalled`,
      body,
      sourceKind: 'agent',
      sourceId: row.id,
      idempotencyKey: `agent-stalled:${row.id}:${input.lastActivityAt}`,
    },
    recipients: [
      {
        id: newId(),
        addressKind: 'active-orchestrator',
        addressJson: { kind: 'active-orchestrator', projectId: row.projectId },
        channel: 'orchestrator-turn',
        deliveryId: newId(),
      },
    ],
    now: input.now,
  });
}

function scoped(
  broadcast: StallWarnDeps['broadcast'],
  projectId: ULID,
): ((event: unknown) => void) | undefined {
  return broadcast ? (event) => broadcast(projectId, event) : undefined;
}

function defaultResolveJsonlPath(row: AgentRunRow): string | null {
  try {
    // Use the run's stored worktreeDir first — that's the cwd CC used when the
    // agent was spawned, so its projects/ key matches the actual JSONL location.
    // Fall back to project.folderPath for legacy rows predating the column.
    const cwd = row.worktreeDir ?? defaultGetProjectById(row.projectId)?.folderPath ?? null;
    return cwd ? jsonlPathFor(cwd, row.ccSessionId) : null;
  } catch {
    return null;
  }
}

function defaultJsonlMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** The inspect helper's tailer read — ONE implementation of "what did this
 *  run last do", shared with pc_inspect_agent_run. */
function defaultLastAction(
  jsonlPath: string,
): { kind: string; text: string | null } | null {
  const res = lastJsonlAction(jsonlPath);
  return res ? { kind: res.kind, text: res.text } : null;
}
