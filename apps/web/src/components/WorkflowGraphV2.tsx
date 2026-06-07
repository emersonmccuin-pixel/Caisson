// Section 19.8 — v2 workflow visualizer (rebuilt on @xyflow/react v12).
//
// Uses elkjs for node positioning (via layoutWorkflow), React Flow for
// pan/zoom/edge-routing/handles, and custom node/edge components preserving
// the Vellum visual vocabulary (KIND_CONFIG, STATE_BORDER, StateBadge).
//
// WorkflowGraphV2Props is byte-for-byte identical — drop-in replacement.
// Modes unchanged:
//   - authoring=false: pan+zoom canvas, node-click optional, no handles.
//   - authoring=true: nodes draggable, handles wire edges, Backspace deletes.

import '@xyflow/react/dist/style.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  getBezierPath,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  type ReactFlowInstance,
  type OnNodeDrag,
  type OnConnect,
  type OnEdgesDelete,
  type NodeTypes,
  type EdgeTypes,
  type IsValidConnection,
} from '@xyflow/react';
import { WorkflowV2 } from '@pc/domain';
import {
  ArrowRightCircle,
  Bot,
  Check,
  Eye,
  RotateCcw,
  ShieldCheck,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  layoutWorkflow,
  type LayoutResult,
  type EdgeKind,
  NODE_WIDTH,
  NODE_HEIGHT,
} from '@/lib/workflow-layout';

// --- Visual config -----------------------------------------------------------

interface KindConfig {
  label: string;
  icon: LucideIcon;
  band: string;
}

const KIND_CONFIG: Record<WorkflowV2.WorkflowNode['kind'], KindConfig> = {
  agent: { label: 'agent', icon: Bot, band: 'bg-primary/70' },
  review: { label: 'review', icon: ShieldCheck, band: 'bg-warning' },
  move: { label: 'move card', icon: ArrowRightCircle, band: 'bg-success/70' },
  loop: { label: 'loop', icon: RotateCcw, band: 'bg-muted-foreground/60' },
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

// --- Internal React Flow data shapes ----------------------------------------

interface WfNodeData extends Record<string, unknown> {
  wfNode: WorkflowV2.WorkflowNode;
  nodeState: WorkflowV2.NodeRunState | null;
  iteration: number | null;
  authoring: boolean;
  onNodeClick?: ((node: WorkflowV2.WorkflowNode) => void) | undefined;
}

interface WfEdgeData extends Record<string, unknown> {
  kind: EdgeKind;
  isActive: boolean;
}

// --- Public contract (UNCHANGED) --------------------------------------------

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

export function WorkflowGraphV2({
  workflow,
  runState,
  authoring = false,
  onChange,
  onNodeClick,
}: WorkflowGraphV2Props) {
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  const rfInstanceRef = useRef<ReactFlowInstance<Node<WfNodeData>, Edge<WfEdgeData>> | null>(null);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<WfNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge<WfEdgeData>>([]);
  // Tracks the last structural key for which fitView was already scheduled.
  const prevStructureKeyRef = useRef<string | null>(null);

  // Structural key (excludes per-node positions) — triggers fitView on
  // connection/kind changes but not on position-only node drags.
  const structureKey = useMemo(
    () =>
      workflow
        ? JSON.stringify({
            id: workflow.id,
            nodes: workflow.nodes.map((n) => ({
              id: n.id,
              kind: n.kind,
              next: n.next ?? [],
              reject: WorkflowV2.isReviewNode(n) ? (n.reject ?? null) : null,
              back: WorkflowV2.isLoopNode(n) ? n.back_to : null,
            })),
          })
        : '',
    [workflow],
  );

  // Full layout key (includes positions) — reruns elkjs on any change.
  const layoutKey = useMemo(
    () =>
      workflow
        ? JSON.stringify({
            id: workflow.id,
            nodes: workflow.nodes.map((n) => ({
              id: n.id,
              kind: n.kind,
              next: n.next ?? [],
              reject: WorkflowV2.isReviewNode(n) ? (n.reject ?? null) : null,
              back: WorkflowV2.isLoopNode(n) ? n.back_to : null,
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

  // Sync React Flow nodes/edges whenever layout or runtime state changes.
  useEffect(() => {
    if (!layout || !workflow) return;

    setRfNodes(
      layout.nodes.flatMap((ln) => {
        const wfNode = workflow.nodes.find((n) => n.id === ln.id);
        if (!wfNode) return [];
        const nodeState = runState?.nodes[ln.id]?.state ?? null;
        const iteration = runState?.nodes[ln.id]?.iteration ?? null;
        const rfNode: Node<WfNodeData> = {
          id: ln.id,
          type: 'workflow',
          position: { x: ln.x, y: ln.y },
          data: { wfNode, nodeState, iteration, authoring, onNodeClick },
          draggable: authoring,
          connectable: authoring,
          selectable: authoring,
        };
        return [rfNode];
      }),
    );

    const runningIds = new Set<string>();
    if (runState) {
      for (const [id, rec] of Object.entries(runState.nodes)) {
        if (rec.state === 'running') runningIds.add(id);
      }
    }

    setRfEdges(
      layout.edges.map((le) => {
        const isActive = runningIds.has(le.target);
        const rfEdge: Edge<WfEdgeData> = {
          id: le.id,
          source: le.source,
          target: le.target,
          sourceHandle: le.kind === 'reject' ? 'reject' : 'out',
          targetHandle: 'in',
          type: 'workflow',
          data: { kind: le.kind, isActive },
          selectable: authoring,
          deletable: authoring,
        };
        return rfEdge;
      }),
    );

    // Fit view on first load and structural changes (not position-only drags).
    const isFirstLoad = prevStructureKeyRef.current === null;
    const structureChanged = prevStructureKeyRef.current !== structureKey;
    prevStructureKeyRef.current = structureKey;
    if (isFirstLoad || structureChanged) {
      const duration = isFirstLoad ? 0 : 150;
      const timer = setTimeout(() => {
        rfInstanceRef.current?.fitView({ padding: 0.1, duration });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [layout, runState, authoring, onNodeClick, workflow, structureKey]);

  // --- Event handlers -------------------------------------------------------

  const onInit = useCallback(
    (instance: ReactFlowInstance<Node<WfNodeData>, Edge<WfEdgeData>>) => {
      rfInstanceRef.current = instance;
    },
    [],
  );

  const handleNodeDragStop = useCallback<OnNodeDrag>(
    (_evt, node) => {
      if (!onChange || !workflow) return;
      const { x, y } = node.position;
      const original = workflow.nodes.find((n) => n.id === node.id);
      if (!original) return;
      if (original.position?.x === x && original.position?.y === y) return;
      onChange({
        ...workflow,
        nodes: workflow.nodes.map((n) =>
          n.id === node.id ? { ...n, position: { x, y } } : n,
        ),
      });
    },
    [workflow, onChange],
  );

  const handleConnect = useCallback<OnConnect>(
    (connection) => {
      if (!onChange || !workflow) return;
      const { source, target, sourceHandle } = connection;
      if (!source || !target || source === target) return;

      const sourceNode = workflow.nodes.find((n) => n.id === source);
      const targetNode = workflow.nodes.find((n) => n.id === target);
      if (!sourceNode || !targetNode) return;
      if (WorkflowV2.isLoopNode(targetNode)) return;

      const port = sourceHandle === 'reject' ? 'reject' : 'out';

      if (port === 'out' && WorkflowV2.isLoopNode(sourceNode)) {
        onChange({
          ...workflow,
          nodes: workflow.nodes.map((n) =>
            WorkflowV2.isLoopNode(n) && n.id === source ? { ...n, back_to: target } : n,
          ),
        });
        return;
      }

      if (port === 'out') {
        onChange({
          ...workflow,
          nodes: workflow.nodes.map((n) => {
            if (n.id !== source || WorkflowV2.isLoopNode(n)) return n;
            const next = Array.from(new Set([...(n.next ?? []), target]));
            return { ...n, next };
          }),
        });
        return;
      }

      if (!WorkflowV2.isReviewNode(sourceNode)) return;
      const existingLoopId = sourceNode.reject;
      if (existingLoopId && workflow.nodes.some((n) => n.id === existingLoopId)) {
        onChange({
          ...workflow,
          nodes: workflow.nodes.map((n) =>
            n.id === existingLoopId && WorkflowV2.isLoopNode(n)
              ? { ...n, back_to: target }
              : n,
          ),
        });
        return;
      }
      let loopId = `${source}-loop`;
      for (let i = 2; workflow.nodes.some((n) => n.id === loopId); i++) {
        loopId = `${source}-loop-${String(i)}`;
      }
      const loopNode: WorkflowV2.LoopNode = { id: loopId, kind: 'loop', back_to: target };
      onChange({
        ...workflow,
        nodes: [
          ...workflow.nodes.map((n) =>
            WorkflowV2.isReviewNode(n) && n.id === source ? { ...n, reject: loopId } : n,
          ),
          loopNode,
        ],
      });
    },
    [workflow, onChange],
  );

  const handleEdgesDelete = useCallback<OnEdgesDelete>(
    (edges) => {
      if (!onChange || !workflow) return;
      let wf = workflow;
      for (const rfEdge of edges) {
        const kind = (rfEdge.data as WfEdgeData | undefined)?.kind ?? 'forward';
        const { source, target } = rfEdge;
        if (kind === 'forward') {
          wf = {
            ...wf,
            nodes: wf.nodes.map((n) => {
              if (n.id !== source || WorkflowV2.isLoopNode(n)) return n;
              return { ...n, next: (n.next ?? []).filter((t) => t !== target) };
            }),
          };
        } else {
          // Back-edge: atomically tear down the whole loop construct.
          const srcNode = wf.nodes.find((n) => n.id === source);
          const loopId =
            srcNode && WorkflowV2.isLoopNode(srcNode)
              ? srcNode.id
              : srcNode && WorkflowV2.isReviewNode(srcNode)
                ? srcNode.reject
                : undefined;
          if (!loopId) continue;
          wf = {
            ...wf,
            nodes: wf.nodes
              .filter((n) => n.id !== loopId)
              .map((n) => {
                if (WorkflowV2.isReviewNode(n) && n.reject === loopId) {
                  const { reject: _r, ...rest } = n;
                  return rest as WorkflowV2.WorkflowNode;
                }
                return n;
              }),
          };
        }
      }
      onChange(wf);
    },
    [workflow, onChange],
  );

  const handleNodeClick = useCallback(
    (_evt: React.MouseEvent, rfNode: Node) => {
      if (authoring || !onNodeClick || !workflow) return;
      const wfNode = workflow.nodes.find((n) => n.id === rfNode.id);
      if (wfNode) onNodeClick(wfNode);
    },
    [authoring, onNodeClick, workflow],
  );

  const handleIsValidConnection = useCallback<IsValidConnection>(
    (connection) => {
      if (!workflow) return true;
      const targetNode = workflow.nodes.find((n) => n.id === connection.target);
      return !targetNode || !WorkflowV2.isLoopNode(targetNode);
    },
    [workflow],
  );

  // --- Loading states -------------------------------------------------------

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

  // --- Canvas ---------------------------------------------------------------

  return (
    <div className="h-full w-full bg-background">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={authoring ? handleConnect : undefined}
        onEdgesDelete={authoring ? handleEdgesDelete : undefined}
        onNodeDragStop={authoring ? handleNodeDragStop : undefined}
        onNodeClick={!authoring ? handleNodeClick : undefined}
        onInit={onInit}
        nodeTypes={WORKFLOW_NODE_TYPES}
        edgeTypes={WORKFLOW_EDGE_TYPES}
        nodesDraggable={authoring}
        nodesConnectable={authoring}
        elementsSelectable={authoring}
        colorMode="dark"
        deleteKeyCode={authoring ? 'Backspace' : null}
        isValidConnection={authoring ? handleIsValidConnection : undefined}
        zoomOnDoubleClick={false}
        selectNodesOnDrag={false}
        proOptions={{ hideAttribution: true }}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
      >
        <Background
          variant={BackgroundVariant.Dots}
          size={1}
          gap={20}
          color="hsl(var(--muted-foreground))"
          style={{ opacity: 0.2 }}
        />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor="hsl(var(--muted))"
          bgColor="hsl(var(--background))"
          maskColor="rgba(0,0,0,0.35)"
        />
      </ReactFlow>
    </div>
  );
}

// --- Node/edge type registries -----------------------------------------------
// Module-scope so React Flow uses stable object identity and never re-inits.

const WORKFLOW_NODE_TYPES: NodeTypes = {
  workflow: WfNodeTile as NodeTypes['workflow'],
};

const WORKFLOW_EDGE_TYPES: EdgeTypes = {
  workflow: WfEdgeTile as EdgeTypes['workflow'],
};

// --- Custom node -------------------------------------------------------------

function WfNodeTile({ data }: NodeProps) {
  const { wfNode, nodeState, iteration, authoring, onNodeClick } =
    data as unknown as WfNodeData;
  const cfg = KIND_CONFIG[wfNode.kind];
  const Icon = cfg.icon;
  const subtitle =
    wfNode.kind === 'agent'
      ? wfNode.agent
      : wfNode.kind === 'move'
        ? `→ ${wfNode.stage}`
        : wfNode.kind === 'loop'
          ? `↻ ${wfNode.back_to} · max ${wfNode.max_iterations === null ? '∞' : String(wfNode.max_iterations ?? 3)}`
          : null;
  const borderCls = nodeState ? STATE_BORDER[nodeState] : 'border-border';
  const isReview = WorkflowV2.isReviewNode(wfNode);
  const clickable = !authoring && onNodeClick != null;

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onNodeClick!(wfNode) : undefined}
      className={
        'border bg-card text-foreground shadow-sm overflow-hidden ' +
        borderCls +
        (authoring
          ? ' cursor-grab active:cursor-grabbing'
          : clickable
            ? ' cursor-pointer hover:border-primary/60'
            : ' cursor-default')
      }
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      {/* Handles must always render so React Flow can anchor + draw edges in
          read-only mode; we just hide them visually when not authoring. */}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        isConnectable={authoring}
        style={
          authoring
            ? {
                background: 'var(--primary)',
                borderColor: 'var(--primary)',
                width: 12,
                height: 12,
              }
            : { opacity: 0, width: 1, height: 1, pointerEvents: 'none', border: 'none' }
        }
      />
      <div className={`h-1.5 w-full ${cfg.band}`} />
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-sm font-medium">{wfNode.id}</div>
          <div className="truncate text-xs text-muted-foreground">
            {subtitle ?? cfg.label}
          </div>
        </div>
        <StateBadge state={nodeState} iteration={iteration} />
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        isConnectable={authoring}
        style={
          authoring
            ? {
                background: 'var(--primary)',
                borderColor: 'var(--primary)',
                width: 12,
                height: 12,
              }
            : { opacity: 0, width: 1, height: 1, pointerEvents: 'none', border: 'none' }
        }
      />
      {isReview && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="reject"
          isConnectable={authoring}
          style={
            authoring
              ? {
                  background: 'var(--warning)',
                  borderColor: 'var(--warning)',
                  width: 12,
                  height: 12,
                }
              : { opacity: 0, width: 1, height: 1, pointerEvents: 'none', border: 'none' }
          }
        />
      )}
    </div>
  );
}

// --- Custom edge -------------------------------------------------------------

function WfEdgeTile({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const { kind = 'forward', isActive = false } =
    (data as WfEdgeData | undefined) ?? {};
  const isReject = kind === 'reject';

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const stroke = isActive
    ? 'var(--primary)'
    : isReject
      ? 'var(--warning)'
      : 'color-mix(in srgb, var(--foreground) 55%, transparent)';

  // Per-edge marker id so each colour is independent.
  const markerId = `wf-mk-${id.replace(/[^a-zA-Z0-9-]/g, '_')}`;

  return (
    <>
      <defs>
        <marker
          id={markerId}
          markerWidth="9"
          markerHeight="6"
          refX="8"
          refY="3"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          {/* style= resolves CSS custom properties; fill= attribute does not */}
          <path d="M0,0 L0,6 L9,3 z" style={{ fill: stroke }} />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke,
          strokeWidth: isActive ? 2.5 : 2,
          strokeDasharray: isActive ? '8 4' : isReject ? '6 4' : undefined,
          // dashdraw keyframe is shipped in @xyflow/react/dist/style.css
          animation: isActive ? 'dashdraw 0.5s linear infinite' : undefined,
        }}
        markerEnd={`url(#${markerId})`}
        interactionWidth={12}
      />
    </>
  );
}

// --- StateBadge --------------------------------------------------------------

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
