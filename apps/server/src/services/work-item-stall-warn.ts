// pc-pty-chat-433 — A3: proactive board-health sweep.
//
// Complement to A2's pull tool (pc_board_health): this sweep PUSHES a
// consolidated orchestrator-turn mailbox message when work items have stalled,
// so the orchestrator learns about neglected cards without anyone asking.
//
// Design mirrors the P9/FD-17 run-stall ladder in agent-run-stall-warn.ts:
//   • caller-owned `notifiedItems` map — emit-once per stall episode per item
//   • episode resets when the item gets activity (leaves the stalled list)
//   • idempotency key embeds the set of new item IDs — cross-restart stable
//     via DB dedup (same set → same key → enqueueMailboxMessage no-ops)
//
// Stall computation delegates entirely to getBoardHealth (@pc/db) — the SAME
// function A2's route handler proxies. There is ONE definition of "stalled
// item"; A3 adds no parallel computation of its own.

import {
  listProjects as defaultListProjects,
  getBoardHealth as defaultGetBoardHealth,
  newId,
} from '@pc/db';
import type { BoardHealthItem } from '@pc/db';
import type { ULID } from '@pc/domain';

import type { MailboxEnqueuePort } from './agent-delivery.ts';

/** Default idle threshold (days). Items with no activity for this long are
 *  considered stalled. Matches pc_board_health's default. Tune via
 *  PC_WORK_ITEM_STALL_IDLE_DAYS. */
const DEFAULT_IDLE_DAYS = 7;

/** Default sweep cadence (ms). Work-item staleness is measured in days; 6 h
 *  is frequent enough to catch new stalls within a working day without
 *  hammering the DB. Tune via PC_WORK_ITEM_STALL_SWEEP_MS. */
export const DEFAULT_WORK_ITEM_STALL_SWEEP_MS = 6 * 60 * 60_000;

export function resolveWorkItemStallIdleDays(): number {
  const raw = Number(process.env.PC_WORK_ITEM_STALL_IDLE_DAYS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_IDLE_DAYS;
}

export function resolveWorkItemStallSweepMs(): number {
  const raw = Number(process.env.PC_WORK_ITEM_STALL_SWEEP_MS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_WORK_ITEM_STALL_SWEEP_MS;
}

export interface WorkItemStallWarnDeps {
  /** Caller-owned, persists across ticks — per-project set of item IDs already
   *  notified this stall episode. Cleared per-item when the item gets activity. */
  notifiedItems: Map<string, Set<string>>;
  /** The durable mailbox enqueue. Absent / null ⇒ dry-run (no messages sent). */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  /** Stale threshold in days. Defaults to resolveWorkItemStallIdleDays(). */
  idleDays?: number;
  now?: () => number;
  /** Test seam — defaults to listProjects from @pc/db (excludes deleted). */
  listProjects?: () => Array<{ id: ULID; name: string }>;
  /** Test seam — defaults to getBoardHealth from @pc/db. */
  getBoardHealth?: (projectId: string, idleDays: number) => { stalledItems: BoardHealthItem[] };
}

export interface WorkItemStallWarnResult {
  /** Projects checked this sweep. */
  checked: number;
  /** Projects that received a mailbox notification this sweep. */
  notified: number;
  /** Total newly-stalled items across all notified projects. */
  newStalled: number;
}

export function sweepWorkItemStallWarn(deps: WorkItemStallWarnDeps): WorkItemStallWarnResult {
  const now = (deps.now ?? Date.now)();
  const idleDays = deps.idleDays ?? resolveWorkItemStallIdleDays();
  const projects = (deps.listProjects ?? defaultListProjects)();
  const getHealth = deps.getBoardHealth ?? defaultGetBoardHealth;
  const notifiedItems = deps.notifiedItems;

  let notified = 0;
  let newStalled = 0;

  for (const project of projects) {
    const { stalledItems } = getHealth(project.id, idleDays);
    const currentIds = new Set<string>(stalledItems.map((i) => i.id as string));

    // Per-project tracking set (created lazily on first encounter).
    let projectNotified = notifiedItems.get(project.id);
    if (!projectNotified) {
      projectNotified = new Set();
      notifiedItems.set(project.id, projectNotified);
    }

    // Episode reset: prune items that have regained activity (left the stalled
    // list). They may be re-notified if they go stale again.
    for (const id of projectNotified) {
      if (!currentIds.has(id)) projectNotified.delete(id);
    }

    // Items that first stalled since the last notification for this project.
    const newItems = stalledItems.filter((i) => !projectNotified!.has(i.id));
    if (newItems.length === 0 || !deps.mailboxEnqueue) continue;

    enqueueStallNotify(deps.mailboxEnqueue, {
      projectId: project.id,
      projectName: project.name,
      stalledItems,
      newItems,
      idleDays,
      now,
    });

    for (const item of newItems) projectNotified.add(item.id);
    notified++;
    newStalled += newItems.length;
  }

  return { checked: projects.length, notified, newStalled };
}

/** Enqueue ONE consolidated mailbox message to the project orchestrator
 *  summarising all currently-stalled items, highlighting the new arrivals.
 *
 *  Idempotency key: `work-item-stalled:{projectId}:{sortedNewItemIds}` —
 *  stable for the same set of newly-stalled items so a server restart that
 *  finds the same stalled set hits DB dedup and does NOT double-notify. */
function enqueueStallNotify(
  mailboxEnqueue: MailboxEnqueuePort,
  input: {
    projectId: ULID;
    projectName: string;
    stalledItems: BoardHealthItem[];
    newItems: BoardHealthItem[];
    idleDays: number;
    now: number;
  },
): void {
  const { projectId, projectName, stalledItems, newItems, idleDays, now } = input;

  // Show up to 5 items oldest-first (getBoardHealth already sorts ascending).
  const top = stalledItems.slice(0, 5);
  const lines = top.map((item) => {
    const ref = item.callsign ? `[${item.callsign}]` : `[${item.id.slice(0, 8)}]`;
    return `• ${ref} "${item.title.slice(0, 80)}" — ${item.ageInStageDays}d in stage ${item.stageId}`;
  });
  const overflow = stalledItems.length - top.length;
  if (overflow > 0) lines.push(`  … and ${overflow} more`);

  const body =
    `${stalledItems.length} work item(s) in project "${projectName}" have had no activity for ` +
    `${idleDays}+ days (${newItems.length} newly stalled this sweep). ` +
    `Top stalled items (oldest first):\n${lines.join('\n')}\n` +
    `Use pc_board_health for the full list, pc_get_work_item + pc_move_work_item to act on them, ` +
    `or pc_create_agent_work_item to dispatch follow-up work.`;

  const newIdsSorted = newItems
    .map((i) => i.id)
    .sort()
    .join(':');

  mailboxEnqueue({
    message: {
      id: newId(),
      projectId,
      kind: 'work-item-stalled',
      subject: `Board health: ${stalledItems.length} stalled item(s) in "${projectName}"`,
      body,
      sourceKind: 'system',
      sourceId: null,
      idempotencyKey: `work-item-stalled:${projectId}:${newIdsSorted}`,
    },
    recipients: [
      {
        id: newId(),
        addressKind: 'active-orchestrator',
        addressJson: { kind: 'active-orchestrator', projectId },
        channel: 'orchestrator-turn',
        deliveryId: newId(),
      },
    ],
    now,
  });
}
