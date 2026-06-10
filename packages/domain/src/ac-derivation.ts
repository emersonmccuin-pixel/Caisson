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
  RepoCheck,
} from './contract.ts';

/** Default per-check timeout for bash predicates derived from a repo contract's
 *  `checks` list. 10 minutes is generous enough for workspace-wide
 *  pnpm typecheck / pnpm test runs on real monorepos (the 30s default was
 *  SIGKILLing them mid-run and false-failing verification — pc-pty-chat-370).
 *  Individual checks can override via `RepoCheck.timeout_ms`. */
export const REPO_CHECK_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

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

function deriveAnswerV2(
  spec: Extract<ExpectedOutputV2, { kind: 'answer' }>,
): AcceptancePredicateV2[] {
  const preds: AcceptancePredicateV2[] = [];
  // must_address[] is agent guidance only — NOT compiled to report_contains
  // predicates (verification-soundness Principle 1, pc-pty-chat-371).
  // report_contains/body_contains remain valid for orchestrator-authored literal
  // assertions; we only stop AUTO-DERIVING them from semantic intent fields.
  if (typeof spec.min_chars === 'number' && spec.min_chars > 0) {
    // min_length measures the DELIVERABLE (not the report) — the one-door fix
    // for min_chars-via-report-regex false-fails (pc-pty-chat-265.1).
    preds.push({ kind: 'min_length', min: spec.min_chars });
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
  // attachment asserts the document actually landed, by name.
  if (spec.store === 'attachment') {
    preds.push({ kind: 'attachments_present', names: [proseAttachmentName(spec)] });
  }
  // sections[] is agent guidance only — NOT compiled to body_contains/report_contains
  // predicates (verification-soundness Principle 1, pc-pty-chat-371).
  // report_contains/body_contains remain valid for orchestrator-authored literal
  // assertions; we only stop AUTO-DERIVING them from semantic intent fields.
  if (typeof spec.min_chars === 'number' && spec.min_chars > 0) {
    // min_length measures the DELIVERABLE (not the report/body) — the one-door
    // fix for min_chars-via-report-regex false-fails (pc-pty-chat-265.1).
    // Both `store: contract` and `store: attachment` derive the same
    // min_length predicate — same intent, same mechanism.
    preds.push({ kind: 'min_length', min: spec.min_chars });
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
  for (const rawCheck of spec.checks ?? []) {
    // Normalize plain-string checks (e.g. "pnpm typecheck") to the object form
    // { command: string }. At runtime, callers may pass strings even though the
    // type declares RepoCheck[]; accepting them avoids a 500 on
    // guessable-but-wrong input (pc-pty-chat-279).
    const check: RepoCheck =
      typeof (rawCheck as unknown) === 'string'
        ? { command: rawCheck as unknown as string }
        : (rawCheck as RepoCheck);
    if ('preset' in check) {
      preds.push({
        kind: 'bash_exit_zero',
        command: `pnpm ${check.preset}`,
        cwd,
        timeout_ms: check.timeout_ms ?? REPO_CHECK_DEFAULT_TIMEOUT_MS,
      });
    } else {
      preds.push({
        kind: 'bash_exit_zero',
        command: check.command,
        cwd: check.cwd ?? cwd,
        timeout_ms: check.timeout_ms ?? REPO_CHECK_DEFAULT_TIMEOUT_MS,
      });
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
  // The ask tools leave a durable pending-ask row — assert that too, so an
  // agent that merely emits the tool_use frame without the side-effect landing
  // still fails. M7 (FD-6): ☠ pc_ask_user; the surviving ask doors
  // (pc_ask_orchestrator · pc_request_approval) both write pending_asks.
  if (/ask_orchestrator|request_approval/.test(spec.tool)) {
    preds.push({ kind: 'pending_ask_created' });
  }
  return preds;
}
