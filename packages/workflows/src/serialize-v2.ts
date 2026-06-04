// Section 19 — v2 workflow YAML serialize/parse. Pure (no I/O). v2 definitions
// live as YAML files alongside v1 in `.project-companion/workflows/`; a top-level
// `version: 2` marker discriminates them (the v1 registry skips version:2 files;
// the v2 registry skips everything else). Unlike v1, the node `kind:` field IS
// on-disk for v2 (it's the schema discriminator the parser reads).

import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import type { WorkflowV2 } from '@pc/domain';
import { validateWorkflowV2 } from './dag/validate.ts';

/** Marker written at the top of every v2 workflow file. */
export const WORKFLOW_V2_VERSION = 2;

/** Cheap check: is this YAML text a v2 workflow (top-level `version: 2`)? Used
 *  to keep the v1 boot migration from touching v2 files in the shared dir. */
export function isV2WorkflowText(yamlText: string): boolean {
  try {
    const doc = yamlLoad(yamlText);
    return doc !== null && typeof doc === 'object' && (doc as Record<string, unknown>).version === WORKFLOW_V2_VERSION;
  } catch {
    return false;
  }
}

/** Serialize a v2 workflow to round-trippable YAML. Fixed key order keeps the
 *  on-disk shape human-readable + diff-friendly. */
export function serializeWorkflowV2(workflow: WorkflowV2.Workflow): string {
  const out: Record<string, unknown> = { version: WORKFLOW_V2_VERSION, id: workflow.id, name: workflow.name };
  if (workflow.description !== undefined) out.description = workflow.description;
  if (workflow.worktree !== undefined) out.worktree = workflow.worktree;
  if (workflow.max_concurrency !== undefined) out.max_concurrency = workflow.max_concurrency;
  if (workflow.disabled === true) out.disabled = true;
  out.nodes = workflow.nodes;
  return yamlDump(out, { lineWidth: 0, noRefs: true });
}

export type ParseV2Result =
  | { ok: true; workflow: WorkflowV2.Workflow }
  /** File parsed but isn't a v2 workflow (no `version: 2`). Registry skips it. */
  | { ok: false; notV2: true }
  /** File IS v2 but failed YAML parse or graph validation. Registry flags it. */
  | { ok: false; notV2?: false; errors: string[] };

/**
 * Parse + validate a v2 workflow YAML document. Returns `notV2` for non-v2 files
 * (so the registry skips v1 quietly), validation `errors` for malformed v2 files
 * (surfaced in the UI), or the typed workflow. `expectedId` (from the filename)
 * is authoritative for `id` — the body's id is coerced to match.
 */
export function parseWorkflowV2Text(yamlText: string, opts: { expectedId?: string } = {}): ParseV2Result {
  let doc: unknown;
  try {
    doc = yamlLoad(yamlText);
  } catch (err) {
    return { ok: false, errors: [`YAML parse error: ${(err as Error).message}`] };
  }
  if (doc === null || typeof doc !== 'object') {
    return { ok: false, notV2: true };
  }
  const raw = doc as Record<string, unknown>;
  if (raw.version !== WORKFLOW_V2_VERSION) {
    return { ok: false, notV2: true };
  }

  const { version: _v, ...rest } = raw;
  if (opts.expectedId) rest.id = opts.expectedId;
  const workflow = rest as unknown as WorkflowV2.Workflow;

  const result = validateWorkflowV2(workflow);
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }
  return { ok: true, workflow };
}

/** M6 one-shot data-migration helper — rewrite a stored definition's YAML to
 *  the v3 step model. Idempotent transforms:
 *  - FD-10 (slice A): drop a dead top-level `triggers:` key.
 *  - FD-9 (slice B): `node.move: S` → an inserted `move` step spliced into the
 *    node's forward path · review `reject: {back_to, max_iterations?, carry?}`
 *    → a minted `loop` step + `reject: <loopId>` · `reject.move` DROPPED whole
 *    (on-reject move-back died with FD-9) · dead `retry:` keys dropped.
 *  Returns `changed: false` when nothing matches (or the text doesn't parse —
 *  nothing to rewrite safely). When changed, returns the re-serialized YAML +
 *  the re-validated workflow (`workflow: null` + `errors` when the def is
 *  invalid for OTHER reasons — the caller keeps its honest `invalid` status). */
export function migrateWorkflowTextToV3(
  yamlText: string,
  expectedId: string,
):
  | { changed: false }
  | { changed: true; yaml: string; workflow: WorkflowV2.Workflow | null; errors: string[] } {
  let doc: unknown;
  try {
    doc = yamlLoad(yamlText);
  } catch {
    return { changed: false };
  }
  if (doc === null || typeof doc !== 'object') return { changed: false };
  const raw = doc as Record<string, unknown>;

  let changed = false;
  if (raw.triggers !== undefined) {
    delete raw.triggers;
    changed = true;
  }

  const nodes = Array.isArray(raw.nodes) ? (raw.nodes as Record<string, unknown>[]) : [];
  const ids = new Set(nodes.map((n) => (typeof n.id === 'string' ? n.id : '')));
  const mintId = (base: string): string => {
    let candidate = base;
    for (let i = 2; ids.has(candidate); i++) candidate = `${base}-${String(i)}`;
    ids.add(candidate);
    return candidate;
  };

  const inserted: Record<string, unknown>[] = [];
  for (const n of nodes) {
    const nodeId = typeof n.id === 'string' ? n.id : '?';
    // dead retry keys (never executed)
    if (n.retry !== undefined) {
      delete n.retry;
      changed = true;
    }
    // node.move → spliced move step on the forward path
    if (typeof n.move === 'string' && n.move) {
      const moveId = mintId(`${nodeId}-move`);
      const moveNode: Record<string, unknown> = { id: moveId, kind: 'move', stage: n.move };
      if (Array.isArray(n.next) && n.next.length > 0) moveNode.next = n.next;
      n.next = [moveId];
      delete n.move;
      inserted.push(moveNode);
      changed = true;
    } else if (n.move !== undefined) {
      delete n.move;
      changed = true;
    }
    // review reject object → loop step (reject.move DROPPED — FD-9)
    if (n.kind === 'review' && n.reject !== undefined && typeof n.reject !== 'string') {
      const reject = (n.reject ?? {}) as Record<string, unknown>;
      if (typeof reject.back_to === 'string' && reject.back_to) {
        const loopId = mintId(`${nodeId}-loop`);
        const loopNode: Record<string, unknown> = {
          id: loopId,
          kind: 'loop',
          back_to: reject.back_to,
        };
        if (reject.max_iterations !== undefined) loopNode.max_iterations = reject.max_iterations;
        if (reject.carry !== undefined) loopNode.carry = reject.carry;
        n.reject = loopId;
        inserted.push(loopNode);
      } else {
        delete n.reject;
      }
      changed = true;
    }
  }
  if (inserted.length > 0) raw.nodes = [...nodes, ...inserted];

  if (!changed) return { changed: false };

  const { version: _v, ...rest } = raw;
  const workflow = { ...rest, id: expectedId } as unknown as WorkflowV2.Workflow;
  const result = validateWorkflowV2(workflow);
  const yaml = serializeWorkflowV2(workflow);
  return result.ok
    ? { changed: true, yaml, workflow, errors: [] }
    : { changed: true, yaml, workflow: null, errors: result.errors };
}
