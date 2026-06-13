// Workflow `call` node — the LIVE callTool dep from makeExecutorDeps.
//
// Real DB (tmp PC_DATA_DIR + migrations), injected mcpToolCaller fake (no real
// MCP server). Covers: registry resolution (unknown server → typed failure;
// project row shadows global), arg rendering ($refs + {{input}} ports through
// to string leaves at any depth), output capture + truncation, the
// `tool_called` diary line, and the resolver's field-form read of a call
// node's JSON output.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-dag-call-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createMcpServerRegistry, createProject, runMigrations, workflowRunsV2Repo } =
  await import('@pc/db');
const { makeExecutorDeps } = await import('../src/services/dag-run-service.ts');
import type { DagRunServiceOptions } from '../src/services/dag-run-service.ts';
import type { DagNodeContext } from '../src/services/dag-executor.ts';
import type { PodMcpServerConfig, Project, ULID, WorkflowV2 } from '@pc/domain';

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

let project: Project;
let runId: ULID;

before(() => {
  runMigrations();
  project = createProject({
    slug: 'call-svc-' + String(Date.now()),
    name: 'Call Service',
    stages,
    folderPath: join(tmpDir, 'call-svc'),
  });
  const run = workflowRunsV2Repo.createRun({
    workflowId: 'wf-call',
    workflowName: 'Call Test',
    projectId: project.id as ULID,
    workflowYamlSnapshot: '{}',
    workItemId: null,
    worktreePath: null,
    status: 'running',
  });
  runId = run.id;
});
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface CapturedCall {
  config: PodMcpServerConfig;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number | undefined;
}

function makeDeps(
  caller: (
    config: PodMcpServerConfig,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<{ status: 'ok'; output: string } | { status: 'failed'; error: string }>,
) {
  const opts = {
    projectId: project.id as ULID,
    workspaceDir: join(tmpDir, 'ws'),
    getProject: () => project,
    workItemService: {} as never,
    worktrees: {} as never,
    sessionDirFor: () => tmpDir,
    broadcast: () => {},
    mcpToolCaller: caller,
  } as unknown as DagRunServiceOptions;
  const workflow: WorkflowV2.Workflow = { id: 'wf-call', name: 'Call Test', nodes: [] };
  return makeExecutorDeps({ id: runId, workItemId: null, worktreePath: null }, workflow, opts);
}

function ctx(over: Partial<DagNodeContext> = {}): DagNodeContext {
  return {
    runId,
    rootWorkItemId: null,
    worktreePath: null,
    carry: {},
    resolve: () => '',
    ...over,
  };
}

test('unknown server: typed failure, caller never invoked', async () => {
  let invoked = 0;
  const deps = makeDeps(async () => {
    invoked += 1;
    return { status: 'ok', output: '' };
  });
  const outcome = await deps.callTool(
    { id: 'c1', kind: 'call', server: 'nope', tool: 't' },
    ctx(),
  );
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.error ?? '', /MCP server "nope" is not registered/);
  assert.equal(invoked, 0);
});

test('registered server: args rendered (refs + input ports, nested), output captured, diary line written', async () => {
  createMcpServerRegistry({
    scope: 'project',
    projectId: project.id as ULID,
    name: 'gmail',
    transport: { url: 'http://localhost:9999/mcp' },
  });

  const captured: CapturedCall[] = [];
  const deps = makeDeps(async (config, tool, args, timeoutMs) => {
    captured.push({ config, tool, args, timeoutMs });
    return { status: 'ok', output: '{"draftId":"d-123","ok":true}' };
  });

  const node: WorkflowV2.CallNode = {
    id: 'send',
    kind: 'call',
    server: 'gmail',
    tool: 'create_draft',
    input: { recipient: '$research.output.email' },
    args: {
      to: '{{recipient}}',
      body: 'Findings: $research.output',
      options: { labels: ['$research.output.label'], draft: true, retries: 2 },
    },
    timeout: 5_000,
  };
  const resolve = (nodeId: string, field: string | undefined): string => {
    if (nodeId !== 'research') return '';
    if (field === 'email') return 'a@b.com';
    if (field === 'label') return 'auto';
    return 'the findings';
  };

  const outcome = await deps.callTool(node, ctx({ resolve }));
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.output, '{"draftId":"d-123","ok":true}');

  assert.equal(captured.length, 1);
  const call = captured[0]!;
  assert.equal(call.tool, 'create_draft');
  assert.equal(call.config.url, 'http://localhost:9999/mcp');
  assert.equal(call.timeoutMs, 5_000);
  assert.deepEqual(call.args, {
    to: 'a@b.com',
    body: 'Findings: the findings',
    options: { labels: ['auto'], draft: true, retries: 2 },
  });

  const events = workflowRunsV2Repo.listEvents(runId);
  const toolEvents = events.filter((e) => e.type === 'tool_called');
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0]!.nodeId, 'send');
  assert.equal((toolEvents[0]!.data as Record<string, unknown>).server, 'gmail');
  assert.equal((toolEvents[0]!.data as Record<string, unknown>).ok, true);
});

test('tool failure: typed failed node naming server.tool, diary line carries the error', async () => {
  const deps = makeDeps(async () => ({ status: 'failed', error: 'auth expired' }));
  const outcome = await deps.callTool(
    { id: 'send2', kind: 'call', server: 'gmail', tool: 'create_draft' },
    ctx(),
  );
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error, 'call gmail.create_draft failed: auth expired');

  const events = workflowRunsV2Repo.listEvents(runId);
  const ev = events.filter((e) => e.type === 'tool_called' && e.nodeId === 'send2');
  assert.equal(ev.length, 1);
  assert.equal((ev[0]!.data as Record<string, unknown>).ok, false);
  assert.equal((ev[0]!.data as Record<string, unknown>).error, 'auth expired');
});

test('oversized output is truncated with a marker', async () => {
  const huge = 'x'.repeat(40_000);
  const deps = makeDeps(async () => ({ status: 'ok', output: huge }));
  const outcome = await deps.callTool(
    { id: 'big', kind: 'call', server: 'gmail', tool: 'create_draft' },
    ctx(),
  );
  assert.equal(outcome.state, 'completed');
  assert.ok((outcome.output ?? '').length < huge.length);
  assert.match(outcome.output ?? '', /…\[truncated 8000 chars\]$/);
});

test('resolver field-form reads a key off a call node JSON output', async () => {
  const deps = makeDeps(async () => ({ status: 'ok', output: '' }));
  const state: WorkflowV2.WorkflowDagState = {
    nodes: {
      send: { state: 'completed', output: '{"draftId":"d-123","count":2}' },
      text: { state: 'completed', output: 'not json' },
    },
  };
  const resolve = deps.resolveRef(state);
  assert.equal(resolve('send', undefined), '{"draftId":"d-123","count":2}');
  assert.equal(resolve('send', 'draftId'), 'd-123');
  assert.equal(resolve('send', 'count'), '2');
  assert.equal(resolve('send', 'missing'), '');
  assert.equal(resolve('text', undefined), 'not json');
  assert.equal(resolve('text', 'field'), '');
});
