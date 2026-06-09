// Pure helper used by WorkflowGraphV2 to resolve the project-visible pod
// that backs an agent node's `agent` name.  Extracted here so it is
// importable by node:test without the CSS / React / @xyflow imports that
// WorkflowGraphV2.tsx brings in.

import type { Pod } from '@/features/agents/client';

/** Resolve the project-visible pod for the given agent name.
 *  Prefers a project-scoped match over a global/stock one — mirrors the
 *  same resolution logic in AgentTranscriptModal. */
export function resolveAgentPod(pods: Pod[], agentName: string): Pod | null {
  const named = pods.filter((p) => p.name === agentName);
  return named.find((p) => p.scope === 'project') ?? named[0] ?? null;
}
