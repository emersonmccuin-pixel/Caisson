// pc-pty-chat-355 — pure grouping logic for the Focus tree.
// No React, no DOM — safe to import in node:test without jsdom.
//
// Hierarchy: project → area → work items.
// A focused work item is always shown under its real project and real area
// (even if the project/area itself is not focused) so the hierarchy reads true.

export interface FocusItem {
  id: string;
  projectId: string;
  areaId: string | null;
  title: string;
  callsign: string | null;
  status: string;
  focusedAt: number | null;
}

export interface FocusArea {
  id: string | null; // null = Uncategorized
  name: string;
  items: FocusItem[];
}

export interface FocusProject {
  id: string;
  name: string;
  areas: FocusArea[];
}

/** Build the nested focus tree from flat lists.
 *  Accepts any objects that satisfy the minimal shape — callers may pass the
 *  full WorkItem / Project / Area DTO and the extra fields are ignored. */
export function buildFocusTree(
  focusedItems: FocusItem[],
  allProjects: ReadonlyArray<{ id: string; name: string }>,
  allAreas: ReadonlyArray<{ id: string; projectId: string; name: string }>,
): FocusProject[] {
  if (focusedItems.length === 0) return [];

  // Index structures.
  const projectMap = new Map(allProjects.map((p) => [p.id, p.name]));
  const areaMap = new Map(allAreas.map((a) => [a.id, a]));

  // Group items by projectId then by areaId.
  const projectItems = new Map<string, FocusItem[]>();
  for (const item of focusedItems) {
    const bucket = projectItems.get(item.projectId) ?? [];
    bucket.push(item);
    projectItems.set(item.projectId, bucket);
  }

  // Build the tree, preserving the order items appear within each project (focusedAt asc).
  const tree: FocusProject[] = [];
  for (const [projectId, items] of projectItems) {
    const projectName = projectMap.get(projectId) ?? projectId;

    // Group items by area within this project.
    const areaItems = new Map<string | null, FocusItem[]>();
    for (const item of items) {
      const key = item.areaId;
      const bucket = areaItems.get(key) ?? [];
      bucket.push(item);
      areaItems.set(key, bucket);
    }

    // Build area rows: named areas first (sorted by name), then Uncategorized.
    const areas: FocusArea[] = [];
    for (const [areaId, aItems] of areaItems) {
      if (areaId !== null) {
        const areaName = areaMap.get(areaId)?.name ?? areaId;
        areas.push({ id: areaId, name: areaName, items: aItems });
      }
    }
    areas.sort((a, b) => a.name.localeCompare(b.name));
    const uncategorized = areaItems.get(null);
    if (uncategorized) {
      areas.push({ id: null, name: 'Uncategorized', items: uncategorized });
    }

    tree.push({ id: projectId, name: projectName, areas });
  }

  // Sort projects by name.
  tree.sort((a, b) => a.name.localeCompare(b.name));
  return tree;
}
