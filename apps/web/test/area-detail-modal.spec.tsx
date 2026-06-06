// Real-component test for AreaDetailModal.
// Imports and renders the ACTUAL component (not an inline copy).
//
// Contracts tested:
//   1. area name renders in the header
//   2. only OPEN work items in this area appear (complete excluded; other-area + null-area excluded)
//   3. row click calls openWorkItem with the work item's id (not callsign)
//   4. openWorkItem is not called during render — only on interaction
//   5. uncategorized mode: title is "Uncategorized", lists only open areaId==null items
//   6. uncategorized create-in-place button label

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { AreaDetailModal } from '@/components/work-items/AreaDetailModal';
import type { Area } from '@/features/areas/client';
import type { WorkItem } from '@/features/work-items/client';
import type { Project } from '@/features/projects/client';

// ── Mocks ────────────────────────────────────────────────────────────────────

// AreaDetailModal calls useChatWorkItemModal(selector) to get the open fn.
const mockOpen = vi.fn();
vi.mock('@/store/chat-work-item-modal', () => ({
  useChatWorkItemModal: (selector: (s: { open: (id: string) => void }) => unknown) =>
    selector({ open: mockOpen }),
}));

// AreaEditModal mounts over AreaDetailModal on "Edit" — not exercised here.
vi.mock('@/components/work-items/AreaEditModal', () => ({
  AreaEditModal: () => null,
}));

// contextDocsApi.list — not the focus of these tests; return empty.
vi.mock('@/features/context-docs/client', () => ({
  contextDocsApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

// useGlobalQuickAdd — stub the open action.
const mockQuickAdd = vi.fn();
vi.mock('@/store/global-quick-add', () => ({
  useGlobalQuickAdd: (selector: (s: { open: typeof mockQuickAdd }) => unknown) =>
    selector({ open: mockQuickAdd }),
}));

// useLiveEntitySignature — returns a stable empty string (no live refresh needed).
vi.mock('@/store/live-store', () => ({
  useLiveEntitySignature: () => '',
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PROJECT: Project = {
  id: 'p1',
  slug: 'test',
  name: 'Test Project',
  folderPath: '/tmp',
  gitRemote: null,
  callsignSeq: 1,
  stages: [{ id: 's1', name: 'Draft', order: 0, isNew: true }],
  settings: { cancelledVisibility: 'use-global', remoteControl: 'use-global' },
};

const AREA: Area = {
  id: 'a1',
  name: 'Alpha Area',
  summary: 'A test area',
  sortOrder: 0,
  projectId: 'p1',
  version: 1,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
};

/** Minimal WorkItem that satisfies the type + AreaDetailModal's used fields. */
function wi(overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'areaId' | 'title' | 'status'>): WorkItem {
  return {
    projectId: 'p1',
    parentId: null,
    initiativeId: null,
    position: 0,
    body: '',
    stageId: 's1',
    type: 'task',
    fields: {},
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    history: [],
    callsign: null,
    statusReason: null,
    ...overrides,
  };
}

const ITEMS: WorkItem[] = [
  wi({ id: 'w1', areaId: 'a1', status: 'pending', title: 'Open item' }),
  wi({ id: 'w2', areaId: 'a1', status: 'complete', title: 'Done item' }),
  wi({ id: 'w3', areaId: 'a2', status: 'pending', title: 'Other area item' }),
  wi({ id: 'w4', areaId: null, status: 'pending', title: 'Uncaptured item' }),
];

// ── Tests — real area mode ────────────────────────────────────────────────────

describe('AreaDetailModal (real component)', () => {
  beforeEach(() => {
    mockOpen.mockClear();
    mockQuickAdd.mockClear();
  });

  function renderModal(overrides?: Partial<Parameters<typeof AreaDetailModal>[0]>) {
    return render(
      <AreaDetailModal
        project={PROJECT}
        area={AREA}
        workItems={ITEMS}
        openCount={2}
        doneCount={1}
        onClose={vi.fn()}
        onChanged={vi.fn()}
        {...overrides}
      />,
    );
  }

  test('renders the area name in the header', () => {
    renderModal();
    expect(screen.getByText('Alpha Area')).toBeInTheDocument();
  });

  test('member list shows only OPEN items in this area (complete excluded)', () => {
    renderModal();
    // Open pending items in area a1 appear.
    expect(screen.getByText('Open item')).toBeInTheDocument();
    // complete items are excluded by isOpenStatus.
    expect(screen.queryByText('Done item')).not.toBeInTheDocument();
    // Items from other areas are excluded.
    expect(screen.queryByText('Other area item')).not.toBeInTheDocument();
    // Null-area items are excluded.
    expect(screen.queryByText('Uncaptured item')).not.toBeInTheDocument();
  });

  test('row click calls openWorkItem with the work item id', () => {
    renderModal();
    fireEvent.click(screen.getByText('Open item'));
    expect(mockOpen).toHaveBeenCalledWith('w1');
  });

  test('openWorkItem receives the id, not the callsign', () => {
    const withCallsign = [wi({ id: 'w-cs', areaId: 'a1', status: 'pending', title: 'Has Callsign', callsign: 'proj-7' })];
    renderModal({ workItems: withCallsign });
    fireEvent.click(screen.getByText('Has Callsign'));
    expect(mockOpen).toHaveBeenCalledWith('w-cs');
    expect(mockOpen).not.toHaveBeenCalledWith('proj-7');
  });

  test('openWorkItem is not called during render — only on row click', () => {
    renderModal();
    // Verify the member list rendered (render phase complete) without invoking open
    expect(screen.getByText('Open item')).toBeInTheDocument();
    expect(mockOpen).not.toHaveBeenCalled();

    // A single click emits exactly one call
    fireEvent.click(screen.getByText('Open item'));
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  test('shows empty state when no items belong to this area', () => {
    renderModal({ workItems: [] });
    expect(screen.getByText(/No open tasks in this area/i)).toBeInTheDocument();
  });

  test('Edit button is visible in real area mode', () => {
    renderModal();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
  });
});

// ── Tests — uncategorized mode ────────────────────────────────────────────────

describe('AreaDetailModal — uncategorized mode', () => {
  beforeEach(() => {
    mockOpen.mockClear();
    mockQuickAdd.mockClear();
  });

  function renderUncategorized(overrides?: Partial<Parameters<typeof AreaDetailModal>[0]>) {
    return render(
      <AreaDetailModal
        project={PROJECT}
        // No area prop = uncategorized mode
        workItems={ITEMS}
        openCount={1}
        doneCount={0}
        onClose={vi.fn()}
        onChanged={vi.fn()}
        {...overrides}
      />,
    );
  }

  test('title is "Uncategorized" when no area is passed', () => {
    renderUncategorized();
    expect(screen.getByRole('heading', { name: /uncategorized/i })).toBeInTheDocument();
  });

  test('lists only open items with areaId == null', () => {
    renderUncategorized();
    // w4 is areaId=null, status=pending — should appear.
    expect(screen.getByText('Uncaptured item')).toBeInTheDocument();
    // w1 is areaId=a1 — should not appear.
    expect(screen.queryByText('Open item')).not.toBeInTheDocument();
    // w3 is areaId=a2 — should not appear.
    expect(screen.queryByText('Other area item')).not.toBeInTheDocument();
    // w2 is complete — excluded by isOpenStatus.
    expect(screen.queryByText('Done item')).not.toBeInTheDocument();
  });

  test('Edit button is NOT rendered in uncategorized mode', () => {
    renderUncategorized();
    // All buttons visible; none should say "Edit"
    const buttons = screen.getAllByRole('button');
    expect(buttons.every((b) => b.textContent?.trim() !== 'Edit')).toBe(true);
  });

  test('create-in-place button label is "no area" in uncategorized mode', () => {
    renderUncategorized();
    expect(screen.getByText(/new task \(no area\)/i)).toBeInTheDocument();
  });

  test('empty state says "No unassigned open tasks" when no null-area items', () => {
    // Only items with a real area — nothing for uncategorized
    const areaItems = [wi({ id: 'w1', areaId: 'a1', status: 'pending', title: 'Area task' })];
    renderUncategorized({ workItems: areaItems });
    expect(screen.getByText(/No unassigned open tasks/i)).toBeInTheDocument();
  });

  test('clicking a row still calls openWorkItem with the work item id', () => {
    renderUncategorized();
    fireEvent.click(screen.getByText('Uncaptured item'));
    expect(mockOpen).toHaveBeenCalledWith('w4');
  });
});
