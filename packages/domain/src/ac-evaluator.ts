// Section 26 / slice 014a — acceptance-criteria evaluator. Walks an
// `AcceptanceCriteria` predicate list and reports pass/fail per predicate.
//
// 014a widens this to the v2 predicate union (`contract.ts`, a superset of the
// v1 set) and feeds it the run's tool-call stream + the contract report, so
// `action`/`external`/`payload`/`repo` contracts become verifiable instead of
// silently passing. v1 predicates evaluate byte-identically.
//
// The pure predicates evaluate against the in-memory `EvaluationContext`. The
// side-effecting predicates (files_exist, bash_exit_zero, git_diff_nonempty)
// consult the caller-supplied `PredicateExecutors` — this keeps `@pc/domain`
// free of `node:fs` / `child_process` so the library stays zero-dep +
// browser-loadable.

import type {
  AcceptanceCriteria,
  AcceptancePredicate,
  AcceptancePredicateKind,
  JsonSchema,
} from './contract.ts';
import type { WorkItemStatus } from './work-item.ts';

export interface EvaluationContext {
  body: string;
  fields: Record<string, unknown>;
  /** Attachments on the work item. `content` is optional because some callers
   *  (e.g. UI previews) may not carry the full payload; when omitted,
   *  attachment content is simply absent from `body_contains` searches. */
  attachments: ReadonlyArray<{ name: string; content?: string }>;
  childWorkItems: ReadonlyArray<{ status: WorkItemStatus }>;
  // ── v2 additions (014a). Optional with documented defaults so existing
  //    construction sites stay valid until callers are updated. ──
  /** The contract's free-text report to the orchestrator. Default ''. */
  report?: string;
  /** The submitted deliverable's inline text (answer.text / prose.text). Used
   *  by `report_contains` (which searches the DELIVERABLE corpus, not just the
   *  report) and `min_length` (which measures deliverable size). Default ''. */
  deliverableText?: string;
  /** Tool-call names from the producing run's transcript. Powers `tool_called`.
   *  Default []. */
  toolCalls?: ReadonlyArray<{ name: string }>;
  /** True when the run created a durable pending-ask (pc_ask_orchestrator /
   *  pc_request_approval). Powers `pending_ask_created`. Default false. */
  pendingAskCreated?: boolean;
  /** The captured payload deliverable's data. Validated by `schema_valid`. */
  payload?: unknown;
  /** The captured external deliverable's handle. Checked by
   *  `external_handle_present`. */
  externalHandle?: string | null;
}

export interface PredicateExecutors {
  /** Resolves the size of a worktree-relative path in bytes, or null if the
   *  path doesn't exist (or isn't a regular file). */
  fileSize: (relativePath: string) => Promise<number | null>;
  /** Runs the bash command in either the worktree or the project root and
   *  resolves the exit result. `timedOut` is true when the process was killed
   *  by the timeout rather than exiting naturally, so callers can report
   *  "timed out" instead of "exited 124" in failure messages. The optional
   *  `timeoutMs` overrides the executor's built-in default for this one call
   *  (used to apply per-predicate timeouts from `bash_exit_zero.timeout_ms`). */
  runBash: (
    command: string,
    cwd: 'worktree' | 'project',
    timeoutMs?: number,
  ) => Promise<{ exitCode: number; timedOut: boolean }>;
  /** True when the git tree has relevant changes vs its base.
   *
   *  For worktree dispatches (`cwd: 'worktree'`): returns true when the
   *  worktree branch has committed changes vs the provisioning base branch —
   *  working-tree dirtiness is intentionally ignored so a clean commit passes.
   *  This is the fix for pc-pty-chat-207: a coder agent that commits cleanly
   *  and leaves a clean working tree must NOT false-fail the predicate.
   *
   *  For in-place dispatches (`cwd: 'project'`): falls back to checking
   *  working-tree dirtiness (committed-only detection requires a stored
   *  pre-dispatch HEAD, deferred).
   *
   *  Powers `git_diff_nonempty`. Optional — absent ⇒ the predicate fails with
   *  a clear "no git executor" reason. */
  hasGitDiff?: (cwd: 'worktree' | 'project') => Promise<boolean>;
}

export interface PredicateFailure {
  kind: AcceptancePredicateKind;
  reason: string;
}

export interface EvaluationResult {
  pass: boolean;
  failures: PredicateFailure[];
}

export async function evaluateAcceptance(
  criteria: AcceptanceCriteria,
  ctx: EvaluationContext,
  executors: PredicateExecutors,
): Promise<EvaluationResult> {
  const failures: PredicateFailure[] = [];
  for (const pred of criteria) {
    const res = await evaluatePredicate(pred, ctx, executors);
    if (!res.pass) {
      failures.push({ kind: pred.kind, reason: res.reason ?? 'predicate failed' });
    }
  }
  return { pass: failures.length === 0, failures };
}

export async function evaluatePredicate(
  pred: AcceptancePredicate,
  ctx: EvaluationContext,
  executors: PredicateExecutors,
): Promise<{ pass: boolean; reason?: string }> {
  switch (pred.kind) {
    case 'fields_populated':
      return evalFieldsPopulated(pred, ctx);
    case 'field_matches':
      return evalFieldMatches(pred, ctx);
    case 'body_contains':
      return evalBodyContains(pred, ctx);
    case 'attachments_present':
      return evalAttachmentsPresent(pred, ctx);
    case 'child_work_items_done':
      return evalChildrenDone(pred, ctx);
    case 'files_exist':
      return await evalFilesExist(pred, executors);
    case 'bash_exit_zero':
      return await evalBashExitZero(pred, executors);
    // ── v2 predicates (014a) ──
    case 'report_contains':
      return evalReportContains(pred, ctx);
    case 'tool_called':
      return evalToolCalled(pred, ctx);
    case 'pending_ask_created':
      return evalPendingAskCreated(ctx);
    case 'schema_valid':
      return evalSchemaValid(pred, ctx);
    case 'external_handle_present':
      return evalExternalHandlePresent(ctx);
    case 'git_diff_nonempty':
      return await evalGitDiffNonempty(pred, executors);
    case 'min_length':
      return evalMinLength(pred, ctx);
  }
}

// ── Pure predicates (v1) ────────────────────────────────────────────────────

function evalFieldsPopulated(
  pred: Extract<AcceptancePredicate, { kind: 'fields_populated' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  const missing: string[] = [];
  for (const key of pred.keys) {
    if (!isPopulated(ctx.fields[key])) missing.push(key);
  }
  if (missing.length === 0) return { pass: true };
  return { pass: false, reason: `missing or empty field(s): ${missing.join(', ')}` };
}

/** Mirrors the workflow runtime's done_when semantics: nullish, '', [], {}
 *  reject; `0` and `false` pass. */
function isPopulated(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

function evalFieldMatches(
  pred: Extract<AcceptancePredicate, { kind: 'field_matches' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  const raw = ctx.fields[pred.key];
  if (raw === undefined || raw === null) {
    return { pass: false, reason: `field ${pred.key} is missing` };
  }
  const value = String(raw);
  let re: RegExp;
  try {
    re = new RegExp(pred.pattern);
  } catch (err) {
    return {
      pass: false,
      reason: `invalid regex for field ${pred.key}: ${(err as Error).message}`,
    };
  }
  if (re.test(value)) return { pass: true };
  return { pass: false, reason: `field ${pred.key} does not match /${pred.pattern}/` };
}

function evalBodyContains(
  pred: Extract<AcceptancePredicate, { kind: 'body_contains' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  // Section 26 carry-over #2 (Option A) — `body_contains` searches both the
  // work-item body AND attachment contents. Agents commonly persist
  // non-trivial deliverables as attachments (researcher attaches
  // `findings.md`); requiring the predicate to match only `body` forced
  // duplicate writes. The pure substring/regex semantics are preserved; the
  // search corpus is just wider. Attachments with no `content` (UI previews
  // that didn't load the payload) are skipped.
  const corpus = collectSearchCorpus(ctx);
  return matchCorpus(corpus, pred.pattern, pred.regex, 'body or attachments');
}

/** Concatenates the work-item body + every attachment's content into a single
 *  string for `body_contains` searches. Attachments are separated by a marker
 *  so a pattern doesn't accidentally match across a body/attachment seam.
 *  Attachments with no `content` are skipped (treat as empty). */
function collectSearchCorpus(ctx: EvaluationContext): string {
  const parts: string[] = [ctx.body];
  for (const a of ctx.attachments) {
    if (typeof a.content === 'string' && a.content.length > 0) {
      parts.push(`\n--- attachment: ${a.name} ---\n${a.content}`);
    }
  }
  return parts.join('');
}

/** Shared substring/regex match used by `body_contains` + `report_contains`. */
function matchCorpus(
  corpus: string,
  pattern: string,
  regex: boolean | undefined,
  label: string,
): { pass: boolean; reason?: string } {
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      return { pass: false, reason: `invalid regex: ${(err as Error).message}` };
    }
    if (re.test(corpus)) return { pass: true };
    return { pass: false, reason: `${label} do not match /${pattern}/` };
  }
  // Non-regex path: normalize before substring matching —
  //   1. Remove whitespace around punctuation (so "a / b" matches "a/b").
  //   2. Collapse remaining whitespace runs to a single space.
  //   3. Lowercase.
  // This lets section-heading predicates like "Where 228/267/270 each land"
  // match documents that wrote "Where 228 / 267 / 270 each land"
  // (pc-pty-chat-277). Regex path is unaffected (callers that need exact
  // control use `regex: true`).
  const norm = (s: string): string =>
    s
      .replace(/\s*([^\w\s])\s*/g, '$1') // strip spaces around punctuation
      .replace(/\s+/g, ' ')              // collapse whitespace runs
      .toLowerCase();
  if (norm(corpus).includes(norm(pattern))) return { pass: true };
  return { pass: false, reason: `${label} do not contain "${pattern}"` };
}

function evalAttachmentsPresent(
  pred: Extract<AcceptancePredicate, { kind: 'attachments_present' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  const have = new Set(ctx.attachments.map((a) => a.name));
  const missing = pred.names.filter((n) => !have.has(n));
  if (missing.length === 0) return { pass: true };
  return { pass: false, reason: `missing attachment(s): ${missing.join(', ')}` };
}

function evalChildrenDone(
  pred: Extract<AcceptancePredicate, { kind: 'child_work_items_done' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  const total = ctx.childWorkItems.length;
  const done = ctx.childWorkItems.filter((c) => c.status === 'complete').length;
  if (pred.all !== false) {
    // `all` defaults to true when both flags omitted; explicit false flips the
    // semantics to "count satisfies if >= pred.count".
    if (total === 0) {
      return { pass: false, reason: 'no child work items present' };
    }
    if (done === total) return { pass: true };
    return { pass: false, reason: `${done}/${total} child work items complete` };
  }
  const need = pred.count ?? 0;
  if (done >= need) return { pass: true };
  return {
    pass: false,
    reason: `${done}/${total} children complete (need at least ${need})`,
  };
}

// ── v2 pure predicates (014a) ──────────────────────────────────────────────

/** Builds the deliverable corpus for `report_contains` and `min_length`:
 *  the contract report + the deliverable's inline text + every attachment's
 *  content. The work-item BODY is intentionally EXCLUDED — the body is the
 *  human brief, not the agent's output. */
function collectDeliverableCorpus(ctx: EvaluationContext): string {
  const parts: string[] = [ctx.report ?? ''];
  const dt = ctx.deliverableText ?? '';
  if (dt.length > 0) parts.push(dt);
  for (const a of ctx.attachments) {
    if (typeof a.content === 'string' && a.content.length > 0) {
      parts.push(`\n--- attachment: ${a.name} ---\n${a.content}`);
    }
  }
  return parts.join('');
}

function evalReportContains(
  pred: Extract<AcceptancePredicate, { kind: 'report_contains' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  // Searches the DELIVERABLE corpus (report + deliverableText + attachments),
  // not just the report string. A token in the submitted answer text or in an
  // attached document satisfies the predicate — the fix for the false-fail
  // where a complete deliverable with its summary in an attachment failed
  // `report_contains: 'summary'` (pc-pty-chat-265.1).
  const corpus = collectDeliverableCorpus(ctx);
  return matchCorpus(corpus, pred.pattern, pred.regex, 'deliverable');
}

function evalMinLength(
  pred: Extract<AcceptancePredicate, { kind: 'min_length' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  // Measures the deliverable content: deliverableText + attachment bodies.
  // The report is intentionally EXCLUDED — it is orchestrator-facing free text,
  // not part of the deliverable size (fix for min_chars-via-report false-fail,
  // pc-pty-chat-265.1).
  const dt = ctx.deliverableText ?? '';
  let total = dt.length;
  for (const a of ctx.attachments) {
    if (typeof a.content === 'string') total += a.content.length;
  }
  if (total >= pred.min) return { pass: true };
  return {
    pass: false,
    reason: `deliverable length ${total} < required ${pred.min}`,
  };
}

function evalToolCalled(
  pred: Extract<AcceptancePredicate, { kind: 'tool_called' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  const min = pred.min_count ?? 1;
  const count = (ctx.toolCalls ?? []).filter((t) => t.name === pred.name).length;
  if (count >= min) return { pass: true };
  return {
    pass: false,
    reason: `tool ${pred.name} called ${count}x (need ${min})`,
  };
}

function evalPendingAskCreated(ctx: EvaluationContext): { pass: boolean; reason?: string } {
  if (ctx.pendingAskCreated === true) return { pass: true };
  return { pass: false, reason: 'no pending ask was created' };
}

function evalExternalHandlePresent(ctx: EvaluationContext): { pass: boolean; reason?: string } {
  const h = ctx.externalHandle;
  if (typeof h === 'string' && h.length > 0) return { pass: true };
  return { pass: false, reason: 'no external handle present on the deliverable' };
}

function evalSchemaValid(
  pred: Extract<AcceptancePredicate, { kind: 'schema_valid' }>,
  ctx: EvaluationContext,
): { pass: boolean; reason?: string } {
  if (!('payload' in ctx) || ctx.payload === undefined) {
    return { pass: false, reason: 'no payload deliverable to validate' };
  }
  const errors = validateJsonSchema(ctx.payload, pred.schema, '$');
  if (errors.length === 0) return { pass: true };
  return { pass: false, reason: `payload schema invalid: ${errors.slice(0, 3).join('; ')}` };
}

// ── Side-effecting predicates ──────────────────────────────────────────────

async function evalFilesExist(
  pred: Extract<AcceptancePredicate, { kind: 'files_exist' }>,
  executors: PredicateExecutors,
): Promise<{ pass: boolean; reason?: string }> {
  const min = pred.min_size_bytes ?? 1;
  const failures: string[] = [];
  for (const path of pred.paths) {
    const size = await executors.fileSize(path);
    if (size === null) {
      failures.push(`${path} (missing)`);
    } else if (size < min) {
      failures.push(`${path} (${size}b < min ${min}b)`);
    }
  }
  if (failures.length === 0) return { pass: true };
  return { pass: false, reason: failures.join('; ') };
}

async function evalBashExitZero(
  pred: Extract<AcceptancePredicate, { kind: 'bash_exit_zero' }>,
  executors: PredicateExecutors,
): Promise<{ pass: boolean; reason?: string }> {
  const cwd = pred.cwd ?? 'worktree';
  const { exitCode, timedOut } = await executors.runBash(pred.command, cwd, pred.timeout_ms);
  if (exitCode === 0) return { pass: true };
  if (timedOut) {
    // Distinguish a SIGKILL timeout from a genuine non-zero exit so the
    // verification notes say "timed out" rather than "exited 124" — the
    // latter looks like a real test failure when it's actually just a
    // misconfigured timeout (pc-pty-chat-370).
    return { pass: false, reason: `bash command timed out: ${pred.command}` };
  }
  return {
    pass: false,
    reason: `bash command exited ${exitCode}: ${pred.command}`,
  };
}

async function evalGitDiffNonempty(
  pred: Extract<AcceptancePredicate, { kind: 'git_diff_nonempty' }>,
  executors: PredicateExecutors,
): Promise<{ pass: boolean; reason?: string }> {
  if (!executors.hasGitDiff) {
    return { pass: false, reason: 'no git executor available to check the diff' };
  }
  const has = await executors.hasGitDiff(pred.cwd ?? 'worktree');
  if (has) return { pass: true };
  return { pass: false, reason: 'git tree has no changes' };
}

// ── Minimal JsonSchema validator (zero-dep) ─────────────────────────────────
// Covers the `JsonSchema` subset declared in contract.ts: type, properties,
// items, required, enum. Returns a list of human-readable error paths; empty
// means valid.

function validateJsonSchema(value: unknown, schema: JsonSchema, path: string): string[] {
  const errs: string[] = [];
  if (!schema || typeof schema !== 'object') return errs;

  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((e) => deepEqual(e, value));
    if (!ok) errs.push(`${path} not in enum`);
  }

  if (schema.type) {
    if (!typeMatches(value, schema.type)) {
      errs.push(`${path} expected ${schema.type}`);
      return errs; // wrong base type — nested checks are meaningless
    }
  }

  if (schema.properties || schema.required || schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errs.push(`${path} expected object`);
      return errs;
    }
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errs.push(`${path}.${req} required`);
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in obj) errs.push(...validateJsonSchema(obj[k], sub, `${path}.${k}`));
    }
  }

  if (schema.items || schema.type === 'array') {
    if (!Array.isArray(value)) {
      errs.push(`${path} expected array`);
      return errs;
    }
    if (schema.items) {
      value.forEach((v, i) => errs.push(...validateJsonSchema(v, schema.items as JsonSchema, `${path}[${i}]`)));
    }
  }

  return errs;
}

function typeMatches(value: unknown, type: NonNullable<JsonSchema['type']>): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
