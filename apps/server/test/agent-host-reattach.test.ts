// Slice 009 OBJ-2A C-coherence — the reconcile sweep + applyAgentHostEvent
// run-state case must ALSO re-seed a registered HostBackedActiveRunHandle so
// its snapshot stops being a stale lie. Convenience only (no gate reads it),
// but it keeps display/getState() callers + the OBJ-2 markPaused path coherent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import type { AgentRunRow, ULID } from '@pc/domain';
import type {
  AgentHostCommand,
  AgentHostCommandResponse,
  AgentHostEvent,
  AgentHostRunSnapshot,
} from '@pc/runtime';

import {
  ActiveRunRegistry,
  HostBackedActiveRunHandle,
} from '../src/services/agent-active-runs.ts';
import {
  applyAgentHostEvent,
  reconcileAgentRunsAgainstHost,
  type AgentHostReattachClient,
} from '../src/services/agent-host-reattach.ts';

class FakeHostClient extends EventEmitter implements AgentHostReattachClient {
  commands: AgentHostCommand[] = [];
  constructor(private readonly runs: AgentHostRunSnapshot[]) {
    super();
  }
  listRuns(): readonly AgentHostRunSnapshot[] {
    return this.runs;
  }
  sendCommand(command: AgentHostCommand): AgentHostCommandResponse | void {
    this.commands.push(command);
  }
  onEvent(listener: (event: AgentHostEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

function row(id: string, patch: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: id as ULID,
    projectId: '01KHOSTPROJECT00000000001' as ULID,
    dispatcherSessionId: 'orch-session',
    ccSessionId: `cc-${id}`,
    podName: 'researcher',
    podRevisionAtDispatch: 'agent:1',
    podRevisionAtResume: null,
    status: 'queued',
    continues: null,
    parentInvokeDepth: 0,
    parentWorkItemId: null,
    input: 'input',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: 1_700_000_000_000,
    spawnedAt: null,
    readyAt: null,
    pid: null,
    lastActivityAt: null,
    completedAt: null,
    rev: 0,
    ...patch,
  };
}

function hostRun(
  id: string,
  state: AgentHostRunSnapshot['state'] = 'running',
  patch: Partial<AgentHostRunSnapshot> = {},
): AgentHostRunSnapshot {
  return {
    runId: id as ULID,
    projectId: '01KHOSTPROJECT00000000001' as ULID,
    dispatcherSessionId: 'orch-session',
    ccSessionId: `cc-${id}`,
    podName: 'researcher',
    worktreeDir: 'E:/worktree',
    state,
    jsonlPath: null,
    transcriptPath: null,
    queuedAt: 1_700_000_000_000,
    spawnedAt: 1_700_000_000_100,
    readyAt: 1_700_000_000_200,
    updatedAt: 1_700_000_000_300,
    terminalAt: null,
    ...patch,
  };
}

function registerHostHandle(
  registry: ActiveRunRegistry,
  host: FakeHostClient,
  seed: AgentHostRunSnapshot,
): HostBackedActiveRunHandle {
  const handle = new HostBackedActiveRunHandle(seed, host);
  registry.register({
    run: handle,
    projectId: seed.projectId,
    dispatcherSessionId: seed.dispatcherSessionId,
    ccSessionId: seed.ccSessionId,
    podName: seed.podName,
    parentWorkItemId: null,
    podRevisionAtDispatch: null,
  });
  return handle;
}

test('reconcileAgentRunsAgainstHost re-seeds a registered host handle on a non-terminal sweep (C-coherence)', () => {
  let currentRow = row('run-coherence', { status: 'spawning' });
  const host = new FakeHostClient([hostRun('run-coherence', 'running')]);
  const registry = new ActiveRunRegistry();
  // Handle is stale at `spawning` (the live-bug state).
  const handle = registerHostHandle(
    registry,
    host,
    hostRun('run-coherence', 'spawning'),
  );
  assert.equal(handle.getState(), 'spawning');

  const res = reconcileAgentRunsAgainstHost({
    hostClient: host,
    activeRunRegistry: registry,
    listNonTerminalRuns: () => [currentRow],
    getAgentRun: () => currentRow,
    updateStatus: (input) => {
      currentRow = { ...currentRow, status: input.status };
    },
    broadcast: () => {},
  });

  assert.equal(res.statusUpdated, 1);
  // The handle snapshot is now coherent with the reconciled host state.
  assert.equal(handle.getState(), 'running');
});

test('applyAgentHostEvent run-state case re-seeds a registered host handle', () => {
  let currentRow = row('run-event-coherence', { status: 'spawning' });
  const host = new FakeHostClient([]);
  const registry = new ActiveRunRegistry();
  const handle = registerHostHandle(
    registry,
    host,
    hostRun('run-event-coherence', 'spawning'),
  );
  assert.equal(handle.getState(), 'spawning');

  const res = applyAgentHostEvent(
    { seq: 1, type: 'run-state', run: hostRun('run-event-coherence', 'running') },
    {
      activeRunRegistry: registry,
      getAgentRun: () => currentRow,
      updateStatus: (input) => {
        currentRow = { ...currentRow, status: input.status };
      },
      broadcast: () => {},
    },
  );

  assert.equal(res.statusUpdated, 1);
  assert.equal(handle.getState(), 'running');
});
