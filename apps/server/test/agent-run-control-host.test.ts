// T1.3 — host-aware hardKillAgentRun. With a `host` dep, kill AWAITS a host
// `cancel` (by runId) before the local pid-kill, so a host-backed run (pid null)
// actually terminates instead of orphaning compute. Host errors are swallowed —
// the local kill + idempotent finalize stay the net.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRunRow, AgentRunStatus, ULID } from '@pc/domain';

import {
  hardKillAgentRun,
  type AgentRunControlDeps,
} from '../src/services/agent-run-control.ts';

function row(patch: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: 'run-1' as ULID,
    projectId: 'proj-1' as ULID,
    dispatcherSessionId: 'disp-1',
    ccSessionId: 'cc-1',
    podName: 'planner',
    podRevisionAtDispatch: null,
    podRevisionAtResume: null,
    status: 'running' as AgentRunStatus,
    continues: null,
    parentInvokeDepth: 0,
    parentWorkItemId: null,
    input: 'go',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: 1,
    spawnedAt: 2,
    readyAt: 3,
    pid: null,
    lastActivityAt: 3,
    completedAt: null,
    rev: 0,
    ...patch,
  };
}

type SentCommand = { type: string; runId?: string; pcSessionId?: string };

function fakeHost(commands: SentCommand[], opts: { throwOnSend?: boolean } = {}) {
  return {
    listRuns: () => [],
    sendCommand: async (cmd: SentCommand) => {
      commands.push(cmd);
      if (opts.throwOnSend) throw new Error('host send failed');
      return { ok: true } as never;
    },
  } as never;
}

test('T1.3 host-backed kill (pid null) issues host cancel, finalizes, reports hostCancelled', async () => {
  const commands: SentCommand[] = [];
  let finalized = 0;
  const deps: AgentRunControlDeps = {
    getAgentRun: () => row({ pid: null }),
    activeRunRegistry: { get: () => null } as never,
    host: fakeHost(commands),
    killProcess: () => assert.fail('host run has null pid — no local kill'),
    applyTerminalEffects: () => {
      finalized += 1;
      return { applied: 1 };
    },
  };
  const res = await hardKillAgentRun('run-1' as ULID, deps);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.hostCancelled, true);
    assert.equal(res.processKilled, false);
  }
  assert.deepEqual(commands, [{ type: 'cancel', runId: 'run-1' }]);
  assert.equal(finalized, 1, 'row force-finalized (idempotent net)');
});

test('T1.3 workflow-dispatched run (wf- dispatcher) issues a plain cancel by runId (door unified)', async () => {
  // Post door-unification, a workflow agent run is a normal host run keyed by
  // runId — no `cancel-workflow-subagent` special-case for the `wf-` dispatcher.
  const commands: SentCommand[] = [];
  const deps: AgentRunControlDeps = {
    getAgentRun: () => row({ pid: null, dispatcherSessionId: 'wf-abc-node1-def' }),
    activeRunRegistry: { get: () => null } as never,
    host: fakeHost(commands),
    applyTerminalEffects: () => ({ applied: 1 }),
  };
  const res = await hardKillAgentRun('run-1' as ULID, deps);
  assert.equal(res.ok, true);
  assert.deepEqual(commands, [{ type: 'cancel', runId: 'run-1' }]);
});

test('T1.3 no host + a pid → existing local-kill behavior (regression guard)', async () => {
  const killed: number[] = [];
  let finalized = 0;
  const deps: AgentRunControlDeps = {
    getAgentRun: () => row({ pid: 7777 }),
    activeRunRegistry: { get: () => null } as never,
    killProcess: (pid) => killed.push(pid),
    applyTerminalEffects: () => {
      finalized += 1;
      return { applied: 1 };
    },
  };
  const res = await hardKillAgentRun('run-1' as ULID, deps);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.processKilled, true);
    assert.equal(res.hostCancelled, false, 'no host dep → no host cancel');
  }
  assert.deepEqual(killed, [7777]);
  assert.equal(finalized, 1);
});

test('T1.3 host sendCommand throws → swallowed; row still finalized', async () => {
  const commands: SentCommand[] = [];
  let finalized = 0;
  const deps: AgentRunControlDeps = {
    getAgentRun: () => row({ pid: null }),
    activeRunRegistry: { get: () => null } as never,
    host: fakeHost(commands, { throwOnSend: true }),
    applyTerminalEffects: () => {
      finalized += 1;
      return { applied: 1 };
    },
  };
  const res = await hardKillAgentRun('run-1' as ULID, deps);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.hostCancelled, false, 'throw → not acked');
  assert.equal(finalized, 1, 'finalize still runs — the net holds');
});

test('T1.3 already-terminal run → no host command, idempotent ok', async () => {
  const commands: SentCommand[] = [];
  const res = await hardKillAgentRun('run-1' as ULID, {
    getAgentRun: () => row({ status: 'completed', pid: null }),
    host: fakeHost(commands),
    applyTerminalEffects: () => assert.fail('no finalize on already-terminal'),
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.alreadyTerminal, true);
    assert.equal(res.hostCancelled, false);
  }
  assert.deepEqual(commands, [], 'no host command for a terminal run');
});
