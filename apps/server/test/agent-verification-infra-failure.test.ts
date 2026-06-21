// pc-pty-chat-437 Fix D — INFRA_FAILURE_CAUSES split in runVerificationOnTerminal.
// Infrastructure causes → verificationStatus: 'pending' (contract reusable).
// Agent causes / null → verificationStatus: 'failed' (existing behavior).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { ULID } from '@pc/domain';
import type { ContractService } from '@pc/app-services';

import {
  runVerificationOnTerminal,
  type RunVerificationInput,
} from '../src/services/agent-verification.ts';

// Minimal ContractService stub that stores a contract and records setVerification calls.
function makeContractStub(extra: Partial<{
  workItemId: ULID | null;
  verificationTier: import('@pc/domain').VerificationTier;
}> = {}) {
  const calls: Parameters<ContractService['setVerification']>[0][] = [];
  const stub = {
    get: (_id: ULID) => ({
      id: 'contract-01' as ULID,
      workItemId: extra.workItemId ?? null,
      verificationTier: extra.verificationTier ?? 'auto',
      expectedOutput: { kind: 'answer' },
      acceptanceCriteria: null,
      status: 'pending' as const,
      attempt: 1,
    }),
    setVerification: (args: Parameters<ContractService['setVerification']>[0]) => {
      calls.push(args);
    },
  } as unknown as ContractService;
  return { stub, calls };
}

function makeInput(
  overrides: Partial<RunVerificationInput> = {},
): RunVerificationInput {
  return {
    contractId: 'contract-01' as ULID,
    terminalStatus: 'failed',
    failureCause: null,
    failureReason: 'some error',
    projectFolderPath: '/fake/project',
    worktreeDir: '/fake/worktree',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 4b-1: Infrastructure causes -> verificationStatus: 'pending'
// ---------------------------------------------------------------------------

const INFRA_CAUSES = [
  'host-lost',
  'host-unavailable',
  'host-crashed',
  'host-protocol-error',
  'host-rejected',
  'server-restart',
] as const;

for (const cause of INFRA_CAUSES) {
  test('4b-infra: ' + cause + ' -> verificationStatus pending (no rejection)', async () => {
    const { stub, calls } = makeContractStub();
    const result = await runVerificationOnTerminal(
      makeInput({ failureCause: cause as import('@pc/domain').AgentRunFailureCause }),
      { contractService: stub },
    );

    assert.ok(result, 'result not null');
    assert.equal(result!.verificationStatus, 'pending', 'status is pending for infra cause');
    assert.equal(calls.length, 1, 'setVerification called once');
    assert.equal(calls[0]!.verificationStatus, 'pending');
    assert.ok(
      calls[0]!.verificationNotes?.includes(cause),
      'notes mention the cause',
    );
  });
}

// ---------------------------------------------------------------------------
// 4b-2: Agent cause (idle-timeout) -> verificationStatus: 'failed'
// ---------------------------------------------------------------------------

test('4b-agent: idle-timeout -> verificationStatus failed (existing behavior)', async () => {
  const { stub, calls } = makeContractStub();
  const result = await runVerificationOnTerminal(
    makeInput({ failureCause: 'idle-timeout' as import('@pc/domain').AgentRunFailureCause }),
    { contractService: stub },
  );

  assert.ok(result);
  assert.equal(result!.verificationStatus, 'failed');
  assert.equal(calls[0]!.verificationStatus, 'failed');
});

// ---------------------------------------------------------------------------
// 4b-3: null cause -> verificationStatus: 'failed' (preserve prior behavior)
// ---------------------------------------------------------------------------

test('4b-null: null failureCause -> verificationStatus failed', async () => {
  const { stub, calls } = makeContractStub();
  const result = await runVerificationOnTerminal(
    makeInput({ failureCause: null }),
    { contractService: stub },
  );

  assert.ok(result);
  assert.equal(result!.verificationStatus, 'failed');
  assert.equal(calls[0]!.verificationStatus, 'failed');
});

// ---------------------------------------------------------------------------
// 4b-4: cancelled -> no contract update (preserve existing behaviour)
// ---------------------------------------------------------------------------

test('4b-cancelled: cancelled status -> null (no contract mutation)', async () => {
  const { stub, calls } = makeContractStub();
  const result = await runVerificationOnTerminal(
    makeInput({ terminalStatus: 'cancelled' }),
    { contractService: stub },
  );

  // cancelled returns null — no verification, no setVerification call
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});
