// Pure derivation: given a stream of WS envelopes, compute the set of
// project IDs that currently have an actively running orchestrator process.
//
// A `runtime-state` envelope carries the current runtime health for its
// project. The SERVER sends one on every WS connect (connect-snapshot) and
// broadcasts one whenever the runtime health changes. Both the active-project
// socket (materialized via chat-session-reducer into ws.events) and the
// background activity sockets (raw envelopes in backgroundWs.events) deliver
// these, so scanning both gives a complete cross-project picture.
//
// The LAST `runtime-state` per project in each stream wins — the arrays
// grow chronologically, so the tail is always the freshest signal.
//
// NOTE: using `session-changed` for this was wrong — the durable session row
// stays `status: 'active'` even when no Claude process is running, causing
// every project that ever had a session to light up on boot. The
// `runtime-state` health field is the truthful liveness signal.

import type { OrchestratorRuntimeHealth } from '@/features/runtime/types';
import type { WsEnvelope } from '@/features/runtime/ws-types';

/** Health values that mean a Claude process is actually running right now. */
const LIVE_HEALTH = new Set<OrchestratorRuntimeHealth>([
  'spawning',
  'ready',
  'busy',
  'respawning',
]);

/** True when a `runtime-state` envelope reports a health value that means an
 *  orchestrator process is actively running. Exported for unit testing. */
export function isLiveRuntimeHealth(env: WsEnvelope): boolean {
  if (env.type !== 'runtime-state') return false;
  const health = (env as { health?: unknown }).health;
  return typeof health === 'string' && LIVE_HEALTH.has(health as OrchestratorRuntimeHealth);
}

/** Derive the set of project IDs that currently have a live orchestrator
 *  process. Scans both the active-project event stream and the background
 *  event stream; the last `runtime-state` per project in either stream
 *  determines the current state. */
export function deriveActiveSessionProjectIds(
  activeEvents: readonly WsEnvelope[],
  backgroundEvents: readonly WsEnvelope[],
): ReadonlySet<string> {
  const runtimeLive = new Map<string, boolean>();

  for (const env of activeEvents) {
    if (env.type !== 'runtime-state') continue;
    const projectId = typeof env.projectId === 'string' ? env.projectId : null;
    if (!projectId) continue;
    runtimeLive.set(projectId, isLiveRuntimeHealth(env));
  }

  // Background events override active events for the same project — they are
  // fresher once a project becomes background (the background socket sends a
  // fresh connect-snapshot when it first opens, superseding the stale active-
  // project state that was recorded before the user switched away).
  for (const env of backgroundEvents) {
    if (env.type !== 'runtime-state') continue;
    const projectId = typeof env.projectId === 'string' ? env.projectId : null;
    if (!projectId) continue;
    runtimeLive.set(projectId, isLiveRuntimeHealth(env));
  }

  const out = new Set<string>();
  for (const [id, live] of runtimeLive) {
    if (live) out.add(id);
  }
  return out;
}
