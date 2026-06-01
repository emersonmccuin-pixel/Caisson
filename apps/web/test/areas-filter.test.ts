// Slice 010 — Areas web seams.
//
// The web test runner (`tsx --test` from repo root) cannot resolve the `@/`
// Vite alias, so filter-sort.ts / the hooks can't be imported directly;
// `pnpm typecheck` covers their wiring. These tests pin the two contract-level
// seams the slice depends on, replicating production logic verbatim:
//   1. matchesAreaFilter — the left-rail Area filter predicate (filter-sort.ts).
//   2. the area-frame refetch gate — `isAreaChangedLiveEventFrame` + project +
//      `reason === 'deleted'` carry-forward branch (Kanban/Table/useProjectAreas).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAreaChangedLiveEventFrame, type AreaDto } from '@pc/contracts';

// ── 1. matchesAreaFilter (verbatim copy of filter-sort.ts) ──────────────────

type AreaFilter = string | null | 'uncaptured';

function matchesAreaFilter(wi: { areaId: string | null }, areaFilter: AreaFilter): boolean {
  if (areaFilter == null) return true;
  if (areaFilter === 'uncaptured') return wi.areaId == null;
  return wi.areaId === areaFilter;
}

test('matchesAreaFilter: All (null) passes everything', () => {
  assert.equal(matchesAreaFilter({ areaId: null }, null), true);
  assert.equal(matchesAreaFilter({ areaId: 'a1' }, null), true);
});

test('matchesAreaFilter: uncaptured matches only null areaId', () => {
  assert.equal(matchesAreaFilter({ areaId: null }, 'uncaptured'), true);
  assert.equal(matchesAreaFilter({ areaId: 'a1' }, 'uncaptured'), false);
});

test('matchesAreaFilter: an Area id matches only that area', () => {
  assert.equal(matchesAreaFilter({ areaId: 'a1' }, 'a1'), true);
  assert.equal(matchesAreaFilter({ areaId: 'a2' }, 'a1'), false);
  assert.equal(matchesAreaFilter({ areaId: null }, 'a1'), false);
});

// ── 2. area-frame refetch gate ──────────────────────────────────────────────

function area(over: Partial<AreaDto> = {}): AreaDto {
  return {
    id: 'a1',
    projectId: 'p1',
    name: 'Bugs',
    summary: '',
    sortOrder: 0,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...over,
  };
}

function frame(reason: string, projectId = 'p1', payload: object = {}) {
  return {
    type: 'live-event',
    event: {
      id: `e-${reason}`,
      cursor: '1',
      scope: 'project',
      projectId,
      type: 'area.changed',
      entity: 'area',
      entityId: 'a1',
      version: 1,
      createdAt: 1,
      payload: { reason, ...payload },
    },
  };
}

test('isAreaChangedLiveEventFrame accepts a created frame carrying an area', () => {
  const f = frame('created', 'p1', { area: area() });
  assert.equal(isAreaChangedLiveEventFrame(f), true);
});

test('isAreaChangedLiveEventFrame accepts a reordered frame carrying areas[]', () => {
  const f = frame('reordered', 'p1', { areas: [area(), area({ id: 'a2', sortOrder: 1 })] });
  assert.equal(isAreaChangedLiveEventFrame(f), true);
});

test('isAreaChangedLiveEventFrame accepts a bare deleted frame', () => {
  const f = frame('deleted', 'p1');
  assert.equal(isAreaChangedLiveEventFrame(f), true);
});

test('a non-area frame is rejected', () => {
  const f = {
    type: 'live-event',
    event: {
      id: 'e1',
      cursor: '1',
      scope: 'project',
      projectId: 'p1',
      type: 'work-item.changed',
      entity: 'work-item',
      entityId: 'w1',
      version: 1,
      createdAt: 1,
      payload: { reason: 'patched' },
    },
  };
  assert.equal(isAreaChangedLiveEventFrame(f), false);
});

test('deleted carry-forward gate: only fires on this project + reason deleted', () => {
  // Contract-level guard check. T3.2b moved Kanban/Table onto the live store
  // (`hasNewDeletedAreaFrame`, pinned in area-live-events.test.ts); the store's
  // project-scope selector applies the project filter, so this only asserts the
  // guard + reason discrimination still hold.
  const matches = (f: unknown, projectId: string) =>
    isAreaChangedLiveEventFrame(f) &&
    f.event.projectId === projectId &&
    f.event.payload.reason === 'deleted';

  assert.equal(matches(frame('deleted', 'p1'), 'p1'), true);
  assert.equal(matches(frame('deleted', 'p2'), 'p1'), false); // other project
  assert.equal(matches(frame('patched', 'p1', { area: area() }), 'p1'), false); // not a delete
});
