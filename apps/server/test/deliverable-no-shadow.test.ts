// Slice 3 guardrail -- the completion envelope ALWAYS surfaces the typed
// deliverable text as the primary result, never the incidental free-text turn
// result.
//
// The bug (pre-fix): captureDeliverable early-returns the raw result whenever
// it is non-empty, even when the contract already carries an authoritative
// submitted deliverable. The turn-end chatter shadows the typed output.
//
// Tests:
//   1. Unit: buildAgentCompletedBody with result=AUTHORITATIVE + note=incidental
//      turn chatter => Result: section carries deliverable text; Note: section
//      carries incidental text (and appears after Result:).
//   2. Unit: no Note: section emitted when note is absent or empty.
//   3. Integration: applyAgentRunTerminalEffects with submitted deliverable
//      (AUTHORITATIVE) + non-empty input.result (incidental turn chatter) =>
//      terminal envelope body surfaces AUTHORITATIVE in Result:, not turn text.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAgentCompletedBody } from '../src/services/agent-event-header.ts';

// -- 1. pure unit -- Result: / Note: rendering --------------------------------

test('buildAgentCompletedBody: Result: carries deliverable text, Note: carries incidental text', () => {
  const body = buildAgentCompletedBody({
    runId: 'r1',
    sessionId: 's1',
    agentName: 'writer',
    parentWorkItemId: null,
    result: 'AUTHORITATIVE',
    note: 'incidental turn chatter',
  });
  // Split on newline to inspect sections without embedding escape sequences.
  const bls = body.split('\n');
  const ri = bls.indexOf('Result:');
  const ni = bls.indexOf('Note:');

  assert.ok(ri !== -1, 'Result: section present');
  assert.ok(ni !== -1, 'Note: section present');
  assert.equal(bls[ri + 1], 'AUTHORITATIVE', 'deliverable text is the primary result');
  assert.equal(bls[ni + 1], 'incidental turn chatter', 'incidental text surfaces in Note:');
  assert.ok(ri < ni, 'Result: section appears before Note: section');
});

test('buildAgentCompletedBody: no Note: section when note is absent', () => {
  const body = buildAgentCompletedBody({
    runId: 'r1',
    sessionId: 's1',
    agentName: 'writer',
    parentWorkItemId: null,
    result: 'just the result',
  });
  const bls = body.split('\n');
  assert.ok(!bls.includes('Note:'), 'no Note: section when note is omitted');
  assert.ok(bls.includes('Result:'), 'Result: section present');
});

test('buildAgentCompletedBody: no Note: section when note is empty string', () => {
  const body = buildAgentCompletedBody({
    runId: 'r1',
    sessionId: 's1',
    agentName: 'writer',
    parentWorkItemId: null,
    result: 'the result',
    note: '',
  });
  const bls = body.split('\n');
  assert.ok(!bls.includes('Note:'), 'no Note: section for empty note');
});

// -- 2. integration -- full applyAgentRunTerminalEffects path -----------------

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-no-shadow-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  insertAgentRunRow,
  newId,
  runMigrations,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');

import type { EnqueueMailboxMessageInput } from '@pc/db';
import type { Stage, ULID } from '@pc/domain';
import { applyAgentRunTerminalEffects } from '../src/services/agent-run-terminal-effects.ts';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkProject(slug: string) {
  return createProject({ slug, name: slug, stages, folderPath: join(tmpDir, slug) });
}

test('no-shadow: submitted deliverable surfaces in Result:, incidental turn text in Note:', async () => {
  const p = mkProject('no-shadow');
  // Real orchestrator session so deliverAgentEnvelope does not skip the envelope.
  const session = createOrchestratorSession({
    projectId: p.id,
    providerSessionId: 'cc-no-shadow',
  });
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'writer',
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  // Agent submitted its authoritative deliverable before going terminal.
  new ContractService().setDeliverable({
    id: contract.id as ULID,
    deliverable: { kind: 'answer', text: 'AUTHORITATIVE' },
    report: 'AUTHORITATIVE',
  });
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: p.id as ULID,
    podName: 'writer',
    dispatcherSessionId: session.id,
    ccSessionId: 'cc-ns',
    status: 'running',
    input: 'go',
    contractId: contract.id as ULID,
    queuedAt: Date.now(),
  });

  const capturedMessages: EnqueueMailboxMessageInput[] = [];
  applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: 'cc-ns',
      podName: 'writer',
      projectId: p.id as ULID,
      dispatcherSessionId: session.id,
      parentWorkItemId: null,
      worktreeDir: join(tmpDir, 'no-shadow'),
      slug: 'writer',
      status: 'completed',
      // The incidental free-text turn result -- must NOT shadow the deliverable.
      result: 'incidental turn chatter',
      completedAt: Date.now(),
      startedAt: Date.now(),
      contractId: contract.id as ULID,
    },
    {
      markTerminal: () => {},
      // Skip the verifier so we do not need a full project/worktree setup.
      verifyOnTerminal: async () => null,
      mailboxEnqueue: (msg) => { capturedMessages.push(msg); },
    },
  );

  // Let the async finishTerminalEffects tail complete.
  await new Promise((r) => setTimeout(r, 100));

  const terminal = capturedMessages.find((m) => m.message.kind === 'agent-terminal');
  assert.ok(terminal, 'terminal envelope was enqueued to the mailbox');

  const bls = terminal!.message.body.split('\n');
  const ri = bls.indexOf('Result:');
  assert.ok(ri !== -1, 'Result: section present in envelope body');

  assert.equal(
    bls[ri + 1],
    'AUTHORITATIVE',
    'deliverable text is in the Result: section of the envelope',
  );
  assert.notEqual(
    bls[ri + 1],
    'incidental turn chatter',
    'incidental turn text is NOT the primary result in the envelope',
  );
});
