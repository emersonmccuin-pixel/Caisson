// Deterministic WorkflowV2.Workflow → Mermaid flowchart LR string.
// Zero runtime dependencies. Browser-safe — use server-side or in any web surface.
//
// Guardrail: this is the SINGLE source of truth for workflow diagrams. Always
// generated from the actual node/edge structure — never free-handed. Same
// definition produces the same string on every call.

import type { Workflow, WorkflowNode } from './workflow-v2.ts';
import { isLoopNode, isReviewNode } from './workflow-v2.ts';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Escapes a string for use as a Mermaid node label inside double quotes. */
function escapeMermaidLabel(text: string): string {
  return text
    .replace(/"/g, "'") // double quotes would break label parsing
    .replace(/[<>]/g, '') // can trigger HTML parsing in some Mermaid versions
    .replace(/[#;]/g, ''); // Mermaid metacharacters
}

/** Converts a hyphenated/underscored id to Title Case words. */
function humanizeId(id: string): string {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Returns a valid Mermaid node identifier for a workflow node id. */
function mermaidNodeId(id: string): string {
  // Prefix n_ so numeric-starting ids remain valid; replace non-alnum with _.
  return `n_${id.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/** Returns the display label text for a workflow node. */
function buildNodeLabel(node: WorkflowNode): string {
  switch (node.kind) {
    case 'agent':
      return escapeMermaidLabel(humanizeId(node.id));
    case 'review':
      return escapeMermaidLabel(
        node.reviewer === 'human'
          ? `Approve: ${humanizeId(node.id)}`
          : `Auto-review: ${humanizeId(node.id)}`,
      );
    case 'move':
      return escapeMermaidLabel(`Move card: ${humanizeId(node.stage)}`);
    case 'loop': {
      const max =
        node.max_iterations === null
          ? 'unlimited'
          : `max ${String(node.max_iterations ?? 3)}`;
      return escapeMermaidLabel(`Retry (${max})`);
    }
    case 'merge':
      return escapeMermaidLabel('Merge to integration');
    case 'call':
      return escapeMermaidLabel(`Call: ${node.server} · ${node.tool}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts a v2 workflow definition into a Mermaid `flowchart LR` string.
 *
 * - **Deterministic** — same definition → same string every call.
 * - **Reflects the real graph** — all node kinds (agent / review / move / loop /
 *   merge / call), forward edges, and reject-loops as dashed edges. Never hand-drawn.
 * - **Browser-safe, zero runtime deps** — import from server or web app alike.
 *
 * Node shapes encode kind: pill = agent · diamond = review · parallelogram =
 * move · circle = loop · hexagon = merge · subroutine box = call. Colors match
 * the app's Vellum palette.
 * Reject / retry back-edges render as dashed arrows (`-.->`) so they are visually
 * distinct from forward flow.
 */
export function workflowToMermaid(workflow: Workflow): string {
  const lines: string[] = [];

  lines.push('flowchart LR');

  // Kind styling — colors match the Vellum warm-dark palette.
  lines.push('  classDef agentNode fill:#221a08,stroke:#f0d080,color:#f0e4c4');
  lines.push('  classDef reviewNode fill:#1e1600,stroke:#d8a848,color:#fef3c7');
  lines.push('  classDef moveNode fill:#0c1a08,stroke:#8cb06a,color:#dcf0c8');
  lines.push('  classDef loopNode fill:#181410,stroke:#9a8e7a,color:#c8c0b0');
  lines.push('  classDef mergeNode fill:#181614,stroke:#f5e8c8,color:#f5e8c8');
  lines.push('  classDef callNode fill:#101a1e,stroke:#7ab8cc,color:#cfe8f0');

  // Node definitions — shape encodes kind.
  for (const node of workflow.nodes) {
    const id = mermaidNodeId(node.id);
    const label = buildNodeLabel(node);
    switch (node.kind) {
      case 'agent':
        // Stadium/pill — agent dispatch step.
        lines.push(`  ${id}(["${label}"])`);
        break;
      case 'review':
        // Diamond — approval gate.
        lines.push(`  ${id}{"${label}"}`);
        break;
      case 'move':
        // Parallelogram — card transition.
        lines.push(`  ${id}[/"${label}"/]`);
        break;
      case 'loop':
        // Circle — retry loop.
        lines.push(`  ${id}(("${label}"))`);
        break;
      case 'merge':
        // Hexagon — special engine operation.
        lines.push(`  ${id}{{"${label}"}}`);
        break;
      case 'call':
        // Subroutine box — engine-executed external tool call.
        lines.push(`  ${id}[["${label}"]]`);
        break;
    }
  }

  // Class assignments — after node definitions so Mermaid processes them.
  for (const node of workflow.nodes) {
    lines.push(`  class ${mermaidNodeId(node.id)} ${node.kind}Node`);
  }

  // Edges — forward edges solid, reject / retry back-edges dashed.
  for (const node of workflow.nodes) {
    const srcId = mermaidNodeId(node.id);

    if (isLoopNode(node)) {
      // Loop back-edge: dashed arrow labeled "retry".
      lines.push(`  ${srcId} -.->|retry| ${mermaidNodeId(node.back_to)}`);
      continue;
    }

    // Forward edges.
    for (const nextId of node.next ?? []) {
      if (isReviewNode(node)) {
        // Label approve-path on review nodes to distinguish from the reject edge.
        lines.push(`  ${srcId} -->|approve| ${mermaidNodeId(nextId)}`);
      } else {
        lines.push(`  ${srcId} --> ${mermaidNodeId(nextId)}`);
      }
    }

    // Reject back-edge for review nodes: dashed arrow to the loop node.
    if (isReviewNode(node) && node.reject) {
      lines.push(`  ${srcId} -.->|reject| ${mermaidNodeId(node.reject)}`);
    }
  }

  return lines.join('\n');
}
