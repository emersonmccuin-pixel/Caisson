// pc-pty-chat-270 Chunk B -- dag-run-service mergeToDev (step 6).
// Tests the mergeToDev closure via a fake WorktreeService.
// Pure unit coverage of the idempotent reconcile logic branches — no DB or real git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowV2 } from '@pc/domain';
import type { WorktreeService } from '../src/services/worktree.ts';

type MergeOutcome = { outcome: 'merged' | 'conflict' | 'failed'; error?: string };

/** Mirrors the mergeToDev closure from dag-run-service.ts with injected fakes. */
function makeMergeToDev(
  branch: string,
  fakeWorktrees: Pick<WorktreeService, 'mergeState' | 'mergeBranchIntoDev' | 'pushDev'>,
  events: Array<{ type: string }>,
): (node: WorkflowV2.MergeNode) => Promise<MergeOutcome> {
  return async (node) => {
    const emitConflict = (): void => { events.push({ type: 'git_conflict' }); };
    try {
      const state = await fakeWorktrees.mergeState(branch);
      if (state.mergeInProgress) { emitConflict(); return { outcome: 'conflict' }; }
      if (state.alreadyMerged) {
        if (!state.pushed) {
          try {
            await fakeWorktrees.pushDev();
          } catch (pushErr) {
            const msg = (pushErr as Error).message ?? '';
            if (/rejected|non-fast-forward/i.test(msg)) { emitConflict(); return { outcome: 'conflict' }; }
            return { outcome: 'failed', error: msg };
          }
          const afterPush = await fakeWorktrees.mergeState(branch);
          if (!afterPush.pushed) return { outcome: 'failed', error: 'origin/dev != dev' };
        }
        events.push({ type: 'git_merged' });
        return { outcome: 'merged' };
      }
      await fakeWorktrees.mergeBranchIntoDev(branch);
      const afterMerge = await fakeWorktrees.mergeState(branch);
      if (!afterMerge.alreadyMerged) {
        return { outcome: 'failed', error: 'branch tip not ancestor of dev' };
      }
      try {
        await fakeWorktrees.pushDev();
      } catch (pushErr) {
        const msg = (pushErr as Error).message ?? '';
        if (/rejected|non-fast-forward/i.test(msg)) { emitConflict(); return { outcome: 'conflict' }; }
        return { outcome: 'failed', error: msg };
      }
      const afterPush2 = await fakeWorktrees.mergeState(branch);
      if (!afterPush2.pushed) return { outcome: 'failed', error: 'origin/dev != dev' };
      events.push({ type: 'git_merged' });
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

const mergeNode: WorkflowV2.MergeNode = { id: 'merge', kind: 'merge', target: 'dev' };

test('alreadyMerged + pushed: idempotent path returns merged without merge or push', async () => {
  let mergeCalled = false;
  let pushCalled = false;
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToDev('agent-AAAA1234', {
    mergeState: async () => ({ alreadyMerged: true, mergeInProgress: false, pushed: true }),
    mergeBranchIntoDev: async () => { mergeCalled = true; },
    pushDev: async () => { pushCalled = true; },
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'merged');
  assert.ok(!mergeCalled, 'merge not called when already merged + pushed');
  assert.ok(!pushCalled, 'push not called when already pushed');
  assert.ok(events.some((e) => e.type === 'git_merged'));
});

test('mergeInProgress: returns conflict without calling merge', async () => {
  let mergeCalled = false;
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToDev('agent-BBBB5678', {
    mergeState: async () => ({ alreadyMerged: false, mergeInProgress: true, pushed: false }),
    mergeBranchIntoDev: async () => { mergeCalled = true; },
    pushDev: async () => {},
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'conflict');
  assert.ok(!mergeCalled, 'merge not called when MERGE_HEAD present');
  assert.ok(events.some((e) => e.type === 'git_conflict'));
});

test('fresh merge + push + verify: returns merged', async () => {
  let merged = false;
  let pushed = false;
  let stateCallCount = 0;
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToDev('agent-CCCC9012', {
    mergeState: async () => {
      stateCallCount += 1;
      if (stateCallCount === 1) return { alreadyMerged: false, mergeInProgress: false, pushed: false };
      if (stateCallCount === 2) return { alreadyMerged: true, mergeInProgress: false, pushed: false };
      return { alreadyMerged: true, mergeInProgress: false, pushed: true };
    },
    mergeBranchIntoDev: async () => { merged = true; },
    pushDev: async () => { pushed = true; },
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'merged');
  assert.ok(merged, 'merge was called');
  assert.ok(pushed, 'push was called');
  assert.equal(stateCallCount, 3, 'mergeState checked three times (before, after merge, after push)');
  assert.ok(events.some((e) => e.type === 'git_merged'));
});

test('push rejected: returns conflict', async () => {
  let stateCallCount = 0;
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToDev('agent-DDDD3456', {
    mergeState: async () => {
      stateCallCount += 1;
      if (stateCallCount === 1) return { alreadyMerged: false, mergeInProgress: false, pushed: false };
      return { alreadyMerged: true, mergeInProgress: false, pushed: false };
    },
    mergeBranchIntoDev: async () => {},
    pushDev: async () => { throw new Error('rejected: non-fast-forward'); },
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'conflict', 'push rejection triggers conflict outcome');
  assert.ok(events.some((e) => e.type === 'git_conflict'));
});

test('merge throws conflict error: returns conflict', async () => {
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToDev('agent-EEEE7890', {
    mergeState: async () => ({ alreadyMerged: false, mergeInProgress: false, pushed: false }),
    mergeBranchIntoDev: async () => { throw new Error('Automatic merge failed; fix conflicts'); },
    pushDev: async () => {},
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'conflict');
  assert.ok(events.some((e) => e.type === 'git_conflict'));
});

test('alreadyMerged but not pushed: pushes and verifies receipt', async () => {
  let pushed = false;
  let stateCallCount = 0;
  const events: Array<{ type: string }> = [];
  const fn = makeMergeToDev('agent-FFFF2345', {
    mergeState: async () => {
      stateCallCount += 1;
      if (stateCallCount === 1) return { alreadyMerged: true, mergeInProgress: false, pushed: false };
      return { alreadyMerged: true, mergeInProgress: false, pushed: true };
    },
    mergeBranchIntoDev: async () => { throw new Error('should not be called'); },
    pushDev: async () => { pushed = true; },
  }, events);
  const result = await fn(mergeNode);
  assert.equal(result.outcome, 'merged');
  assert.ok(pushed, 'push was called to close the idempotent gap');
  assert.ok(events.some((e) => e.type === 'git_merged'));
});
