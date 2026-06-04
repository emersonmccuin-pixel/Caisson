// Derive the acceptance-criteria predicate set from the contract's v2
// `ExpectedOutput` spec. Pure function; no IO, no runtime deps. Reusable across
// MCP, the workflow runtime's node evaluation, and the UI editor.
//
// Maps the 7-mechanism v2 `ExpectedOutput` to its evidence predicates. Each
// kind derives predicates that read REAL evidence (the report, the tool-call
// stream, the payload, the git tree, the external handle) rather than the
// echo-poisonable work-item body.
//
// `KINDS_REQUIRING_EVIDENCE` lists the side-effect kinds whose [] derivation
// must NOT auto-pass (the server's fail-closed branch consults this). A kind
// that captures a structural artifact (answer/prose/payload/binary) is safe to
// trust on an empty derivation; action/external/repo are not.

import type {
  AcceptanceCriteria as AcceptanceCriteriaV2,
  AcceptancePredicate as AcceptancePredicateV2,
  ExpectedOutput as ExpectedOutputV2,
} from './contract.ts';

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

/** The attachment filename the `store: attachment` executor writes AND the
 *  `attachments_present` predicate asserts. Shared so writer + reader can't
 *  drift (the writer-vs-reader-mismatch class of bug). `<doc_type>.md`, or
 *  `deliverable.md` when no doc_type is declared. */
export function proseAttachmentName(spec: Extract<ExpectedOutputV2, { kind: 'prose' }>): string {
  return `${spec.doc_type ?? 'deliverable'}.md`;
}

function deriveProseV2(
  spec: Extract<ExpectedOutputV2, { kind: 'prose' }>,
): AcceptancePredicateV2[] {
  // `repo_file` writes to disk — the section/min-chars text isn't loaded into
  // the in-memory eval context, so the placement proof is the file existing +
  // being non-trivial (min_chars → min_size_bytes). Content-level section
  // checks aren't available for this store.
  if (spec.store === 'repo_file') {
    if (!spec.path) return [];
    const minBytes = typeof spec.min_chars === 'number' && spec.min_chars > 0 ? spec.min_chars : 1;
    return [{ kind: 'files_exist', paths: [spec.path], min_size_bytes: minBytes }];
  }

  const preds: AcceptancePredicateV2[] = [];
  // The store decides which corpus the section/min-chars checks read:
  //   - attachment → the work-item body + attachment contents (`body_contains`
  //     searches both); the executor writes the document there.
  //   - contract (default — FD-5/M5) → the contract report (`report_contains`);
  //     the text stays on the contract and verification reads it via the report
  //     fallback. ☠ work_item_body: the body is the human brief only.
  const useBody = spec.store === 'attachment';
  // attachment also asserts the document actually landed, by name.
  if (spec.store === 'attachment') {
    preds.push({ kind: 'attachments_present', names: [proseAttachmentName(spec)] });
  }
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
