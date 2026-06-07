// Section 19.8 — pure layout function for the v2 workflow visualizer.
//
// Takes a WorkflowV2.Workflow and returns positioned nodes + edges using
// elkjs's `layered` algorithm. Top-to-bottom direction matches the
// one-socket-per-side model (lock 6): top = in, bottom = out,
// side (EAST) = reject back-edge socket on review nodes.
//
// Async because elkjs's layout is Promise-returning. Pure: no DOM access, no
// React, no side effects. Safe to call from a useEffect.
//
// React Flow owns edge routing — only node x/y from elkjs is used. The
// allManual path skips elkjs entirely and uses saved per-node positions.

import ELK, { type ElkNode, type ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
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

export type EdgeKind = 'forward' | 'reject';

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
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

  // Layering edges fed to elk: forward `next` edges + review→loop reject edges.
  // We deliberately EXCLUDE the loop→back_to edges here — those are true
  // backward edges and, if given to elk, its cycle-breaker scrambles the
  // column order (loop/gate nodes get dragged to the front). elk only needs
  // the forward DAG to position nodes start→end; the back-edges are still
  // DRAWN by React Flow (see edgesFromWorkflow) so the loop stays visible.
  const elkEdges: ElkExtendedEdge[] = [];
  for (const n of wf.nodes) {
    for (const next of n.next ?? []) {
      elkEdges.push({
        id: `e:${n.id}->${next}`,
        sources: [`${n.id}__out`],
        targets: [`${next}__in`],
      });
    }
    if (WorkflowV2.isReviewNode(n) && n.reject) {
      elkEdges.push({
        id: `r:${n.id}->${n.reject}`,
        sources: [`${n.id}__reject`],
        targets: [`${n.reject}__in`],
      });
    }
  }

  // n8n-style left-to-right layered layout.
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '50',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
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

  // React Flow draws ALL edges (forward + reject + loop back-edges) from the
  // workflow itself — independent of which subset elk used for layering.
  return {
    nodes,
    edges: edgesFromWorkflow(wf),
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
}

/** Derive every render edge (forward / reject / loop back-edge) straight from
 *  the workflow definition. Shared by the auto-layout and manual paths so both
 *  draw the same edge set regardless of how node positions were produced. */
function edgesFromWorkflow(wf: WorkflowV2.Workflow): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  for (const n of wf.nodes) {
    for (const next of n.next ?? []) {
      edges.push({ id: `e:${n.id}->${next}`, source: n.id, target: next, kind: 'forward' });
    }
    if (WorkflowV2.isReviewNode(n) && n.reject) {
      edges.push({ id: `r:${n.id}->${n.reject}`, source: n.id, target: n.reject, kind: 'reject' });
    }
    if (WorkflowV2.isLoopNode(n)) {
      edges.push({ id: `r:${n.id}->${n.back_to}`, source: n.id, target: n.back_to, kind: 'reject' });
    }
  }
  return edges;
}

/** When every node carries `position`, skip elkjs and use the saved positions.
 *  React Flow handles edge routing — we only produce source/target/kind info. */
function layoutFromManualPositions(wf: WorkflowV2.Workflow): LayoutResult {
  const nodes: LayoutNode[] = wf.nodes.map((n) => ({
    id: n.id,
    x: n.position!.x,
    y: n.position!.y,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }));

  const edges: LayoutEdge[] = edgesFromWorkflow(wf);

  const width = Math.max(0, ...nodes.map((n) => n.x + n.width));
  const height = Math.max(0, ...nodes.map((n) => n.y + n.height));
  return { nodes, edges, width, height };
}

function portsForNode(n: WorkflowV2.WorkflowNode): NonNullable<ElkNode['ports']> {
  // Left-to-right flow (n8n style): input on the WEST edge, output on the
  // EAST edge; review reject back-edge drops off the SOUTH edge.
  const base: NonNullable<ElkNode['ports']> = [
    { id: `${n.id}__in`, layoutOptions: { 'port.side': 'WEST' } },
    { id: `${n.id}__out`, layoutOptions: { 'port.side': 'EAST' } },
  ];
  if (WorkflowV2.isReviewNode(n)) {
    base.push({ id: `${n.id}__reject`, layoutOptions: { 'port.side': 'SOUTH' } });
  }
  return base;
}

/** Port-anchor helper for the React renderer. Maps a port id back to a side. */
export function portSideOf(portId: string): PortSide {
  if (portId.endsWith('__in')) return 'WEST';
  if (portId.endsWith('__out')) return 'EAST';
  if (portId.endsWith('__reject')) return 'SOUTH';
  return 'WEST';
}
