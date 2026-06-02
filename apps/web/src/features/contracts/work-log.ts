// Slice 013 — pure work-log helpers (no React, no `@/` alias — importable by the
// `tsx --test` web runner that can't resolve the Vite alias). Holds:
//   1. contractFromLiveEvent  — turn a `contract.changed` frame into a Contract.
//   2. mergeContractsWithLive — seed timeline + live overlay, deduped by id+version.
//   3. summarizeExpectedOutput — "what it was asked to produce", one line.
//   4. describeDeliverable      — per-`deliverable.kind` descriptor for the renderer.
//
// The renderer descriptor is structured data (kind + label + detail + href),
// NOT JSX, so the per-kind logic is unit-testable without rendering.

import {
  isContractChangedLivePayload,
  type Contract,
  type Deliverable,
  type ExpectedOutput,
  type LiveEvent,
} from '@pc/contracts';

/** Adapt a live-store `contract.changed` frame to a Contract, gated to the
 *  project. Returns null for a wrong-project or unusable payload. Mirrors the
 *  agent-run `extractFromLiveEvent` seam. */
export function contractFromLiveEvent(event: LiveEvent, projectId: string): Contract | null {
  if (!isContractChangedLivePayload(event.payload)) return null;
  const c = event.payload.contract;
  if (c.projectId !== projectId) return null;
  return c;
}

/** Seed (HTTP, oldest-first) + live overlay (frames), keyed by contract id with
 *  per-contract `version` dedup. Result is sorted oldest-first by createdAt then
 *  id — a stable timeline order independent of frame arrival order. */
export function mergeContractsWithLive(seed: Contract[], live: Contract[]): Contract[] {
  const byId = new Map<string, Contract>();
  for (const c of seed) byId.set(c.id, c);
  for (const c of live) {
    const existing = byId.get(c.id);
    // Strictly-older frame loses (guards out-of-order delivery); equal/newer wins.
    if (existing && c.version < existing.version) continue;
    byId.set(c.id, c);
  }
  return Array.from(byId.values()).sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** "What it was asked to produce" — a one-line summary of the typed spec. */
export function summarizeExpectedOutput(eo: ExpectedOutput | null): string {
  if (!eo) return 'No spec';
  switch (eo.kind) {
    case 'answer':
      return 'Answer';
    case 'prose':
      return eo.doc_type ? `Prose (${eo.doc_type})` : 'Prose';
    case 'payload':
      return eo.semantic ? `Data (${eo.semantic})` : 'Structured data';
    case 'repo':
      return `Code (${eo.isolation === 'worktree' ? 'worktree' : 'in place'})`;
    case 'external':
      return `${eo.system} · ${eo.action}`;
    case 'binary':
      return eo.artifact_type ? `File (${eo.artifact_type})` : 'File';
    case 'action':
      return `Tool call (${eo.tool})`;
    default:
      return 'Unknown';
  }
}

/** A structured, render-agnostic descriptor of what was delivered. The Work Log
 *  renderer maps this to JSX; tests assert on it directly. */
export interface DeliverableView {
  /** The deliverable kind, or 'none' when nothing was delivered yet. */
  kind: Deliverable['kind'] | 'none';
  /** Short label for the kind chip. */
  label: string;
  /** Human-readable primary text (the answer/prose text, "called X", etc.). */
  detail: string;
  /** Optional outbound link (PR url, external resource url). */
  href?: string;
  /** Optional secondary line (branch + diffstat, attachment ref, idempotency). */
  meta?: string;
}

export function describeDeliverable(d: Deliverable | null): DeliverableView {
  if (!d) return { kind: 'none', label: '—', detail: 'No deliverable yet.' };
  switch (d.kind) {
    case 'answer':
      return { kind: 'answer', label: 'Answer', detail: d.text };
    case 'prose':
      return {
        kind: 'prose',
        label: 'Prose',
        detail: d.text ?? (d.attachmentId ? 'See attachment' : d.ref ?? 'Prose document'),
        meta: d.attachmentId
          ? `attachment ${shortId(d.attachmentId)}`
          : d.ref
            ? `ref ${d.ref}`
            : undefined,
      };
    case 'payload':
      return { kind: 'payload', label: 'Data', detail: stringifyData(d.data) };
    case 'repo': {
      const stat = d.diffStat
        ? `${d.diffStat.files} files +${d.diffStat.insertions} −${d.diffStat.deletions}`
        : undefined;
      const branch = d.branch ? `branch ${d.branch}` : d.commit ? `commit ${shortId(d.commit)}` : 'repo change';
      return {
        kind: 'repo',
        label: 'Code',
        detail: branch,
        href: d.prUrl,
        meta: stat,
      };
    }
    case 'external':
      return {
        kind: 'external',
        label: 'External',
        detail: `${d.system}: ${d.handle}`,
        href: d.url,
        meta: `key ${d.idempotencyKey}`,
      };
    case 'binary':
      return {
        kind: 'binary',
        label: 'File',
        detail: `${d.mime} · ${formatBytes(d.bytes)}`,
        meta: `attachment ${shortId(d.attachmentId)}`,
      };
    case 'action':
      return {
        kind: 'action',
        label: 'Action',
        detail: `called ${d.tool}${d.count > 1 ? ` ×${d.count}` : ''}`,
      };
    default:
      // Unknown/future kind — graceful empty-ish state.
      return { kind: 'none', label: '?', detail: 'Unrecognized deliverable.' };
  }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}

function stringifyData(data: unknown): string {
  if (data == null) return '—';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '? B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
