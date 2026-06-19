// pc-pty-chat-270 Chunk B -- dag-run-service mergeToIntegration (step 6).
// Tests the mergeToIntegration closure via a fake WorktreeService.
// Pure unit coverage of the idempotent reconcile logic branches — no DB or real git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowV2 } from '@pc/domain';
import type { WorktreeService } from '../src/services/worktree.ts';

type MergeOutcome = { outcome: 'merged' | 'conflict' | 'failed'; error?: string };

/** Mirrors the mergeToIntegration closure from dag-run-service.ts with injected fakes. */
function makeMergeToIntegration(
  branch: string,
  fakeWorktrees: Pick<
    WorktreeService,
    'mergeState' | 'mergeBranchIntoIntegration' | 'pushIntegration' | 'integrationBranch'
  >,
  events: Array<{ type: string; into?: string }>,
): (node: WorkflowV2.MergeNode) => Promise<MergeOutcome> {
  return async (node) => {
    let into: string;
    try {
      into = await fakeWorktrees.integrationBranch();
    } catch (err) {
      return { outcome: 'failed', error: (err as Error).message };
    }
    const emitConflict = (): void => { events.push({ type: 'git_conflict' }); };
    try {
      const state = await fakeWorktrees.mergeState(branch);
      if (state.mergeInProgress) { emitConflict(); return { outcome: 'conflict' }; }
      if (state.alreadyMerged) {
        if (!state.pushed) {
          try {
            await fakeWorktrees.pushIntegration(branch);
          } catch (pushErr) {
            const msg = (pushErr as Error).message ?? '';
            if (/rejected|non-fast-forward/i.test(msg)) { emitConflict(); return { outcome: 'conflict' }; }
            return { outcome: 'failed', error: msg };
          }
          const afterPush = await fakeWorktrees.mergeState(branch);
          if (!afterPush.pushed) return { outcome: 'failed', error: `origin/${into} != ${into}` };
        }
        events.push({ type: 'git_merged', into });
        return { outcome: 'merged' };
      }
      await fakeWorktrees.mergeBranchIntoIntegration(branch);
      const afterMerge = await fakeWorktrees.mergeState(branch);
      if (!afterMerge.alreadyMerged) {
        return { outcome: 'failed', error: `branch tip not ancestor of ${into}` };
      }
      try {
        await fakeWorktrees.pushIntegration(branch);
      } catch (pushErr) {
        const msg = (pushErr as Error).message ?? '';
        if (/rejected|non-fast-forward/i.test(msg)) { emitConflict(); return { outcome: 'conflict' }; }
        return { outcome: 'failed', error: msg };
      }
      const afterPush2 = await fakeWorktrees.mergeState(branch);
      if (!afterPush2.pushed) return { outcome: 'failed', error: `origin/${into} != ${into}` };
      events.push({ type: 'git_merged', into });
      return { outcome: 'merged' };
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown error';
      if (/conflict|CONFLICT|Automatic merge failed/i.test(msg)) {
        emitConflict();
        return { outcome: 'conflict' };
      }
      return { outcome: 'failed', error: msg };
    }
  };
}

const mergeNode: WorkflowV2.MergeNode = { id: 'merge', kind: 'merge' };
const DEV = async () => 'dev';

test('alreadyMerged + pushed: idempotent path returns merged without merge or push', async () => {
  let mergeCalled = false;
  let pushCalled = false;
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToIntegration('agent-AAAA1234', {
    integrationBranch: DEV,
    mergeState: async () => ({ alreadyMerged: true, mergeInProgress: false, pushed: true }),
    mergeBranchIntoIntegration: async () => { mergeCalled = true; },
    pushIntegration: async () => { pushCalled = true; },
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'merged');
  assert.ok(!mergeCalled, 'merge not called when already merged + pushed');
  assert.ok(!pushCalled, 'push not called when already pushed');
  assert.ok(events.some((e) => e.type === 'git_merged'));
});

test('resolver failure: node fails LOUDLY with the fix-it message, nothing attempted', async () => {
  let mergeCalled = false;
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToIntegration('agent-NOBR0000', {
    integrationBranch: async () => {
      throw new Error('cannot detect an integration branch for project "x" — set one in Project Settings');
    },
    mergeState: async () => { throw new Error('should not be called'); },
    mergeBranchIntoIntegration: async () => { mergeCalled = true; },
    pushIntegration: async () => {},
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'failed');
  assert.match(result.error ?? '', /Project Settings/, 'fix-it pointer surfaces on the run');
  assert.ok(!mergeCalled, 'no git work attempted without a merge target');
});

test('mergeInProgress: returns conflict without calling merge', async () => {
  let mergeCalled = false;
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToIntegration('agent-BBBB5678', {
    integrationBranch: DEV,
    mergeState: async () => ({ alreadyMerged: false, mergeInProgress: true, pushed: false }),
    mergeBranchIntoIntegration: async () => { mergeCalled = true; },
    pushIntegration: async () => {},
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'conflict');
  assert.ok(!mergeCalled, 'merge not called when MERGE_HEAD present');
  assert.ok(events.some((e) => e.type === 'git_conflict'));
});

test('fresh merge + push + verify: returns merged with the integration branch on the receipt', async () => {
  let merged = false;
  let pushed = false;
  let stateCallCount = 0;
  const events: Array<{ type: string; into?: string }> = [];
  const fn = makeMergeToIntegration('agent-CCCC9012', {
    integrationBranch: async () => 'reporting-rebuild-phase2',
    mergeState: async () => {
      stateCallCount += 1;
      if (stateCallCount === 1) return { alreadyMerged: false, mergeInProgress: false, pushed: false };
      if (stateCallCount === 2) return { alreadyMerged: true, mergeInProgress: false, pushed: false };
      return { alreadyMerged: true, mergeInProgress: false, pushed: true };
    },
    mergeBranchIntoIntegration: async () => { merged = true; },
    pushIntegration: async () => { pushed = true; },
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'merged');
  assert.ok(merged, 'merge was called');
  assert.ok(pushed, 'push was called');
  assert.equal(stateCallCount, 3, 'mergeState checked three times (before, after merge, after push)');
  const receipt = events.find((e) => e.type === 'git_merged');
  assert.equal(receipt?.into, 'reporting-rebuild-phase2', 'receipt names the real merge target');
});

test('push rejected: returns conflict', async () => {
  let stateCallCount = 0;
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToIntegration('agent-DDDD3456', {
    integrationBranch: DEV,
    mergeState: async () => {
      stateCallCount += 1;
      if (stateCallCount === 1) return { alreadyMerged: false, mergeInProgress: false, pushed: false };
      return { alreadyMerged: true, mergeInProgress: false, pushed: false };
    },
    mergeBranchIntoIntegration: async () => {},
    pushIntegration: async () => { throw new Error('rejected: non-fast-forward'); },
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'conflict', 'push rejection triggers conflict outcome');
  assert.ok(events.some((e) => e.type === 'git_conflict'));
});

test('merge throws conflict error: returns conflict', async () => {
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToIntegration('agent-EEEE7890', {
    integrationBranch: DEV,
    mergeState: async () => ({ alreadyMerged: false, mergeInProgress: false, pushed: false }),
    mergeBranchIntoIntegration: async () => { throw new Error('Automatic merge failed; fix conflicts'); },
    pushIntegration: async () => {},
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'conflict');
  assert.ok(events.some((e) => e.type === 'git_conflict'));
});

test('guard violation (non-conflict error from mergeBranchIntoIntegration): returns failed, not conflict', async () => {
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToIntegration('agent-GGGG1234', {
    integrationBranch: DEV,
    mergeState: async () => ({ alreadyMerged: false, mergeInProgress: false, pushed: false }),
    mergeBranchIntoIntegration: async () => {
      // Precondition guard in WorktreeService.mergeBranchIntoIntegration throws this:
      throw new Error('MERGE GUARD: merge worktree is on branch "main", expected detached HEAD or "dev" — refusing to merge');
    },
    pushIntegration: async () => {},
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'failed', 'guard violation must return failed, not conflict');
  assert.match(result.error ?? '', /MERGE GUARD/, 'error message carries the guard detail');
  assert.ok(!events.some((e) => e.type === 'git_conflict'), 'no conflict event for a guard violation');
});

test('alreadyMerged but not pushed: pushes and verifies receipt', async () => {
  let pushed = false;
  let stateCallCount = 0;
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToIntegration('agent-FFFF2345', {
    integrationBranch: DEV,
    mergeState: async () => {
      stateCallCount += 1;
      if (stateCallCount === 1) return { alreadyMerged: true, mergeInProgress: false, pushed: false };
      return { alreadyMerged: true, mergeInProgress: false, pushed: true };
    },
    mergeBranchIntoIntegration: async () => { throw new Error('should not be called'); },
    pushIntegration: async () => { pushed = true; },
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'merged');
  assert.ok(pushed, 'push was called to close the idempotent gap');
  assert.ok(events.some((e) => e.type === 'git_merged'));
});

test('legacy target: "dev" still type-checks and validates on stored defs', () => {
  // Stored workflow defs + run snapshots carry `target: 'dev'` — the field is
  // optional-legacy, never read by the engine.
  const legacy: WorkflowV2.MergeNode = { id: 'm', kind: 'merge', target: 'dev' };
  assert.equal(legacy.target, 'dev');
});
