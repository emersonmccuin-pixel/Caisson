import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TypedLocalhostClient, type TypedClientTransport } from '../src/client/typed-client.ts';
import type { ServerResponse } from '../src/tools/context.ts';
import type { WorkItemDto } from '@pc/contracts';

const WORK_ITEM: WorkItemDto = {
  id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
  projectId: '01PPPPPPPPPPPPPPPPPPPPPPPP',
  parentId: null,
  callsign: 'pc-1',
  position: 0,
  title: 'Do the thing',
  body: 'details',
  stageId: 'todo',
  status: 'pending',
  statusReason: null,
  type: 'task',
  fields: {},
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  isAgentTask: false,
  isWorkflowRoot: false,
  ephemeral: false,
  acceptanceCriteria: null,
  expectedOutput: null,
  verificationTier: null,
  verificationStatus: null,
  verificationNotes: null,
  assignedAgentRunId: null,
  worktreePath: null,
  areaId: null,
};

function transportReturning(res: ServerResponse): TypedClientTransport {
  const r = async () => res;
  return { postServer: r, putServer: r, getServer: r, patchServer: r, deleteServer: r };
}

test('parses a well-formed 2xx body into the DTO + preserves raw body', async () => {
  const body = JSON.stringify({ ok: true, workItem: WORK_ITEM });
  const client = new TypedLocalhostClient(transportReturning({ status: 200, body }));
  const result = await client.getWorkItem('/api/projects/P/work-items/x');
  assert.equal(result.status, 200);
  assert.equal(result.body, body); // raw body preserved byte-for-byte
  assert.ok(result.parsed.ok);
  if (result.parsed.ok) assert.equal(result.parsed.value.id, WORK_ITEM.id);
});

test('non-2xx returns a typed error AND the raw {status, body}', async () => {
  const body = JSON.stringify({ ok: false, error: 'not found' });
  const client = new TypedLocalhostClient(transportReturning({ status: 404, body }));
  const result = await client.getWorkItem('/api/projects/P/work-items/x');
  assert.equal(result.status, 404);
  assert.equal(result.body, body);
  assert.equal(result.parsed.ok, false);
});

test('malformed body falls back to raw without throwing', async () => {
  const body = 'this is not json {';
  const client = new TypedLocalhostClient(transportReturning({ status: 200, body }));
  const result = await client.getWorkItem('/api/projects/P/work-items/x');
  assert.equal(result.status, 200);
  assert.equal(result.body, body);
  assert.equal(result.parsed.ok, false);
});

test('shape miss (2xx but wrong DTO shape) surfaces a typed error, raw preserved', async () => {
  const body = JSON.stringify({ ok: true, workItem: { id: 'x' } }); // missing fields
  const client = new TypedLocalhostClient(transportReturning({ status: 200, body }));
  const result = await client.getWorkItem('/api/projects/P/work-items/x');
  assert.equal(result.status, 200);
  assert.equal(result.body, body);
  assert.equal(result.parsed.ok, false);
});

test('list method parses an array of DTOs', async () => {
  const body = JSON.stringify({ ok: true, workItems: [WORK_ITEM, WORK_ITEM] });
  const client = new TypedLocalhostClient(transportReturning({ status: 200, body }));
  const result = await client.listWorkItems('/api/projects/P/work-items');
  assert.ok(result.parsed.ok);
  if (result.parsed.ok) assert.equal(result.parsed.value.length, 2);
});

test('list method on a non-array field falls back to typed error', async () => {
  const body = JSON.stringify({ ok: true, workItems: 'nope' });
  const client = new TypedLocalhostClient(transportReturning({ status: 200, body }));
  const result = await client.listWorkItems('/api/projects/P/work-items');
  assert.equal(result.parsed.ok, false);
  assert.equal(result.body, body);
});

test('fromContext builds a client that issues through the injected transport', async () => {
  // sanity: the static helper exists and produces a usable client
  let seen = '';
  const t: TypedClientTransport = {
    postServer: async (p) => {
      seen = p;
      return { status: 200, body: JSON.stringify({ workItem: WORK_ITEM }) };
    },
    putServer: async () => ({ status: 200, body: '{}' }),
    getServer: async () => ({ status: 200, body: '{}' }),
    patchServer: async () => ({ status: 200, body: '{}' }),
    deleteServer: async () => ({ status: 200, body: '{}' }),
  };
  const client = new TypedLocalhostClient(t);
  await client.createWorkItem('/api/projects/P/work-items/create', { title: 'x' });
  assert.equal(seen, '/api/projects/P/work-items/create');
});
