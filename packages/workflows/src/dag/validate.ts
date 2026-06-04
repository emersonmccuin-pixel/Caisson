// Section 19.6 — save-time / fire-time workflow graph validator. Pure, I/O-free.
// Composes findForwardCycle (topo.ts) + evaluateCondition's grammar check
// (when.ts). PC improvement over Archon: cycle detection at LOAD, `when:`
// validated at save (not discovered at runtime). Collects ALL errors (not
// first-only) so the builder / orchestrator can surface every problem at once.
//
// Input may be untyped JSON straight off the wire (the /fire route casts), so
// every field read is defensive — never assume the discriminated union holds.

import type { WorkflowV2 } from '@pc/domain';
import { computeUpstreams, findForwardCycle } from './topo.ts';
import { evaluateCondition } from './when.ts';
import { extractRefs, extractInputPlaceholders, type RefResolver } from './refs.ts';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const NODE_KINDS = new Set(['agent', 'review', 'move', 'loop']);
const REVIEW_KINDS = new Set(['review']);
const REVIEWERS = new Set(['human', 'orchestrator']);
/** Flow fields a `loop` node cannot carry — its routing is fixed. */
const LOOP_FORBIDDEN = ['next', 'when', 'trigger_rule', 'input', 'timeout'] as const;

/** Grammar-only probe for `when:`. A resolver returning '0' lets every
 *  well-formed atom parse (string-eq AND numeric), so `parsed: false` means the
 *  expression is genuinely malformed — not merely that a value was absent. */
const GRAMMAR_PROBE: RefResolver = () => '0';

/**
 * Validate a v2 workflow graph. Checks (in order): shell shape · unique node
 * ids · known kinds + per-kind required fields · ref integrity (next /
 * review reject → loop · loop back_to · bundle_from point to real nodes) ·
 * loop↔review pairing · forward-edge acyclicity ·
 * `when:` grammar. Returns every error found.
 */
export function validateWorkflowV2(workflow: WorkflowV2.Workflow): ValidationResult {
  const errors: string[] = [];
  const wf = workflow as unknown as {
    name?: unknown;
    nodes?: unknown;
    triggers?: unknown;
  };

  if (typeof wf.name !== 'string' || wf.name.trim() === '') errors.push('workflow.name is required');

  const nodes = (Array.isArray(wf.nodes) ? wf.nodes : []) as Record<string, unknown>[];
  if (nodes.length === 0) errors.push('workflow must have at least one node');

  // ── node ids + kinds + per-kind required fields ──
  const ids = new Set<string>();
  for (const n of nodes) {
    const id = typeof n.id === 'string' ? n.id : '';
    if (!id) {
      errors.push('every node needs a non-empty string id');
      continue;
    }
    if (ids.has(id)) errors.push(`duplicate node id "${id}"`);
    if (id === 'root') errors.push(`node id "root" is reserved`);
    ids.add(id);

    const kind = n.kind as string;
    if (!NODE_KINDS.has(kind)) {
      errors.push(`node "${id}": unknown kind "${String(kind)}"`);
      continue;
    }
    if (kind === 'agent' && (typeof n.agent !== 'string' || n.agent === ''))
      errors.push(`agent node "${id}": missing "agent" (pod name)`);
    if (kind === 'agent' && (typeof n.task !== 'string' || n.task === ''))
      errors.push(`agent node "${id}": missing "task"`);
    if (kind === 'review' && !REVIEWERS.has(n.reviewer as string))
      errors.push(`review node "${id}": reviewer must be "human" or "orchestrator"`);
    if (kind === 'move' && (typeof n.stage !== 'string' || n.stage === ''))
      errors.push(`move node "${id}": missing "stage" (the destination stage id)`);
    if (kind === 'loop') {
      if (typeof n.back_to !== 'string' || n.back_to === '')
        errors.push(`loop node "${id}": missing "back_to" (the node to re-run from)`);
      if (
        n.max_iterations !== undefined &&
        n.max_iterations !== null &&
        (typeof n.max_iterations !== 'number' || n.max_iterations < 1)
      )
        errors.push(`loop node "${id}": max_iterations must be a number ≥ 1 or null (unlimited)`);
      for (const f of LOOP_FORBIDDEN) {
        if (n[f] !== undefined)
          errors.push(`loop node "${id}": "${f}" is not allowed — a loop's routing is fixed (under ceiling → back_to; at ceiling → human)`);
      }
    }

    // input map shape — an object of identifier → string (a `$ref` or literal).
    if (n.input !== undefined) {
      if (typeof n.input !== 'object' || n.input === null || Array.isArray(n.input)) {
        errors.push(`node "${id}": input must be a map of name → ref`);
      } else {
        for (const [k, v] of Object.entries(n.input as Record<string, unknown>)) {
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k))
            errors.push(`node "${id}": input key "${k}" must be a plain identifier`);
          if (typeof v !== 'string')
            errors.push(`node "${id}": input "${k}" must be a string ref or literal`);
        }
      }
    }
  }

  // ── ref integrity ──
  const known = (id: unknown): boolean => typeof id === 'string' && ids.has(id);
  const kindOf = (id: unknown): string | undefined =>
    typeof id === 'string' ? (nodes.find((m) => m.id === id)?.kind as string | undefined) : undefined;
  for (const n of nodes) {
    const id = (n.id as string) || '?';
    for (const nx of Array.isArray(n.next) ? n.next : []) {
      if (!known(nx)) errors.push(`node "${id}": next → unknown node "${String(nx)}"`);
      else if (kindOf(nx) === 'loop')
        errors.push(`node "${id}": next → "${String(nx)}" is a loop step — loops are reached only via a review's reject`);
    }
    if (REVIEW_KINDS.has(n.kind as string)) {
      if (n.reject !== undefined) {
        if (typeof n.reject !== 'string' || !known(n.reject))
          errors.push(`review node "${id}": reject → unknown node "${String(n.reject)}" (must name a loop step)`);
        else if (kindOf(n.reject) !== 'loop')
          errors.push(`review node "${id}": reject → "${String(n.reject)}" is not a loop step (FD-9: the loop is a drawn step; on-reject card moves died with it)`);
      }
      for (const b of Array.isArray(n.bundle_from) ? n.bundle_from : []) {
        if (!known(b)) errors.push(`review node "${id}": bundle_from → unknown node "${String(b)}"`);
      }
    }
    if (n.kind === 'loop' && typeof n.back_to === 'string' && n.back_to !== '') {
      if (!known(n.back_to))
        errors.push(`loop node "${id}": back_to → unknown node "${String(n.back_to)}"`);
      else if (kindOf(n.back_to) === 'loop' || kindOf(n.back_to) === 'review')
        errors.push(`loop node "${id}": back_to must point at an agent or move step (the work to re-run)`);
    }
  }

  // ── loop ↔ review pairing — every loop is the reject target of EXACTLY one
  // review (the loop's iteration count is per-owning-review bookkeeping). ──
  const loopOwners = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.kind === 'loop' && typeof n.id === 'string') loopOwners.set(n.id, []);
  }
  for (const n of nodes) {
    if (REVIEW_KINDS.has(n.kind as string) && typeof n.reject === 'string') {
      loopOwners.get(n.reject)?.push((n.id as string) || '?');
    }
  }
  for (const [loopId, owners] of loopOwners) {
    if (owners.length === 0)
      errors.push(`loop node "${loopId}": no review points at it — wire a review's reject to it or remove it`);
    if (owners.length > 1)
      errors.push(`loop node "${loopId}": ${String(owners.length)} reviews point at it (${owners.join(', ')}) — each loop serves exactly one review`);
  }

  // ── forward-edge acyclicity (reject back-edges are excluded by forwardEdges) ──
  const cycle = findForwardCycle(nodes as unknown as WorkflowV2.WorkflowNode[]);
  if (cycle) errors.push(`cycle in forward edges: ${cycle.join(' → ')}`);

  // ── ref ordering ("Saved ⇒ runnable", §4.1) ──
  // Every `$X.output[.field]` a step reads must point at a STRICTLY-EARLIER step
  // (a forward-edge ancestor) or the run-root card (`$root`). A step can't read
  // its own output or a downstream/sibling step's output that hasn't run yet —
  // the chain can't be wired to read a value before it exists. Skipped when the
  // graph has a cycle (the upstream relation is meaningless until that's fixed).
  if (!cycle) {
    const upstreams = computeUpstreams(nodes as unknown as WorkflowV2.WorkflowNode[]);
    const ancestorCache = new Map<string, Set<string>>();
    const ancestorsOf = (nodeId: string): Set<string> => {
      const cached = ancestorCache.get(nodeId);
      if (cached) return cached;
      const acc = new Set<string>();
      const stack = [...(upstreams.get(nodeId) ?? [])];
      while (stack.length) {
        const u = stack.pop()!;
        if (acc.has(u)) continue;
        acc.add(u);
        for (const p of upstreams.get(u) ?? []) stack.push(p);
      }
      ancestorCache.set(nodeId, acc);
      return acc;
    };
    for (const n of nodes) {
      const id = typeof n.id === 'string' ? n.id : '';
      if (!id) continue;
      // The substitutable text bodies a step renders refs from — its task /
      // prompt AND every value in its declared `input:` map (each value is a
      // `$ref` bound to an upstream port, subject to the same ordering rule).
      const inputVals =
        n.input && typeof n.input === 'object' && !Array.isArray(n.input)
          ? Object.values(n.input as Record<string, unknown>).filter(
              (v): v is string => typeof v === 'string',
            )
          : [];
      const bodies = [n.task, n.prompt, ...inputVals].filter(
        (v): v is string => typeof v === 'string',
      );
      if (bodies.length === 0) continue;
      const ancestors = ancestorsOf(id);
      const seen = new Set<string>();
      for (const body of bodies) {
        for (const ref of extractRefs(body)) {
          const fieldSuffix = ref.field ? `.${ref.field}` : '';
          const key = `${ref.nodeId}${fieldSuffix}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (ref.nodeId === 'root') continue; // the run-root card is always available
          if (ref.nodeId === 'self') {
            errors.push(`node "${id}": $self.output is only valid in a reject edge's carry, not in a body`);
            continue;
          }
          if (ref.nodeId === id) {
            errors.push(`node "${id}": reads its own output ($${id}.output${fieldSuffix})`);
            continue;
          }
          if (!known(ref.nodeId)) {
            errors.push(`node "${id}": reads $${ref.nodeId}.output${fieldSuffix} — no such node`);
            continue;
          }
          const refKind = kindOf(ref.nodeId);
          if (refKind === 'move' || refKind === 'loop') {
            errors.push(
              `node "${id}": reads $${ref.nodeId}.output${fieldSuffix} but "${ref.nodeId}" is a ${refKind} step — only agent steps produce an output`,
            );
            continue;
          }
          if (!ancestors.has(ref.nodeId)) {
            errors.push(
              `node "${id}": reads $${ref.nodeId}.output${fieldSuffix} but "${ref.nodeId}" is not an upstream step — a ref must point at a strictly-earlier step`,
            );
          }
        }
      }
    }
  }

  // ── input placeholders ({{name}}) must bind to a declared input key ──
  // "Saved ⇒ runnable": a task/prompt that consumes `{{x}}` must declare `x`
  // under `input:`, so the wiring is always resolvable (no silent empty value).
  for (const n of nodes) {
    const id = typeof n.id === 'string' ? n.id : '?';
    const inputKeys = new Set(
      n.input && typeof n.input === 'object' && !Array.isArray(n.input)
        ? Object.keys(n.input as Record<string, unknown>)
        : [],
    );
    const seen = new Set<string>();
    for (const body of [n.task, n.prompt].filter((v): v is string => typeof v === 'string')) {
      for (const name of extractInputPlaceholders(body)) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (!inputKeys.has(name)) {
          errors.push(`node "${id}": {{${name}}} has no matching input — declare it under input:`);
        }
      }
    }
  }

  // ── when: grammar ──
  for (const n of nodes) {
    if (typeof n.when === 'string' && n.when.trim() !== '') {
      const { parsed } = evaluateCondition(n.when, GRAMMAR_PROBE);
      if (!parsed) errors.push(`node "${(n.id as string) || '?'}": when "${n.when}" failed to parse`);
    }
  }

  // ── triggers — ☠ DELETED (M6/FD-10) ──
  // Workflows no longer declare triggers; runs start via "Run now" or the
  // orchestrator's fire tool. A leftover `triggers:` key is rejected at the
  // door so authors (human or agent) learn immediately instead of carrying a
  // dead key forward.
  if (wf.triggers !== undefined) {
    errors.push(
      'workflows no longer declare triggers — remove the "triggers:" key. Every run starts via "Run now" or the orchestrator fire tool.',
    );
  }

  return { ok: errors.length === 0, errors };
}
