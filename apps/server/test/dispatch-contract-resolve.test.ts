// Slice 019 — resolveContractForDispatch is contract-first: it ALWAYS yields a
// contract (no WI required), reuses an open contract on an attached WI, and lets
// an explicit expectedOutput win over the linked WI's columns.
// pc-pty-chat-303 — explicit expectedOutput must never be silently dropped when
// a WI already has a contract; the new spec lands on a fresh contract.

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

// ── pc-pty-chat-303 regression ────────────────────────────────────────────────

test('[303] explicit expectedOutput + WI has dispatched contract of different kind → new contract, spec preserved', () => {
  // WI already carries a dispatched 'answer' contract from a prior run.
  // Re-dispatch with kind 'repo' must produce a FRESH contract — not reuse
  // the stale 'answer' one.
  const { service, created } = fakeService();
  const id = resolveContractForDispatch(
    {
      projectId: 'P1' as any,
      workItemId: 'W1' as any,
      agentRunId: 'R2' as any,
      podName: 'coder',
      contractService: service,
      expectedOutput: { kind: 'repo', isolation: 'in_place' } as any,
    },
    {
      listContractsForWorkItem: (() => [
        { id: 'C-OLD', agentRunId: 'R1', expectedOutput: { kind: 'answer' } },
      ]) as any,
      getWorkItem: (() => null) as any,
      setAgentRunContractId: (() => {}) as any,
    },
  );
  assert.equal(id, 'C-NEW');
  assert.equal(created.length, 1, 'fresh contract must be created');
  assert.equal(created[0].expectedOutput.kind, 'repo', 'new spec must be repo, not the stale answer');
});

test('[303] explicit expectedOutput + WI has undispatched contract → still mints fresh (correctness over reuse)', () => {
  // An un-dispatched (open) contract exists but already has a spec; the new
  // dispatch carries a different spec — must not reuse the stale one.
  const { service, created } = fakeService();
  const id = resolveContractForDispatch(
    {
      projectId: 'P1' as any,
      workItemId: 'W1' as any,
      agentRunId: 'R2' as any,
      podName: 'coder',
      contractService: service,
      expectedOutput: { kind: 'repo', isolation: 'in_place' } as any,
    },
    {
      listContractsForWorkItem: (() => [
        { id: 'C-OPEN', agentRunId: null, expectedOutput: { kind: 'prose' } },
      ]) as any,
      getWorkItem: (() => null) as any,
      setAgentRunContractId: (() => {}) as any,
    },
  );
  assert.equal(id, 'C-NEW');
  assert.equal(created.length, 1, 'fresh contract must be created');
  assert.equal(created[0].expectedOutput.kind, 'repo');
});

// ── 2026-06-07 empty-contract guard ───────────────────────────────────────────

test('requireExpectedOutput: pod with no default + no inline spec → null (abort, no create)', () => {
  // A custom pod (not in the stock default table) dispatched with no spec must
  // NOT mint a spec-less contract — resolveContractForDispatch returns null so
  // the fresh-dispatch path aborts with a typed refusal.
  const { service, created } = fakeService();
  const id = resolveContractForDispatch(
    {
      projectId: 'P1' as any,
      workItemId: null,
      agentRunId: 'R1' as any,
      podName: 'snowflake-expert',
      contractService: service,
      requireExpectedOutput: true,
    },
    {
      listContractsForWorkItem: (() => []) as any,
      getWorkItem: (() => null) as any,
      setAgentRunContractId: (() => {}) as any,
      // No stored pod-row default — forces the chain to end in null.
      getPodRowExpectedOutput: (() => null) as any,
    },
  );
  assert.equal(id, null, 'no resolvable spec → null');
  assert.equal(created.length, 0, 'must not create a spec-less contract');
});

test('requireExpectedOutput: explicit inline spec on a custom pod → still creates', () => {
  const { service, created } = fakeService();
  const id = resolveContractForDispatch(
    {
      projectId: 'P1' as any,
      workItemId: null,
      agentRunId: 'R1' as any,
      podName: 'snowflake-expert',
      contractService: service,
      expectedOutput: { kind: 'answer', must_address: ['summary'] } as any,
      requireExpectedOutput: true,
    },
    {
      listContractsForWorkItem: (() => []) as any,
      getWorkItem: (() => null) as any,
      setAgentRunContractId: (() => {}) as any,
      getPodRowExpectedOutput: (() => null) as any,
    },
  );
  assert.equal(id, 'C-NEW');
  assert.equal(created.length, 1);
  assert.equal(created[0].verificationTier, 'auto', 'tier written explicitly, not left null');
});

test('[303] no explicit expectedOutput + WI has dispatched contract → reuse (continuation path unchanged)', () => {
  // pc_continue_agent passes no expectedOutput — must still reuse.
  const { service, created } = fakeService();
  const id = resolveContractForDispatch(
    { projectId: 'P1' as any, workItemId: 'W1' as any, agentRunId: 'R3' as any, podName: 'coder', contractService: service },
    {
      listContractsForWorkItem: (() => [
        { id: 'C-DISPATCHED', agentRunId: 'R1', expectedOutput: { kind: 'answer' } },
      ]) as any,
      getWorkItem: (() => null) as any,
      setAgentRunContractId: (() => {}) as any,
    },
  );
  assert.equal(id, 'C-DISPATCHED');
  assert.equal(created.length, 0, 'must reuse, not create');
});
