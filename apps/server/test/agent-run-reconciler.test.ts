// Step 2 guards — ONE reconciler, all states.
//
// 1. ONE-RECONCILER  — exactly one interval owner for run liveness; index.ts
//                      consumes the module, never the raw sweeps; the deleted
//                      boot-reconcile path AND the deleted in-process liveness
//                      sweep (P9/FD-17) stay deleted.
// 2. HOLD            — an unreachable / unrefreshed host withholds the absence
//                      signal, the counters, and handle registration: nothing
//                      can finalize on no-information (boot AND tick).
// (PAUSED-SURVIVES — FD-14 law — is guarded in agent-host-reattach.test.ts;
//  queued/spawning rows the host never reports finalize via the spawn-lost
//  tick counter there too. The in-process sweep that used to own those died
//  in P9 — it had been dead code since P2 removed the in-process spawn path.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAgentRunReconciler } from '../src/services/agent-run-reconciler.ts';
import { ActiveRunRegistry } from '../src/services/agent-active-runs.ts';

const SRC = join(import.meta.dirname, '..', 'src');

// ── 1. ONE-RECONCILER (structural guard) ─────────────────────────────────────

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('ONE-RECONCILER: the deleted boot-reconcile path stays deleted', () => {
  assert.equal(
    existsSync(join(SRC, 'services', 'agent-run-boot-reconcile.ts')),
    false,
    'agent-run-boot-reconcile.ts must not regrow',
  );
  assert.equal(
    existsSync(join(SRC, 'services', 'agent-run-server-boot.ts')),
    false,
    'agent-run-server-boot.ts must not regrow',
  );
  // P9 (FD-17): the in-process liveness sweep (pid-check + 10min idle-kill)
  // is deleted — silence escalates via the ladder, it never executes.
  assert.equal(
    existsSync(join(SRC, 'services', 'agent-run-liveness-sweep.ts')),
    false,
    'agent-run-liveness-sweep.ts must not regrow',
  );
  const deletedImport = /from\s+'[^']*agent-run-(?:boot-reconcile|server-boot|liveness-sweep)/;
  for (const file of walkTsFiles(SRC)) {
    const content = readFileSync(file, 'utf8');
    assert.ok(
      !deletedImport.test(content),
      `${file} must not import the deleted boot-reconcile path`,
    );
  }
});

test('ONE-RECONCILER: index.ts consumes the reconciler module, never the raw sweeps', () => {
  const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
  assert.ok(
    index.includes("from './services/agent-run-reconciler.ts'"),
    'index.ts imports the one reconciler',
  );
  for (const banned of [
    'agent-host-reattach.ts',
    'agent-run-liveness-sweep.ts',
    'agent-run-stall-warn.ts',
  ]) {
    assert.ok(!index.includes(banned), `index.ts must not import ${banned} (a second loop owner)`);
  }
});

test('ONE-RECONCILER: exactly one liveness interval owner in src', () => {
  // The loop's setInterval lives in agent-run-reconciler.ts. No other source
  // file may call the sweeps — one consumer (the loop), one definition each.
  const sweepCalls = ['reconcileAgentRunsAgainstHost(', 'sweepStallWarn('];
  const allowedCallers = new Set([
    join(SRC, 'services', 'agent-run-reconciler.ts'),
    // definitions (the export function lines match the `name(` probe):
    join(SRC, 'services', 'agent-host-reattach.ts'),
    join(SRC, 'services', 'agent-run-stall-warn.ts'),
  ]);
  for (const file of walkTsFiles(SRC)) {
    const content = readFileSync(file, 'utf8');
    for (const probe of sweepCalls) {
      if (content.includes(probe)) {
        assert.ok(
          allowedCallers.has(file),
          `${file} calls ${probe}) — only the one reconciler may drive the sweeps`,
        );
      }
    }
  }
});

// ── 2. HOLD (unreachable host ⇒ zero destructive input) ─────────────────────

interface CapturedReconcileArgs {
  hostAuthoritativelyAbsent?: boolean;
  missingFromHostTicks?: Map<string, number>;
  registerMissingHandles?: boolean;
}

function holdProbe(opts: { refreshThrows: boolean; connected: boolean }) {
  const captured: CapturedReconcileArgs[] = [];
  const host = {
    sendCommand: () => undefined,
    listRuns: () => [],
    refreshRuns: () =>
      opts.refreshThrows ? Promise.reject(new Error('host down')) : Promise.resolve([]),
    isConnected: () => opts.connected,
    onEvent: () => () => {},
  };
  const reconciler = createAgentRunReconciler({
    host: host as never,
    activeRunRegistry: new ActiveRunRegistry(),
    log: () => {},
    warn: () => {},
    reconcileHost: ((deps: CapturedReconcileArgs) => {
      captured.push(deps);
      return {
        checked: 0,
        terminalApplied: 0,
        statusUpdated: 0,
        hostLost: 0,
        registered: 0,
        backfilledEvents: 0,
      };
    }) as never,
    stallWarn: (() => ({ checked: 0, warned: 0, cleared: 0 })) as never,
  });
  return { reconciler, captured };
}

test('HOLD: refreshRuns throws → tick withholds absence signal, counters, and registration', async () => {
  const { reconciler, captured } = holdProbe({ refreshThrows: true, connected: true });
  const res = await reconciler.tick();
  assert.equal(res.held, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].hostAuthoritativelyAbsent, false, 'no absence signal on a thrown refresh');
  assert.equal(captured[0].missingFromHostTicks, undefined, 'no counters on a thrown refresh');
  assert.equal(captured[0].registerMissingHandles, false, 'no registration against a stale cache');
});

test('HOLD: refresh ok but disconnected → same withholding (boot included)', async () => {
  const { reconciler, captured } = holdProbe({ refreshThrows: false, connected: false });
  const res = await reconciler.boot();
  assert.equal(res.held, true);
  assert.equal(captured[0].hostAuthoritativelyAbsent, false);
  assert.equal(captured[0].registerMissingHandles, false);
});

test('HOLD: reachable host → absence signal + counters + registration flow', async () => {
  const { reconciler, captured } = holdProbe({ refreshThrows: false, connected: true });
  const res = await reconciler.tick();
  assert.equal(res.held, false);
  assert.equal(captured[0].hostAuthoritativelyAbsent, true);
  assert.ok(captured[0].missingFromHostTicks instanceof Map);
  assert.equal(captured[0].registerMissingHandles, true);
});

test('HOLD: the missing-tick counter map persists across ticks (same identity)', async () => {
  const { reconciler, captured } = holdProbe({ refreshThrows: false, connected: true });
  await reconciler.tick();
  await reconciler.tick();
  assert.equal(captured.length, 2);
  assert.ok(captured[0].missingFromHostTicks === captured[1].missingFromHostTicks);
});

