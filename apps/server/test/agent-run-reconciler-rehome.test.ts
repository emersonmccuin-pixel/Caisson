// pc-pty-chat-437 Fix E — reconciler threads reHomeQueuedRun + reHomeAttempts.
// Integration tests: the reconciler correctly wires the re-home deps to the
// reconcileHost call and the reHomeAttempts map persists across ticks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRunReconciler } from '../src/services/agent-run-reconciler.ts';
import { ActiveRunRegistry } from '../src/services/agent-active-runs.ts';

interface CapturedReconcileArgs {
  hostAuthoritativelyAbsent?: boolean;
  missingFromHostTicks?: Map<string, number>;
  reHomeQueuedRun?: (() => Promise<string>) | undefined;
  maxReHomeAttempts?: number;
  reHomeAttempts?: Map<string, number>;
}

function makeHost(opts: { connected?: boolean; refreshThrows?: boolean } = {}) {
  return {
    sendCommand: () => undefined,
    listRuns: () => [],
    refreshRuns: () =>
      opts.refreshThrows ? Promise.reject(new Error('host down')) : Promise.resolve([]),
    isConnected: () => opts.connected ?? true,
    onEvent: () => () => {},
  };
}

// ---------------------------------------------------------------------------
// 4c-1: reHomeQueuedRun is threaded to reconcileHost when provided
// ---------------------------------------------------------------------------

test('4c-1: reHomeQueuedRun threaded through to reconcileHost', async () => {
  const captured: CapturedReconcileArgs[] = [];
  const reHomeQueuedRun = async () => 're-sent' as const;

  const reconciler = createAgentRunReconciler({
    host: makeHost() as never,
    activeRunRegistry: new ActiveRunRegistry(),
    log: () => {},
    warn: () => {},
    reHomeQueuedRun,
    reconcileHost: ((deps: CapturedReconcileArgs) => {
      captured.push(deps);
      return Promise.resolve({
        checked: 0, terminalApplied: 0, statusUpdated: 0,
        hostLost: 0, registered: 0, backfilledEvents: 0, ghostCancelled: 0,
      });
    }) as never,
    stallWarn: (() => ({ checked: 0, warned: 0, cleared: 0 })) as never,
  });

  await reconciler.tick();

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.reHomeQueuedRun, reHomeQueuedRun, 'reHomeQueuedRun passed through');
});

// ---------------------------------------------------------------------------
// 4c-2: reHomeAttempts map persists across ticks (same identity)
// ---------------------------------------------------------------------------

test('4c-2: reHomeAttempts map persists across ticks', async () => {
  const captured: CapturedReconcileArgs[] = [];

  const reconciler = createAgentRunReconciler({
    host: makeHost() as never,
    activeRunRegistry: new ActiveRunRegistry(),
    log: () => {},
    warn: () => {},
    reHomeQueuedRun: async () => 're-sent' as const,
    reconcileHost: ((deps: CapturedReconcileArgs) => {
      captured.push(deps);
      return Promise.resolve({
        checked: 0, terminalApplied: 0, statusUpdated: 0,
        hostLost: 0, registered: 0, backfilledEvents: 0, ghostCancelled: 0,
      });
    }) as never,
    stallWarn: (() => ({ checked: 0, warned: 0, cleared: 0 })) as never,
  });

  await reconciler.tick();
  await reconciler.tick();

  assert.equal(captured.length, 2);
  assert.ok(
    captured[0]!.reHomeAttempts instanceof Map,
    'reHomeAttempts is a Map',
  );
  assert.ok(
    captured[0]!.reHomeAttempts === captured[1]!.reHomeAttempts,
    'same reHomeAttempts map identity across ticks',
  );
});

// ---------------------------------------------------------------------------
// 4c-3: maxReHomeAttempts is threaded through when provided
// ---------------------------------------------------------------------------

test('4c-3: maxReHomeAttempts threaded through', async () => {
  const captured: CapturedReconcileArgs[] = [];

  const reconciler = createAgentRunReconciler({
    host: makeHost() as never,
    activeRunRegistry: new ActiveRunRegistry(),
    log: () => {},
    warn: () => {},
    reHomeQueuedRun: async () => 'failed' as const,
    maxReHomeAttempts: 5,
    reconcileHost: ((deps: CapturedReconcileArgs) => {
      captured.push(deps);
      return Promise.resolve({
        checked: 0, terminalApplied: 0, statusUpdated: 0,
        hostLost: 0, registered: 0, backfilledEvents: 0, ghostCancelled: 0,
      });
    }) as never,
    stallWarn: (() => ({ checked: 0, warned: 0, cleared: 0 })) as never,
  });

  await reconciler.tick();

  assert.equal(captured[0]!.maxReHomeAttempts, 5);
});

// ---------------------------------------------------------------------------
// 4c-4: no reHomeQueuedRun dep → not wired (backward compat)
// ---------------------------------------------------------------------------

test('4c-4: absent reHomeQueuedRun -> not passed to reconcileHost', async () => {
  const captured: CapturedReconcileArgs[] = [];

  const reconciler = createAgentRunReconciler({
    host: makeHost() as never,
    activeRunRegistry: new ActiveRunRegistry(),
    log: () => {},
    warn: () => {},
    reconcileHost: ((deps: CapturedReconcileArgs) => {
      captured.push(deps);
      return Promise.resolve({
        checked: 0, terminalApplied: 0, statusUpdated: 0,
        hostLost: 0, registered: 0, backfilledEvents: 0, ghostCancelled: 0,
      });
    }) as never,
    stallWarn: (() => ({ checked: 0, warned: 0, cleared: 0 })) as never,
  });

  await reconciler.tick();

  assert.equal(captured[0]!.reHomeQueuedRun, undefined, 'no reHomeQueuedRun when not wired');
});
