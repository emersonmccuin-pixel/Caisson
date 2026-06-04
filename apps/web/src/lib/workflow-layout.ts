// Section 19.8 — pure layout function for the v2 workflow visualizer.
//
// Takes a WorkflowV2.Workflow and returns positioned nodes + edges using
// elkjs's `layered` algorithm with orthogonal routing. Top-to-bottom direction
// matches the one-socket-per-side model (lock 6): top = in, bottom = out,
// side (EAST) = reject back-edge socket on review nodes.
//
// Async because elkjs's layout is Promise-returning. Pure: no DOM access, no
// React, no side effects. Safe to call from a useEffect.
//
// Authoring overlays (drag-to-move, manual positions) layer on top of the
// elkjs result in the React component — the layout here is the auto baseline.

import ELK, { type ElkNode, type ElkExtendedEdge, type ElkExtendedEdge as ElkEdge } from 'elkjs/lib/elk.bundled.js';
import { WorkflowV2 } from '@pc/domain';

const elk = new ELK();

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 88;

export type PortSide = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdgePoint {
  x: number;
  y: number;
}

export type EdgeKind = 'forward' | 'reject';

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** Polyline bend points from elkjs (orthogonal routing). The first/last
   *  points are anchored at the source/target ports. */
  points: LayoutEdgePoint[];
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** Bounding box of the laid-out graph. Useful for sizing the canvas. */
  width: number;
  height: number;
}

/** Auto-layout the workflow. Returns positions in graph-local coordinates
 *  (top-left = 0,0). The React component owns the pan/zoom transform.
 *
 *  Honors per-node `position` overrides when ALL nodes have one (manual
 *  authoring took over). Mixed mode (some positions set, others not) falls
 *  back to full auto-layout — elkjs doesn't reliably partially-fix nodes in
 *  the `layered` algorithm, so v1 picks one of the two regimes cleanly. */
export async function layoutWorkflow(wf: WorkflowV2.Workflow): Promise<LayoutResult> {
  const allManual = wf.nodes.length > 0 && wf.nodes.every((n) => n.position !== undefined);
  if (allManual) return layoutFromManualPositions(wf);

  const elkNodes: ElkNode[] = wf.nodes.map((n) => ({
    id: n.id,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    ports: portsForNode(n),
    layoutOptions: { 'portConstraints': 'FIXED_SIDE' },
  }));

  const elkEdges: ElkExtendedEdge[] = [];
  for (const n of wf.nodes) {
    for (const next of n.next ?? []) {
      elkEdges.push({
        id: `e:${n.id}->${next}`,
        sources: [`${n.id}__out`],
        targets: [`${next}__in`],
        labels: [{ id: `${n.id}-${next}-kind`, text: 'forward' }],
      });
    }
    // FD-9: review reject → loop step, then loop → back_to. Both render as
    // back-edge ('reject') styling.
    if (WorkflowV2.isReviewNode(n) && n.reject) {
      elkEdges.push({
        id: `r:${n.id}->${n.reject}`,
        sources: [`${n.id}__reject`],
        targets: [`${n.reject}__in`],
        labels: [{ id: `${n.id}-reject-${n.reject}-kind`, text: 'reject' }],
      });
    }
    if (WorkflowV2.isLoopNode(n)) {
      elkEdges.push({
        id: `r:${n.id}->${n.back_to}`,
        sources: [`${n.id}__out`],
        targets: [`${n.back_to}__in`],
        labels: [{ id: `${n.id}-loopback-${n.back_to}-kind`, text: 'reject' }],
      });
    }
  }

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.portConstraints': 'FIXED_SIDE',
      // Keep reject back-edges visually distinct by letting elkjs route them
      // through the side socket; with FIXED_SIDE it'll wrap around cleanly.
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: elkNodes,
    edges: elkEdges,
  };

  const result = await elk.layout(graph);

  const nodes: LayoutNode[] = (result.children ?? []).map((c) => ({
    id: c.id,
    x: c.x ?? 0,
    y: c.y ?? 0,
    width: c.width ?? NODE_WIDTH,
    height: c.height ?? NODE_HEIGHT,
  }));

  const edges: LayoutEdge[] = (result.edges ?? []).map((e: ElkEdge) => {
    const kind: EdgeKind = e.labels?.[0]?.text === 'reject' ? 'reject' : 'forward';
    const section = e.sections?.[0];
    const points: LayoutEdgePoint[] = section
      ? [
          { x: section.startPoint.x, y: section.startPoint.y },
          ...(section.bendPoints ?? []).map((p) => ({ x: p.x, y: p.y })),
          { x: section.endPoint.x, y: section.endPoint.y },
        ]
      : [];
    return {
      id: e.id,
      source: (e.sources?.[0] ?? '').split('__')[0]!,
      target: (e.targets?.[0] ?? '').split('__')[0]!,
      kind,
      points,
    };
  });

  return {
    nodes,
    edges,
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
}

/** When every node carries `position`, skip elkjs and route edges as simple
 *  straight lines bottom-of-source → top-of-target. The user has taken over;
 *  the visualizer's job is to render their positions faithfully, not relayout
 *  on every drag. Reject back-edges route from EAST side → target NORTH. */
function layoutFromManualPositions(wf: WorkflowV2.Workflow): LayoutResult {
  const nodes: LayoutNode[] = wf.nodes.map((n) => ({
    id: n.id,
    x: n.position!.x,
    y: n.position!.y,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const edges: LayoutEdge[] = [];
  for (const n of wf.nodes) {
    const src = byId.get(n.id)!;
    for (const next of n.next ?? []) {
      const tgt = byId.get(next);
      if (!tgt) continue;
      edges.push({
        id: `e:${n.id}->${next}`,
        source: n.id,
        target: next,
        kind: 'forward',
        points: straightVerticalEdge(src, tgt),
      });
    }
    if (WorkflowV2.isReviewNode(n) && n.reject) {
      const tgt = byId.get(n.reject);
      if (!tgt) continue;
      edges.push({
        id: `r:${n.id}->${n.reject}`,
        source: n.id,
        target: n.reject,
        kind: 'reject',
        points: rejectSideEdge(src, tgt),
      });
    }
    if (WorkflowV2.isLoopNode(n)) {
      const tgt = byId.get(n.back_to);
      if (!tgt) continue;
      edges.push({
        id: `r:${n.id}->${n.back_to}`,
        source: n.id,
        target: n.back_to,
        kind: 'reject',
        points: rejectSideEdge(src, tgt),
      });
    }
  }

  const width = Math.max(0, ...nodes.map((n) => n.x + n.width));
  const height = Math.max(0, ...nodes.map((n) => n.y + n.height));
  return { nodes, edges, width, height };
}

function straightVerticalEdge(src: LayoutNode, tgt: LayoutNode): LayoutEdgePoint[] {
  const sx = src.x + src.width / 2;
  const sy = src.y + src.height;
  const tx = tgt.x + tgt.width / 2;
  const ty = tgt.y;
  // Orthogonal: vertical, horizontal at mid, vertical.
  const midY = sy + Math.max(20, (ty - sy) / 2);
  return [
    { x: sx, y: sy },
    { x: sx, y: midY },
    { x: tx, y: midY },
    { x: tx, y: ty },
  ];
}

function rejectSideEdge(src: LayoutNode, tgt: LayoutNode): LayoutEdgePoint[] {
  const sx = src.x + src.width;
  const sy = src.y + src.height / 2;
  const tx = tgt.x + tgt.width / 2;
  const ty = tgt.y;
  // Loop out to the right, up, then in to the top of target.
  const outX = sx + 40;
  return [
    { x: sx, y: sy },
    { x: outX, y: sy },
    { x: outX, y: ty - 30 },
    { x: tx, y: ty - 30 },
    { x: tx, y: ty },
  ];
}

function portsForNode(n: WorkflowV2.WorkflowNode): NonNullable<ElkNode['ports']> {
  const base: NonNullable<ElkNode['ports']> = [
    { id: `${n.id}__in`, layoutOptions: { 'port.side': 'NORTH' } },
    { id: `${n.id}__out`, layoutOptions: { 'port.side': 'SOUTH' } },
  ];
  if (WorkflowV2.isReviewNode(n)) {
    base.push({ id: `${n.id}__reject`, layoutOptions: { 'port.side': 'EAST' } });
  }
  return base;
}

/** Port-anchor helper for the React renderer. Maps a port id back to a side. */
export function portSideOf(portId: string): PortSide {
  if (portId.endsWith('__in')) return 'NORTH';
  if (portId.endsWith('__out')) return 'SOUTH';
  if (portId.endsWith('__reject')) return 'EAST';
  return 'NORTH';
}
