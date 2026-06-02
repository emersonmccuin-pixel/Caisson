// Section 19.8 — v2 workflow visualizer.
//
// Renders a WorkflowV2.Workflow as a top-to-bottom DAG with elkjs layout +
// one-socket-per-side (lock 6) + runtime overlay (lock 9). v1 surface
// (apps/web/src/components/WorkflowGraph.tsx) stays untouched until 19.12;
// both coexist.
//
// Modes (lock 7):
//   - authoring=false (default): pan-only canvas, node-click optional.
//   - authoring=true: nodes are draggable, sockets wire edges, edges are
//     click-deletable. Create/delete-node is agent-only — not handled here.
//
// Controlled via onChange. The component never mutates the workflow directly;
// every interaction produces a new WorkflowV2.Workflow value that the parent
// persists (typically into the workflow-builder draft store, 19.9).

import { useEffect, useMemo, useRef, useState } from 'react';
import { WorkflowV2 } from '@pc/domain';
import {
  Bot,
  Check,
  Eye,
  ShieldCheck,
  Terminal,
  Code,
  X,
  type LucideIcon,
} from 'lucide-react';

import {
  layoutWorkflow,
  type LayoutResult,
  type LayoutEdge,
  NODE_WIDTH,
  NODE_HEIGHT,
} from '@/lib/workflow-layout';

interface KindConfig {
  label: string;
  icon: LucideIcon;
  band: string;
}

const KIND_CONFIG: Record<WorkflowV2.WorkflowNode['kind'], KindConfig> = {
  agent: { label: 'agent', icon: Bot, band: 'bg-primary/70' },
  bash: { label: 'bash', icon: Terminal, band: 'bg-foreground/60' },
  script: { label: 'script', icon: Code, band: 'bg-foreground/60' },
  review: { label: 'review', icon: ShieldCheck, band: 'bg-warning' },
};

// Border + animation classes per lock 9 (runtime overlay vocabulary).
const STATE_BORDER: Record<WorkflowV2.NodeRunState, string> = {
  pending: 'border-muted-foreground/30',
  running: 'border-primary animate-pulse',
  completed: 'border-muted-foreground/20 opacity-70',
  failed: 'border-destructive',
  skipped: 'border-muted-foreground/20 opacity-40',
  'awaiting-review': 'border-warning',
};

export interface WorkflowGraphV2Props {
  workflow: WorkflowV2.Workflow | null;
  /** Optional runtime DAG state for the overlay vocabulary. */
  runState?: WorkflowV2.WorkflowDagState | null;
  /** When true, enables drag-to-move, drag-from-socket-to-wire, and
   *  click-edge-to-delete. Fires `onChange` on every committed edit. */
  authoring?: boolean;
  /** Required when `authoring` is true. Called with the next workflow value. */
  onChange?: (next: WorkflowV2.Workflow) => void;
  /** Optional node-click callback (read-only mode only — authoring mouseup
   *  on a node tile commits a drag, not a click). */
  onNodeClick?: (node: WorkflowV2.WorkflowNode) => void;
}

type PortKind = 'out' | 'reject';

interface NodeDragState {
  nodeId: string;
  startMouseX: number;
  startMouseY: number;
  origX: number;
  origY: number;
  currentX: number;
  currentY: number;
}

interface WireDragState {
  sourceId: string;
  port: PortKind;
  startX: number;
  startY: number;
  mouseX: number;
  mouseY: number;
}

export function WorkflowGraphV2({
  workflow,
  runState,
  authoring = false,
  onChange,
  onNodeClick,
}: WorkflowGraphV2Props) {
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [nodeDrag, setNodeDrag] = useState<NodeDragState | null>(null);
  const [wireDrag, setWireDrag] = useState<WireDragState | null>(null);
  const panDragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // Re-layout when the workflow STRUCTURE changes (id/kind/next/reject/positions).
  const layoutKey = useMemo(
    () =>
      workflow
        ? JSON.stringify({
            id: workflow.id,
            nodes: workflow.nodes.map((n) => ({
              id: n.id,
              kind: n.kind,
              next: n.next ?? [],
              reject: WorkflowV2.isReviewNode(n) ? n.reject?.back_to ?? null : null,
              pos: n.position ?? null,
            })),
          })
        : '',
    [workflow],
  );

  useEffect(() => {
    let cancelled = false;
    if (!workflow) {
      setLayout(null);
      return undefined;
    }
    void layoutWorkflow(workflow).then((res) => {
      if (!cancelled) setLayout(res);
    });
    return () => {
      cancelled = true;
    };
  }, [layoutKey, workflow]);

  if (!workflow) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground text-sm">
        No workflow selected.
      </div>
    );
  }
  if (!layout) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground text-sm">
        Laying out…
      </div>
    );
  }

  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));
  const runningIds = new Set<string>();
  if (runState) {
    for (const [id, rec] of Object.entries(runState.nodes)) {
      if (rec.state === 'running') runningIds.add(id);
    }
  }

  // Layout positions with the in-flight drag overlay applied.
  const positionedNodes = layout.nodes.map((n) => {
    if (nodeDrag && nodeDrag.nodeId === n.id) {
      return { ...n, x: nodeDrag.currentX, y: nodeDrag.currentY };
    }
    return n;
  });
  const posById = new Map(positionedNodes.map((n) => [n.id, n]));

  // Container-relative mouse coords (compensates for pan + canvas origin offset).
  const toGraphCoords = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clientX - rect.left - pan.x - 24,
      y: clientY - rect.top - pan.y - 24,
    };
  };

  const beginNodeDrag = (
    nodeId: string,
    clientX: number,
    clientY: number,
  ) => {
    const n = posById.get(nodeId);
    if (!n) return;
    setNodeDrag({
      nodeId,
      startMouseX: clientX,
      startMouseY: clientY,
      origX: n.x,
      origY: n.y,
      currentX: n.x,
      currentY: n.y,
    });
  };

  const commitNodeDrag = () => {
    if (!nodeDrag) return;
    const { nodeId, currentX, currentY, origX, origY } = nodeDrag;
    setNodeDrag(null);
    if (currentX === origX && currentY === origY) return;
    if (!onChange) return;
    onChange({
      ...workflow,
      nodes: workflow.nodes.map((n) =>
        n.id === nodeId ? { ...n, position: { x: currentX, y: currentY } } : n,
      ),
    });
  };

  const beginWire = (sourceId: string, port: PortKind, clientX: number, clientY: number) => {
    const src = posById.get(sourceId);
    if (!src) return;
    const startX = port === 'out' ? src.x + src.width / 2 : src.x + src.width;
    const startY = port === 'out' ? src.y + src.height : src.y + src.height / 2;
    const m = toGraphCoords(clientX, clientY);
    setWireDrag({ sourceId, port, startX, startY, mouseX: m.x, mouseY: m.y });
  };

  const commitWire = (targetId: string | null) => {
    if (!wireDrag) return;
    const { sourceId, port } = wireDrag;
    setWireDrag(null);
    if (!targetId || targetId === sourceId) return;
    if (!onChange) return;
    onChange({
      ...workflow,
      nodes: workflow.nodes.map((n) => {
        if (n.id !== sourceId) return n;
        if (port === 'out') {
          const next = Array.from(new Set([...(n.next ?? []), targetId]));
          return { ...n, next };
        }
        if (WorkflowV2.isReviewNode(n)) {
          return { ...n, reject: { back_to: targetId, ...(n.reject ?? {}) } };
        }
        return n;
      }),
    });
  };

  const deleteEdge = (edge: LayoutEdge) => {
    if (!onChange) return;
    onChange({
      ...workflow,
      nodes: workflow.nodes.map((n) => {
        if (n.id !== edge.source) return n;
        if (edge.kind === 'forward') {
          return { ...n, next: (n.next ?? []).filter((t) => t !== edge.target) };
        }
        // reject
        if (WorkflowV2.isReviewNode(n)) {
          const { reject: _reject, ...rest } = n;
          return rest as WorkflowV2.WorkflowNode;
        }
        return n;
      }),
    });
  };

  return (
    <div
      ref={canvasRef}
      className="relative h-full w-full overflow-hidden bg-background select-none"
      onMouseDown={(e) => {
        const onBg =
          e.target === e.currentTarget ||
          (e.target as HTMLElement).hasAttribute('data-graph-bg');
        if (!onBg) return;
        panDragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      }}
      onMouseMove={(e) => {
        if (panDragRef.current) {
          const dx = e.clientX - panDragRef.current.x;
          const dy = e.clientY - panDragRef.current.y;
          setPan({ x: panDragRef.current.panX + dx, y: panDragRef.current.panY + dy });
        }
        if (nodeDrag) {
          const dx = e.clientX - nodeDrag.startMouseX;
          const dy = e.clientY - nodeDrag.startMouseY;
          setNodeDrag({
            ...nodeDrag,
            currentX: Math.max(0, nodeDrag.origX + dx),
            currentY: Math.max(0, nodeDrag.origY + dy),
          });
        }
        if (wireDrag) {
          const m = toGraphCoords(e.clientX, e.clientY);
          setWireDrag({ ...wireDrag, mouseX: m.x, mouseY: m.y });
        }
      }}
      onMouseUp={() => {
        panDragRef.current = null;
        if (nodeDrag) commitNodeDrag();
        if (wireDrag) commitWire(null);
      }}
      onMouseLeave={() => {
        panDragRef.current = null;
        if (nodeDrag) commitNodeDrag();
        if (wireDrag) commitWire(null);
      }}
    >
      <div
        data-graph-bg
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, hsl(var(--muted-foreground) / 0.15) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />
      <div
        className="absolute top-0 left-0"
        style={{
          transform: `translate(${String(pan.x + 24)}px, ${String(pan.y + 24)}px)`,
          width: Math.max(layout.width, 600),
          height: Math.max(layout.height, 400),
        }}
      >
        <svg
          className="absolute top-0 left-0"
          width={Math.max(layout.width, 600) + 200}
          height={Math.max(layout.height, 400) + 200}
          style={{ overflow: 'visible', pointerEvents: 'none' }}
        >
          {layout.edges.map((edge) => (
            <EdgePath
              key={edge.id}
              edge={edge}
              isActive={runningIds.has(edge.target)}
              authoring={authoring}
              onDelete={authoring ? () => deleteEdge(edge) : undefined}
            />
          ))}
          {wireDrag && (
            <line
              x1={wireDrag.startX}
              y1={wireDrag.startY}
              x2={wireDrag.mouseX}
              y2={wireDrag.mouseY}
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              strokeDasharray="6 4"
            />
          )}
        </svg>
        {positionedNodes.map((ln) => {
          const node = nodeById.get(ln.id);
          if (!node) return null;
          const nodeState = runState?.nodes[ln.id]?.state ?? null;
          const iteration = runState?.nodes[ln.id]?.iteration;
          return (
            <NodeTile
              key={ln.id}
              node={node}
              x={ln.x}
              y={ln.y}
              state={nodeState}
              iteration={iteration ?? null}
              authoring={authoring}
              onMouseDownNode={
                authoring
                  ? (e) => beginNodeDrag(ln.id, e.clientX, e.clientY)
                  : undefined
              }
              onMouseDownPort={
                authoring
                  ? (port, e) => beginWire(ln.id, port, e.clientX, e.clientY)
                  : undefined
              }
              onMouseUpInPort={
                wireDrag ? () => commitWire(ln.id) : undefined
              }
              onClick={!authoring && onNodeClick ? () => onNodeClick(node) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

function EdgePath({
  edge,
  isActive,
  authoring,
  onDelete,
}: {
  edge: LayoutEdge;
  isActive: boolean;
  authoring: boolean;
  onDelete?: () => void;
}) {
  if (edge.points.length < 2) return null;
  const d = edge.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${String(p.x)} ${String(p.y)}`)
    .join(' ');
  const isReject = edge.kind === 'reject';
  const last = edge.points[edge.points.length - 1]!;
  const beforeLast = edge.points[edge.points.length - 2]!;
  const dx = last.x - beforeLast.x;
  const dy = last.y - beforeLast.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  const arrowLen = 8;
  const arrowWid = 4;
  const ax = last.x - ux * arrowLen;
  const ay = last.y - uy * arrowLen;
  const px = -uy * arrowWid;
  const py = ux * arrowWid;
  const arrow = `M ${String(last.x)} ${String(last.y)} L ${String(ax + px)} ${String(
    ay + py,
  )} L ${String(ax - px)} ${String(ay - py)} Z`;

  const stroke = isActive
    ? 'hsl(var(--primary))'
    : isReject
      ? 'hsl(var(--warning))'
      : 'hsl(var(--foreground) / 0.6)';

  return (
    <g style={{ pointerEvents: authoring ? 'auto' : 'none' }}>
      {/* Invisible hit-area wider than the visible stroke for click-to-delete. */}
      {authoring && onDelete && (
        <path
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={12}
          onClick={onDelete}
          style={{ cursor: 'pointer' }}
        >
          <title>Click to delete edge</title>
        </path>
      )}
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={isActive ? 2 : 1.5}
        strokeDasharray={isActive ? '8 4' : isReject ? '6 4' : undefined}
        className={isActive ? 'animate-[dash_1.2s_linear_infinite]' : undefined}
        pointerEvents="none"
      />
      <path d={arrow} fill={stroke} pointerEvents="none" />
    </g>
  );
}

function NodeTile({
  node,
  x,
  y,
  state,
  iteration,
  authoring,
  onMouseDownNode,
  onMouseDownPort,
  onMouseUpInPort,
  onClick,
}: {
  node: WorkflowV2.WorkflowNode;
  x: number;
  y: number;
  state: WorkflowV2.NodeRunState | null;
  iteration: number | null;
  authoring: boolean;
  onMouseDownNode?: (e: React.MouseEvent) => void;
  onMouseDownPort?: (port: PortKind, e: React.MouseEvent) => void;
  onMouseUpInPort?: () => void;
  onClick?: () => void;
}) {
  const cfg = KIND_CONFIG[node.kind];
  const Icon = cfg.icon;
  const subtitle = node.kind === 'agent' ? node.agent : null;
  const borderCls = state ? STATE_BORDER[state] : 'border-border';
  const isReview = WorkflowV2.isReviewNode(node);

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onMouseDown={(e) => {
        // Don't initiate a node-drag if the mousedown landed on a port.
        if ((e.target as HTMLElement).hasAttribute('data-port')) return;
        if (onMouseDownNode) {
          e.stopPropagation();
          onMouseDownNode(e);
        }
      }}
      className={
        'absolute border bg-card text-foreground shadow-sm rounded-md overflow-hidden ' +
        borderCls +
        ' ' +
        (authoring
          ? 'cursor-grab active:cursor-grabbing'
          : onClick
            ? 'cursor-pointer hover:border-primary/60'
            : 'cursor-default')
      }
      style={{
        transform: `translate(${String(x)}px, ${String(y)}px)`,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }}
    >
      <div className={`h-1.5 w-full ${cfg.band}`} />
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-sm font-medium">{node.id}</div>
          <div className="truncate text-xs text-muted-foreground">
            {subtitle ?? cfg.label}
          </div>
        </div>
        <StateBadge state={state} iteration={iteration} />
      </div>

      {authoring && (
        <>
          <Port
            kind="in"
            position="top"
            onMouseUp={onMouseUpInPort}
          />
          <Port
            kind="out"
            position="bottom"
            onMouseDown={(e) => onMouseDownPort?.('out', e)}
          />
          {isReview && (
            <Port
              kind="reject"
              position="right"
              onMouseDown={(e) => onMouseDownPort?.('reject', e)}
            />
          )}
        </>
      )}
    </div>
  );
}

function Port({
  kind,
  position,
  onMouseDown,
  onMouseUp,
}: {
  kind: 'in' | 'out' | 'reject';
  position: 'top' | 'bottom' | 'right';
  onMouseDown?: (e: React.MouseEvent) => void;
  onMouseUp?: () => void;
}) {
  const style: React.CSSProperties =
    position === 'top'
      ? { top: -6, left: '50%', transform: 'translateX(-50%)' }
      : position === 'bottom'
        ? { bottom: -6, left: '50%', transform: 'translateX(-50%)' }
        : { right: -6, top: '50%', transform: 'translateY(-50%)' };
  const color =
    kind === 'reject' ? 'bg-warning border-warning' : 'bg-primary border-primary';
  return (
    <div
      data-port={kind}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      className={`absolute h-3 w-3 rounded-full border-2 ${color} cursor-crosshair hover:scale-125 transition-transform`}
      style={style}
      title={kind === 'reject' ? 'reject (back-edge)' : kind === 'in' ? 'incoming' : 'next'}
    />
  );
}

function StateBadge({
  state,
  iteration,
}: {
  state: WorkflowV2.NodeRunState | null;
  iteration: number | null;
}) {
  if (!state || state === 'pending') return null;
  if (state === 'completed') {
    return <Check className="h-4 w-4 shrink-0 text-success" />;
  }
  if (state === 'failed') {
    return <X className="h-4 w-4 shrink-0 text-destructive" />;
  }
  if (state === 'running') {
    return (
      <span className="text-xs text-primary">
        {iteration && iteration > 1 ? `run ${String(iteration)}` : 'running'}
      </span>
    );
  }
  if (state === 'awaiting-review') {
    return <Eye className="h-4 w-4 shrink-0 text-warning" />;
  }
  if (state === 'skipped') {
    return <span className="text-xs text-muted-foreground">skipped</span>;
  }
  return null;
}
