// Review Modal — shared full-size modal for verification-review and workflow-review inbox cards.
// Launched from MailboxInboxRow's "Review" button in BOTH the InboxBell popover and
// the ActivityPanel MailboxInbox. Explicit close only — no backdrop or Escape dismissal
// (the reject form hosts typed feedback; an accidental dismiss destroys it).
// Per feedback_modals_explicit_close_only.

import { useEffect, useState } from 'react';

import { Markdown } from '@/components/Markdown';
import { contractsApi } from '@/features/contracts/client';
import {
  describeDeliverable,
  summarizeExpectedOutput,
} from '@/features/contracts/work-log';
import type { Contract } from '@/features/contracts/client';
import type { AcceptanceCriteria, AcceptancePredicate } from '@pc/contracts';
import { mailboxApi } from './client';
import type { MailboxInboxItem } from './types';

// ── Payload shapes (defensive reads everywhere) ───────────────────────────────

interface VerificationPayload {
  contractId: string;
  workItemId: string | null;
  workItemTitle: string | null;
  runId: string;
  agent: string;
}

interface WorkflowBundleItem {
  nodeId: string;
  output: string;
}

interface WorkflowPayload {
  runId: string;
  nodeId: string;
  workflowName: string;
  workItemId: string | null;
  prompt: string;
  summary: string;
  bundle?: WorkflowBundleItem[];
  escalated: boolean;
  iteration: number;
}

function parseVerificationPayload(p: unknown): VerificationPayload | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (typeof o.contractId !== 'string') return null;
  return {
    contractId: o.contractId,
    workItemId: typeof o.workItemId === 'string' ? o.workItemId : null,
    workItemTitle: typeof o.workItemTitle === 'string' ? o.workItemTitle : null,
    runId: typeof o.runId === 'string' ? o.runId : '',
    agent: typeof o.agent === 'string' ? o.agent : 'agent',
  };
}

function parseWorkflowPayload(p: unknown): WorkflowPayload | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (typeof o.runId !== 'string' || typeof o.nodeId !== 'string') return null;
  const bundle = Array.isArray(o.bundle)
    ? (o.bundle as unknown[]).filter(
        (b): b is WorkflowBundleItem =>
          !!b &&
          typeof b === 'object' &&
          typeof (b as Record<string, unknown>).nodeId === 'string' &&
          typeof (b as Record<string, unknown>).output === 'string',
      )
    : undefined;
  return {
    runId: o.runId,
    nodeId: o.nodeId,
    workflowName: typeof o.workflowName === 'string' ? o.workflowName : 'Workflow',
    workItemId: typeof o.workItemId === 'string' ? o.workItemId : null,
    prompt: typeof o.prompt === 'string' ? o.prompt : '',
    summary: typeof o.summary === 'string' ? o.summary : '',
    bundle,
    escalated: o.escalated === true,
    iteration: typeof o.iteration === 'number' ? o.iteration : 1,
  };
}

// ── Public component ──────────────────────────────────────────────────────────

export interface ReviewModalProps {
  item: MailboxInboxItem;
  projectName: string | null;
  projectId: string;
  onClose: () => void;
  /** Fired after a decision so the caller can refetch the inbox list. */
  onDecided: () => void;
}

export function ReviewModal({
  item,
  projectName,
  projectId,
  onClose,
  onDecided,
}: ReviewModalProps) {
  const { message } = item;

  if (message.kind === 'verification-review') {
    const vp = parseVerificationPayload(message.payload);
    if (!vp) {
      return (
        <ModalShell onClose={onClose} title="Review" projectName={projectName}>
          <div className="px-6 py-4 text-sm text-destructive">
            Malformed verification-review payload.
          </div>
        </ModalShell>
      );
    }
    return (
      <VerificationReviewModal
        payload={vp}
        message={message}
        projectName={projectName}
        projectId={projectId}
        onClose={onClose}
        onDecided={onDecided}
      />
    );
  }

  if (message.kind === 'workflow-review') {
    const wp = parseWorkflowPayload(message.payload);
    if (!wp) {
      return (
        <ModalShell onClose={onClose} title="Review" projectName={projectName}>
          <div className="px-6 py-4 text-sm text-destructive">
            Malformed workflow-review payload.
          </div>
        </ModalShell>
      );
    }
    return (
      <WorkflowReviewModal
        payload={wp}
        projectName={projectName}
        projectId={projectId}
        onClose={onClose}
        onDecided={onDecided}
      />
    );
  }

  return null;
}

// ── Shared modal shell ────────────────────────────────────────────────────────

function ModalShell({
  onClose,
  title,
  projectName,
  badge,
  children,
  footer,
}: {
  onClose: () => void;
  title: string;
  projectName: string | null;
  badge?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  // No Escape dismissal and no backdrop-click — per feedback_modals_explicit_close_only.
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal
    >
      <div className="flex h-full max-h-[88vh] w-full max-w-3xl flex-col border border-border bg-card text-foreground shadow-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {title}
          </span>
          {projectName && (
            <span className="shrink-0 bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
              {projectName}
            </span>
          )}
          {badge}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close review"
            className="ml-1 shrink-0 border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:bg-muted"
          >
            Close
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-border bg-muted/20 px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}

// ── Verification-review modal ─────────────────────────────────────────────────

function VerificationReviewModal({
  payload,
  message,
  projectName,
  projectId,
  onClose,
  onDecided,
}: {
  payload: VerificationPayload;
  message: MailboxInboxItem['message'];
  projectName: string | null;
  projectId: string;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    contractsApi
      .getContract(payload.contractId)
      .then((c) => {
        if (!cancelled) { setContract(c); setLoading(false); }
      })
      .catch((err: Error) => {
        if (!cancelled) { setLoadError(err.message); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [payload.contractId]);

  const title = payload.workItemTitle
    ? `Review — ${payload.agent}: ${payload.workItemTitle}`
    : `Review — ${payload.agent}`;

  const isPending = contract?.verificationStatus === 'pending';

  return (
    <ModalShell
      onClose={onClose}
      title={title}
      projectName={projectName}
      footer={
        !loading && contract ? (
          isPending ? (
            <VerificationDecisionFooter
              projectId={projectId}
              workItemId={payload.workItemId}
              onDecided={() => { onDecided(); setTimeout(onClose, 1400); }}
            />
          ) : (
            <AlreadyDecidedBanner status={contract.verificationStatus} />
          )
        ) : undefined
      }
    >
      {loading && (
        <div className="px-6 py-8 text-sm text-muted-foreground">
          Loading review package...
        </div>
      )}
      {loadError && (
        <div className="px-6 py-4 text-sm text-destructive">
          Could not load contract: {loadError}
        </div>
      )}
      {contract && (
        <VerificationReviewBody payload={payload} contract={contract} message={message} />
      )}
    </ModalShell>
  );
}

function AlreadyDecidedBanner({ status }: { status: string | null }) {
  const passed = status === 'passed';
  return (
    <div
      className={`px-3 py-2 text-sm font-medium ${
        passed ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
      }`}
    >
      {passed ? 'Already approved.' : 'Already rejected / failed.'}
    </div>
  );
}

function VerificationReviewBody({
  payload,
  contract,
}: {
  payload: VerificationPayload;
  contract: Contract;
  message: MailboxInboxItem['message'];
}) {
  const deliverable = describeDeliverable(contract.deliverable);
  const asked = summarizeExpectedOutput(contract.expectedOutput);
  const finishedAt = new Date(contract.updatedAt).toLocaleString();

  return (
    <div className="divide-y divide-border/40">
      {/* Header strip */}
      <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-6 py-4 text-xs">
        <span className="text-muted-foreground">Agent</span>
        <span className="font-medium text-foreground">{payload.agent}</span>
        <span className="text-muted-foreground">Contract</span>
        <span className="font-mono text-[11px] text-muted-foreground/80">{contract.id}</span>
        <span className="text-muted-foreground">Finished</span>
        <span className="text-foreground">{finishedAt}</span>
        <span className="text-muted-foreground">Status</span>
        <span className="text-foreground">{contract.status}</span>
        {payload.workItemId && (
          <>
            <span className="text-muted-foreground">Card</span>
            <span className="font-mono text-[11px] text-muted-foreground/80">
              {payload.workItemId}
            </span>
          </>
        )}
      </div>

      {/* What was asked */}
      <section className="px-6 py-4">
        <SectionHeading>What was asked</SectionHeading>
        <div className="mb-2 text-xs text-muted-foreground">
          Expected output: <span className="text-foreground">{asked}</span>
        </div>
        {contract.acceptanceCriteria && contract.acceptanceCriteria.length > 0 && (
          <AcceptanceCriteriaList criteria={contract.acceptanceCriteria} />
        )}
      </section>

      {/* What was delivered */}
      <section className="px-6 py-4">
        <SectionHeading>What was delivered</SectionHeading>
        <DeliverableSection deliverable={deliverable} contract={contract} />
      </section>

      {/* Agent report */}
      {contract.report && (
        <section className="px-6 py-4">
          <SectionHeading>Agent report</SectionHeading>
          <Markdown text={contract.report} className="text-sm" />
        </section>
      )}

      {/* Verification notes */}
      {contract.verificationNotes && (
        <section className="px-6 py-4">
          <SectionHeading>Verification notes</SectionHeading>
          <div className="text-sm text-muted-foreground">{contract.verificationNotes}</div>
        </section>
      )}
    </div>
  );
}

function DeliverableSection({
  deliverable,
  contract,
}: {
  deliverable: ReturnType<typeof describeDeliverable>;
  contract: Contract;
}) {
  if (deliverable.kind === 'none') {
    return <div className="text-sm text-muted-foreground">{deliverable.detail}</div>;
  }

  // answer / prose: render inline text as Markdown
  if (
    (deliverable.kind === 'answer' || deliverable.kind === 'prose') &&
    contract.deliverable &&
    (contract.deliverable.kind === 'answer' || contract.deliverable.kind === 'prose')
  ) {
    const text =
      contract.deliverable.kind === 'answer'
        ? contract.deliverable.text
        : (contract.deliverable.text ?? null);
    if (text) return <Markdown text={text} className="text-sm" />;
  }

  // payload: pretty-print JSON
  if (deliverable.kind === 'payload' && contract.deliverable?.kind === 'payload') {
    const json = (() => {
      try { return JSON.stringify(contract.deliverable.data, null, 2); }
      catch { return String(contract.deliverable.data); }
    })();
    return (
      <pre className="overflow-x-auto border border-border/40 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-foreground">
        {json}
      </pre>
    );
  }

  // repo / external / binary / action: chip + text + optional link
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {deliverable.label}
        </span>
        {deliverable.href ? (
          <a
            href={deliverable.href}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 break-all text-primary hover:underline"
          >
            {deliverable.detail}
          </a>
        ) : (
          <span className="min-w-0 break-words text-foreground">{deliverable.detail}</span>
        )}
      </div>
      {deliverable.meta && (
        <span className="text-xs text-muted-foreground">{deliverable.meta}</span>
      )}
    </div>
  );
}

function AcceptanceCriteriaList({ criteria }: { criteria: AcceptanceCriteria }) {
  return (
    <div className="mt-1">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Acceptance criteria
      </div>
      <ul className="flex flex-col gap-0.5">
        {criteria.map((p, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs">
            <span className="mt-0.5 shrink-0 text-muted-foreground/60">·</span>
            <span className="text-foreground">{describeAcceptancePredicate(p)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function describeAcceptancePredicate(p: AcceptancePredicate): string {
  switch (p.kind) {
    case 'files_exist': return `Files exist: ${p.paths.join(', ')}`;
    case 'fields_populated': return `Fields populated: ${p.keys.join(', ')}`;
    case 'field_matches': return `Field "${p.key}" matches ${p.pattern}`;
    case 'bash_exit_zero': return `Shell exits 0: ${p.command}`;
    case 'attachments_present': return `Attachments present: ${p.names.join(', ')}`;
    case 'body_contains': return `Body contains: ${p.pattern}`;
    case 'child_work_items_done':
      return p.all ? 'All child items done' : `At least ${p.count ?? 1} child items done`;
    case 'schema_valid': return 'Payload matches JSON schema';
    case 'git_diff_nonempty': return 'Git diff is non-empty';
    case 'external_handle_present': return 'External handle present';
    case 'tool_called':
      return `Tool called: ${p.name}${p.min_count && p.min_count > 1 ? ` x${p.min_count}` : ''}`;
    case 'pending_ask_created': return 'Pending ask created';
    case 'report_contains': return `Report contains: ${p.pattern}`;
    default: return `Criterion: ${(p as { kind: string }).kind}`;
  }
}

// ── Verification decision footer ──────────────────────────────────────────────

function VerificationDecisionFooter({
  projectId,
  workItemId,
  onDecided,
}: {
  projectId: string;
  workItemId: string | null;
  onDecided: () => void;
}) {
  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!workItemId) {
    return (
      <div className="text-xs text-muted-foreground">
        No work item linked — decision not available from here.
      </div>
    );
  }

  if (decided) {
    return (
      <div
        className={`px-3 py-2 text-sm font-medium ${
          decided === 'approved' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
        }`}
      >
        {decided === 'approved'
          ? 'Approved — the run continues.'
          : 'Sent back with your feedback.'}
      </div>
    );
  }

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      const res =
        decision === 'approve'
          ? await mailboxApi.approveVerification(projectId, workItemId, note.trim() || undefined)
          : await mailboxApi.rejectVerification(projectId, workItemId, feedback.trim());
      if (!res.ok) throw new Error(res.error ?? 'decision failed');
      setDecided(decision === 'approve' ? 'approved' : 'rejected');
      onDecided();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {!showReject ? (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional approval note..."
            disabled={busy}
            className="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-xs"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide('approve')}
            className="shrink-0 bg-primary px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Approving...' : 'Approve'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setShowReject(true)}
            className="shrink-0 border border-destructive/60 bg-card px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Send back...
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            placeholder="What should change? (required — the agent gets this feedback)"
            disabled={busy}
            autoFocus
            className="border border-border bg-background px-2 py-1.5 text-xs"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !feedback.trim()}
              onClick={() => void decide('reject')}
              className="bg-destructive px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {busy ? 'Sending...' : 'Send back'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowReject(false)}
              className="border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <div className="text-xs text-destructive">Failed: {error}</div>}
    </div>
  );
}

// ── Workflow-review modal ─────────────────────────────────────────────────────

function WorkflowReviewModal({
  payload,
  projectName,
  projectId,
  onClose,
  onDecided,
}: {
  payload: WorkflowPayload;
  projectName: string | null;
  projectId: string;
  onClose: () => void;
  onDecided: () => void;
}) {
  const badge = (
    <span className="flex items-center gap-1.5">
      {payload.escalated && (
        <span className="bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive">
          Loop exhausted
        </span>
      )}
      <span className="bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
        iter {payload.iteration}
      </span>
    </span>
  );

  return (
    <ModalShell
      onClose={onClose}
      title={`Review — ${payload.workflowName}`}
      projectName={projectName}
      badge={badge}
      footer={
        <WorkflowDecisionFooter
          projectId={projectId}
          runId={payload.runId}
          nodeId={payload.nodeId}
          onDecided={() => { onDecided(); setTimeout(onClose, 1400); }}
        />
      }
    >
      <div className="divide-y divide-border/40">
        {/* Header strip */}
        <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-6 py-4 text-xs">
          <span className="text-muted-foreground">Workflow</span>
          <span className="font-medium text-foreground">{payload.workflowName}</span>
          <span className="text-muted-foreground">Gate node</span>
          <span className="font-mono text-[11px] text-muted-foreground/80">{payload.nodeId}</span>
          {payload.workItemId && (
            <>
              <span className="text-muted-foreground">Card</span>
              <span className="font-mono text-[11px] text-muted-foreground/80">
                {payload.workItemId}
              </span>
            </>
          )}
        </div>

        {/* Gate prompt */}
        {payload.prompt && (
          <section className="px-6 py-4">
            <SectionHeading>Gate prompt</SectionHeading>
            <Markdown text={payload.prompt} className="text-sm" />
          </section>
        )}

        {/* Step outputs — structured bundle preferred; flat summary as fallback */}
        <section className="px-6 py-4">
          <SectionHeading>Step outputs</SectionHeading>
          {payload.bundle && payload.bundle.length > 0 ? (
            <div className="flex flex-col gap-3 pt-1">
              {payload.bundle.map((step) => (
                <StepOutputSection key={step.nodeId} nodeId={step.nodeId} output={step.output} />
              ))}
            </div>
          ) : (
            <Markdown text={payload.summary} className="text-sm" />
          )}
        </section>
      </div>
    </ModalShell>
  );
}

function StepOutputSection({ nodeId, output }: { nodeId: string; output: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-border/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-[10px] text-muted-foreground/60">{open ? '▾' : '▸'}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {nodeId}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/30 px-3 py-3">
          <Markdown text={output} className="text-sm" />
        </div>
      )}
    </div>
  );
}

// ── Workflow decision footer ──────────────────────────────────────────────────

function WorkflowDecisionFooter({
  projectId,
  runId,
  nodeId,
  onDecided,
}: {
  projectId: string;
  runId: string;
  nodeId: string;
  onDecided: () => void;
}) {
  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (decided) {
    return (
      <div
        className={`px-3 py-2 text-sm font-medium ${
          decided === 'approved' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
        }`}
      >
        {decided === 'approved'
          ? 'Approved — the run continues.'
          : 'Sent back with your feedback.'}
      </div>
    );
  }

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      const res = await mailboxApi.decideWorkflowReview(
        projectId,
        runId,
        nodeId,
        decision,
        decision === 'reject' ? feedback.trim() : undefined,
      );
      if (!res.ok) throw new Error(res.error ?? 'decision failed');
      setDecided(decision === 'approve' ? 'approved' : 'rejected');
      onDecided();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {!showReject ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide('approve')}
            className="bg-primary px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Approving...' : 'Approve'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setShowReject(true)}
            className="border border-destructive/60 bg-card px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Send back...
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            placeholder="What should change? (required — the agent gets this feedback)"
            disabled={busy}
            autoFocus
            className="border border-border bg-background px-2 py-1.5 text-xs"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !feedback.trim()}
              onClick={() => void decide('reject')}
              className="bg-destructive px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {busy ? 'Sending...' : 'Send back'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowReject(false)}
              className="border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <div className="text-xs text-destructive">Failed: {error}</div>}
    </div>
  );
}

// ── Shared utility ────────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
