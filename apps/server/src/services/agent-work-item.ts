// Section 26.3 — Service helper for `pc_create_agent_work_item`.
//
// Resolves the pod's default `expected_output` if the caller didn't override,
// derives the tier-1 AC predicate list from `expected_output`, applies the
// raw-AC escape hatch if supplied, and persists via `WorkItemService.create`.
// Stage defaults to the project's first stage when the caller omits one — the
// kanban hides agent work items by default anyway (Section 26.7), so stage
// choice is mostly bookkeeping at v1.
//
// Validation is loud: malformed `expected_output` / `raw_acceptance_criteria`
// throw `AgentWorkItemInputError` so the route can map to HTTP 400 with a clean
// message. The pod-name lookup is a hard requirement — passing a name the
// project can't dispatch returns 400 (orchestrator chose wrong), NOT silently
// no-default falling through.

import type {
  AcceptancePredicate,
  AcceptancePredicateKind,
  ExpectedOutput,
  Project,
  ULID,
  VerificationTier,
  WorkItem,
} from '@pc/domain';
import {
  ACCEPTANCE_PREDICATE_KINDS,
  EXPECTED_OUTPUT_KINDS,
  VERIFICATION_TIERS,
  deriveAcceptanceCriteriaV2,
  getPodDefaultExpectedOutput,
} from '@pc/domain';
import type { ContractService } from '@pc/app-services';
import type { ULID as DomainULID } from '@pc/domain';
import type { WorkItemService } from './work-item.ts';

export interface CreateAgentWorkItemInput {
  title: string;
  task: string;
  pod: string;
  expectedOutput?: ExpectedOutput;
  verificationTier?: VerificationTier;
  parentWorkItemId?: ULID | null;
  stageId?: string;
  worktree?: string | null;
  /** Override the derived AC entirely. Audit-logged inside the work-item
   *  history at create time so downstream tooling can spot raw-AC patterns. */
  rawAcceptanceCriteria?: AcceptancePredicate[];
}

export interface CreateAgentWorkItemDeps {
  workItemService: WorkItemService;
  getProject: () => Project;
  /** When supplied, a first-class `agent_contracts` row is created alongside
   *  the WI and linked to it (work-log + the verification spine). The contract
   *  is the authority for verification; the WI is the optional output home.
   *  Omitting this creates the WI only (tests that don't care about a contract). */
  contractService?: ContractService;
  /** Optional: look up the pod row's expected_output by name (project-scope
   *  first). When set, consulted between caller-supplied expectedOutput and
   *  the stock map. Added for Issue #3 — agents.expected_output column.
   *  Tests omit it; the stock-map fallback still works without it. */
  getPodRowExpectedOutput?: (podName: string) => ExpectedOutput | null | undefined;
}

export class AgentWorkItemInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentWorkItemInputError';
  }
}

/** Create a work item carrying the agent's task as its body, and (when a
 *  contractService is supplied) mint the first-class contract linked to it.
 *  The contract is the verification spine; the WI is the optional output home.
 *  Returns the newly-created `WorkItem`. */
export function createAgentWorkItem(
  input: CreateAgentWorkItemInput,
  deps: CreateAgentWorkItemDeps,
): WorkItem {
  const title = input.title?.trim() ?? '';
  if (!title) throw new AgentWorkItemInputError('title required');
  const task = input.task?.trim() ?? '';
  if (!task) throw new AgentWorkItemInputError('task required');
  const pod = input.pod?.trim() ?? '';
  if (!pod) throw new AgentWorkItemInputError('pod required');

  // Verification tier validation — default 'auto'.
  const tier: VerificationTier = input.verificationTier ?? 'auto';
  if (!VERIFICATION_TIERS.includes(tier)) {
    throw new AgentWorkItemInputError(
      `verification_tier must be one of: ${VERIFICATION_TIERS.join(', ')}`,
    );
  }

  // Resolve expected_output (v2 contract union): caller-supplied wins; pod row
  // (DB) second; stock map third; hard-fail when all three are absent.
  let expectedOutput: ExpectedOutput | null;
  if (input.expectedOutput !== undefined) {
    assertExpectedOutputShape(input.expectedOutput);
    expectedOutput = input.expectedOutput;
  } else {
    // Pod-row lookup (project-scope first, injected by callers with DB access).
    const rowOutput = deps.getPodRowExpectedOutput?.(pod);
    if (rowOutput != null) {
      assertExpectedOutputShape(rowOutput);
      expectedOutput = rowOutput;
    } else {
      const def = getPodDefaultExpectedOutput(pod);
      expectedOutput = def ?? null;
    }
  }
  if (expectedOutput === null) {
    throw new AgentWorkItemInputError(
      `pod "${pod}" has no default expected_output — pass expected_output explicitly`,
    );
  }

  // Derive AC from the v2 spec, then apply the raw override if supplied.
  let acceptanceCriteria: AcceptancePredicate[] = deriveAcceptanceCriteriaV2(expectedOutput);
  if (input.rawAcceptanceCriteria !== undefined) {
    assertAcceptanceCriteriaShape(input.rawAcceptanceCriteria);
    acceptanceCriteria = input.rawAcceptanceCriteria;
  }

  // Stage: caller-supplied or fall back to the project's first stage. Throws
  // a generic `unknown stage` from the service layer if invalid.
  const project = deps.getProject();
  const stages = (project.stages ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const stageId = input.stageId?.trim() || stages[0]?.id;
  if (!stageId) {
    throw new AgentWorkItemInputError(
      `project has no stages — agent work item needs a stage to land in`,
    );
  }

  const workItem = deps.workItemService.create({
    title,
    stageId,
    body: task,
    ...(input.parentWorkItemId !== undefined ? { parentId: input.parentWorkItemId } : {}),
  });

  // Mint the first-class contract linked to the WI. The dispatch path
  // (agent-run-factory) resolves it back by work-item id; it owns verification
  // + the deliverable.
  if (deps.contractService) {
    deps.contractService.create({
      projectId: workItem.projectId as DomainULID,
      workItemId: workItem.id as DomainULID,
      podName: pod,
      expectedOutput,
      acceptanceCriteria,
      verificationTier: tier,
      worktreePath: input.worktree?.trim() || null,
    });
  }

  return workItem;
}

/** Allowed keys per v2 `ExpectedOutput.kind`. `kind` itself is always allowed.
 *  Strict unknown-field reject closes the orchestrator's smuggling channel
 *  (non-schema fields slipping past validation + dodging AC derivation). */
const ALLOWED_EXPECTED_OUTPUT_KEYS: Record<string, ReadonlySet<string>> = {
  answer: new Set(['kind', 'must_address', 'min_chars']),
  prose: new Set(['kind', 'doc_type', 'sections', 'min_chars', 'store', 'path']),
  payload: new Set(['kind', 'schema', 'semantic']),
  repo: new Set(['kind', 'isolation', 'paths_touched', 'checks', 'require_diff']),
  external: new Set(['kind', 'system', 'action', 'confirm', 'idempotency_key', 'verify_handle']),
  binary: new Set(['kind', 'artifact_type', 'mime', 'min_size_bytes']),
  action: new Set(['kind', 'tool', 'min_count', 'before_end_turn']),
};

/** Throws AgentWorkItemInputError if the shape doesn't look like a v2
 *  ExpectedOutput. Includes a strict unknown-field reject so callers can't
 *  smuggle task content via non-schema fields and silently dodge AC derivation. */
function assertExpectedOutputShape(value: unknown): asserts value is ExpectedOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentWorkItemInputError('expected_output must be an object');
  }
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !(EXPECTED_OUTPUT_KINDS as readonly string[]).includes(kind)) {
    throw new AgentWorkItemInputError(
      `expected_output.kind must be one of: ${EXPECTED_OUTPUT_KINDS.join(', ')}`,
    );
  }
  const v = value as Record<string, unknown>;
  const allowed = ALLOWED_EXPECTED_OUTPUT_KEYS[kind]!;
  const unknownKeys = Object.keys(v).filter((k) => !allowed.has(k));
  if (unknownKeys.length > 0) {
    throw new AgentWorkItemInputError(
      `expected_output (${kind}): unknown field${unknownKeys.length === 1 ? '' : 's'} ${unknownKeys
        .map((k) => `"${k}"`)
        .join(', ')}. Allowed: ${[...allowed].join(', ')}.`,
    );
  }
  switch (kind) {
    case 'payload':
      if (!v.schema || typeof v.schema !== 'object' || Array.isArray(v.schema)) {
        throw new AgentWorkItemInputError('expected_output (payload): schema must be an object');
      }
      break;
    case 'repo':
      if (v.isolation !== 'worktree' && v.isolation !== 'in_place') {
        throw new AgentWorkItemInputError(
          'expected_output (repo): isolation must be "worktree" or "in_place"',
        );
      }
      break;
    case 'external':
      if (typeof v.system !== 'string' || v.system.trim() === '') {
        throw new AgentWorkItemInputError('expected_output (external): system must be a non-empty string');
      }
      if (typeof v.action !== 'string' || v.action.trim() === '') {
        throw new AgentWorkItemInputError('expected_output (external): action must be a non-empty string');
      }
      if (typeof v.idempotency_key !== 'string' || v.idempotency_key.trim() === '') {
        throw new AgentWorkItemInputError(
          'expected_output (external): idempotency_key must be a non-empty string',
        );
      }
      break;
    case 'action':
      if (typeof v.tool !== 'string' || v.tool.trim() === '') {
        throw new AgentWorkItemInputError('expected_output (action): tool must be a non-empty string');
      }
      break;
    case 'answer':
    case 'prose':
    case 'binary':
      // No required nested fields; the unknown-key reject above closes the
      // smuggling channel.
      break;
  }
}

/** Validate every entry in a raw AC list. Beyond `kind`, each predicate must
 *  carry the fields the evaluator reads — the evaluator assumes they exist
 *  and crashes with TypeErrors otherwise. Section 22.6 — stabilization fix:
 *  previously this validated only `kind`, so a malformed predicate (`{ kind:
 *  'files_exist' }` with no `paths`) would persist and then explode at
 *  verification time. The handoff also called out that `bash_exit_zero`
 *  predicates run real shell commands — flagged here as well.
 *
 *  This validator catches structural problems at persistence time and
 *  surfaces clear per-predicate error messages so the orchestrator can fix
 *  the call. */
function assertAcceptanceCriteriaShape(
  value: unknown,
): asserts value is AcceptancePredicate[] {
  if (!Array.isArray(value)) {
    throw new AgentWorkItemInputError('raw_acceptance_criteria must be an array');
  }
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    const path = `raw_acceptance_criteria[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AgentWorkItemInputError(`${path}: predicate must be an object`);
    }
    const k = (entry as { kind?: unknown }).kind;
    if (
      typeof k !== 'string' ||
      !(ACCEPTANCE_PREDICATE_KINDS as readonly string[]).includes(k)
    ) {
      throw new AgentWorkItemInputError(
        `${path}.kind must be one of: ${ACCEPTANCE_PREDICATE_KINDS.join(', ')}`,
      );
    }
    assertPredicateFields(entry as Record<string, unknown>, k as AcceptancePredicateKind, path);
  }
}

/** Per-kind structural validation. Throws on missing or wrong-typed fields. */
function assertPredicateFields(
  pred: Record<string, unknown>,
  kind: AcceptancePredicateKind,
  path: string,
): void {
  switch (kind) {
    case 'files_exist': {
      assertStringArray(pred.paths, `${path}.paths`);
      if (pred.min_size_bytes !== undefined) {
        if (typeof pred.min_size_bytes !== 'number' || !Number.isFinite(pred.min_size_bytes)) {
          throw new AgentWorkItemInputError(`${path}.min_size_bytes must be a finite number`);
        }
      }
      return;
    }
    case 'fields_populated': {
      assertStringArray(pred.keys, `${path}.keys`);
      return;
    }
    case 'field_matches': {
      assertNonEmptyString(pred.key, `${path}.key`);
      assertNonEmptyString(pred.pattern, `${path}.pattern`);
      return;
    }
    case 'bash_exit_zero': {
      // Note: `bash_exit_zero` runs the supplied string through a real shell
      // at verification time (see services/agent-verification.ts). Treat this
      // as a deliberate local-shell execution surface — the orchestrator must
      // own the contents of `command`.
      assertNonEmptyString(pred.command, `${path}.command`);
      if (pred.cwd !== undefined && pred.cwd !== 'worktree' && pred.cwd !== 'project') {
        throw new AgentWorkItemInputError(
          `${path}.cwd must be "worktree" or "project" (got ${JSON.stringify(pred.cwd)})`,
        );
      }
      return;
    }
    case 'attachments_present': {
      assertStringArray(pred.names, `${path}.names`);
      return;
    }
    case 'body_contains': {
      assertNonEmptyString(pred.pattern, `${path}.pattern`);
      if (pred.regex !== undefined && typeof pred.regex !== 'boolean') {
        throw new AgentWorkItemInputError(`${path}.regex must be a boolean`);
      }
      return;
    }
    case 'child_work_items_done': {
      if (pred.count !== undefined) {
        if (
          typeof pred.count !== 'number' ||
          !Number.isInteger(pred.count) ||
          pred.count < 0
        ) {
          throw new AgentWorkItemInputError(`${path}.count must be a non-negative integer`);
        }
      }
      if (pred.all !== undefined && typeof pred.all !== 'boolean') {
        throw new AgentWorkItemInputError(`${path}.all must be a boolean`);
      }
      return;
    }
  }
}

function assertNonEmptyString(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentWorkItemInputError(`${path} must be a non-empty string`);
  }
}

function assertStringArray(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AgentWorkItemInputError(`${path} must be a non-empty string[]`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string' || value[i]!.length === 0) {
      throw new AgentWorkItemInputError(`${path}[${i}] must be a non-empty string`);
    }
  }
}
