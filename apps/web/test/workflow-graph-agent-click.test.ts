// T — resolveAgentPod (workflow-graph agent-click modal resolution).
//
// Tests the pure `resolveAgentPod` helper from lib/workflow-agent-pod.ts.
// The full graph component (WorkflowGraphV2) is React+xyflow+CSS and not
// importable in tsx --test (no DOM harness).  The resolution logic is the
// load-bearing part — a wrong resolution means the wrong pod (or no pod)
// opens on click.  WorkflowGraphV2 re-exports this function so callers
// who import from the component barrel still see it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAgentPod } from '../src/lib/workflow-agent-pod.ts';

// Also verify the re-export from the pure module is present at the import level.
import * as PodUtil from '../src/lib/workflow-agent-pod.ts';

// Minimal pod stubs (only the fields resolveAgentPod inspects).
type StubPod = { name: string; scope: 'global' | 'project'; origin: 'stock' | 'user-created' };

function stub(name: string, scope: 'global' | 'project', origin: 'stock' | 'user-created' = 'user-created'): StubPod {
  return { name, scope, origin };
}

// resolveAgentPod accepts Pod[] but only reads .name and .scope — stubs are fine.

test('resolveAgentPod is exported from workflow-agent-pod', () => {
  assert.equal(typeof PodUtil.resolveAgentPod, 'function');
});

test('returns null when no pod matches the agent name', () => {
  const pods = [stub('researcher', 'project'), stub('summarizer', 'global')];
  // @ts-expect-error stub satisfies the fields resolveAgentPod reads
  assert.equal(resolveAgentPod(pods, 'unknown-agent'), null);
});

test('returns the sole matching pod when only one exists', () => {
  const pods = [stub('researcher', 'project'), stub('other', 'global')];
  // @ts-expect-error stub satisfies the fields resolveAgentPod reads
  const result = resolveAgentPod(pods, 'researcher');
  assert.ok(result);
  assert.equal(result.name, 'researcher');
});

test('prefers project-scoped match over global when both have the same name', () => {
  const pods = [
    stub('researcher', 'global', 'stock'),
    stub('researcher', 'project'),
  ];
  // @ts-expect-error stub satisfies the fields resolveAgentPod reads
  const result = resolveAgentPod(pods, 'researcher');
  assert.ok(result);
  assert.equal(result.scope, 'project');
});

test('falls back to global/stock pod when no project-scoped match exists', () => {
  const pods = [stub('researcher', 'global', 'stock'), stub('other', 'project')];
  // @ts-expect-error stub satisfies the fields resolveAgentPod reads
  const result = resolveAgentPod(pods, 'researcher');
  assert.ok(result);
  assert.equal(result.scope, 'global');
  assert.equal(result.name, 'researcher');
});

test('returns null for empty pod list', () => {
  // @ts-expect-error stub satisfies the fields resolveAgentPod reads
  assert.equal(resolveAgentPod([], 'researcher'), null);
});

test('name match is case-sensitive (agent names are kebab-case slugs)', () => {
  const pods = [stub('Researcher', 'project')];
  // @ts-expect-error stub satisfies the fields resolveAgentPod reads
  assert.equal(resolveAgentPod(pods, 'researcher'), null);
  // @ts-expect-error stub satisfies the fields resolveAgentPod reads
  const hit = resolveAgentPod(pods, 'Researcher');
  assert.ok(hit);
  assert.equal(hit.name, 'Researcher');
});
