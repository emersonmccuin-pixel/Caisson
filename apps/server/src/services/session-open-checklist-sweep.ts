// Slice F — session-open checklist sweep formatter.
//
// This is the CATCH-UP tool for Point B: when the orchestrator becomes ready,
// it gets a snapshot of every open card that still has un-ticked done-conditions.
// It is NOT a live feed — state is read once at ready-time and may be seconds
// stale by the time the orchestrator processes it. (Risk #3, accepted.)
//
// Public surface:
//   collectOpenChecklistCards — filter WorkItem[] to cards with open boxes
//   formatSweepBlock          — render the [pc:system] block (null when empty)
//   sweepClientMessageId      — deterministic key → send-queue dedupe (Gotcha #5)

import type { WorkItem } from '@pc/domain';

export interface SweepCardSummary {
  callsign: string;
  title: string;
  openItems: string[];
}

/**
 * Filter a list of work items to those with at least one un-ticked
 * done-checklist box. Items with no checklist, an empty checklist, or all
 * boxes already ticked are excluded.
 */
export function collectOpenChecklistCards(items: WorkItem[]): SweepCardSummary[] {
  const result: SweepCardSummary[] = [];
  for (const item of items) {
    if (!item.doneChecklist || item.doneChecklist.length === 0) continue;
    const openItems = item.doneChecklist.filter((i) => !i.done).map((i) => i.label);
    if (openItems.length === 0) continue;
    // Fall back to a short ID slice when the row pre-dates callsign assignment.
    const callsign = item.callsign ?? item.id.slice(0, 12);
    result.push({ callsign, title: item.title, openItems });
  }
  return result;
}

/**
 * Render a [pc:system kind=session-open-checklist-sweep] block listing each
 * card as a pc://work-item/<callsign> markdown link with its open boxes.
 * Returns null when cards is empty — no empty injection (Risk #3: accepted).
 */
export function formatSweepBlock(cards: SweepCardSummary[]): string | null {
  if (cards.length === 0) return null;
  const lines: string[] = [];
  lines.push('[pc:system kind=session-open-checklist-sweep]');
  lines.push('');
  lines.push('Cards with open done-conditions at session start:');
  for (const card of cards) {
    lines.push('');
    lines.push(`[${card.callsign}](pc://work-item/${card.callsign}) — ${card.title}`);
    for (const label of card.openItems) {
      lines.push(`  [ ] ${label}`);
    }
  }
  return lines.join('\n');
}

/**
 * Deterministic clientMessageId keyed on the PC session id.
 *
 * - Same session → same id → enqueueRuntimeTurn dedupes → no re-injection on
 *   busy→ready cycles or server-restart/resume (Gotcha #5).
 * - New session (new id) → new clientMessageId → correctly re-sweeps.
 */
export function sweepClientMessageId(sessionId: string): string {
  return `session-open-sweep:${sessionId}`;
}
