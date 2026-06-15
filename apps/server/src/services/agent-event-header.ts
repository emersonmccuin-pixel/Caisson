// Section 16b — Header tag for agent→orchestrator channel messages.
// Prepended to every
// channel POST body originating from the agent runtime so the orchestrator
// can recognise the message kind via a stable token instead of matching
// prose phrasing.
//
// Shape: `[pc:agent-event kind=<kind> version=<n>]`
//
// Kinds enumerated in `@pc/domain` as `AgentChannelEventKind`.

import type {
  AgentChannelEventKind,
  AgentFailedPayload,
  VerificationStatus,
  VerificationTier,
} from '@pc/domain';

/** Slice D — render shape for a work item's done-checklist block. Derived from
 *  `DoneChecklistItem[]` by the caller so this module has no DB dependency.
 *  Omit / pass null to suppress the block entirely (no-checklist-set case and
 *  the replay path). */
export interface DoneChecklistBlock {
  total: number;
  open: number;
  items: Array<{ label: string; done: boolean }>;
}

function appendDoneChecklistTags(lines: string[], checklist: DoneChecklistBlock): void {
  lines.push(`[done-checklist: ${checklist.open} of ${checklist.total} open]`);
  for (const item of checklist.items) {
    lines.push(`  [${item.done ? 'x' : ' '}] ${item.label}`);
  }
}

/** Section 26.5 / slice 020 — verification block carried on terminal envelopes.
 *  Keyed on the CONTRACT id; carries the linked work item id only when one
 *  exists (a contract-only dispatch leaves `workItemId` null). */
export interface VerificationBlock {
  contractId: string;
  /** The contract's linked work item, when one exists. */
  workItemId: string | null;
  status: VerificationStatus;
  tier: VerificationTier;
  /** Human-readable predicate-failure summary; null when the contract flipped
   *  to a passing or pending state. Truncated to 400 chars to keep the
   *  envelope human-readable. */
  notes: string | null;
}

function appendVerificationTags(lines: string[], v: VerificationBlock): void {
  lines.push(`[contractId: ${v.contractId}]`);
  if (v.workItemId) lines.push(`[workItemId: ${v.workItemId}]`);
  lines.push(`[verification: ${v.status}]`);
  lines.push(`[verificationTier: ${v.tier}]`);
  if (v.notes) {
    const truncated = v.notes.length > 400 ? `${v.notes.slice(0, 400)}…` : v.notes;
    lines.push(`[verificationNotes: ${truncated}]`);
  }
}

export function buildAgentEventHeader(kind: AgentChannelEventKind, version = 1): string {
  return `[pc:agent-event kind=${kind} version=${version}]`;
}

/** Compose the channel-event body the orchestrator's pod prompt parses for
 *  `agent-completed` (handler protocol entry #4). Surfaces a background-
 *  dispatched agent's terminal result back to the caller as a `<channel>`
 *  block so the orchestrator can start a new turn surfacing it to the user
 *  with the right context. */
export function buildAgentCompletedBody(args: {
  runId: string;
  sessionId: string;
  agentName: string;
  parentWorkItemId: string | null;
  result: string;
  /** Slice 3 — incidental free-text turn result demoted to a secondary note
   *  when the contract carries an authoritative submitted deliverable. Rendered
   *  after the Result: section so the deliverable is always the headline. */
  note?: string | null;
  /** Section 26.5 — appended when the dispatch was a contract dispatch. The
   *  tags let the orchestrator's pod prompt branch on verification outcome
   *  without re-fetching the work item. */
  verification?: VerificationBlock | null;
  /** Slice D — open done-checklist for the parent work item. Omitted when the
   *  card has no checklist, or on the replay path (pass null explicitly). When
   *  null / absent the block is entirely suppressed — output is byte-identical
   *  to before this slice. */
  doneChecklist?: DoneChecklistBlock | null;
}): string {
  const lines: string[] = [
    buildAgentEventHeader('agent-completed'),
    `[runId: ${args.runId}]`,
    `[sessionId: ${args.sessionId}]`,
    `[agentName: ${args.agentName}]`,
  ];
  if (args.parentWorkItemId) lines.push(`[parentWorkItemId: ${args.parentWorkItemId}]`);
  if (args.verification) appendVerificationTags(lines, args.verification);
  if (args.doneChecklist) appendDoneChecklistTags(lines, args.doneChecklist);
  lines.push('');
  lines.push('Result:');
  lines.push(args.result || '(no output)');
  lines.push('');
  if (args.note) {
    lines.push('Note:');
    lines.push(args.note);
    lines.push('');
  }
  if (args.verification) {
    lines.push(describeVerificationForPrompt(args.agentName, args.verification));
  } else {
    lines.push(
      `The ${args.agentName} agent you dispatched earlier finished. Start a new turn surfacing this result to the user with enough context for them to remember what they asked.`,
    );
  }
  return lines.join('\n');
}

function describeVerificationForPrompt(agentName: string, v: VerificationBlock): string {
  const wiSuffix = v.workItemId ? ` (rolled up to work item ${v.workItemId})` : '';
  switch (v.status) {
    case 'passed':
      return `The ${agentName} agent finished and its contract ${v.contractId} was accepted (tier-1 verification passed)${wiSuffix}. Start a new turn surfacing the result to the user.`;
    case 'failed':
      return `The ${agentName} agent finished BUT tier-1 verification failed on contract ${v.contractId}. Surface the failure to the user; review the predicate failures (verificationNotes tag) and decide whether to retry / fix / drop.`;
    case 'pending':
      return `The ${agentName} agent finished and contract ${v.contractId} is awaiting ${v.tier} verification. Read the contract's deliverable, decide whether it was met, then call pc_resolve_work_item with decision "approve" or "reject".`;
  }
}

/** Section 18.7 — compose the channel-event body for `agent-queued-started`.
 *  Fires when a dispatch that was previously queued (because the global
 *  concurrent cap was full) actually starts. Lets the orchestrator update
 *  its mental model — "the agent you queued earlier is now running" — so
 *  the user doesn't think the dispatch was lost. The terminal event (
 *  `agent-completed` / `agent-failed`) still lands separately when the
 *  spawned run finishes. */
export function buildAgentQueuedStartedBody(args: {
  runId: string;
  sessionId: string;
  agentName: string;
  parentWorkItemId: string | null;
  queuedAt: number;
  startedAt: number;
}): string {
  const waitedMs = Math.max(0, args.startedAt - args.queuedAt);
  const waitedSec = Math.round(waitedMs / 1000);
  const lines: string[] = [
    buildAgentEventHeader('agent-queued-started'),
    `[runId: ${args.runId}]`,
    `[sessionId: ${args.sessionId}]`,
    `[agentName: ${args.agentName}]`,
    `[queuedAt: ${args.queuedAt}]`,
    `[startedAt: ${args.startedAt}]`,
    `[waitedMs: ${waitedMs}]`,
  ];
  if (args.parentWorkItemId) lines.push(`[parentWorkItemId: ${args.parentWorkItemId}]`);
  lines.push('');
  lines.push(
    `The ${args.agentName} agent you queued earlier just started (waited ~${waitedSec}s in the dispatch queue). You'll see its terminal event when it finishes.`,
  );
  return lines.join('\n');
}

/** Compose the channel-event body for `agent-failed` (handler protocol
 *  entry #5). Same shape as `agent-completed` but with a failure summary
 *  + structured cause so the orchestrator can suggest a next step (retry
 *  / drop / hand-write). */
export function buildAgentFailedBody(args: {
  runId: string;
  sessionId: string;
  agentName: string;
  parentWorkItemId: string | null;
  reason: string;
  cause: AgentFailedPayload['cause'];
  /** Section 26.5 — appended when the dispatch was a contract dispatch.
   *  Always carries `status: 'failed'` on the agent-failed path (the
   *  verification helper flips the WI to failed without running predicates
   *  when the agent died before reporting done). */
  verification?: VerificationBlock | null;
  /** Slice D — same as the completed-body param; a failed run does not erase
   *  the card's open done-conditions. Null / absent = block suppressed. */
  doneChecklist?: DoneChecklistBlock | null;
}): string {
  const lines: string[] = [
    buildAgentEventHeader('agent-failed'),
    `[runId: ${args.runId}]`,
    `[sessionId: ${args.sessionId}]`,
    `[agentName: ${args.agentName}]`,
    `[cause: ${args.cause ?? 'error'}]`,
  ];
  if (args.parentWorkItemId) lines.push(`[parentWorkItemId: ${args.parentWorkItemId}]`);
  if (args.verification) appendVerificationTags(lines, args.verification);
  if (args.doneChecklist) appendDoneChecklistTags(lines, args.doneChecklist);
  lines.push('');
  lines.push('Failure:');
  lines.push(args.reason || '(no reason recorded)');
  lines.push('');
  if (args.verification) {
    lines.push(
      `The ${args.agentName} agent failed AND its contract ${args.verification.contractId} was rejected. Surface this to the user with a one-line summary + a suggested next step (retry / drop / hand-write).`,
    );
  } else {
    lines.push(
      `The ${args.agentName} agent you dispatched earlier failed. Surface this to the user with a one-line summary + a suggested next step (retry / drop / hand-write).`,
    );
  }
  return lines.join('\n');
}
