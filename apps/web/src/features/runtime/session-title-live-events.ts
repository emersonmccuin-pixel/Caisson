// T3.2b — pure decision helper for the Orchestrator session-title consumer.
// Picks the latest session payload across the live store's `session-title`
// frames (latest-by-cursor; session-title frames carry version null). Extracted
// so the selection can be pinned under tsx --test without jsdom.

import type { LiveEvent } from '@pc/contracts';
import type { OrchestratorSession } from './client';

export function latestSessionFromTitleEvents(
  events: LiveEvent[],
): OrchestratorSession | null {
  let best: LiveEvent | null = null;
  for (const ev of events) {
    const session = (ev.payload as { session?: unknown }).session;
    if (!session) continue;
    if (!best || ev.cursor > best.cursor) best = ev;
  }
  if (!best) return null;
  const session = (best.payload as { session?: OrchestratorSession }).session;
  return session ?? null;
}
