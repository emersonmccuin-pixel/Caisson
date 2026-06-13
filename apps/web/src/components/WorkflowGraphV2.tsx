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

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { agentsApi, type Pod } from '@/features/agents/client';
import { PodDetailModal } from '@/components/agents/PodDetailModal';
import { resolveAgentPod } from '@/lib/workflow-agent-pod';

export { resolveAgentPod } from '@/lib/workflow-agent-pod';
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
  GitMerge,
  Maximize2,
  Minimize2,
  Plug,
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
  merge: { label: 'merge', icon: GitMerge, band: 'bg-info/70' },
  call: { label: 'tool call', icon: Plug, band: 'bg-info/50' },
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

// --- Helpers -----------------------------------------------------------------

/** Converts a hyphenated/underscored id to Title Case words. */
function humanizeId(id: string): string {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Pure helper — friendly display label for any workflow node.
 *  Exported so the logic is reused by the tile, the detail panel, and tests. */
export function nodeLabel(node: WorkflowV2.WorkflowNode): {
  title: string;
  subtitle: string | null;
} {
  switch (node.kind) {
    case 'agent':
      return {
        title: humanizeId(node.id),
        subtitle: `Runs the ${node.agent} agent`,
      };
    case 'review':
      return {
        title: node.reviewer === 'human' ? 'You approve it' : 'Auto-review',
        subtitle: humanizeId(node.id),
      };
    case 'move':
      return { title: `Move card → ${humanizeId(node.stage)}`, subtitle: null };
    case 'loop': {
      const max =
        node.max_iterations === null
          ? 'unlimited retries'
          : `up to ${String(node.max_iterations ?? 3)} times`;
      return { title: 'If rejected, retry', subtitle: max };
    }
    case 'merge':
      return { title: 'Merge into integration branch', subtitle: humanizeId(node.id) };
    case 'call':
      return {
        title: humanizeId(node.id),
        subtitle: `Calls ${node.tool} on ${node.server}`,
      };
  }
}

/** Walk forward from loop.back_to until reaching the review that owns the loop.
 *  Returns the set of node ids in the highlighted path. */
function computeLoopHighlightIds(
  loopId: string,
  wf: WorkflowV2.Workflow,
): Set<string> {
  const loopNode = wf.nodes.find((n) => n.id === loopId);
  if (!loopNode || !WorkflowV2.isLoopNode(loopNode)) return new Set();

  const ownerReview = wf.nodes.find(
    (n) => WorkflowV2.isReviewNode(n) && n.reject === loopId,
  );
  if (!ownerReview) return new Set();

  const highlighted = new Set<string>([loopId]);
  const visited = new Set<string>();
  const queue: string[] = [loopNode.back_to];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (visited.has(curr)) continue;
    visited.add(curr);
    highlighted.add(curr);
    if (curr === ownerReview.id) break;
    const node = wf.nodes.find((n) => n.id === curr);
    if (!node) continue;
    for (const next of node.next ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  return highlighted;
}

// --- Internal React Flow data shapes ----------------------------------------

interface WfNodeData extends Record<string, unknown> {
  wfNode: WorkflowV2.WorkflowNode;
  nodeState: WorkflowV2.NodeRunState | null;
  iteration: number | null;
  authoring: boolean;
  onLoopHover?: ((id: string | null) => void) | undefined;
  dimmed?: boolean;
  loopHighlighted?: boolean;
  isStart?: boolean;
  isEnd?: boolean;
}

interface WfEdgeData extends Record<string, unknown> {
  kind: EdgeKind;
  isActive: boolean;
  dimmed?: boolean;
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
  /** Optional node-click callback (read-only mode only). */
  onNodeClick?: (node: WorkflowV2.WorkflowNode) => void;
  /** When provided, clicking an agent node resolves node.agent → the
   *  project-visible pod and opens the PodDetailModal for inspection. */
  projectId?: string;
}

export function WorkflowGraphV2({
  workflow,
  runState,
  authoring = false,
  onChange,
  onNodeClick,
  projectId,
}: WorkflowGraphV2Props) {
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  const rfInstanceRef = useRef<ReactFlowInstance<Node<WfNodeData>, Edge<WfEdgeData>> | null>(null);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<WfNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge<WfEdgeData>>([]);
  const prevStructureKeyRef = useRef<string | null>(null);

  // Feature 1: selected node for detail panel
  const [detailNode, setDetailNode] = useState<WorkflowV2.WorkflowNode | null>(null);
  // Feature 2: loop hover highlight
  const [hoveredLoopId, setHoveredLoopId] = useState<string | null>(null);
  // Feature 4: fullscreen toggle
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Agent-node click → PodDetailModal
  const [agentPod, setAgentPod] = useState<Pod | null>(null);
  const [agentPodErr, setAgentPodErr] = useState<string | null>(null);
  const [agentPodLoading, setAgentPodLoading] = useState(false);

  // Derived: active loop highlight (hover takes priority over panel selection).
  const highlightedLoopId =
    hoveredLoopId ?? (detailNode?.kind === 'loop' ? detailNode.id : null);

  // Stable callback passed through node data for loop-node hover events.
  const handleLoopHover = useCallback((id: string | null) => {
    setHoveredLoopId(id);
  }, []);

  // Open the PodDetailModal for the agent named by an agent node.
  const openAgentPod = useCallback(
    async (agentName: string) => {
      if (agentPodLoading || !projectId) return;
      setAgentPodLoading(true);
      setAgentPodErr(null);
      try {
        const pods = await agentsApi.listPods(projectId);
        const match = resolveAgentPod(pods, agentName);
        if (!match) {
          setAgentPodErr(`No agent named "${agentName}" found in this project.`);
        } else {
          setAgentPod(match);
        }
      } catch (err) {
        setAgentPodErr(`Couldn't open agent: ${(err as Error).message}`);
      } finally {
        setAgentPodLoading(false);
      }
    },
    [agentPodLoading, projectId],
  );

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

    // Feature 3: nodes with no incoming forward edge = START candidates.
    const incomingForwardTargets = new Set<string>();
    for (const n of workflow.nodes) {
      for (const next of n.next ?? []) {
        incomingForwardTargets.add(next);
      }
    }

    setRfNodes(
      layout.nodes.flatMap((ln) => {
        const wfNode = workflow.nodes.find((n) => n.id === ln.id);
        if (!wfNode) return [];
        const nodeState = runState?.nodes[ln.id]?.state ?? null;
        const iteration = runState?.nodes[ln.id]?.iteration ?? null;
        const isLoop = WorkflowV2.isLoopNode(wfNode);
        // Exclude loop nodes from START/END — they are internal retry constructs.
        const isStart = !isLoop && !incomingForwardTargets.has(ln.id);
        const isEnd = !isLoop && (!wfNode.next || wfNode.next.length === 0);
        const rfNode: Node<WfNodeData> = {
          id: ln.id,
          type: 'workflow',
          position: { x: ln.x, y: ln.y },
          data: {
            wfNode,
            nodeState,
            iteration,
            authoring,
            onLoopHover: handleLoopHover,
            dimmed: false,
            loopHighlighted: false,
            isStart,
            isEnd,
          },
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
          data: { kind: le.kind, isActive, dimmed: false },
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
  }, [layout, runState, authoring, handleLoopHover, workflow, structureKey]);

  // Feature 2: apply loop highlight / dim to nodes + edges.
  useEffect(() => {
    if (!workflow) return;
    const highlightedIds = highlightedLoopId
      ? computeLoopHighlightIds(highlightedLoopId, workflow)
      : null;

    setRfNodes((nodes) =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          dimmed: highlightedIds !== null && !highlightedIds.has(n.id),
          loopHighlighted: highlightedIds !== null && highlightedIds.has(n.id),
        },
      })),
    );

    setRfEdges((edges) =>
      edges.map((e) => ({
        ...e,
        data: {
          ...(e.data as WfEdgeData),
          dimmed:
            highlightedIds !== null &&
            (!highlightedIds.has(e.source) || !highlightedIds.has(e.target)),
        },
      })),
    );
  }, [highlightedLoopId, workflow]);

  // Feature 4: fit view after entering fullscreen.
  useEffect(() => {
    if (!isFullscreen) return;
    const timer = setTimeout(() => {
      rfInstanceRef.current?.fitView({ padding: 0.1 });
    }, 50);
    return () => clearTimeout(timer);
  }, [isFullscreen]);

  // Feature 4: Escape exits fullscreen.
  useEffect(() => {
    if (!isFullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isFullscreen]);

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
    (_evt: unknown, rfNode: Node) => {
      if (authoring || !workflow) return;
      const wfNode = workflow.nodes.find((n) => n.id === rfNode.id);
      if (!wfNode) return;
      onNodeClick?.(wfNode);
      // Always show the node detail panel first. Agent nodes expose a
      // clickable agent name inside the panel that opens the PodDetailModal.
      setDetailNode((prev) => (prev?.id === wfNode.id ? null : wfNode));
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
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 bg-background'
          : 'relative h-full w-full bg-background'
      }
    >
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
          color="var(--muted-foreground)"
          style={{ opacity: 0.2 }}
        />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor="var(--muted)"
          bgColor="var(--background)"
          maskColor="rgba(0,0,0,0.35)"
        />
      </ReactFlow>

      {/* Feature 4: fullscreen toggle */}
      <button
        type="button"
        onClick={() => setIsFullscreen((f) => !f)}
        className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center border border-border bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground"
        title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Expand to fullscreen'}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Expand to fullscreen'}
      >
        {isFullscreen ? (
          <Minimize2 className="h-3.5 w-3.5" />
        ) : (
          <Maximize2 className="h-3.5 w-3.5" />
        )}
      </button>

      {/* Feature 3: kind legend */}
      <KindLegend />

      {/* Feature 1: node detail panel */}
      {detailNode && !authoring && (
        <NodeDetailPanel
          node={detailNode}
          workflow={workflow}
          onClose={() => setDetailNode(null)}
          onOpenAgent={projectId ? openAgentPod : undefined}
          agentPodLoading={agentPodLoading}
        />
      )}

      {/* Agent-click error toast */}
      {agentPodErr && (
        <div className="absolute bottom-2 left-1/2 z-30 -translate-x-1/2 border border-destructive/60 bg-background/95 px-3 py-1.5 text-xs text-destructive backdrop-blur-sm">
          {agentPodErr}
          <button
            type="button"
            onClick={() => setAgentPodErr(null)}
            className="ml-2 underline"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Agent-node → PodDetailModal */}
      {agentPod && (
        <PodDetailModal
          pod={agentPod}
          readOnly={agentPod.origin === 'stock'}
          onClose={() => setAgentPod(null)}
          onDeleted={() => setAgentPod(null)}
        />
      )}
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
  const {
    wfNode,
    nodeState,
    iteration,
    authoring,
    onLoopHover,
    dimmed = false,
    loopHighlighted = false,
    isStart = false,
    isEnd = false,
  } = data as unknown as WfNodeData;

  const cfg = KIND_CONFIG[wfNode.kind];
  const Icon = cfg.icon;
  const label = nodeLabel(wfNode);
  const isReview = WorkflowV2.isReviewNode(wfNode);
  const isLoop = WorkflowV2.isLoopNode(wfNode);

  // State-based border, overridden by loop highlight.
  const borderCls = loopHighlighted
    ? 'border-primary/70'
    : nodeState
      ? STATE_BORDER[nodeState]
      : 'border-border';

  return (
    <div
      role={!authoring ? 'button' : undefined}
      tabIndex={!authoring ? 0 : undefined}
      onMouseEnter={isLoop ? () => onLoopHover?.(wfNode.id) : undefined}
      onMouseLeave={isLoop ? () => onLoopHover?.(null) : undefined}
      className={
        'border bg-card text-foreground shadow-sm overflow-hidden transition-opacity duration-150 ' +
        borderCls +
        (loopHighlighted ? ' bg-primary/5' : '') +
        (dimmed ? ' opacity-25' : '') +
        (authoring
          ? ' cursor-grab active:cursor-grabbing'
          : ' cursor-pointer hover:border-primary/60')
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

      {/* Feature 3: colored kind band */}
      <div className={`h-1.5 w-full ${cfg.band}`} />

      <div className="flex items-start gap-2 px-3 py-1.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Feature 5: friendly title + START/END badges */}
          <div className="flex items-center gap-1">
            <div className="truncate text-sm font-medium leading-tight">{label.title}</div>
            {isStart && (
              <span className="shrink-0 rounded-sm bg-success/25 px-1 py-px text-[8px] font-bold uppercase tracking-wider text-success">
                START
              </span>
            )}
            {isEnd && (
              <span className="shrink-0 rounded-sm bg-muted/60 px-1 py-px text-[8px] font-bold uppercase tracking-wider text-muted-foreground">
                END
              </span>
            )}
          </div>
          {/* Feature 5: subtitle */}
          <div className="truncate text-xs text-muted-foreground leading-snug">
            {label.subtitle ?? cfg.label}
          </div>
          {/* Feature 5: raw id demoted to tiny muted monospace tag */}
          <div className="mt-0.5 truncate font-mono text-[9px] leading-none text-muted-foreground/40">
            {wfNode.id}
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
  const { kind = 'forward', isActive = false, dimmed = false } =
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
    <g style={{ opacity: dimmed ? 0.12 : 1, transition: 'opacity 0.15s ease' }}>
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
    </g>
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

// --- Feature 3: Kind legend --------------------------------------------------

function KindLegend() {
  return (
    <div className="absolute left-2 top-2 z-10 border border-border bg-background/80 px-2 py-1.5 backdrop-blur-sm">
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {(
          Object.entries(KIND_CONFIG) as [
            WorkflowV2.WorkflowNodeKind,
            KindConfig,
          ][]
        ).map(([kind, cfg]) => {
          const Icon = cfg.icon;
          return (
            <div key={kind} className="flex items-center gap-1">
              <div className={`h-2 w-2 shrink-0 rounded-sm ${cfg.band}`} />
              <Icon className="h-3 w-3 shrink-0 text-muted-foreground/70" />
              <span className="text-[10px] text-muted-foreground">{cfg.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Feature 1: Node detail panel --------------------------------------------

function NodeDetailPanel({
  node,
  workflow,
  onClose,
  onOpenAgent,
  agentPodLoading = false,
}: {
  node: WorkflowV2.WorkflowNode;
  workflow: WorkflowV2.Workflow;
  onClose: () => void;
  onOpenAgent?: ((agentName: string) => void) | undefined;
  agentPodLoading?: boolean;
}) {
  const label = nodeLabel(node);
  const cfg = KIND_CONFIG[node.kind];

  return (
    <aside className="absolute right-0 top-0 z-20 flex h-full w-72 shrink-0 flex-col overflow-hidden border-l border-border bg-background/95 backdrop-blur-sm">
      <div className="flex items-start gap-2 border-b border-border px-3 py-2">
        <div className={`mt-1 h-2 w-2 shrink-0 rounded-sm ${cfg.band}`} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-sm font-medium leading-tight">{label.title}</div>
          {label.subtitle && (
            <div className="truncate text-xs text-muted-foreground">{label.subtitle}</div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3 text-xs">
        <div>
          <code className="rounded bg-muted/40 px-1 py-px font-mono text-[10px] text-muted-foreground/70">
            {node.id}
          </code>
        </div>
        <NodeDetailBody
          node={node}
          workflow={workflow}
          onOpenAgent={onOpenAgent}
          agentPodLoading={agentPodLoading}
        />
      </div>
    </aside>
  );
}

function NodeDetailBody({
  node,
  workflow,
  onOpenAgent,
  agentPodLoading = false,
}: {
  node: WorkflowV2.WorkflowNode;
  workflow: WorkflowV2.Workflow;
  onOpenAgent?: ((agentName: string) => void) | undefined;
  agentPodLoading?: boolean;
}) {
  if (node.kind === 'agent') {
    const inputEntries = node.input ? Object.entries(node.input) : [];
    return (
      <>
        {onOpenAgent ? (
          <DetailSection label="Agent">
            <button
              type="button"
              onClick={() => onOpenAgent(node.agent)}
              disabled={agentPodLoading}
              className="group flex items-center gap-1.5 text-left text-primary hover:underline disabled:opacity-60"
              title="Open agent details"
            >
              <Bot className="h-3.5 w-3.5 shrink-0" />
              <span className="break-words font-medium">{node.agent}</span>
              <span className="text-[10px] text-muted-foreground/70 group-hover:text-primary">
                {agentPodLoading ? '(opening…)' : '(view details)'}
              </span>
            </button>
          </DetailSection>
        ) : (
          <DetailRow label="Agent" value={node.agent} />
        )}
        {node.task && (
          <DetailSection label="Task">
            <p className="whitespace-pre-wrap break-words text-foreground/80">{node.task}</p>
          </DetailSection>
        )}
        {node.expected_output && (
          <DetailRow label="Produces" value={node.expected_output.kind} />
        )}
        {node.when && (
          <DetailSection label="Condition">
            <code className="break-all font-mono text-[10px] text-muted-foreground">{node.when}</code>
          </DetailSection>
        )}
        {inputEntries.length > 0 && (
          <DetailSection label="Inputs">
            {inputEntries.map(([k, v]) => (
              <div key={k} className="flex gap-1 font-mono text-[10px]">
                <span className="shrink-0 text-primary/70">{k}</span>
                <span className="text-muted-foreground">←</span>
                <span className="break-all text-muted-foreground/80">{v}</span>
              </div>
            ))}
          </DetailSection>
        )}
      </>
    );
  }

  if (node.kind === 'review') {
    const reviewer =
      node.reviewer === 'human'
        ? 'You (human approval required)'
        : 'Project orchestrator (auto-review)';
    const loopNode = node.reject
      ? workflow.nodes.find((n) => n.id === node.reject)
      : null;
    const loopBack =
      loopNode && WorkflowV2.isLoopNode(loopNode) ? loopNode.back_to : null;
    return (
      <>
        <DetailRow label="Reviewed by" value={reviewer} />
        {node.prompt && (
          <DetailSection label="What to review">
            <p className="whitespace-pre-wrap break-words text-foreground/80">{node.prompt}</p>
          </DetailSection>
        )}
        {loopBack ? (
          <DetailRow label="On reject" value={`Loops back to "${humanizeId(loopBack)}"`} />
        ) : (
          <DetailRow label="On reject" value="Fails the run (no retry configured)" />
        )}
      </>
    );
  }

  if (node.kind === 'move') {
    return <DetailRow label="Destination stage" value={humanizeId(node.stage)} />;
  }

  if (node.kind === 'loop') {
    const max =
      node.max_iterations === null ? 'Unlimited' : String(node.max_iterations ?? 3);
    return (
      <>
        <DetailRow label="Loops back to" value={humanizeId(node.back_to)} />
        <DetailRow label="Max retries" value={max} />
      </>
    );
  }

  if (node.kind === 'call') {
    const argEntries = node.args ? Object.entries(node.args) : [];
    return (
      <>
        <DetailRow label="MCP server" value={node.server} />
        <DetailRow label="Tool" value={node.tool} />
        {node.when && (
          <DetailSection label="Condition">
            <code className="break-all font-mono text-[10px] text-muted-foreground">{node.when}</code>
          </DetailSection>
        )}
        {argEntries.length > 0 && (
          <DetailSection label="Arguments">
            {argEntries.map(([k, v]) => (
              <div key={k} className="flex gap-1 font-mono text-[10px]">
                <span className="shrink-0 text-primary/70">{k}</span>
                <span className="text-muted-foreground">←</span>
                <span className="break-all text-muted-foreground/80">
                  {typeof v === 'string' ? v : JSON.stringify(v)}
                </span>
              </div>
            ))}
          </DetailSection>
        )}
      </>
    );
  }

  return null;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="text-foreground/90">{value}</div>
    </div>
  );
}

function DetailSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
