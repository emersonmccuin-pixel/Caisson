// Floating preview card for hovered rich-links. Mounted at Shell level.
// Reads anchor state from useRichLinkPreview; fetches via useRichLinkData;
// dispatches per-kind renderer for the content body.
//
// Positioning: anchored above-or-below the pill, flipped if it'd clip the
// bottom edge. Width capped at 360px. Card is fixed-positioned (viewport
// space) so it floats above all chat content.

import { useEffect, useState } from 'react';

import type { FilePreview } from '@/features/files/client';
import type { Attachment, WorkItem } from '@/features/work-items/client';
import type { WorkflowRow } from '@/features/workflows/client';
import { useRichLinkData, type RichLinkData } from '@/hooks/use-rich-link-data';
import {
  cancelRichLinkHide,
  scheduleRichLinkHide,
  useRichLinkPreview,
} from '@/store/rich-link-preview';

const CARD_MAX_WIDTH = 360;
const FLIP_THRESHOLD = 280; // px from bottom

interface Position {
  top: number;
  left: number;
  flipped: boolean;
}

function computePosition(anchor: HTMLElement): Position {
  const r = anchor.getBoundingClientRect();
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const spaceBelow = viewportH - r.bottom;
  const flipped = spaceBelow < FLIP_THRESHOLD && r.top > FLIP_THRESHOLD;
  const top = flipped ? r.top - 8 : r.bottom + 8;
  // Center horizontally on the pill; clamp inside the viewport.
  const ideal = r.left + r.width / 2 - CARD_MAX_WIDTH / 2;
  const left = Math.max(8, Math.min(viewportW - CARD_MAX_WIDTH - 8, ideal));
  return { top, left, flipped };
}

export function RichLinkPreviewCard() {
  const { anchor, url, projectId } = useRichLinkPreview();
  const [pos, setPos] = useState<Position | null>(null);

  useEffect(() => {
    if (!anchor) {
      setPos(null);
      return;
    }
    setPos(computePosition(anchor));
    const onScroll = () => setPos(computePosition(anchor));
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [anchor]);

  if (!anchor || !url || !projectId || !pos) return null;
  return (
    <div
      className="pc-rich-link-preview"
      style={{
        position: 'fixed',
        top: pos.flipped ? undefined : pos.top,
        bottom: pos.flipped ? window.innerHeight - pos.top : undefined,
        left: pos.left,
        maxWidth: CARD_MAX_WIDTH,
        width: CARD_MAX_WIDTH,
        zIndex: 90,
      }}
      onMouseEnter={cancelRichLinkHide}
      onMouseLeave={scheduleRichLinkHide}
    >
      <PreviewBody projectId={projectId} url={url} />
    </div>
  );
}

function PreviewBody({ projectId, url }: { projectId: string; url: string }) {
  const { status, data, error, trigger } = useRichLinkData(projectId, url);

  // Kick the fetch when the card mounts (lazy-on-hover per buildout). The
  // hover handler also triggers, but the card may mount before the handler
  // ran (debounce timing).
  useEffect(() => {
    trigger();
    // trigger is stable per renderer; we just need this to fire once per url.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, projectId]);

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
    );
  }
  if (status === 'not-found') {
    return (
      <div className="px-3 py-2 text-xs">
        <div className="font-medium text-muted-foreground">
          Reference no longer available
        </div>
        <div className="mt-1 break-all font-mono text-[10px] text-fg-dim opacity-70">
          {url}
        </div>
      </div>
    );
  }
  if (status === 'error' || !data) {
    return (
      <div className="px-3 py-2 text-xs">
        <div className="font-medium text-destructive">Preview failed</div>
        <div className="mt-1 text-[10px] text-muted-foreground">{error ?? 'unknown error'}</div>
      </div>
    );
  }
  return <KindBody data={data} />;
}

function KindBody({ data }: { data: RichLinkData }) {
  if (data.kind === 'work-item') return <WorkItemPreview workItem={data.workItem} />;
  if (data.kind === 'file') return <FilePreviewBody path={data.path} preview={data.preview} />;
  if (data.kind === 'workflow') return <WorkflowPreview workflow={data.workflow} />;
  return <AttachmentPreview attachment={data.attachment} />;
}

// ── work-item ────────────────────────────────────────────────────────────

function WorkItemPreview({ workItem }: { workItem: WorkItem }) {
  const snippet = (workItem.body ?? '').trim().slice(0, 240);
  const hasMore = (workItem.body ?? '').length > 240;
  const type = workItem.type ?? 'task';
  return (
    <div className="px-3 py-2 text-xs">
      {/* Section 35 — callsign header line above the title; NULL on agent
          contracts (skipped). */}
      {workItem.callsign && (
        <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {workItem.callsign}
        </div>
      )}
      <div className="mb-1 truncate text-sm font-medium text-foreground">
        {workItem.title}
      </div>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wider">
        {type !== 'task' && (
          <span className="border border-border px-1.5 py-0.5 text-fg-dim">{type}</span>
        )}
        <span className="border border-border px-1.5 py-0.5 text-muted-foreground">
          {workItem.stageId}
        </span>
        <span className="border border-border px-1.5 py-0.5 text-muted-foreground">
          {workItem.status}
        </span>
        {workItem.parentId && (
          <span className="text-fg-dim">↪ child</span>
        )}
      </div>
      {snippet && (
        <div className="whitespace-pre-wrap break-words text-[11px] leading-snug text-muted-foreground">
          {snippet}
          {hasMore && '…'}
        </div>
      )}
    </div>
  );
}

// ── file ─────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function FilePreviewBody({ path, preview }: { path: string; preview: FilePreview }) {
  return (
    <div className="px-3 py-2 text-xs">
      <div className="mb-1 break-all font-mono text-[11px] font-medium text-foreground">
        {path}
      </div>
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {preview.kind} · {formatBytes(preview.byteSize)}
      </div>
      {preview.kind === 'image' && (
        <img
          src={preview.dataUri}
          alt={path}
          className="max-h-32 max-w-full border border-border object-contain"
        />
      )}
      {(preview.kind === 'markdown' ||
        preview.kind === 'html' ||
        preview.kind === 'text') && (
        <pre className="max-h-32 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-muted-foreground">
          {preview.content.split('\n').slice(0, 6).join('\n')}
        </pre>
      )}
      {(preview.kind === 'binary' || preview.kind === 'oversized') && (
        <div className="text-[10px] italic text-fg-dim">
          {preview.kind === 'binary' ? 'binary file' : 'too large to preview'}
        </div>
      )}
    </div>
  );
}

// ── workflow ──────────────────────────────────────────────────────────────

function WorkflowPreview({ workflow }: { workflow: WorkflowRow }) {
  const label = workflow.displayName ?? workflow.name;
  const scope = workflow.scope === 'global' ? 'global' : 'project';
  const status = workflow.disabled ? 'disabled' : workflow.status;
  return (
    <div className="px-3 py-2 text-xs">
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        workflow · {workflow.slug}
      </div>
      <div className="mb-1 truncate text-sm font-medium text-foreground">{label}</div>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wider">
        <span className="border border-border px-1.5 py-0.5 text-muted-foreground">{scope}</span>
        <span className="border border-border px-1.5 py-0.5 text-muted-foreground">{status}</span>
      </div>
      {workflow.description && (
        <div className="whitespace-pre-wrap break-words text-[11px] leading-snug text-muted-foreground">
          {workflow.description.slice(0, 240)}
          {workflow.description.length > 240 && '…'}
        </div>
      )}
    </div>
  );
}

// ── attachment ───────────────────────────────────────────────────────────

function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  const ct = attachment.contentType ?? 'text/plain';
  const isImage = ct.startsWith('image/');
  const isText = ct.startsWith('text/') || ct.includes('json') || ct.includes('xml');
  const snippet = attachment.content?.slice(0, 240) ?? '';
  const hasMore = (attachment.content?.length ?? 0) > 240;
  return (
    <div className="px-3 py-2 text-xs">
      <div className="mb-1 truncate text-sm font-medium text-foreground">
        {attachment.name}
      </div>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className="border border-border px-1.5 py-0.5">{ct}</span>
        <span className="border border-border px-1.5 py-0.5">
          {formatBytes(attachment.content?.length ?? 0)}
        </span>
      </div>
      {isImage && (
        <div className="text-[10px] italic text-fg-dim">image preview unavailable inline</div>
      )}
      {isText && snippet && (
        <pre className="max-h-32 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-muted-foreground">
          {snippet}
          {hasMore && '…'}
        </pre>
      )}
      {!isImage && !isText && (
        <div className="text-[10px] italic text-fg-dim">no inline preview</div>
      )}
    </div>
  );
}
