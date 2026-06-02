// Section 26 — derive the tier-1 acceptance-criteria predicate set from the
// orchestrator's `expected_output` spec. Pure function; no IO, no runtime
// deps. Reusable across MCP, future workflow-runtime node-evaluation, and
// the (future) UI editor.
//
// Derivation rules (locked at design time — the agent output contract
// § "AC derivation rules"):
//
//   text         → body_contains per section + min-chars regex if specified
//   files        → files_exist for every declared path
//   structured   → fields_populated for the declared field keys
//   side-effect  → bash_exit_zero if verify_via_bash was provided; else []
//   mixed        → union of the constituent derivations
//
// An empty result is legal — it means "trust the agent's end-of-turn signal"
// (tier-1 verification effectively passes by default). The orchestrator can
// always opt in to a stricter tier per dispatch.

import type {
  AcceptanceCriteria,
  AcceptancePredicate,
  ExpectedOutput,
} from './work-item-contract.ts';
import type {
  AcceptanceCriteria as AcceptanceCriteriaV2,
  AcceptancePredicate as AcceptancePredicateV2,
  ExpectedOutput as ExpectedOutputV2,
} from './contract.ts';

export function deriveAcceptanceCriteria(spec: ExpectedOutput): AcceptanceCriteria {
  switch (spec.kind) {
    case 'text':
      return deriveText(spec);
    case 'files':
      return deriveFiles(spec);
    case 'structured':
      return deriveStructured(spec);
    case 'side-effect':
      return deriveSideEffect(spec);
    case 'mixed':
      return deriveMixed(spec);
  }
}

function deriveText(
  spec: Extract<ExpectedOutput, { kind: 'text' }>,
): AcceptancePredicate[] {
  const preds: AcceptancePredicate[] = [];
  if (spec.sections) {
    for (const section of spec.sections) {
      // Section name appears verbatim in the body. Authors typically render
      // them as markdown headers (`## Summary`); the bare-substring check
      // works either way.
      preds.push({ kind: 'body_contains', pattern: section });
    }
  }
  if (typeof spec.min_chars === 'number' && spec.min_chars > 0) {
    // Regex: any sequence of at least N chars (including whitespace + newlines).
    preds.push({
      kind: 'body_contains',
      pattern: `^[\\s\\S]{${spec.min_chars},}$`,
      regex: true,
    });
  }
  return preds;
}

function deriveFiles(
  spec: Extract<ExpectedOutput, { kind: 'files' }>,
): AcceptancePredicate[] {
  if (spec.paths.length === 0) return [];
  const pred: AcceptancePredicate = { kind: 'files_exist', paths: spec.paths };
  if (typeof spec.min_size_bytes === 'number') {
    pred.min_size_bytes = spec.min_size_bytes;
  }
  return [pred];
}

function deriveStructured(
  spec: Extract<ExpectedOutput, { kind: 'structured' }>,
): AcceptancePredicate[] {
  const keys = Object.keys(spec.fields);
  if (keys.length === 0) return [];
  return [{ kind: 'fields_populated', keys }];
}

function deriveSideEffect(
  spec: Extract<ExpectedOutput, { kind: 'side-effect' }>,
): AcceptancePredicate[] {
  if (!spec.verify_via_bash) return [];
  return [{ kind: 'bash_exit_zero', command: spec.verify_via_bash, cwd: 'worktree' }];
}

function deriveMixed(
  spec: Extract<ExpectedOutput, { kind: 'mixed' }>,
): AcceptancePredicate[] {
  const preds: AcceptancePredicate[] = [];
  if (spec.text) {
    preds.push(...deriveText({ kind: 'text', ...spec.text }));
  }
  if (spec.files) {
    preds.push(...deriveFiles({ kind: 'files', ...spec.files }));
  }
  if (spec.structured) {
    preds.push(...deriveStructured({ kind: 'structured', ...spec.structured }));
  }
  if (spec.side_effect) {
    preds.push(...deriveSideEffect({ kind: 'side-effect', ...spec.side_effect }));
  }
  return preds;
}

// ── v2 derivation (slice 014a) ──────────────────────────────────────────────
// Maps the 7-mechanism v2 `ExpectedOutput` to its evidence predicates. Each
// kind derives predicates that read REAL evidence (the report, the tool-call
// stream, the payload, the git tree, the external handle) rather than the
// echo-poisonable work-item body. Added alongside the v1 `deriveAcceptance-
// Criteria`; the v1 path stays until dispatch authors v2 specs (slice 019).
//
// `KINDS_REQUIRING_EVIDENCE` lists the side-effect kinds whose [] derivation
// must NOT auto-pass (the server's fail-closed branch consults this). A kind
// that captures a structural artifact (answer/prose/payload/binary) is safe to
// trust on an empty derivation; action/external/repo are not.

/** Side-effect kinds that must fail-closed on an empty derived AC. */
export const KINDS_REQUIRING_EVIDENCE: ReadonlyArray<ExpectedOutputV2['kind']> = [
  'action',
  'external',
  'repo',
];

export function deriveAcceptanceCriteriaV2(spec: ExpectedOutputV2): AcceptanceCriteriaV2 {
  switch (spec.kind) {
    case 'answer':
      return deriveAnswerV2(spec);
    case 'prose':
      return deriveProseV2(spec);
    case 'payload':
      return [{ kind: 'schema_valid', schema: spec.schema }];
    case 'repo':
      return deriveRepoV2(spec);
    case 'external':
      return spec.verify_handle === false ? [] : [{ kind: 'external_handle_present' }];
    case 'binary':
      // The artifact is captured as an attachment; the capture itself is the
      // evidence (there's no declared name to assert). Trust on empty.
      return [];
    case 'action':
      return deriveActionV2(spec);
  }
}

function minCharsRegex(minChars: number): string {
  return `^[\\s\\S]{${minChars},}$`;
}

function deriveAnswerV2(
  spec: Extract<ExpectedOutputV2, { kind: 'answer' }>,
): AcceptancePredicateV2[] {
  const preds: AcceptancePredicateV2[] = [];
  for (const topic of spec.must_address ?? []) {
    preds.push({ kind: 'report_contains', pattern: topic });
  }
  if (typeof spec.min_chars === 'number' && spec.min_chars > 0) {
    preds.push({ kind: 'report_contains', pattern: minCharsRegex(spec.min_chars), regex: true });
  }
  return preds;
}

function deriveProseV2(
  spec: Extract<ExpectedOutputV2, { kind: 'prose' }>,
): AcceptancePredicateV2[] {
  const preds: AcceptancePredicateV2[] = [];
  // Where the prose lands decides which corpus the section/min-chars checks
  // read: the work-item body (store: work_item_body) or the contract report.
  const useBody = spec.store === 'work_item_body';
  const contains = (pattern: string, regex?: boolean): AcceptancePredicateV2 =>
    useBody
      ? { kind: 'body_contains', pattern, ...(regex ? { regex } : {}) }
      : { kind: 'report_contains', pattern, ...(regex ? { regex } : {}) };
  for (const section of spec.sections ?? []) {
    preds.push(contains(section));
  }
  if (typeof spec.min_chars === 'number' && spec.min_chars > 0) {
    preds.push(contains(minCharsRegex(spec.min_chars), true));
  }
  if (spec.store === 'repo_file' && spec.path) {
    preds.push({ kind: 'files_exist', paths: [spec.path] });
  }
  return preds;
}

function deriveRepoV2(
  spec: Extract<ExpectedOutputV2, { kind: 'repo' }>,
): AcceptancePredicateV2[] {
  const cwd: 'worktree' | 'project' = spec.isolation === 'in_place' ? 'project' : 'worktree';
  const preds: AcceptancePredicateV2[] = [];
  if (spec.require_diff !== false) {
    preds.push({ kind: 'git_diff_nonempty', cwd });
  }
  for (const check of spec.checks ?? []) {
    if ('preset' in check) {
      preds.push({ kind: 'bash_exit_zero', command: `pnpm ${check.preset}`, cwd });
    } else {
      preds.push({ kind: 'bash_exit_zero', command: check.command, cwd: check.cwd ?? cwd });
    }
  }
  return preds;
}

function deriveActionV2(
  spec: Extract<ExpectedOutputV2, { kind: 'action' }>,
): AcceptancePredicateV2[] {
  const preds: AcceptancePredicateV2[] = [
    { kind: 'tool_called', name: spec.tool, ...(spec.min_count ? { min_count: spec.min_count } : {}) },
  ];
  // pc_ask_user leaves a durable pending-ask row — assert that too, so an
  // agent that merely emits the tool_use frame without the side-effect landing
  // still fails.
  if (/ask_user/.test(spec.tool)) {
    preds.push({ kind: 'pending_ask_created' });
  }
  return preds;
}
