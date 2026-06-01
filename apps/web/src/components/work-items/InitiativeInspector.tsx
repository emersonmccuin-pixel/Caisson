// Section 37.8 — full-page inspector for a single work item. Replaces the
// modal as the surface for top-level (and recursive) drilling. Sticky header
// + four-tab strip: Brief (this phase) · Children (37.9) · Documents (37.11)
// · Activity (37.12). The latter three are placeholders here.
//
// Open / close is controlled by the parent (WorkItemsPage); this component
// is presentational + handles inline editing of the body via the existing
// PATCH /work-items/:id endpoint.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import type { Project, Stage } from '@/features/projects/client';
import { useProjectAreas } from '@/hooks/use-project-areas';
import { WorkItemConflictError, workItemsApi, type Attachment, type WorkItem, type WorkItemStatus, type WorkItemType } from '@/features/work-items/client';
import { attachmentChangedFromLiveFrame } from '@/features/work-items/attachment-live-events';
import { workItemHistoryRows } from '@/features/work-items/work-item-live-events';
import { useLiveEntitySignature, useLiveEvents } from '@/store/live-store';
import {
  WORK_ITEM_STATUS_GLYPH,
  WORK_ITEM_STATUS_GROUP_ORDER,
  WORK_ITEM_STATUS_LABEL,
  labelWorkItemStatus,
} from '@/features/work-items/status';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useAttachmentLightbox } from '@/store/attachment-lightbox';
import { useChatComposerPrefill } from '@/store/chat-composer-prefill';
import { CreateWorkItemModal } from './CreateWorkItemModal';

type InspectorTab = 'brief' | 'children' | 'documents' | 'activity';

interface Props {
  project: Project;
  workItem: WorkItem;
  events: WsEnvelope[];
  /** Where the user came from — drives the back-breadcrumb label. */
  backLabel: string;
  onBack: () => void;
  /** Called after a successful body edit so the parent can update its list. */
  onWorkItemPatched: (next: WorkItem) => void;
  /** Click a child in the Children tab → replaces the inspected item. */
  onNavigate: (next: WorkItem) => void;
}

export function InitiativeInspector({
  project,
  workItem,
  events,
  backLabel,
  onBack,
  onWorkItemPatched,
  onNavigate,
}: Props) {
  const [tab, setTab] = useState<InspectorTab>('brief');
  // Reset to Brief whenever we switch which item is being inspected.
  useEffect(() => setTab('brief'), [workItem.id]);

  const stage = useMemo(
    () => project.stages.find((s) => s.id === workItem.stageId) ?? null,
    [project.stages, workItem.stageId],
  );
  const phaseLabel = derivePhaseLabel(stage, workItem);
  const pushPrefill = useChatComposerPrefill((s) => s.push);
  const setCenterTab = useActiveCenterTab((s) => s.setTab);
  const { areas } = useProjectAreas(project, events);

  const chatAboutThis = useCallback(() => {
    // Pre-fill format: `[About: <title>] ` — the bracketed prefix is a
    // soft Option-C step (Section 37). v1 doesn't require the orchestrator
    // to parse it; future Section 37 (or true Option C) could lean on it
    // as a structured context marker.
    pushPrefill(`[About: ${workItem.title}] `);
    setCenterTab('orchestrator');
  }, [pushPrefill, setCenterTab, workItem.title]);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Back breadcrumb */}
      <div
        className="flex items-center gap-2 border-b border-border/30 bg-[var(--surface-1)] px-5 text-[11px] uppercase tracking-[0.06em] text-muted-foreground"
        style={{ height: 32 }}
      >
        <button
          type="button"
          onClick={onBack}
          className="hover:text-primary"
        >
          ← {backLabel}
        </button>
        <span className="text-[var(--fg-dim)]">/</span>
        <span className="text-primary normal-case tracking-normal">
          {workItem.title}
        </span>
      </div>

      {/* Sticky header */}
      <div className="flex items-center gap-4 border-b border-border/30 bg-background px-7 py-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[18px] font-bold tracking-[0.02em] text-[var(--fg-hot)]">
            {workItem.title}
          </h1>
          {workItem.callsign && (
            <span className="text-[11px] text-[var(--fg-dim)]">
              {workItem.callsign}
            </span>
          )}
        </div>
        <span className="border border-border/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-secondary">
          {phaseLabel}
        </span>
        <AreaSelect
          project={project}
          workItem={workItem}
          areas={areas}
          onPatched={onWorkItemPatched}
        />
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <HeaderButton title="Pin (coming in 37.15)" disabled>
            Pin
          </HeaderButton>
          <HeaderButton title="Archive (coming in 37.15)" disabled>
            Archive
          </HeaderButton>
          <HeaderButton primary onClick={chatAboutThis} title="Open the orchestrator chat with this initiative pre-filled in the composer">
            Chat about this →
          </HeaderButton>
        </div>
      </div>

      {/* Tab bar */}
      <div
        className="flex items-center gap-1 border-b border-border/30 bg-[var(--surface-1)] px-7"
        style={{ height: 36 }}
      >
        <InspectorTabButton value="brief" active={tab} onSelect={setTab}>
          Brief
        </InspectorTabButton>
        <InspectorTabButton value="children" active={tab} onSelect={setTab}>
          Children
        </InspectorTabButton>
        <InspectorTabButton value="documents" active={tab} onSelect={setTab}>
          Documents
        </InspectorTabButton>
        <InspectorTabButton value="activity" active={tab} onSelect={setTab}>
          Activity
        </InspectorTabButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'brief' ? (
          <BriefTab
            project={project}
            workItem={workItem}
            onPatched={onWorkItemPatched}
          />
        ) : tab === 'children' ? (
          <ChildrenTab
            project={project}
            parent={workItem}
            onNavigate={onNavigate}
          />
        ) : tab === 'activity' ? (
          <ActivityTab
            project={project}
            workItem={workItem}
            events={events}
          />
        ) : tab === 'documents' ? (
          <DocumentsTab
            project={project}
            workItem={workItem}
            events={events}
          />
        ) : (
          <ComingSoonPane tab={tab} />
        )}
      </div>
    </div>
  );
}

/** Slice 010 — inline Area dropdown in the inspector header. PATCHes the work
 *  item's areaId immediately on change (`''` clears to Uncaptured). */
function AreaSelect({
  project,
  workItem,
  areas,
  onPatched,
}: {
  project: Project;
  workItem: WorkItem;
  areas: { id: string; name: string; sortOrder: number }[];
  onPatched: (next: WorkItem) => void;
}) {
  const [saving, setSaving] = useState(false);
  const sorted = useMemo(
    () => [...areas].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [areas],
  );

  async function change(value: string) {
    const areaId = value === '' ? null : value;
    if (areaId === (workItem.areaId ?? null) || saving) return;
    setSaving(true);
    try {
      const next = await workItemsApi.patchWorkItem(
        project.id,
        workItem.id,
        workItem.version,
        { areaId },
      );
      onPatched(next);
    } catch (e) {
      if (e instanceof WorkItemConflictError) onPatched(e.current);
      // else: swallow — the select snaps back to workItem.areaId on re-render.
    } finally {
      setSaving(false);
    }
  }

  return (
    <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--fg-dim)]">
      Area
      <select
        value={workItem.areaId ?? ''}
        disabled={saving}
        onChange={(e) => void change(e.target.value)}
        className="border border-border/40 bg-background px-1.5 py-0.5 text-[11px] normal-case tracking-normal text-foreground disabled:opacity-50"
      >
        <option value="">none</option>
        {sorted.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function HeaderButton({
  children,
  primary,
  disabled,
  title,
  onClick,
}: {
  children: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`border px-2.5 py-1 text-[11px] uppercase tracking-[0.06em] disabled:opacity-40 ${
        primary
          ? 'border-primary text-primary hover:bg-primary/10'
          : 'border-border/40 text-muted-foreground hover:border-border hover:text-accent'
      }`}
    >
      {children}
    </button>
  );
}

function InspectorTabButton({
  value,
  active,
  onSelect,
  children,
}: {
  value: InspectorTab;
  active: InspectorTab;
  onSelect: (tab: InspectorTab) => void;
  children: React.ReactNode;
}) {
  const isActive = active === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`inline-flex h-full items-center px-3 text-[11px] uppercase tracking-[0.08em] ${
        isActive
          ? 'text-primary'
          : 'text-muted-foreground hover:text-accent'
      }`}
      style={{
        borderBottom: `2px solid ${isActive ? 'var(--primary)' : 'transparent'}`,
      }}
    >
      {children}
    </button>
  );
}

function ComingSoonPane(_props: { tab: InspectorTab }) {
  // All four inspector tabs are wired as of 37.11. Kept as a defensive
  // fallback for any future tab kind that lands ahead of its implementation.
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Children tab (37.9)

const TYPE_CHIP: Record<
  WorkItemType,
  { label: string; icon: string; className: string }
> = {
  task: { label: 'Task', icon: '▢', className: 'border-border text-muted-foreground' },
  bug: {
    label: 'Bug',
    icon: '🐛',
    className: 'border-destructive/40 bg-destructive/15 text-destructive',
  },
  feature: {
    label: 'Feature',
    icon: '✨',
    className: 'border-success/40 bg-success/15 text-success',
  },
  spike: {
    label: 'Spike',
    icon: '⚡',
    className: 'border-primary/40 bg-primary/15 text-primary',
  },
};

function ChildrenTab({
  project,
  parent,
  onNavigate,
}: {
  project: Project;
  parent: WorkItem;
  onNavigate: (wi: WorkItem) => void;
}) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refetch = useCallback(() => {
    workItemsApi.workItems(project.id)
      .then(setItems)
      .catch((e) => setError((e as Error).message));
  }, [project.id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // T3.2b — refetch children on any work-item change, keyed off the live store
  // signature (rebuild-proof; flips only on a genuine change).
  const wiSig = useLiveEntitySignature('work-item', project.id);
  useEffect(() => {
    if (wiSig) refetch();
  }, [wiSig, refetch]);

  const children = useMemo(
    () => items.filter((i) => i.parentId === parent.id),
    [items, parent.id],
  );

  const grouped = useMemo(() => {
    const byStatus = new Map<WorkItemStatus, WorkItem[]>();
    for (const status of WORK_ITEM_STATUS_GROUP_ORDER) byStatus.set(status, []);
    for (const wi of children) {
      const bucket = byStatus.get(wi.status);
      if (bucket) bucket.push(wi);
    }
    for (const bucket of byStatus.values()) {
      bucket.sort((a, b) => a.position - b.position);
    }
    return byStatus;
  }, [children]);

  const totalDone = grouped.get('complete')?.length ?? 0;
  const totalCount = children.length;

  return (
    <div className="mx-auto max-w-[1000px] px-7 py-6 pb-16">
      <div className="mb-4 flex items-center justify-between text-[11px] uppercase tracking-[0.06em] text-[var(--fg-dim)]">
        <span>
          {totalCount === 0
            ? 'No children yet.'
            : `${totalDone} of ${totalCount} done`}
        </span>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="border border-primary px-3 py-1 text-[10px] text-primary hover:bg-primary/10"
        >
          + Add task
        </button>
      </div>

      {children.length === 0 ? (
        <div className="border border-dashed border-border/30 px-4 py-10 text-center text-sm text-muted-foreground">
          Nothing here yet. Add a sub-task or let the orchestrator break this
          initiative down.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {WORK_ITEM_STATUS_GROUP_ORDER.map((status) => {
            const bucket = grouped.get(status) ?? [];
            if (bucket.length === 0) return null;
            return (
              <ChildGroup
                key={status}
                status={status}
                items={bucket}
                onClickItem={onNavigate}
              />
            );
          })}
        </div>
      )}

      {error && (
        <div className="mt-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </div>
      )}

      {createOpen && (
        <CreateWorkItemModal
          project={project}
          stageId={parent.stageId}
          parentId={parent.id}
          onClose={() => setCreateOpen(false)}
          onCreated={(wi) => {
            setItems((prev) => (prev.some((p) => p.id === wi.id) ? prev : [...prev, wi]));
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ChildGroup({
  status,
  items,
  onClickItem,
}: {
  status: WorkItemStatus;
  items: WorkItem[];
  onClickItem: (wi: WorkItem) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between border border-b-0 border-border/30 bg-[var(--surface-2)] px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        <span>{WORK_ITEM_STATUS_LABEL[status]}</span>
        <span className="text-[var(--fg-dim)]">{items.length}</span>
      </div>
      <div className="border border-border/30 bg-card">
        {items.map((wi) => {
          const glyph = WORK_ITEM_STATUS_GLYPH[wi.status];
          const type = TYPE_CHIP[wi.type];
          return (
            <button
              key={wi.id}
              type="button"
              onClick={() => onClickItem(wi)}
              className="grid w-full grid-cols-[24px_1fr_auto_auto_auto] items-center gap-3 border-b border-border/30 px-3 py-2 text-left text-[12px] last:border-b-0 hover:bg-primary/[0.04]"
            >
              <span className={`text-center text-[14px] ${glyph?.className ?? ''}`}>
                {glyph?.glyph ?? '▢'}
              </span>
              <span className="text-foreground">{wi.title}</span>
              <span
                className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.05em] ${type.className}`}
              >
                <span>{type.icon}</span>
                <span>{type.label}</span>
              </span>
              <span className="text-[10px] text-[var(--fg-dim)]">
                {wi.callsign ?? ''}
              </span>
              <span className="text-[10px] text-[var(--fg-dim)]">
                {formatRelative(wi.updatedAt)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BriefTab({
  project,
  workItem,
  onPatched,
}: {
  project: Project;
  workItem: WorkItem;
  onPatched: (next: WorkItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(workItem.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the draft when the underlying body changes (e.g. orchestrator
  // updates it while we have the inspector open).
  useEffect(() => {
    if (!editing) setDraft(workItem.body);
  }, [workItem.body, editing]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await workItemsApi.patchWorkItem(project.id, workItem.id, workItem.version, {
        body: draft,
      });
      onPatched(next);
      setEditing(false);
    } catch (e) {
      if (e instanceof WorkItemConflictError) {
        setError('This item changed elsewhere. Reloading the brief.');
        onPatched(e.current);
        setDraft(e.current.body);
        setEditing(false);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(workItem.body);
    setEditing(false);
    setError(null);
  }

  return (
    <div className="mx-auto max-w-[820px] px-7 py-7 pb-16">
      <div className="mb-4 flex items-center justify-between border-b border-dashed border-border/30 pb-2 text-[11px] uppercase tracking-[0.06em] text-[var(--fg-dim)]">
        <span>Last updated {formatRelative(workItem.updatedAt)}</span>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="border border-border/40 px-2.5 py-0.5 text-[10px] text-muted-foreground hover:border-border hover:text-primary"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={24}
            className="w-full resize-y border border-border bg-background px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground"
            placeholder="No body yet — write what this initiative is about, the current state, decisions, links."
            autoFocus
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="border border-primary bg-primary/10 px-3 py-1 text-[11px] uppercase tracking-[0.06em] text-primary hover:bg-primary/20 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="border border-border/40 px-3 py-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground hover:border-border hover:text-accent disabled:opacity-50"
            >
              Cancel
            </button>
            {error && (
              <span className="text-[11px] text-destructive">{error}</span>
            )}
          </div>
        </div>
      ) : workItem.body.trim().length > 0 ? (
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
            {workItem.body}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="border border-dashed border-border/30 px-4 py-8 text-center text-sm text-muted-foreground">
          No brief yet. Click <span className="text-primary">Edit</span> to add one
          — overview, current state, decisions, links.
        </div>
      )}
    </div>
  );
}

function derivePhaseLabel(stage: Stage | null, wi: WorkItem): string {
  // Status-driven labels take priority for clearly-named lifecycle states.
  if (wi.status === 'blocked') return 'Blocked';
  if (wi.status === 'failed') return 'Failed';
  if (wi.status === 'complete') return 'Done';
  if (wi.status === 'awaiting-verification') return labelWorkItemStatus(wi.status);
  if (wi.status === 'cancelled') return labelWorkItemStatus(wi.status);
  if (wi.status === 'archived') return 'Archived';
  // Otherwise show the stage name (e.g. "In dev", "Spec review", "Discovery").
  if (stage) return stage.name;
  // Final fallback when stage is missing.
  return wi.status === 'in-progress' ? 'In progress' : 'Pending';
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (abs < minute) return 'just now';
  const future = diff < 0;
  let value: string;
  if (abs < hour) value = `${Math.round(abs / minute)}m ago`;
  else if (abs < day) value = `${Math.round(abs / hour)}h ago`;
  else if (abs < week) value = `${Math.round(abs / day)}d ago`;
  else value = `${Math.round(abs / week)}w ago`;
  return future ? `in ${value.replace(' ago', '')}` : value;
}

// ──────────────────────────────────────────────────────────────────────
// Activity tab (37.12)
//
// Day-grouped reverse-chronological feed pulled from three sources:
//   1. workItem.history          (server-persisted, survives refresh)
//   2. attachments               (treated as "X attached Y")
//   3. live WS work-item-changed events for this item (current session only)
// Out-of-scope for v1: descendant events. The buildout proposes them but each
// row would need a recursive fetch; defer until the Children tab pushes a
// concrete need.

type ActivityActor = 'human' | 'agent' | 'orchestrator' | 'system';

interface ActivityRow {
  ts: number;
  actor: ActivityActor;
  actorLabel: string;
  text: string;
}

function ActivityTab({
  project,
  workItem,
  events,
}: {
  project: Project;
  workItem: WorkItem;
  events: WsEnvelope[];
}) {
  const [attachments, setAttachments] = useState<
    { id: string; createdAt: number; name: string; kind: string; runId: string | null; createdBySessionId: string | null }[]
  >([]);
  // T3.2b — live work-item history rows off the live store (rebuild-proof),
  // filtered to this item. #5 keeps the children refetch on the signature; this
  // list selector is distinct (Q5).
  const wiHistoryEvents = useLiveEvents('work-item', project.id);

  useEffect(() => {
    let alive = true;
    workItemsApi.listAttachments(project.id, workItem.id)
      .then((list) => {
        if (alive) setAttachments(list);
      })
      .catch(() => {
        if (alive) setAttachments([]);
      });
    return () => {
      alive = false;
    };
  }, [project.id, workItem.id]);

  const attLastIdx = useRef(0);
  useEffect(() => {
    if (events.length < attLastIdx.current) attLastIdx.current = 0;
    const start = attLastIdx.current;
    attLastIdx.current = events.length;
    if (start >= events.length) return;
    for (let i = start; i < events.length; i++) {
      const env = events[i];
      const live = attachmentChangedFromLiveFrame(env);
      const legacyMatch = env?.type === 'attachment-changed' && env.workItemId === workItem.id;
      if (legacyMatch || (live && live.workItemId === workItem.id)) {
        workItemsApi.listAttachments(project.id, workItem.id)
          .then(setAttachments)
          .catch(() => {
            /* leave the existing list */
          });
        break;
      }
    }
  }, [events, project.id, workItem.id]);

  const stageNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of project.stages) m.set(s.id, s.name);
    return m;
  }, [project.stages]);

  const rows = useMemo<ActivityRow[]>(() => {
    const out: ActivityRow[] = [];
    out.push({
      ts: workItem.createdAt,
      actor: 'system',
      actorLabel: 'system',
      text: `Created in stage "${stageNameById.get(workItem.stageId) ?? workItem.stageId}"`,
    });
    for (const entry of workItem.history) {
      const ts = Date.parse(entry.ts);
      if (!Number.isFinite(ts)) continue;
      const built = renderHistoryEntry(entry, stageNameById);
      if (built) out.push({ ts, ...built });
    }
    for (const a of attachments) {
      out.push({
        ts: a.createdAt,
        actor: a.runId ? 'agent' : a.createdBySessionId ? 'orchestrator' : 'human',
        actorLabel: a.runId
          ? `run ${a.runId.slice(-8)}`
          : a.createdBySessionId
            ? 'orchestrator'
            : 'you',
        text: `Attached ${a.name} · ${a.kind}`,
      });
    }
    if (workItem.deletedAt) {
      out.push({
        ts: workItem.deletedAt,
        actor: 'system',
        actorLabel: 'system',
        text: 'Archived',
      });
    }
    for (const row of workItemHistoryRows(wiHistoryEvents, workItem.id)) {
      out.push({
        ts: row.ts,
        actor: 'human',
        actorLabel: 'edit',
        text: row.text,
      });
    }
    out.sort((a, b) => b.ts - a.ts);
    const seen = new Set<string>();
    return out.filter((r) => {
      const key = `${r.ts}:${r.actorLabel}:${r.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [workItem, attachments, wiHistoryEvents, stageNameById]);

  const grouped = useMemo(() => groupByDay(rows), [rows]);

  if (rows.length === 0) {
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <div className="text-center text-[12px]">No activity yet.</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[820px] px-7 py-7 pb-16">
      {grouped.map((g) => (
        <div key={g.label} className="mb-6">
          <div className="mb-2 border-b border-dashed border-border/30 pb-1 text-[10px] uppercase tracking-[0.1em] text-[var(--fg-dim)]">
            {g.label}
          </div>
          <ul className="flex flex-col">
            {g.rows.map((row, idx) => (
              <li
                key={`${row.ts}-${idx}`}
                className="grid grid-cols-[80px_1fr_60px] gap-3 border-b border-dashed border-border/20 py-2 text-[12px] last:border-b-0"
              >
                <span className={`truncate text-right text-[11px] font-semibold ${actorColor(row.actor)}`}>
                  {row.actorLabel}
                </span>
                <span className="text-foreground">{row.text}</span>
                <span className="text-right text-[10px] text-[var(--fg-dim)]" title={new Date(row.ts).toLocaleString()}>
                  {formatRelative(row.ts)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function actorColor(actor: ActivityActor): string {
  switch (actor) {
    case 'human':
      return 'text-[var(--cream)]';
    case 'orchestrator':
      return 'text-primary';
    case 'agent':
      return 'text-accent';
    case 'system':
      return 'text-[var(--fg-dim)]';
  }
}

function renderHistoryEntry(
  entry: WorkItem['history'][number],
  stageNameById: Map<string, string>,
): { actor: ActivityActor; actorLabel: string; text: string } | null {
  const stageLabel = (id: string | undefined) =>
    id ? stageNameById.get(id) ?? id : '?';
  switch (entry.kind) {
    case 'move':
      return {
        actor: 'human',
        actorLabel: 'moved',
        text: `${stageLabel(entry.from)} → ${stageLabel(entry.to)}`,
      };
    case 'update': {
      const fields = entry.fields ? Object.keys(entry.fields).join(', ') : '';
      return {
        actor: 'human',
        actorLabel: 'edit',
        text: fields ? `Updated ${fields}` : 'Updated',
      };
    }
    case 'agent-invoke':
      return {
        actor: 'agent',
        actorLabel: entry.agentName ?? 'agent',
        text: entry.note ?? 'Invoked',
      };
    case 'agent-ask-orchestrator':
      return {
        actor: 'agent',
        actorLabel: entry.agentName ?? 'agent',
        text: entry.note ?? 'Asked orchestrator',
      };
    case 'agent-ask-user':
      return {
        actor: 'agent',
        actorLabel: entry.agentName ?? 'agent',
        text: entry.note ?? 'Asked you',
      };
    case 'agent-approval-request':
      return {
        actor: 'agent',
        actorLabel: entry.agentName ?? 'agent',
        text: entry.note ?? 'Requested approval',
      };
    case 'agent-answer':
      return {
        actor: entry.answeredBy === 'user' ? 'human' : 'orchestrator',
        actorLabel: entry.answeredBy ?? 'answer',
        text: entry.note ?? 'Answered',
      };
    case 'agent-completed':
      return {
        actor: 'agent',
        actorLabel: entry.agentName ?? 'agent',
        text: entry.note ?? 'Completed',
      };
    case 'agent-failed':
      return {
        actor: 'agent',
        actorLabel: entry.agentName ?? 'agent',
        text: entry.cause ? `Failed: ${entry.cause}` : 'Failed',
      };
    default:
      return null;
  }
}

function groupByDay(rows: ActivityRow[]): { label: string; rows: ActivityRow[] }[] {
  const groups = new Map<string, ActivityRow[]>();
  const order: string[] = [];
  const todayKey = dayKey(Date.now());
  const yesterdayKey = dayKey(Date.now() - 86_400_000);
  for (const row of rows) {
    const k = dayKey(row.ts);
    if (!groups.has(k)) {
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k)!.push(row);
  }
  return order.map((k) => ({
    label:
      k === todayKey
        ? 'Today'
        : k === yesterdayKey
          ? 'Yesterday'
          : new Date(k).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            }),
    rows: groups.get(k)!,
  }));
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ──────────────────────────────────────────────────────────────────────
// Documents tab (37.11 — flat v1)
//
// Lists existing attachments. No folders yet (the 37.10 schema lands when
// the workflow cull closes; this tab gets folder navigation in a follow-up).
// No upload UI — the create-attachment surface isn't exposed in the API
// today; attachments arrive via agents / MCP tools / chat drag-drop. This
// tab is the read + filter + click-to-preview surface.

type DocTypeFilter = 'all' | 'docs' | 'images' | 'data' | 'links';
type DocCreatorFilter = 'all' | 'ai' | 'you';

function DocumentsTab({
  project,
  workItem,
  events,
}: {
  project: Project;
  workItem: WorkItem;
  events: WsEnvelope[];
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<DocTypeFilter>('all');
  const [creatorFilter, setCreatorFilter] = useState<DocCreatorFilter>('all');
  const openLightbox = useAttachmentLightbox((s) => s.open);

  const refetch = useCallback(() => {
    workItemsApi.listAttachments(project.id, workItem.id)
      .then(setAttachments)
      .catch(() => {
        /* swallow — empty list is the safe fallback */
      });
  }, [project.id, workItem.id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const att2LastIdx = useRef(0);
  useEffect(() => {
    if (events.length < att2LastIdx.current) att2LastIdx.current = 0;
    const start = att2LastIdx.current;
    att2LastIdx.current = events.length;
    if (start >= events.length) return;
    for (let i = start; i < events.length; i++) {
      const env = events[i];
      const live = attachmentChangedFromLiveFrame(env);
      const legacyMatch = env?.type === 'attachment-changed' && env.workItemId === workItem.id;
      if (legacyMatch || (live && live.workItemId === workItem.id)) {
        refetch();
        break;
      }
    }
  }, [events, workItem.id, refetch]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return attachments.filter((a) => {
      if (needle && !a.name.toLowerCase().includes(needle)) return false;
      if (typeFilter !== 'all' && classifyType(a) !== typeFilter) return false;
      if (creatorFilter !== 'all' && classifyCreator(a) !== creatorFilter) return false;
      return true;
    });
  }, [attachments, search, typeFilter, creatorFilter]);

  return (
    <div className="mx-auto max-w-[1000px] px-7 py-6 pb-16">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search documents…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 px-2.5 py-1 text-[12px]"
        />
        <DocFilterChip
          label="All"
          active={typeFilter === 'all'}
          onClick={() => setTypeFilter('all')}
        />
        <DocFilterChip
          label="📄 Docs"
          active={typeFilter === 'docs'}
          onClick={() => setTypeFilter('docs')}
        />
        <DocFilterChip
          label="🖼 Images"
          active={typeFilter === 'images'}
          onClick={() => setTypeFilter('images')}
        />
        <DocFilterChip
          label="📊 Data"
          active={typeFilter === 'data'}
          onClick={() => setTypeFilter('data')}
        />
        <DocFilterChip
          label="🔗 Links"
          active={typeFilter === 'links'}
          onClick={() => setTypeFilter('links')}
        />
        <span className="w-2" />
        <DocFilterChip
          label="By AI"
          active={creatorFilter === 'ai'}
          onClick={() =>
            setCreatorFilter(creatorFilter === 'ai' ? 'all' : 'ai')
          }
        />
        <DocFilterChip
          label="By you"
          active={creatorFilter === 'you'}
          onClick={() =>
            setCreatorFilter(creatorFilter === 'you' ? 'all' : 'you')
          }
        />
      </div>

      {filtered.length === 0 ? (
        <div className="border border-dashed border-border/30 px-4 py-10 text-center text-sm text-muted-foreground">
          {attachments.length === 0
            ? 'No documents on this initiative yet. Agents attach things here when they generate reports, decks, or research.'
            : 'No documents match the current filters.'}
        </div>
      ) : (
        <div className="border border-border/30 bg-card">
          {filtered.map((a) => {
            const icon = typeIcon(a);
            const creator = classifyCreator(a);
            const creatorLabel = creator === 'ai' ? agentLabel(a) : 'you';
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => openLightbox(a.id)}
                className="grid w-full grid-cols-[28px_1fr_130px_90px_90px] items-center gap-3 border-b border-border/30 px-3 py-2 text-left text-[12px] last:border-b-0 hover:bg-primary/[0.04]"
              >
                <span className="text-center text-[15px]">{icon}</span>
                <span className="truncate text-foreground">{a.name}</span>
                <span
                  className={`truncate text-[10px] ${
                    creator === 'ai' ? 'text-accent' : 'text-muted-foreground'
                  }`}
                >
                  {creatorLabel}
                </span>
                <span className="text-[10px] text-[var(--fg-dim)]">{a.kind}</span>
                <span className="text-right text-[10px] text-[var(--fg-dim)]">
                  {formatRelative(a.createdAt)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-4 text-[10px] text-[var(--fg-dim)]">
        Folder organisation + upload land in a follow-up (folders schema
        deferred to 37.10).
      </div>
    </div>
  );

  function agentLabel(a: Attachment): string {
    if (a.runId) return `run ${a.runId.slice(-8)}`;
    if (a.createdBySessionId) return 'orchestrator';
    return 'unknown';
  }
}

function DocFilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border px-2 py-0.5 text-[10px] ${
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border/40 text-muted-foreground hover:border-border hover:text-accent'
      }`}
    >
      {label}
    </button>
  );
}

function classifyType(a: Attachment): DocTypeFilter {
  const kind = (a.kind || '').toLowerCase();
  if (
    kind === 'link' ||
    kind === 'url' ||
    a.name.startsWith('http://') ||
    a.name.startsWith('https://')
  ) {
    return 'links';
  }
  if (
    kind.includes('image') ||
    kind === 'png' ||
    kind === 'jpg' ||
    kind === 'jpeg' ||
    kind === 'gif' ||
    kind === 'webp'
  ) {
    return 'images';
  }
  if (kind === 'json' || kind === 'csv' || kind === 'yaml' || kind === 'yml') {
    return 'data';
  }
  return 'docs';
}

function classifyCreator(a: Attachment): DocCreatorFilter {
  if (a.runId || a.createdBySessionId) return 'ai';
  return 'you';
}

function typeIcon(a: Attachment): string {
  const t = classifyType(a);
  switch (t) {
    case 'images':
      return '🖼';
    case 'data':
      return '📊';
    case 'links':
      return '🔗';
    case 'docs':
      return '📄';
    case 'all':
      return '📎';
  }
}
