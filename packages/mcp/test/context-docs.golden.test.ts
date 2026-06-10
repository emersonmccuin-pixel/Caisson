import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleContextDocTool } from '../src/tools/context-docs.ts';
import { makeFakeContext, ok, err, firstText } from './helpers.ts';

// pc-pty-chat-377 — cross-project context-doc reads via targetProjectId.

test('pc_list_context default: uses current project path', async () => {
  const { ctx, calls } = makeFakeContext({ responder: () => ok({ ok: true, docs: [] }) });
  await handleContextDocTool('pc_list_context', { scope: 'project' }, ctx);
  assert.ok(calls[0].path.startsWith('/api/projects/P01/context-docs'));
});

test('pc_list_context with targetProjectId: uses target project path', async () => {
  const { ctx, calls } = makeFakeContext({ responder: () => ok({ ok: true, docs: [] }) });
  await handleContextDocTool('pc_list_context', { scope: 'project', targetProjectId: 'P02' }, ctx);
  assert.ok(calls[0].path.startsWith('/api/projects/P02/context-docs'));
  const url = new URL('http://localhost' + calls[0].path);
  assert.equal(url.searchParams.get('scope'), 'project');
});

test('pc_list_context with targetProjectId slug: passes slug in path (server resolves)', async () => {
  const { ctx, calls } = makeFakeContext({ responder: () => ok({ ok: true, docs: [] }) });
  await handleContextDocTool('pc_list_context', { scope: 'project', targetProjectId: 'my-project' }, ctx);
  assert.ok(calls[0].path.startsWith('/api/projects/my-project/context-docs'));
});

test('pc_list_context failure: exact failure string + isError', async () => {
  const { ctx } = makeFakeContext({ responder: () => err(404, 'not found') });
  const res = await handleContextDocTool('pc_list_context', { scope: 'project' }, ctx);
  assert.equal(firstText(res), 'pc_list_context failed (404): not found');
  assert.equal(res!.isError, true);
});

test('pc_get_context_doc default: uses current project path + tool read receipt', async () => {
  const serverBody = JSON.stringify({ ok: true, doc: { id: 'DOC1', title: 'Test' } });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleContextDocTool('pc_get_context_doc', { doc_id: 'DOC1' }, ctx);
  assert.equal(firstText(res), serverBody);
  // Phase B (0056): tool fetches stamp readVia=tool so the route records a receipt.
  assert.equal(calls[0].path, '/api/projects/P01/context-docs/DOC1?readVia=tool');
});

test('pc_get_context_doc with an agent run identity: receipt carries the run id', async () => {
  const serverBody = JSON.stringify({ ok: true, doc: { id: 'DOC1' } });
  const { ctx, calls } = makeFakeContext({
    responder: () => ok(serverBody),
    agentRunId: 'AR1',
  });
  await handleContextDocTool('pc_get_context_doc', { doc_id: 'DOC1' }, ctx);
  assert.equal(calls[0].path, '/api/projects/P01/context-docs/DOC1?readVia=tool&agentRunId=AR1');
});

test('pc_get_context_doc with targetProjectId: uses target project path', async () => {
  const serverBody = JSON.stringify({ ok: true, doc: { id: 'DOC1', title: 'Test' } });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleContextDocTool('pc_get_context_doc', { doc_id: 'DOC1', targetProjectId: 'P02' }, ctx);
  assert.equal(firstText(res), serverBody);
  assert.equal(calls[0].path, '/api/projects/P02/context-docs/DOC1?readVia=tool');
});

test('pc_get_context_doc with targetProjectId slug: passes slug in path', async () => {
  const { ctx, calls } = makeFakeContext({
    responder: () => ok(JSON.stringify({ ok: true, doc: { id: 'DOC2' } })),
  });
  await handleContextDocTool('pc_get_context_doc', { doc_id: 'DOC2', targetProjectId: 'other-project' }, ctx);
  assert.equal(calls[0].path, '/api/projects/other-project/context-docs/DOC2?readVia=tool');
});

test('pc_get_context_doc missing doc_id: validation error', async () => {
  const { ctx } = makeFakeContext({ responder: () => ok('{}') });
  const res = await handleContextDocTool('pc_get_context_doc', {}, ctx);
  assert.equal(firstText(res), 'pc_get_context_doc: doc_id required');
  assert.equal(res!.isError, true);
});

test('pc_search default: uses current project context-docs/search path', async () => {
  const serverBody = JSON.stringify({ ok: true, results: [] });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  await handleContextDocTool('pc_search', { query: 'test' }, ctx);
  assert.ok(calls[0].path.startsWith('/api/projects/P01/context-docs/search?q=test'));
});

test('pc_search with targetProjectId: uses target project path', async () => {
  const serverBody = JSON.stringify({ ok: true, results: [] });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  await handleContextDocTool('pc_search', { query: 'test', targetProjectId: 'P02' }, ctx);
  assert.ok(calls[0].path.startsWith('/api/projects/P02/context-docs/search?q=test'));
});

test('pc_search with targetProjectId slug: passes slug in path', async () => {
  const { ctx, calls } = makeFakeContext({
    responder: () => ok(JSON.stringify({ ok: true, results: [] })),
  });
  await handleContextDocTool('pc_search', { query: 'foo', targetProjectId: 'other-project' }, ctx);
  assert.ok(calls[0].path.startsWith('/api/projects/other-project/context-docs/search'));
});

test('pc_search missing query: validation error', async () => {
  const { ctx } = makeFakeContext({ responder: () => ok('{}') });
  const res = await handleContextDocTool('pc_search', {}, ctx);
  assert.equal(firstText(res), 'pc_search: query required');
  assert.equal(res!.isError, true);
});
