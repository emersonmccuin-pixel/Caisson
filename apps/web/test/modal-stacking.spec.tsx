// Z-order stacking test — renders REAL modal components and asserts that
// WorkItemDetailModal (z-[60]) sits above AreaDetailModal (z-50).
//
// This is the automated acceptance test for the pc-pty-chat-202 regression:
// a reviewer "verified" modal stacking by reading class names in code, which
// let a z-inversion sail through to human review.
//
// When a developer accidentally changes z-[60] to z-[40] (or any value ≤ 50),
// this test fails with a non-zero exit code — no human required.
//
// Assertion method: render both modals (with API/hook mocks to avoid network),
// find the backdrop element of each, extract the Tailwind z-class numeric value,
// and assert work-item z > area z.

import { render } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import { AreaDetailModal } from '@/components/work-items/AreaDetailModal';
import { WorkItemDetailModal } from '@/components/work-items/WorkItemDetailModal';
import type { Area } from '@/features/areas/client';
import type { WorkItem } from '@/features/work-items/client';
import type { Project } from '@/features/projects/client';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// AreaDetailModal: useChatWorkItemModal selector
const mockOpen = vi.fn();
vi.mock('@/store/chat-work-item-modal', () => ({
  useChatWorkItemModal: (sel: (s: { open: typeof mockOpen }) => unknown) =>
    sel({ open: mockOpen }),
}));

// AreaEditModal (not needed for stacking test)
vi.mock('@/components/work-items/AreaEditModal', () => ({
  AreaEditModal: () => null,
}));

// WorkItemDetailModal: useProjectAreas (fetches from API — not needed here)
vi.mock('@/hooks/use-project-areas', () => ({
  useProjectAreas: () => ({ areas: [], refetch: vi.fn() }),
}));

// WorkItemDetailModal: useLiveEvents reads the Zustand live-store
vi.mock('@/store/live-store', () => ({
  useLiveEvents: () => [],
  useLiveEntitySignature: () => '',
}));

// WorkItemDetailModal: workItemsApi.listFieldSchemas + listAttachments
vi.mock('@/features/work-items/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/work-items/client')>();
  return {
    ...actual,
    workItemsApi: {
      ...actual.workItemsApi,
      listFieldSchemas: vi.fn().mockResolvedValue([]),
      listAttachments: vi.fn().mockResolvedValue([]),
    },
  };
});

// WorkLogSection (rendered on 'worklog' tab — not the default, skip it)
vi.mock('@/components/work-items/WorkLogSection', () => ({
  WorkLogSection: () => null,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AREA: Area = {
  id: 'a1', name: 'Test Area', summary: '', sortOrder: 0,
  projectId: 'p1', version: 1, createdAt: 0, updatedAt: 0, deletedAt: null,
};

function makeWI(id: string): WorkItem {
  return {
    id, projectId: 'p1', parentId: null, initiativeId: null, areaId: 'a1',
    position: 0, title: 'Test Item', body: '', stageId: 's1', status: 'pending',
    statusReason: null, type: 'task', fields: {}, version: 1,
    createdAt: 0, updatedAt: 0, deletedAt: null, history: [], callsign: null,
  };
}

const PROJECT: Project = {
  id: 'p1', slug: 'test', name: 'Test Project', folderPath: '/tmp',
  gitRemote: null, callsignSeq: 1,
  stages: [{ id: 's1', name: 'Draft', order: 0 }],
  settings: { cancelledVisibility: 'use-global', remoteControl: 'use-global' },
};

const WI = makeWI('wi-1');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse the numeric z-index from a Tailwind z-* class name.
 *   'z-50'    → 50
 *   'z-[60]'  → 60
 *   'z-[40]'  → 40   (the deliberate regression value)
 * Returns NaN if no z-class is found (test will naturally fail on comparison).
 */
function parseTailwindZ(className: string): number {
  // Match z-[N] (arbitrary) or z-N (scale)
  const m = className.match(/\bz-\[(\d+)\]|\bz-(\d+)\b/);
  if (!m) return NaN;
  return parseInt((m[1] ?? m[2])!, 10);
}

/** Find the outermost fixed backdrop element (position:fixed) produced by a modal render. */
function findBackdrop(container: HTMLElement): HTMLElement | null {
  // Both modals produce a root div with class `fixed inset-0 z-* ...`
  return container.querySelector('[class*="fixed"][class*="inset-0"]') as HTMLElement | null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('modal z-order stacking', () => {
  test('AreaDetailModal backdrop has z-50 class', () => {
    const { container } = render(
      <AreaDetailModal
        projectId="p1"
        area={AREA}
        workItems={[WI]}
        openCount={1}
        doneCount={0}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    const backdrop = findBackdrop(container);
    expect(backdrop).not.toBeNull();
    const z = parseTailwindZ(backdrop!.className);
    expect(z).toBe(50);
  });

  test('WorkItemDetailModal backdrop has z-[60] class', () => {
    const { container } = render(
      <WorkItemDetailModal
        workItem={WI}
        project={PROJECT}
        items={[WI]}
        events={[]}
        onClose={vi.fn()}
        onSwitchItem={vi.fn()}
        onItemCreated={vi.fn()}
      />,
    );
    const backdrop = findBackdrop(container);
    expect(backdrop).not.toBeNull();
    const z = parseTailwindZ(backdrop!.className);
    expect(z).toBe(60);
  });

  test('WorkItemDetailModal z-index is strictly higher than AreaDetailModal z-index', () => {
    const { container: areaContainer } = render(
      <AreaDetailModal
        projectId="p1"
        area={AREA}
        workItems={[WI]}
        openCount={1}
        doneCount={0}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    const { container: wiContainer } = render(
      <WorkItemDetailModal
        workItem={WI}
        project={PROJECT}
        items={[WI]}
        events={[]}
        onClose={vi.fn()}
        onSwitchItem={vi.fn()}
        onItemCreated={vi.fn()}
      />,
    );

    const areaBackdrop = findBackdrop(areaContainer);
    const wiBackdrop = findBackdrop(wiContainer);

    expect(areaBackdrop).not.toBeNull();
    expect(wiBackdrop).not.toBeNull();

    const areaZ = parseTailwindZ(areaBackdrop!.className);
    const wiZ = parseTailwindZ(wiBackdrop!.className);

    // WorkItemDetailModal MUST be above AreaDetailModal.
    // Deliberate regression: set WorkItemDetailModal to z-[40] → this fails:
    //   40 > 50 → false → test error
    expect(wiZ).toBeGreaterThan(areaZ);
  });
});
