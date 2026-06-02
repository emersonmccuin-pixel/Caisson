// Slice 013 — the Work Log section of the work-item inspector.
//
// Read-only timeline of the contracts (agent assignments) that touched this work
// item: one row per contract — who ran it (pod / agent run), what it was asked to
// produce (expectedOutput summary), what it delivered (per-`deliverable.kind`
// renderer), and the verification badge. Live off `contract.changed` via the
// identity-keyed live store (useWorkItemContracts). No authoring/submit UI this
// slice (that's 014).

import type { Contract, VerificationStatus } from '@pc/contracts';

import { useWorkItemContracts } from '@/hooks/use-work-item-contracts';
import {
  describeDeliverable,
  summarizeExpectedOutput,
  type DeliverableView,
} from '@/features/contracts/work-log';

export function WorkLogSection({
  projectId,
  workItemId,
}: {
  projectId: string;
  workItemId: string;
}) {
  const { contracts, loading, error } = useWorkItemContracts(projectId, workItemId);

  if (error) {
    return (
      <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {error}
      </div>
    );
  }
  if (loading && contracts.length === 0) {
    return <div className="text-xs text-muted-foreground">Loading work log…</div>;
  }
  if (contracts.length === 0) {
    return (
      <div className="border border-dashed border-border/40 px-4 py-8 text-center text-xs text-muted-foreground">
        No agent contracts yet. When an agent is dispatched to work on this item,
        each assignment shows up here — what it was asked to produce and what it
        delivered.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {contracts.map((c) => (
        <ContractRow key={c.id} contract={c} />
      ))}
    </div>
  );
}

function ContractRow({ contract }: { contract: Contract }) {
  const who =
    contract.podName ??
    (contract.agentRunId ? `run ${shortId(contract.agentRunId)}` : 'agent');
  const asked = summarizeExpectedOutput(contract.expectedOutput);
  const delivered = describeDeliverable(contract.deliverable);

  return (
    <div className="border border-border/40 bg-card">
      <div className="flex items-center gap-2 border-b border-border/30 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={who}>
          {who}
        </span>
        {contract.attempt > 1 && (
          <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            attempt {contract.attempt}
          </span>
        )}
        <VerificationBadge status={contract.verificationStatus} contractStatus={contract.status} />
      </div>
      <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 px-3 py-2 text-xs">
        <span className="text-muted-foreground">Asked for</span>
        <span className="text-foreground">{asked}</span>
        <span className="text-muted-foreground">Delivered</span>
        <span className="min-w-0 text-foreground">
          <DeliverableCell view={delivered} />
        </span>
      </div>
    </div>
  );
}

function DeliverableCell({ view }: { view: DeliverableView }) {
  if (view.kind === 'none') {
    return <span className="text-muted-foreground">{view.detail}</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-baseline gap-2">
        <span className="shrink-0 border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {view.label}
        </span>
        {view.href ? (
          <a
            href={view.href}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 break-words text-primary hover:underline"
          >
            {view.detail}
          </a>
        ) : (
          <span className="min-w-0 break-words text-foreground">{view.detail}</span>
        )}
      </span>
      {view.meta && (
        <span className="text-[10px] text-muted-foreground">{view.meta}</span>
      )}
    </span>
  );
}

function VerificationBadge({
  status,
  contractStatus,
}: {
  status: VerificationStatus | null;
  contractStatus: Contract['status'];
}) {
  // No verification verdict yet — show the lifecycle status instead so the row
  // still reads as "in flight" rather than blank.
  if (!status || status === 'pending') {
    return (
      <span className="shrink-0 border border-border/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {status === 'pending' ? 'pending' : contractStatus}
      </span>
    );
  }
  const passed = status === 'passed';
  return (
    <span
      className={`shrink-0 border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
        passed
          ? 'border-success/50 bg-success/15 text-success'
          : 'border-destructive/50 bg-destructive/15 text-destructive'
      }`}
    >
      {passed ? '✓ passed' : '✕ failed'}
    </span>
  );
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}
