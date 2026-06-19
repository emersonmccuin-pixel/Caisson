// pc-pty-chat-437 — Re-home a queued/spawning run onto the current live host.
//
// Called by the reconciler's handleHostMissingRow guard when a row with status
// `queued` or `spawning` is absent from the host's live list-runs — caused by
// the dev-supervisor replacing the old host on a new port while the run was
// already accepted by the old host.
//
// The run is NOT lost: the DB row, input, contract, and ccSessionId are all
// intact. We reconstruct the start-run request verbatim from the stored row
// and send it to the current live host so the run executes without manual retry.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveAgentForDispatch } from '@pc/db';
import { jsonlPathFor } from '@pc/runtime';
import type { AgentRunRow } from '@pc/domain';
import { ContractService } from '@pc/app-services';
import type { ExpectedOutput } from '@pc/domain';

import type { AgentHostReattachClient } from './agent-host-reattach.ts';
import { preparePodSpawn } from './pod-spawn.ts';

function scratchDirFor(projectId: string, agentRunId: string): string {
  const root = process.env.PC_DATA_DIR ?? 'data';
  return resolve(root, 'projects', projectId, 'agent-runs-v2', agentRunId);
}

/** Re-dispatch an already-accepted queued/spawning run onto the current live
 *  host. Uses the same `runId` so the contract link and ccSessionId are
 *  preserved. Returns:
 *   - `'re-sent'`  — host accepted the start-run; counters should be cleared.
 *   - `'failed'`   — host rejected or network error; caller may retry.
 *   - `'skip'`     — run is un-re-homeable (pod removed from registry, pod
 *                    prep threw) — caller should finalize as host-lost. */
export async function reHomeRunOnCurrentHost(
  row: AgentRunRow,
  hostClient: AgentHostReattachClient,
): Promise<'re-sent' | 'failed' | 'skip'> {
  // 1. Pod still registered? If not, there is nothing to dispatch to.
  const podRow = resolveAgentForDispatch(row.podName, row.projectId);
  if (!podRow) return 'skip';

  // 2. Derive the scratch dir (re-use the existing one — it was created at
  //    the original dispatch and is still alive since the row is not terminal).
  const scratchDir = scratchDirFor(row.projectId, row.id);
  try {
    mkdirSync(scratchDir, { recursive: true });
  } catch {
    /* best-effort — may already exist */
  }

  // 3. Reconstruct the workItem context from the stored contract (optional;
  //    affects only the "## Your assignment" block in the materialised .md).
  let workItem: { workItemId: string; expectedOutput: ExpectedOutput } | undefined;
  if (row.contractId && row.parentWorkItemId) {
    try {
      const svc = new ContractService();
      const contract = svc.get(row.contractId);
      if (contract?.expectedOutput) {
        workItem = {
          workItemId: row.parentWorkItemId,
          expectedOutput: contract.expectedOutput as ExpectedOutput,
        };
      }
    } catch {
      /* best-effort; missing workItem context is non-fatal */
    }
  }

  // 4. Re-run pod prep to get materialised paths (mcpConfigPath, settingsPath,
  //    pluginDir). If this throws the pod is effectively un-usable — skip.
  let podPrep: ReturnType<typeof preparePodSpawn>;
  try {
    podPrep = preparePodSpawn({
      agentName: row.podName,
      projectId: row.projectId,
      worktreeDir: row.worktreeDir ?? '',
      scratchDir,
      workItem,
      identity: {
        agentSessionId: row.ccSessionId,
        agentRunId: row.id,
        dispatcherSessionId: row.dispatcherSessionId,
        parentWorkItemId: row.parentWorkItemId ?? '',
        invokeDepth: row.parentInvokeDepth ?? 1,
      },
    });
  } catch {
    return 'skip';
  }
  if (!podPrep) return 'skip';

  // 5. Rebuild the PC_AGENT_* core env from the row — all vars are derivable.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...podPrep.extraEnv,
    PC_AGENT_NAME: row.podName,
    PC_AGENT_SESSION_ID: row.ccSessionId,
    PC_AGENT_RUN_ID: row.id,
    PC_DISPATCHER_SESSION_ID: row.dispatcherSessionId,
    PC_PROJECT_ID: row.projectId,
    PC_AGENT_INVOKE_DEPTH: String(row.parentInvokeDepth ?? 1),
  };
  if (row.parentWorkItemId) {
    env.PC_AGENT_PARENT_WORK_ITEM_ID = row.parentWorkItemId;
    env.PC_AGENT_WORK_ITEM_ID = row.parentWorkItemId;
  }

  // 6. Reconstruct the start-run request with the SAME runId (preserves the
  //    contract link and ccSessionId — the agent continues from where it was
  //    queued, not as a fresh run).
  const worktreeDir = row.worktreeDir ?? '';
  const request = {
    runId: row.id,
    projectId: row.projectId,
    dispatcherSessionId: row.dispatcherSessionId,
    ccSessionId: row.ccSessionId,
    podDefinition: {
      name: podPrep.agentCliName,
      logicalName: row.podName,
    },
    worktreePath: worktreeDir,
    env,
    initialInput: row.input ?? '',
    mcpConfigPath: podPrep.mcpConfigPath,
    settingsPath: podPrep.settingsPath,
    settingSources: podPrep.settingSources,
    pluginDirs: [podPrep.pluginDir] as readonly string[],
    transcriptPath: resolve(scratchDir, 'transcript.log'),
    jsonlPath: jsonlPathFor(worktreeDir, row.ccSessionId),
  };

  // 7. Send to the current live host. Any error → 'failed' (caller may retry).
  try {
    const response = await hostClient.sendCommand({ type: 'start-run', request });
    if (!response || !response.ok) return 'failed';
    return 're-sent';
  } catch {
    return 'failed';
  } finally {
    // Release the materialised pod files (mcp.json, plugin .md) after send.
    // They are ephemeral per-spawn; the host has already received the paths.
    podPrep.cleanup();
  }
}
