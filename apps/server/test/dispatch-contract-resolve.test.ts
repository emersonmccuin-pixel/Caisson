// Slice 019 — resolveContractForDispatch is contract-first: it ALWAYS yields a
// contract (no WI required), reuses an open contract on an attached WI, and lets
// an explicit expectedOutput win over the linked WI's columns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Defensive: some transitive imports read PC_DATA_DIR at load time.
process.env.PC_DATA_DIR = mkdtempSync(join(tmpdir(), 'pc-dispatch-resolve-'));

const { resolveContractForDispatch } = await import('../src/services/agent-run-factory.ts');

function fakeService() {
  const created: any[] = [];
  const setRun: Array<[string, string]> = [];
  const service = {
    create(input: any) {
      created.push(input);
      return { id: 'C-NEW', ...input };
    },
    setRun(id: string, runId: string) {
      setRun.push([id, runId]);
      return {};
    },
  } as any;
  return { service, created, setRun };
}

test('no work item → still creates a contract + links the run', () => {
  const { service, created, setRun } = fakeService();
  const setContract: Array<[string, string]> = [];
  const id = resolveContractForDispatch(
    { projectId: 'P1' as any, workItemId: null, agentRunId: 'R1' as any, podName: 'researcher', contractService: service },
    {
      listContractsForWorkItem: (() => []) as any,
      getWorkItem: (() => null) as any,
      setAgentRunContractId: ((r: string, c: string) => setContract.push([r, c])) as any,
    },
  );
  assert.equal(id, 'C-NEW');
  assert.equal(created.length, 1);
  assert.equal(created[0].workItemId, null);
  assert.deepEqual(setRun, [['C-NEW', 'R1']]);
  assert.deepEqual(setContract, [['R1', 'C-NEW']]);
});

test('explicit expectedOutput wins over the WI columns', () => {
  const { service, created } = fakeService();
  resolveContractForDispatch(
    {
      projectId: 'P1' as any,
      workItemId: null,
      agentRunId: 'R1' as any,
      podName: 'researcher',
      contractService: service,
      expectedOutput: { kind: 'answer' } as any,
    },
    { listContractsForWorkItem: (() => []) as any, getWorkItem: (() => null) as any, setAgentRunContractId: (() => {}) as any },
  );
  assert.equal(created[0].expectedOutput.kind, 'answer');
});

test('attached WI with an open contract → reuse it, no new create', () => {
  const { service, created } = fakeService();
  const id = resolveContractForDispatch(
    { projectId: 'P1' as any, workItemId: 'W1' as any, agentRunId: 'R2' as any, podName: 'x', contractService: service },
    {
      listContractsForWorkItem: (() => [{ id: 'C-EXIST', agentRunId: null }]) as any,
      getWorkItem: (() => null) as any,
      setAgentRunContractId: (() => {}) as any,
    },
  );
  assert.equal(id, 'C-EXIST');
  assert.equal(created.length, 0);
});
