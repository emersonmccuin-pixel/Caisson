// Pure derivation: given a stream of WS envelopes, compute the set of
// project IDs that currently have an active (live) orchestrator/chat session.
//
// A `session-changed` envelope carries the current session for its project.
// The SERVER sends one on every WS connect (connect-snapshot) and broadcasts
// one whenever a session opens, resumes, or closes. Both the active-project
// socket (materialized via chat-session-reducer into ws.events) and the
// background activity sockets (raw envelopes in backgroundWs.events) deliver
// these, so scanning both gives a complete cross-project picture.
//
// The LAST `session-changed` per project in each stream wins — the arrays
// grow chronologically, so the tail is always the freshest signal.

import type { WsEnvelope } from '@/features/runtime/ws-types';

/** True when a `session-changed` envelope carries a non-null session whose
 *  status is 'active'. Exported for unit testing. */
export function isActiveChatSession(env: WsEnvelope): boolean {
  const session = (env as { session?: unknown }).session;
  if (!session || typeof session !== 'object') return false;
  return (session as { status?: unknown }).status === 'active';
}

/** Derive the set of project IDs that currently have a live orchestrator
 *  session. Scans both the active-project event stream and the background
 *  event stream; the last `session-changed` per project in either stream
 *  determines the current state. */
export function deriveActiveSessionProjectIds(
  activeEvents: readonly WsEnvelope[],
  backgroundEvents: readonly WsEnvelope[],
): ReadonlySet<string> {
  const sessionActive = new Map<string, boolean>();

  for (const env of activeEvents) {
    if (env.type !== 'session-changed') continue;
    const projectId = typeof env.projectId === 'string' ? env.projectId : null;
    if (!projectId) continue;
    sessionActive.set(projectId, isActiveChatSession(env));
  }

  // Background events override active events for the same project — they are
  // fresher once a project becomes background (the background socket sends a
  // fresh connect-snapshot when it first opens, superseding the stale active-
  // project state that was recorded before the user switched away).
  for (const env of backgroundEvents) {
    if (env.type !== 'session-changed') continue;
    const projectId = typeof env.projectId === 'string' ? env.projectId : null;
    if (!projectId) continue;
    sessionActive.set(projectId, isActiveChatSession(env));
  }

  const out = new Set<string>();
  for (const [id, active] of sessionActive) {
    if (active) out.add(id);
  }
  return out;
}
