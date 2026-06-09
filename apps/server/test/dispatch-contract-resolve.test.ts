// Slice 019 — resolveContractForDispatch is contract-first: it ALWAYS yields a
// contract (no WI required), reuses an open contract on an attached WI, and lets
// an explicit expectedOutput win over the linked WI's columns.
// pc-pty-chat-303 — explicit expectedOutput must never be silently dropped when
// a WI already has a contract; the new spec lands on a fresh contract.
//
// Issue 4 fix — approveAgentContract + rejectAgentContract cover the
// contract-only (no linked WI) approve/reject path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Defensive: some transitive imports read PC_DATA_DIR at load time.
process.env.PC_DATA_DIR = mkdtempSync(join(tmpdir(), 'pc-dispatch-resolve-'));

const { resolveContractForDispatch } = await import('../src/services/agent-run-factory.ts');
const { approveAgentContract, rejectAgentContract, VerificationReviewError } = await import(
  '../src/services/agent-verification-review.ts'
);

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

// ── Issue 4 — contract-only approve + reject ──────────────────────────────────

/** Build a fake ContractService stub for approve/reject tests. */
function fakeContractService(contract: any) {
  const verifications: any[] = [];
  return {
    service: {
      get: (id: string) => (id === contract.id ? contract : null),
      setVerification(input: any) { verifications.push(input); },
    } as any,
    verifications,
  };
}

test('[Issue4] approveAgentContract: flips contract status + returns null (no WI)', () => {
  const { service, verifications } = fakeContractService({
    id: 'C-ONLY',
    status: 'verifying',
    workItemId: null,
    agentRunId: 'R1',
    projectId: 'P1',
  });

  const result = approveAgentContract(
    { contractId: 'C-ONLY' as any },
    { contractService: service },
  );

  assert.equal(result, null, 'no work item → always null');
  assert.equal(verifications.length, 1);
  assert.equal(verifications[0].id, 'C-ONLY');
  assert.equal(verifications[0].verificationStatus, 'passed');
});

test('[Issue4] approveAgentContract: 404 when contract not found', () => {
  const { service } = fakeContractService({ id: 'OTHER', status: 'verifying', workItemId: null, agentRunId: null, projectId: 'P1' });

  assert.throws(
    () => approveAgentContract({ contractId: 'MISSING' as any }, { contractService: service }),
    (err: any) => err instanceof VerificationReviewError && err.cause === 'wi-not-found',
  );
});

test('[Issue4] approveAgentContract: 409 when contract not in verifying status', () => {
  const { service } = fakeContractService({ id: 'C-DONE', status: 'accepted', workItemId: null, agentRunId: null, projectId: 'P1' });

  assert.throws(
    () => approveAgentContract({ contractId: 'C-DONE' as any }, { contractService: service }),
    (err: any) => err instanceof VerificationReviewError && err.cause === 'not-awaiting-verification',
  );
});

test('[Issue4] rejectAgentContract: flips contract to rejected + spawns continuation', async () => {
  const { service, verifications } = fakeContractService({
    id: 'C-ONLY',
    status: 'verifying',
    workItemId: null,
    agentRunId: 'R-PARENT',
    projectId: 'P1',
  });

  const continuationCalls: any[] = [];
  const fakeDispatch = async (input: any) => {
    continuationCalls.push(input);
    return { ok: true as const, agentRunId: 'R-CONTINUATION' };
  };

  const result = await rejectAgentContract(
    {
      contractId: 'C-ONLY' as any,
      feedback: 'needs more detail',
      dispatcherSessionId: 'sess-123',
      project: { id: 'P1', folderPath: '/tmp/p1', slug: 'p1' } as any,
    },
    {
      contractService: service,
      dispatch: fakeDispatch as any,
    },
  );

  assert.equal(result.workItem, null, 'no WI linked → workItem null');
  assert.ok(result.contract, 'contract returned');
  assert.equal(verifications.length, 1);
  assert.equal(verifications[0].verificationStatus, 'failed');
  assert.equal(verifications[0].verificationNotes, 'needs more detail');
  assert.equal(continuationCalls.length, 1);
  assert.equal(continuationCalls[0].parentAgentRunId, 'R-PARENT');
  // No workItemId in continuation — contract-only hold.
  assert.equal(continuationCalls[0].workItemId, undefined);
});

test('[Issue4] rejectAgentContract: throws feedback-required when feedback is empty', async () => {
  const { service } = fakeContractService({
    id: 'C-ONLY',
    status: 'verifying',
    workItemId: null,
    agentRunId: 'R1',
    projectId: 'P1',
  });

  await assert.rejects(
    () => rejectAgentContract(
      {
        contractId: 'C-ONLY' as any,
        feedback: '  ',
        dispatcherSessionId: 'sess',
        project: { id: 'P1', folderPath: '/tmp', slug: 'p1' } as any,
      },
      { contractService: service, dispatch: async () => ({ ok: true, agentRunId: 'R' }) as any },
    ),
    (err: any) => err instanceof VerificationReviewError && err.cause === 'feedback-required',
  );
});
