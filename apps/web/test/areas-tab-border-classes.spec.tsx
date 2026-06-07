// Real-component test for AreasTab border classes (pc-pty-chat-239).
//
// Contracts tested:
//   1. Area cards render with Tailwind border classes (border-2 border-border),
//      not an inline style — so the CSS token fix actually ships in the component.
//   2. No area card div has an inline `border` style property.
//   3. The UncategorizedCard uses border-dashed border-border, not an inline style.
//
// jsdom doesn't process CSS so we can't assert visual rendering, but we CAN assert
// the class/style attributes — which is what matters: a future regression would
// re-add the inline style or remove the class, and this test would catch it.

import { render, screen } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import { AreasTab } from '@/components/work-items/AreasTab';
import type { Area } from '@/features/areas/client';
import type { Project } from '@/features/projects/client';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/hooks/use-project-areas', () => ({
  useProjectAreas: () => ({
    areas: AREAS,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-project-work-items', () => ({
  useProjectWorkItems: () => ({
    workItems: [],
  }),
}));

vi.mock('@/components/work-items/AreaDetailModal', () => ({
  AreaDetailModal: () => null,
}));

vi.mock('@/store/live-store', () => ({
  useLiveEntitySignature: () => '',
}));

vi.mock('@/features/areas/client', () => ({
  areasApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    reorder: vi.fn(),
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

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

const AREAS: Area[] = [
  {
    id: 'a1',
    name: 'Alpha Area',
    summary: 'First area',
    sortOrder: 0,
    projectId: 'p1',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  },
  {
    id: 'a2',
    name: 'Beta Area',
    summary: null,
    sortOrder: 1,
    projectId: 'p1',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AreasTab border classes (pc-pty-chat-239)', () => {
  test('area cards use border-2 border-border class, not inline style', () => {
    render(<AreasTab project={PROJECT} events={[]} />);

    // Area names should be visible
    expect(screen.getByText('Alpha Area')).toBeTruthy();
    expect(screen.getByText('Beta Area')).toBeTruthy();

    // Find area card divs: they have bg-card and border-2 classes
    const cards = document.querySelectorAll('[class*="border-2"][class*="border-border"]');
    expect(cards.length).toBeGreaterThan(0);

    // None of the border-2 elements should have an inline border style
    cards.forEach((card) => {
      const el = card as HTMLElement;
      expect(el.style.border).toBe('');
    });
  });

  test('no element with class bg-card has inline border style', () => {
    render(<AreasTab project={PROJECT} events={[]} />);

    // bg-card elements are area cards; they must not rely on inline borders
    const cardDivs = document.querySelectorAll('[class*="bg-card"]');
    cardDivs.forEach((el) => {
      expect((el as HTMLElement).style.border).toBe('');
    });
  });

  test('Uncategorized card uses border-dashed class not inline style', () => {
    render(<AreasTab project={PROJECT} events={[]} />);

    // The Uncategorized button should have border-dashed class
    const uncategorizedBtn = screen.getByTitle(
      'Click to view tasks not assigned to any Area',
    );
    expect(uncategorizedBtn.className).toContain('border-dashed');
    expect(uncategorizedBtn.className).toContain('border-border');
    expect((uncategorizedBtn as HTMLElement).style.border).toBe('');
  });
});
