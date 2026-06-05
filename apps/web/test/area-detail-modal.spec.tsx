// Real-component test for AreaDetailModal.
// Imports and renders the ACTUAL component (not an inline copy).
// Replaces the logic-copy in area-detail-modal.test.ts which admitted to
// testing a re-implemented duplicate ("tsx --test runner cannot resolve @/ aliases").
//
// Contracts tested:
//   1. area name renders in the header
//   2. only work items in this area appear (other-area + null-area excluded)
//   3. row click calls openWorkItem with the work item's id (not callsign)
//   4. openWorkItem is not called during render — only on interaction

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { AreaDetailModal } from '@/components/work-items/AreaDetailModal';
import type { Area } from '@/features/areas/client';
import type { WorkItem } from '@/features/work-items/client';

// ── Mocks ────────────────────────────────────────────────────────────────────

// AreaDetailModal calls useChatWorkItemModal(selector) to get the open fn.
// The selector receives the store slice; return the mock fn for the `open` key.
const mockOpen = vi.fn();
vi.mock('@/store/chat-work-item-modal', () => ({
  useChatWorkItemModal: (selector: (s: { open: (id: string) => void }) => unknown) =>
    selector({ open: mockOpen }),
}));

// AreaEditModal mounts over AreaDetailModal on "Edit" — not exercised here.
vi.mock('@/components/work-items/AreaEditModal', () => ({
  AreaEditModal: () => null,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AreaDetailModal (real component)', () => {
  beforeEach(() => {
    mockOpen.mockClear();
  });

  function renderModal(overrides?: Partial<Parameters<typeof AreaDetailModal>[0]>) {
    return render(
      <AreaDetailModal
        projectId="p1"
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

  test('member list shows only items in this area', () => {
    renderModal();
    expect(screen.getByText('Open item')).toBeInTheDocument();
    expect(screen.getByText('Done item')).toBeInTheDocument();
    expect(screen.queryByText('Other area item')).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByText('Done item'));
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  test('shows empty state when no items belong to this area', () => {
    renderModal({ workItems: [] });
    expect(screen.getByText(/No work items in this Area yet/i)).toBeInTheDocument();
  });
});
