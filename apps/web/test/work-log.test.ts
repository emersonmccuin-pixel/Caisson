// Slice 013 — Work Log web seams.
//
// The web test runner (`tsx --test` from repo root) can't resolve the `@/` Vite
// alias, so the hook + the WorkLogSection component can't be imported. The pure
// helpers in `features/contracts/work-log.ts` import only `@pc/contracts`, so
// they ARE importable and carry the load-bearing logic:
//   1. describeDeliverable — the per-`deliverable.kind` renderer descriptor.
//   2. summarizeExpectedOutput — "what it was asked to produce".
//   3. contractFromLiveEvent + mergeContractsWithLive — the live overlay.
// We also pin the api-client URL builders via the `contractRoutes` exports.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  contractRoutes,
  type Contract,
  type Deliverable,
  type ExpectedOutput,
  type LiveEvent,
} from '@pc/contracts';

import {
  contractFromLiveEvent,
  describeDeliverable,
  mergeContractsWithLive,
  summarizeExpectedOutput,
} from '../src/features/contracts/work-log.ts';

function contract(over: Partial<Contract> = {}): Contract {
  return {
    id: 'c1',
    projectId: 'p1',
    workItemId: 'w1',
    agentRunId: 'r1',
    podName: 'builder',
    expectedOutput: { kind: 'answer' },
    acceptanceCriteria: null,
    verificationTier: null,
    verificationStatus: null,
    verificationNotes: null,
    report: null,
    deliverable: null,
    worktreePath: null,
    status: 'dispatched',
    version: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

function frame(c: Contract, reason = 'patched', projectId: string | null = 'p1'): { event: LiveEvent } {
  return {
    event: {
      id: `e-${c.id}-${c.version}`,
      cursor: String(c.version),
      scope: projectId === null ? 'global' : 'project',
      projectId,
      type: 'contract.changed',
      entity: 'contract',
      entityId: c.id,
      version: c.version,
      createdAt: 1,
      payload: { reason, contract: c },
    } as unknown as LiveEvent,
  };
}

// ── 1. api-client URL builders ──────────────────────────────────────────────

test('contractRoutes builds the detail + work-item URLs', () => {
  assert.equal(contractRoutes.detail('c1'), '/api/contracts/c1');
  assert.equal(contractRoutes.forWorkItem('w1'), '/api/work-items/w1/contracts');
});

test('contractRoutes url-encodes ids', () => {
  assert.equal(contractRoutes.detail('a/b'), '/api/contracts/a%2Fb');
});

// ── 2. summarizeExpectedOutput ──────────────────────────────────────────────

test('summarizeExpectedOutput: each kind + null', () => {
  assert.equal(summarizeExpectedOutput(null), 'No spec');
  assert.equal(summarizeExpectedOutput({ kind: 'answer' }), 'Answer');
  assert.equal(
    summarizeExpectedOutput({ kind: 'prose', doc_type: 'prd' }),
    'Prose (prd)',
  );
  assert.equal(
    summarizeExpectedOutput({ kind: 'repo', isolation: 'worktree' }),
    'Code (worktree)',
  );
  assert.equal(
    summarizeExpectedOutput({
      kind: 'external',
      system: 'email',
      action: 'send',
      confirm: 'always',
      idempotency_key: 'k',
    } as ExpectedOutput),
    'email · send',
  );
  assert.equal(summarizeExpectedOutput({ kind: 'action', tool: 'pc_x' }), 'Tool call (pc_x)');
});

// ── 3. describeDeliverable — per-kind renderer descriptor ────────────────────

test('describeDeliverable: none when missing', () => {
  const v = describeDeliverable(null);
  assert.equal(v.kind, 'none');
  assert.equal(v.detail, 'No deliverable yet.');
});

test('describeDeliverable: answer renders the text inline', () => {
  const v = describeDeliverable({ kind: 'answer', text: '42' });
  assert.equal(v.kind, 'answer');
  assert.equal(v.label, 'Answer');
  assert.equal(v.detail, '42');
  assert.equal(v.href, undefined);
});

test('describeDeliverable: prose inline / attachment ref', () => {
  assert.equal(describeDeliverable({ kind: 'prose', text: 'hi' }).detail, 'hi');
  const att = describeDeliverable({ kind: 'prose', attachmentId: 'att-abcdefghij' });
  assert.equal(att.detail, 'See attachment');
  assert.match(att.meta ?? '', /attachment/);
});

test('describeDeliverable: repo → branch + diffstat + PR href', () => {
  const v = describeDeliverable({
    kind: 'repo',
    branch: 'feat/x',
    diffStat: { files: 3, insertions: 10, deletions: 2 },
    prUrl: 'https://example/pr/1',
  });
  assert.equal(v.kind, 'repo');
  assert.equal(v.detail, 'branch feat/x');
  assert.equal(v.meta, '3 files +10 −2');
  assert.equal(v.href, 'https://example/pr/1');
});

test('describeDeliverable: external → handle + link', () => {
  const v = describeDeliverable({
    kind: 'external',
    system: 'email',
    handle: 'msg-7',
    idempotencyKey: 'k1',
    url: 'https://mail/msg-7',
  });
  assert.equal(v.detail, 'email: msg-7');
  assert.equal(v.href, 'https://mail/msg-7');
  assert.match(v.meta ?? '', /k1/);
});

test('describeDeliverable: binary → attachment ref + size', () => {
  const v = describeDeliverable({ kind: 'binary', attachmentId: 'bin-zzzzzzzz', mime: 'image/png', bytes: 2048 });
  assert.equal(v.kind, 'binary');
  assert.match(v.detail, /image\/png/);
  assert.match(v.detail, /2\.0 KB/);
  assert.match(v.meta ?? '', /attachment/);
});

test('describeDeliverable: payload → data', () => {
  const v = describeDeliverable({ kind: 'payload', data: { a: 1 } });
  assert.equal(v.kind, 'payload');
  assert.equal(v.detail, '{"a":1}');
});

test('describeDeliverable: action → "called X" with count', () => {
  assert.equal(describeDeliverable({ kind: 'action', tool: 'pc_y', count: 1 }).detail, 'called pc_y');
  assert.equal(describeDeliverable({ kind: 'action', tool: 'pc_y', count: 3 }).detail, 'called pc_y ×3');
});

test('describeDeliverable: unknown/future kind → graceful', () => {
  const v = describeDeliverable({ kind: 'mystery' } as unknown as Deliverable);
  assert.equal(v.kind, 'none');
});

// ── 4. live overlay (the same identity-keyed merge other entities use) ───────

test('contractFromLiveEvent extracts a same-project contract', () => {
  const c = contract();
  const got = contractFromLiveEvent(frame(c).event, 'p1');
  assert.ok(got);
  assert.equal(got?.id, 'c1');
});

test('contractFromLiveEvent rejects a wrong-project frame', () => {
  const c = contract({ projectId: 'other' });
  assert.equal(contractFromLiveEvent(frame(c, 'patched', 'other').event, 'p1'), null);
});

test('mergeContractsWithLive: live overlay updates a seeded row by id+version', () => {
  const seed = [contract({ version: 1, status: 'dispatched' })];
  const live = [contract({ version: 2, status: 'accepted', verificationStatus: 'passed' })];
  const merged = mergeContractsWithLive(seed, live);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.status, 'accepted');
  assert.equal(merged[0]?.verificationStatus, 'passed');
});

test('mergeContractsWithLive: a strictly-older frame does not regress the seed', () => {
  const seed = [contract({ version: 3, status: 'accepted' })];
  const live = [contract({ version: 2, status: 'dispatched' })];
  const merged = mergeContractsWithLive(seed, live);
  assert.equal(merged[0]?.status, 'accepted');
});

test('mergeContractsWithLive: a new live contract is appended, sorted oldest-first', () => {
  const seed = [contract({ id: 'c1', createdAt: 1000 })];
  const live = [contract({ id: 'c2', createdAt: 2000 })];
  const merged = mergeContractsWithLive(seed, live);
  assert.deepEqual(merged.map((c) => c.id), ['c1', 'c2']);
});
