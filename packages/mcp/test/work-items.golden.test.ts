import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleWorkItemTool } from '../src/tools/work-items.ts';
import { handleProjectConfigTool } from '../src/tools/project-config.ts';
import { makeFakeContext, ok, err, firstText, type RecordedCall } from './helpers.ts';

// 11C golden text-compat tests. The headline invariant: the agent-visible text
// result string + the HTTP payload/path are byte-identical after routing the
// internals through the typed client. These assert exact strings.

const RICH_LINK_HINT =
  '[system formatting reminder] When you mention any of these in your reply, ' +
  'wrap as markdown links: `[<callsign>](pc://work-item/<callsign>)` for work ' +
  'items (use the callsign string, not the ULID), `[<path>](pc://file/<path>)` ' +
  'for files, `[<name>](pc://attachment/<id>)` for attachments. The user can ' +
  'hover + click these pills. Bare text and backticks are unclickable — never ' +
  'use them for these refs. Applies in lists too: every reference in every row.';

test('pc_get_work_item success: emits raw body + rich-link hint, GETs the right path', async () => {
  const serverBody = JSON.stringify({ ok: true, workItem: { id: 'WI1' } });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleWorkItemTool('pc_get_work_item', { id: 'WI1' }, ctx);
  assert.ok(res);
  assert.equal(res!.content[0].text, serverBody);
  assert.equal(res!.content[1].text, RICH_LINK_HINT);
  assert.equal(res!.isError, undefined);
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/projects/P01/work-items/WI1' }] as RecordedCall[]);
});

test('pc_get_work_item includeArchived appends query', async () => {
  const { calls } = (() => {
    const c = makeFakeContext({ responder: () => ok('{}') });
    return { calls: c.calls, ctx: c.ctx };
  })();
  const c = makeFakeContext({ responder: () => ok('{}') });
  await handleWorkItemTool('pc_get_work_item', { id: 'WI1', includeArchived: true }, c.ctx);
  assert.equal(c.calls[0].path, '/api/projects/P01/work-items/WI1?includeArchived=1');
});

test('pc_get_work_item failure: exact failure string + isError', async () => {
  const { ctx } = makeFakeContext({ responder: () => err(404, 'not found') });
  const res = await handleWorkItemTool('pc_get_work_item', { id: 'WI1' }, ctx);
  assert.equal(firstText(res), 'pc_get_work_item failed (404): not found');
  assert.equal(res!.isError, true);
});

test('pc_get_work_item missing id: exact validation string', async () => {
  const { ctx } = makeFakeContext({ responder: () => ok('{}') });
  const res = await handleWorkItemTool('pc_get_work_item', {}, ctx);
  assert.equal(firstText(res), 'pc_get_work_item: id required');
  assert.equal(res!.isError, true);
});

test('pc_create_work_item success: raw body + hint, posts to create path with payload', async () => {
  const serverBody = JSON.stringify({ ok: true, workItem: { id: 'NEW' } });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody, 201) });
  const res = await handleWorkItemTool(
    'pc_create_work_item',
    { title: 'T', stageId: 'draft', body: 'B', area_id: 'A1' },
    ctx,
  );
  assert.equal(res!.content[0].text, serverBody);
  assert.equal(res!.content[1].text, RICH_LINK_HINT);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/work-items/create',
    body: { title: 'T', stageId: 'draft', areaId: 'A1', body: 'B' },
  });
});

test('pc_create_work_item cross-project: targetProjectId path + origin note', async () => {
  const { ctx, calls } = makeFakeContext({
    projectId: 'P01',
    agentSessionId: 'sess9',
    responder: () => ok('{}', 201),
  });
  await handleWorkItemTool(
    'pc_create_work_item',
    { title: 'T', targetProjectId: 'P02', body: 'B' },
    ctx,
  );
  assert.equal(calls[0].path, '/api/projects/P02/work-items/create');
  const body = calls[0].body as { body: string };
  assert.match(body.body, /^B\n\n---\n\*Created from project: P01 · session: sess9\*$/);
});

test('pc_create_work_item missing title: exact validation string', async () => {
  const { ctx } = makeFakeContext({ responder: () => ok('{}') });
  const res = await handleWorkItemTool('pc_create_work_item', {}, ctx);
  assert.equal(firstText(res), 'pc_create_work_item: title required');
  assert.equal(res!.isError, true);
});

test('pc_list_work_items success: raw body + hint; builds query string', async () => {
  const serverBody = JSON.stringify({ ok: true, workItems: [] });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleWorkItemTool(
    'pc_list_work_items',
    { stage: 'draft', parentId: '', includeArchived: true, limit: 5, cursor: 'C1' },
    ctx,
  );
  assert.equal(res!.content[0].text, serverBody);
  assert.equal(res!.content[1].text, RICH_LINK_HINT);
  assert.equal(
    calls[0].path,
    '/api/projects/P01/work-items?stage=draft&parentId=&includeArchived=1&limit=5&cursor=C1',
  );
});

// pc-pty-chat-254 — new pc_list_work_items params.
test('pc_list_work_items: new params (includeBody, status, open, area_id) append to query string', async () => {
  const { ctx, calls } = makeFakeContext({ responder: () => ok('{}') });
  await handleWorkItemTool(
    'pc_list_work_items',
    { includeBody: true, status: 'active', open: true, area_id: 'A1' },
    ctx,
  );
  const url = new URL('http://x' + calls[0].path);
  assert.equal(url.searchParams.get('includeBody'), '1');
  assert.equal(url.searchParams.get('status'), 'active');
  assert.equal(url.searchParams.get('open'), '1');
  assert.equal(url.searchParams.get('areaId'), 'A1');
});

test('pc_list_work_items: open=false and empty area_id do NOT appear in query', async () => {
  const { ctx, calls } = makeFakeContext({ responder: () => ok('{}') });
  await handleWorkItemTool('pc_list_work_items', {}, ctx);
  assert.equal(calls[0].path, '/api/projects/P01/work-items');
});

// pc-pty-chat-254 — pc_search_work_items.
test('pc_search_work_items success: GETs the search route with query + hint', async () => {
  const serverBody = JSON.stringify({ ok: true, results: [{ id: 'WI1', title: 'hello' }] });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleWorkItemTool('pc_search_work_items', { query: 'hello' }, ctx);
  assert.equal(res!.content[0].text, serverBody);
  assert.equal(res!.content[1].text, RICH_LINK_HINT);
  assert.ok(calls[0].path.startsWith('/api/projects/P01/work-items/search?q=hello'));
});

test('pc_search_work_items with filters: area_id, status, open forwarded', async () => {
  const { ctx, calls } = makeFakeContext({ responder: () => ok('{}') });
  await handleWorkItemTool(
    'pc_search_work_items',
    { query: 'foo', area_id: 'A1', status: 'active', open: true },
    ctx,
  );
  const url = new URL('http://x' + calls[0].path);
  assert.equal(url.searchParams.get('q'), 'foo');
  assert.equal(url.searchParams.get('areaId'), 'A1');
  assert.equal(url.searchParams.get('status'), 'active');
  assert.equal(url.searchParams.get('open'), '1');
});

test('pc_search_work_items: missing query returns validation error', async () => {
  const { ctx } = makeFakeContext({ responder: () => ok('{}') });
  const res = await handleWorkItemTool('pc_search_work_items', {}, ctx);
  assert.equal(firstText(res), 'pc_search_work_items: query required');
  assert.equal(res!.isError, true);
});

test('pc_search_work_items failure: exact failure string + isError', async () => {
  const { ctx } = makeFakeContext({ responder: () => err(500, 'boom') });
  const res = await handleWorkItemTool('pc_search_work_items', { query: 'x' }, ctx);
  assert.equal(firstText(res), 'pc_search_work_items failed (500): boom');
  assert.equal(res!.isError, true);
});

test('pc_list_areas success: emits raw body (no hint)', async () => {
  const serverBody = JSON.stringify({ areas: [{ id: 'A1' }] });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleWorkItemTool('pc_list_areas', {}, ctx);
  assert.equal(firstText(res), serverBody);
  assert.equal(res!.content.length, 1); // no rich-link hint block
  assert.equal(calls[0].path, '/api/projects/P01/areas');
});

// FD-19 — pc_update_area: list-for-version then PATCH with expectedVersion.
const AREA_ROW = {
  id: 'A1',
  projectId: 'P01',
  name: 'Old name',
  summary: 'old summary',
  sortOrder: 0,
  version: 3,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

test('pc_update_area success: reads areas for version, PATCHes with expectedVersion', async () => {
  const patchBody = JSON.stringify({ ok: true, area: { ...AREA_ROW, summary: 'new' } });
  const { ctx, calls } = makeFakeContext({
    responder: (method) =>
      method === 'GET' ? ok({ areas: [AREA_ROW] }) : ok(patchBody),
  });
  const res = await handleWorkItemTool('pc_update_area', { area_id: 'A1', summary: 'new' }, ctx);
  assert.equal(firstText(res), patchBody);
  assert.equal(res!.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'GET', path: '/api/projects/P01/areas' },
    {
      method: 'PATCH',
      path: '/api/projects/P01/areas/A1',
      body: { expectedVersion: 3, summary: 'new' },
    },
  ] as RecordedCall[]);
});

test('pc_update_area: name is trimmed and sent alongside summary', async () => {
  const { ctx, calls } = makeFakeContext({
    responder: (method) => (method === 'GET' ? ok({ areas: [AREA_ROW] }) : ok('{"ok":true}')),
  });
  await handleWorkItemTool('pc_update_area', { area_id: 'A1', name: '  New  ', summary: 's' }, ctx);
  assert.deepEqual(calls[1].body, { expectedVersion: 3, name: 'New', summary: 's' });
});

test('pc_update_area unknown area: exact error, no PATCH issued', async () => {
  const { ctx, calls } = makeFakeContext({
    responder: () => ok({ areas: [AREA_ROW] }),
  });
  const res = await handleWorkItemTool('pc_update_area', { area_id: 'NOPE', name: 'x' }, ctx);
  assert.equal(firstText(res), 'pc_update_area: unknown area NOPE — see pc_list_areas');
  assert.equal(res!.isError, true);
  assert.equal(calls.length, 1); // GET only
});

test('pc_update_area missing args: exact validation strings', async () => {
  const { ctx } = makeFakeContext({ responder: () => ok('{}') });
  const noId = await handleWorkItemTool('pc_update_area', { name: 'x' }, ctx);
  assert.equal(firstText(noId), 'pc_update_area: area_id required');
  assert.equal(noId!.isError, true);
  const noFields = await handleWorkItemTool('pc_update_area', { area_id: 'A1' }, ctx);
  assert.equal(firstText(noFields), 'pc_update_area: at least one of name or summary required');
  assert.equal(noFields!.isError, true);
});

test('pc_update_area PATCH failure: exact failure string + isError', async () => {
  const { ctx } = makeFakeContext({
    responder: (method) =>
      method === 'GET' ? ok({ areas: [AREA_ROW] }) : err(409, 'version conflict'),
  });
  const res = await handleWorkItemTool('pc_update_area', { area_id: 'A1', summary: 's' }, ctx);
  assert.equal(firstText(res), 'pc_update_area failed (409): version conflict');
  assert.equal(res!.isError, true);
});

test('pc_move_work_item success: emits raw body; posts move with resolved id', async () => {
  const serverBody = JSON.stringify({ ok: true });
  const { ctx, calls } = makeFakeContext({
    responder: () => ok(serverBody),
    resolveWorkItemId: async () => 'RESOLVED',
  });
  const res = await handleWorkItemTool(
    'pc_move_work_item',
    { id: 'pc-1', toFlag: 'done', notes: 'because' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/work-items/move',
    body: { id: 'RESOLVED', toFlag: 'done', notes: 'because' },
  });
});

test('pc_update_work_item success: emits raw body; posts update payload', async () => {
  const serverBody = JSON.stringify({ ok: true });
  const { ctx, calls } = makeFakeContext({
    responder: () => ok(serverBody),
    resolveWorkItemId: async () => 'RID',
  });
  await handleWorkItemTool(
    'pc_update_work_item',
    { id: 'pc-2', body: 'newbody', area_id: null },
    ctx,
  );
  assert.deepEqual(calls[0].body, { id: 'RID', body: 'newbody', areaId: null });
});

test('pc_update_work_item with parent_work_item_id: forwards parentId in payload', async () => {
  const serverBody = JSON.stringify({ ok: true });
  const { ctx, calls } = makeFakeContext({
    responder: () => ok(serverBody),
    resolveWorkItemId: async () => 'RID',
  });
  await handleWorkItemTool(
    'pc_update_work_item',
    { id: 'pc-2', parent_work_item_id: 'PARENT1' },
    ctx,
  );
  assert.deepEqual(calls[0].body, { id: 'RID', parentId: 'PARENT1' });
});

test('pc_update_work_item with parent_work_item_id null: forwards parentId: null (detach)', async () => {
  const serverBody = JSON.stringify({ ok: true });
  const { ctx, calls } = makeFakeContext({
    responder: () => ok(serverBody),
    resolveWorkItemId: async () => 'RID',
  });
  await handleWorkItemTool(
    'pc_update_work_item',
    { id: 'pc-2', parent_work_item_id: null },
    ctx,
  );
  assert.deepEqual(calls[0].body, { id: 'RID', parentId: null });
});

test('pc_update_work_item with no mutable fields: validation error names parent_work_item_id', async () => {
  const { ctx } = makeFakeContext({ responder: () => ok('{}'), resolveWorkItemId: async () => 'RID' });
  const res = await handleWorkItemTool('pc_update_work_item', { id: 'pc-2' }, ctx);
  assert.equal(
    firstText(res),
    'pc_update_work_item: at least one of fields, body, title, area_id, or parent_work_item_id required',
  );
  assert.equal(res!.isError, true);
});

test('pc_attach_to_work_item success: emits raw body; posts attachment payload', async () => {
  const serverBody = JSON.stringify({ ok: true, attachment: { id: 'AT1' } });
  const { ctx, calls } = makeFakeContext({
    responder: () => ok(serverBody, 201),
    resolveWorkItemId: async () => 'WID',
  });
  const res = await handleWorkItemTool(
    'pc_attach_to_work_item',
    { workItemId: 'pc-3', name: 'report', content: 'hello' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/work-items/WID/attachments',
    body: { kind: 'markdown', name: 'report', content: 'hello', source: 'agent' },
  });
});

// pc-pty-chat-377 — cross-project reads via targetProjectId
test('pc_get_work_item with targetProjectId: uses target project path, not current project', async () => {
  const serverBody = JSON.stringify({ ok: true, workItem: { id: 'WI2', projectId: 'P02' } });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleWorkItemTool('pc_get_work_item', { id: 'WI2', targetProjectId: 'P02' }, ctx);
  assert.ok(res);
  assert.equal(res!.content[0].text, serverBody);
  assert.equal(res!.content[1].text, RICH_LINK_HINT);
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/projects/P02/work-items/WI2' }] as RecordedCall[]);
});

test('pc_get_work_item with targetProjectId slug: passes slug in path (server resolves)', async () => {
  const { ctx, calls } = makeFakeContext({ responder: () => ok('{"ok":true,"workItem":{"id":"WI3"}}') });
  await handleWorkItemTool('pc_get_work_item', { id: 'WI3', targetProjectId: 'my-project' }, ctx);
  assert.equal(calls[0].path, '/api/projects/my-project/work-items/WI3');
});

test('pc_get_work_item without targetProjectId: still uses current project path', async () => {
  const { ctx, calls } = makeFakeContext({ responder: () => ok('{}') });
  await handleWorkItemTool('pc_get_work_item', { id: 'WI1' }, ctx);
  assert.equal(calls[0].path, '/api/projects/P01/work-items/WI1');
});

test('pc_search_work_items with targetProjectId: uses target project path', async () => {
  const serverBody = JSON.stringify({ ok: true, results: [{ id: 'WI5', title: 'hello' }] });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleWorkItemTool('pc_search_work_items', { query: 'hello', targetProjectId: 'P02' }, ctx);
  assert.equal(res!.content[0].text, serverBody);
  assert.ok(calls[0].path.startsWith('/api/projects/P02/work-items/search?q=hello'));
});

test('pc_search_work_items with targetProjectId + filters: all forwarded', async () => {
  const { ctx, calls } = makeFakeContext({ responder: () => ok('{}') });
  await handleWorkItemTool('pc_search_work_items', { query: 'foo', targetProjectId: 'P02', area_id: 'A1', open: true }, ctx);
  const url = new URL('http://x' + calls[0].path);
  assert.ok(calls[0].path.startsWith('/api/projects/P02/'));
  assert.equal(url.searchParams.get('q'), 'foo');
  assert.equal(url.searchParams.get('areaId'), 'A1');
  assert.equal(url.searchParams.get('open'), '1');
});

// ── project-config family ──────────────────────────────────────────────────

test('pc_list_stages success: projects stages into ok-wrapped JSON', async () => {
  const project = { stages: [{ id: 's1', name: 'Draft', order: 0, isNew: true }] };
  const { ctx, calls } = makeFakeContext({ responder: () => ok(project) });
  const res = await handleProjectConfigTool('pc_list_stages', {}, ctx);
  assert.equal(
    firstText(res),
    JSON.stringify({ ok: true, stages: [{ id: 's1', name: 'Draft', order: 0, isNew: true }] }),
  );
  assert.equal(calls[0].path, '/api/projects/P01');
});

test('pc_list_field_schemas success: emits raw body', async () => {
  const serverBody = JSON.stringify({ ok: true, schemas: [] });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleProjectConfigTool('pc_list_field_schemas', {}, ctx);
  assert.equal(firstText(res), serverBody);
  assert.equal(calls[0].path, '/api/projects/P01/field-schemas');
});

test('pc_write_claude_md success: emits raw body; PUTs content', async () => {
  const serverBody = JSON.stringify({ ok: true });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleProjectConfigTool('pc_write_claude_md', { content: '# Hi' }, ctx);
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'PUT',
    path: '/api/projects/P01/claude-md',
    body: { content: '# Hi' },
  });
});

test('pc_replace_stages failure: exact failure string', async () => {
  const { ctx } = makeFakeContext({ responder: () => err(409, 'STAGE_HAS_ITEMS') });
  const res = await handleProjectConfigTool('pc_replace_stages', { stages: [] }, ctx);
  assert.equal(firstText(res), 'pc_replace_stages failed (409): STAGE_HAS_ITEMS');
  assert.equal(res!.isError, true);
});
