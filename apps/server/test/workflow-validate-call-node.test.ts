// Workflow `call` node — save-time validation.
//
// A `call` node requires `server` (registered MCP server name) and `tool`;
// `args` (when present) must be an object whose string leaves are substitutable
// bodies under the same ref-ordering rules as agent tasks. Call nodes PRODUCE
// an output, so downstream `$callId.output[.field]` refs are legal.
// Also covers the loop.carry validation added alongside (carry shape + carry
// ref integrity — a broken carry ref used to silently substitute '').

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowV2 } from '@pc/domain';
import { validateWorkflowV2 } from '@pc/workflows';

function wf(
  nodes: WorkflowV2.WorkflowNode[],
  extra: Partial<WorkflowV2.Workflow> = {},
): WorkflowV2.Workflow {
  return { id: 'wf', name: 'WF', nodes, ...extra };
}

const callNode: WorkflowV2.CallNode = {
  id: 'draft-email',
  kind: 'call',
  server: 'gmail',
  tool: 'create_draft',
  args: { to: 'a@b.com', body: 'hello' },
};

// ── required fields ──────────────────────────────────────────────────────────

test('call node with server + tool is valid', () => {
  const r = validateWorkflowV2(wf([callNode]));
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('call node without server is rejected', () => {
  const bad = { id: 'c1', kind: 'call', tool: 't' } as unknown as WorkflowV2.WorkflowNode;
  const r = validateWorkflowV2(wf([bad]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /call node "c1".*server/i.test(e)), r.errors.join('; '));
});

test('call node without tool is rejected', () => {
  const bad = { id: 'c1', kind: 'call', server: 's' } as unknown as WorkflowV2.WorkflowNode;
  const r = validateWorkflowV2(wf([bad]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /call node "c1".*tool/i.test(e)), r.errors.join('; '));
});

test('call node with non-object args is rejected', () => {
  const bad = {
    id: 'c1',
    kind: 'call',
    server: 's',
    tool: 't',
    args: ['x'],
  } as unknown as WorkflowV2.WorkflowNode;
  const r = validateWorkflowV2(wf([bad]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /args must be an object/i.test(e)), r.errors.join('; '));
});

// ── call nodes produce an output (refs allowed) ──────────────────────────────

test('a downstream agent may read $call.output', () => {
  const r = validateWorkflowV2(
    wf([
      { ...callNode, next: ['summarise'] },
      {
        id: 'summarise',
        kind: 'agent',
        agent: 'writer',
        task: 'Summarise: $draft-email.output',
      },
    ]),
  );
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('a call node arg may read an upstream agent output; a forward ref is rejected', () => {
  const ok = validateWorkflowV2(
    wf([
      { id: 'research', kind: 'agent', agent: 'researcher', task: 'go', next: ['send'] },
      {
        id: 'send',
        kind: 'call',
        server: 'gmail',
        tool: 'create_draft',
        args: { body: '$research.output' },
      },
    ]),
  );
  assert.equal(ok.ok, true, ok.errors.join('; '));

  const bad = validateWorkflowV2(
    wf([
      {
        id: 'send',
        kind: 'call',
        server: 'gmail',
        tool: 'create_draft',
        args: { nested: { body: '$research.output' } },
        next: ['research'],
      },
      { id: 'research', kind: 'agent', agent: 'researcher', task: 'go' },
    ]),
  );
  assert.equal(bad.ok, false);
  assert.ok(
    bad.errors.some((e) => /node "send".*\$research\.output.*not an upstream step/i.test(e)),
    bad.errors.join('; '),
  );
});

test('reading a move step output is still rejected, with the updated wording', () => {
  const r = validateWorkflowV2(
    wf([
      { id: 'm', kind: 'move', stage: 'st-1', next: ['a'] },
      { id: 'a', kind: 'agent', agent: 'writer', task: 'read $m.output' },
    ]),
  );
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /only agent and call steps produce an output/i.test(e)),
    r.errors.join('; '),
  );
});

// ── loop.carry validation (new) ──────────────────────────────────────────────

test('loop carry referencing an unknown node is rejected at save', () => {
  const r = validateWorkflowV2(
    wf([
      { id: 'draft', kind: 'agent', agent: 'writer', task: 'go', next: ['check'] },
      {
        id: 'check',
        kind: 'review',
        reviewer: 'orchestrator',
        reject: 'check-loop',
      },
      {
        id: 'check-loop',
        kind: 'loop',
        back_to: 'draft',
        carry: { notes: '$nope.output' },
      },
    ]),
  );
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /loop node "check-loop": carry "notes".*no such node/i.test(e)),
    r.errors.join('; '),
  );
});

test('loop carry with $self.output and a real upstream ref is valid', () => {
  const r = validateWorkflowV2(
    wf([
      { id: 'draft', kind: 'agent', agent: 'writer', task: 'go', next: ['check'] },
      {
        id: 'check',
        kind: 'review',
        reviewer: 'orchestrator',
        reject: 'check-loop',
      },
      {
        id: 'check-loop',
        kind: 'loop',
        back_to: 'draft',
        carry: { feedback: '$self.output', prior: '$draft.output' },
      },
    ]),
  );
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('loop carry with a non-string value is rejected', () => {
  const r = validateWorkflowV2(
    wf([
      { id: 'draft', kind: 'agent', agent: 'writer', task: 'go', next: ['check'] },
      { id: 'check', kind: 'review', reviewer: 'orchestrator', reject: 'check-loop' },
      {
        id: 'check-loop',
        kind: 'loop',
        back_to: 'draft',
        carry: { n: 3 } as unknown as Record<string, string>,
      },
    ]),
  );
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /carry "n" must be a string ref or literal/i.test(e)),
    r.errors.join('; '),
  );
});
