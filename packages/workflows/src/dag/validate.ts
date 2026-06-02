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
import { extractRefs, type RefResolver } from './refs.ts';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const NODE_KINDS = new Set(['agent', 'bash', 'script', 'human-review', 'orchestrator-review', 'move-work-item']);
const TRIGGER_KINDS = new Set(['manual', 'stage-on-entry', 'schedule', 'event']);
const SCRIPT_RUNTIMES = new Set(['node', 'python']);
const REVIEW_KINDS = new Set(['human-review', 'orchestrator-review']);

/** Grammar-only probe for `when:`. A resolver returning '0' lets every
 *  well-formed atom parse (string-eq AND numeric), so `parsed: false` means the
 *  expression is genuinely malformed — not merely that a value was absent. */
const GRAMMAR_PROBE: RefResolver = () => '0';

export interface CrossWorkflowValidationOpts {
  /** Other active workflows in the project that have stage-on-entry triggers.
   *  When provided, move-work-item nodes whose `to_stage` collides with one of
   *  these stages produce an error unless `allow_stage_workflow_skip: true` is set. */
  stageOnEntryWorkflows?: Array<{ workflowId: string; name: string; stage: string }>;
}

/**
 * Validate a v2 workflow graph. Checks (in order): shell shape · unique node
 * ids · known kinds + per-kind required fields · ref integrity (next /
 * reject.back_to / bundle_from point to real nodes) · forward-edge acyclicity ·
 * `when:` grammar · trigger shape · cross-workflow stage collisions (when opts
 * supplied). Returns every error found.
 *
 * `opts` is optional. When omitted, behavior is identical to the fire-time call
 * (no cross-workflow checks), preserving back-compat for all existing call sites.
 */
export function validateWorkflowV2(workflow: WorkflowV2.Workflow, opts?: CrossWorkflowValidationOpts): ValidationResult {
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
    if (kind === 'bash' && (typeof n.bash !== 'string' || n.bash === ''))
      errors.push(`bash node "${id}": missing "bash" command`);
    if (kind === 'script') {
      if (typeof n.script !== 'string' || n.script === '') errors.push(`script node "${id}": missing "script" body`);
      if (!SCRIPT_RUNTIMES.has(n.runtime as string))
        errors.push(`script node "${id}": runtime must be "node" or "python"`);
    }
    if (kind === 'move-work-item' && (typeof n.to_stage !== 'string' || n.to_stage === ''))
      errors.push(`move-work-item node "${id}": missing "to_stage"`);
  }

  // ── ref integrity ──
  const known = (id: unknown): boolean => typeof id === 'string' && ids.has(id);
  for (const n of nodes) {
    const id = (n.id as string) || '?';
    for (const nx of Array.isArray(n.next) ? n.next : []) {
      if (!known(nx)) errors.push(`node "${id}": next → unknown node "${String(nx)}"`);
    }
    if (REVIEW_KINDS.has(n.kind as string)) {
      const reject = n.reject as { back_to?: unknown } | undefined;
      if (reject && !known(reject.back_to))
        errors.push(`review node "${id}": reject.back_to → unknown node "${String(reject.back_to)}"`);
      for (const b of Array.isArray(n.bundle_from) ? n.bundle_from : []) {
        if (!known(b)) errors.push(`review node "${id}": bundle_from → unknown node "${String(b)}"`);
      }
    }
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
      // The substitutable text bodies a step renders refs from.
      const bodies = [n.task, n.bash, n.script, n.prompt].filter(
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
          if (!ancestors.has(ref.nodeId)) {
            errors.push(
              `node "${id}": reads $${ref.nodeId}.output${fieldSuffix} but "${ref.nodeId}" is not an upstream step — a ref must point at a strictly-earlier step`,
            );
          }
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

  // ── triggers ──
  const triggers = (Array.isArray(wf.triggers) ? wf.triggers : []) as Record<string, unknown>[];
  if (triggers.length === 0) errors.push('workflow needs at least one trigger');
  for (const t of triggers) {
    const kind = t.kind as string;
    if (!TRIGGER_KINDS.has(kind)) {
      errors.push(`unknown trigger kind "${String(kind)}"`);
      continue;
    }
    if (kind === 'stage-on-entry' && (typeof t.stage !== 'string' || t.stage === ''))
      errors.push('stage-on-entry trigger: missing "stage"');
    if (kind === 'schedule' && (typeof t.cron !== 'string' || t.cron === ''))
      errors.push('schedule trigger: missing "cron"');
    if (kind === 'event' && (typeof t.source !== 'string' || t.source === ''))
      errors.push('event trigger: missing "source"');
  }

  // ── cross-workflow stage-on-entry collision ──
  if (opts?.stageOnEntryWorkflows && opts.stageOnEntryWorkflows.length > 0) {
    for (const n of nodes) {
      if ((n.kind as string) !== 'move-work-item') continue;
      const toStage = n.to_stage as unknown;
      if (typeof toStage !== 'string' || !toStage) continue;
      if ((n as Record<string, unknown>).allow_stage_workflow_skip === true) continue;
      const collision = opts.stageOnEntryWorkflows.find((w) => w.stage === toStage);
      if (collision) {
        const id = typeof n.id === 'string' ? n.id : '?';
        errors.push(
          `move-work-item node "${id}": destination stage is the on-entry trigger of workflow "${collision.name}" — that workflow will be silently skipped. Inline its steps, pick another stage, or set allow_stage_workflow_skip: true to do this intentionally.`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
