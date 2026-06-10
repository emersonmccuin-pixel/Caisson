// Attached-docs footer (migration 0055 — knowledge merged into context docs).
//
// The footer must render ONLY when the agent's expanded tool list carries
// `pc_get_context_doc` (never instruct an agent to call a tool it can't
// reach), and must list every attached doc's title + id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContextDoc, PodAgentRow } from '@pc/domain';
import { renderAgentMd, renderContextDocsFooter } from '../src/pod-materializer.ts';

const READ_TOOL = 'mcp__pc-rig__pc_get_context_doc';

function fakeAgent(): PodAgentRow {
  const now = 1;
  return {
    id: '01AGENT0000000000000000000' as PodAgentRow['id'],
    name: 'writer',
    scope: 'global',
    projectId: null,
    prompt: 'You write things.',
    tools: [],
    model: null,
    effort: null,
    maxTurns: null,
    description: '',
    origin: 'stock',
    dispatchGuidance: null,
    expectedOutput: null,
    rev: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

const DOCS: AgentContextDoc[] = [
  {
    id: '01DOCA00000000000000000000' as AgentContextDoc['id'],
    title: 'Style guide',
    body: 'Always terse.\nMore detail below.',
    updatedAt: 1,
  },
  {
    id: '01DOCB00000000000000000000' as AgentContextDoc['id'],
    title: 'Good report (example)',
    body: '',
    updatedAt: 1,
  },
];

test('footer renders when the read tool is present', () => {
  const md = renderAgentMd(fakeAgent(), [READ_TOOL], DOCS);
  assert.match(md, /## Reference docs attached to this agent/);
  assert.match(md, /pc_get_context_doc\(\{ doc_id: "<one of the ids below>" \}\)/);
  assert.match(md, /\*\*Style guide\*\* \(`01DOCA00000000000000000000`\)/);
  assert.match(md, /\*\*Good report \(example\)\*\* \(`01DOCB00000000000000000000`\)/);
});

test('no footer without the read tool, even with docs attached', () => {
  const md = renderAgentMd(fakeAgent(), ['mcp__pc-rig__pc_get_work_item'], DOCS);
  assert.doesNotMatch(md, /Reference docs attached/);
  assert.doesNotMatch(md, /pc_get_context_doc\(/);
});

test('no footer with the tool but zero docs', () => {
  const md = renderAgentMd(fakeAgent(), [READ_TOOL], []);
  assert.doesNotMatch(md, /Reference docs attached/);
});

test('renderContextDocsFooter summarises the first body line', () => {
  const footer = renderContextDocsFooter(DOCS);
  assert.match(footer, /Style guide.*Always terse\./);
  assert.match(footer, /Good report \(example\).*\(empty\)/);
});
