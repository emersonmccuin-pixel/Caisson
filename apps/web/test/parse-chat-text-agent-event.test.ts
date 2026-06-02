import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseUserText } from '../src/lib/parse-chat-text.ts';

const AGENT_BODY = [
  '[pc:agent-event kind=agent-asks-orchestrator version=1]',
  '[pendingAskId: 01HZABCDEF]',
  '[sessionId: cc-sess-1]',
  '[agentName: researcher]',
  '[runId: 01HZRUN]',
  '',
  'Question:',
  'Which dataset should I use for the Q3 numbers — prod or staging?',
].join('\n');

test('bare mailbox agent-event turn (no <channel> wrapper) parses to an agent-event part', () => {
  const parts = parseUserText(AGENT_BODY);
  assert.equal(parts.length, 1);
  const p = parts[0];
  assert.equal(p.kind, 'agent-event');
  assert.equal(p.agentEventKind, 'agent-asks-orchestrator');
  assert.equal(p.agentName, 'researcher');
  assert.equal(p.agentRunId, '01HZRUN');
});

test('bare mailbox workflow-event turn parses to a workflow-event part', () => {
  const body = '[pc:workflow-event kind=terminated version=1]\n[workflowRunId: 01HZWF]\n\nReason: boom';
  const parts = parseUserText(body);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'workflow-event');
  assert.equal(parts[0].workflowEventKind, 'terminated');
  assert.equal(parts[0].workflowRunId, '01HZWF');
});

test('a real user message is NOT misread as an event', () => {
  const parts = parseUserText('hey can you check the deploy? [note: not a tag]');
  assert.ok(parts.every((p) => p.kind !== 'agent-event' && p.kind !== 'workflow-event'));
});

test('legacy <channel>-wrapped agent-event still parses (back-compat)', () => {
  const wrapped = `<channel source="agent">${AGENT_BODY}</channel>`;
  const parts = parseUserText(wrapped);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'agent-event');
  assert.equal(parts[0].agentName, 'researcher');
});
