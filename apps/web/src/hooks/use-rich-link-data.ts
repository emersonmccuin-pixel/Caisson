// Lazy fetch + in-memory cache for pc:// rich-link entities. One Map keyed by
// the full pc:// URL; entries shared across every <RichLink> in the chat.
//
// Lifecycle:
//   - Hover (or click) on a <RichLink> calls trigger() → kicks fetch if
//     status is 'idle'.
//   - Status flows idle → loading → ok | not-found | error.
//   - WS invalidation (see use-rich-link-invalidator.ts) evicts entries on
//     work-items-changed + attachment-changed envelopes; next hover refetches.
//   - Cache lives for the page session; reload clears it.
//
// `not-found` (404) is the cached broken-link state — surfaces in 1.5.8 as
// the struck-through pill. Distinct from `error` (other failures) so retries
// for a known-missing entity don't keep refetching.

import { useSyncExternalStore } from 'react';

import type { ULID } from '@/features/projects/client';
import { filesApi, type FilePreview } from '@/features/files/client';
import { workItemsApi, type Attachment, type WorkItem } from '@/features/work-items/client';
import type { RichLinkKind } from '@/lib/parse-chat-text';

export type RichLinkData =
  | { kind: 'work-item'; workItem: WorkItem }
  | { kind: 'file'; path: string; preview: FilePreview }
  | { kind: 'attachment'; attachment: Attachment };

export type RichLinkStatus = 'idle' | 'loading' | 'ok' | 'not-found' | 'error';

interface CacheEntry {
  status: RichLinkStatus;
  data?: RichLinkData;
  error?: string;
}

const IDLE_ENTRY: CacheEntry = Object.freeze({ status: 'idle' as RichLinkStatus });
const cache = new Map<string, CacheEntry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function getEntry(url: string): CacheEntry {
  return cache.get(url) ?? IDLE_ENTRY;
}

function setEntry(url: string, entry: CacheEntry): void {
  cache.set(url, entry);
  notify();
}

const PC_URL_RE = /^pc:\/\/([\w-]+)\/(.+)$/;

export function parsePcUrl(url: string): { kind: RichLinkKind; ref: string } | null {
  const m = url.match(PC_URL_RE);
  if (!m) return null;
  const k = m[1];
  if (k !== 'work-item' && k !== 'file' && k !== 'attachment' && k !== 'inbox') return null;
  return { kind: k, ref: decodeURIComponent(m[2] ?? '') };
}

async function fetchData(projectId: ULID, url: string): Promise<void> {
  const parsed = parsePcUrl(url);
  if (!parsed || !parsed.ref) {
    setEntry(url, { status: 'error', error: 'malformed pc:// URL' });
    return;
  }
  setEntry(url, { status: 'loading' });
  try {
    if (parsed.kind === 'work-item') {
      const wi = await workItemsApi.getWorkItem(projectId, parsed.ref as ULID);
      setEntry(url, { status: 'ok', data: { kind: 'work-item', workItem: wi } });
      return;
    }
    if (parsed.kind === 'file') {
      const preview = await filesApi.previewFile(projectId, parsed.ref);
      setEntry(url, { status: 'ok', data: { kind: 'file', path: parsed.ref, preview } });
      return;
    }
    if (parsed.kind === 'attachment') {
      const att = await workItemsApi.getAttachmentById(projectId, parsed.ref as ULID);
      setEntry(url, { status: 'ok', data: { kind: 'attachment', attachment: att } });
      return;
    }
    // inbox — Section 7 will land it.
    setEntry(url, { status: 'not-found', error: 'inbox links not supported yet' });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const looksMissing = /\b404\b|not[\s_-]?found/i.test(msg);
    setEntry(url, { status: looksMissing ? 'not-found' : 'error', error: msg });
  }
}

export interface RichLinkResult {
  status: RichLinkStatus;
  data?: RichLinkData;
  error?: string;
  /** Kicks the fetch on first call. No-op for already-loaded/loading/broken URLs. */
  trigger: () => void;
}

export function useRichLinkData(projectId: ULID | string | null, url: string): RichLinkResult {
  const entry = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => getEntry(url),
    () => getEntry(url),
  );
  const trigger = () => {
    if (!projectId) return;
    const current = cache.get(url);
    if (current && current.status !== 'idle') return;
    void fetchData(projectId as ULID, url);
  };
  return {
    status: entry.status,
    data: entry.data,
    error: entry.error,
    trigger,
  };
}

// ── Invalidators (called from the WS subscriber wired in Shell) ──────────

export function invalidateByWorkItemId(workItemId: string): void {
  let dirty = false;
  for (const url of cache.keys()) {
    const parsed = parsePcUrl(url);
    if (parsed && parsed.kind === 'work-item' && parsed.ref === workItemId) {
      cache.delete(url);
      dirty = true;
    }
  }
  if (dirty) notify();
}

export function invalidateByAttachmentId(attachmentId: string): void {
  let dirty = false;
  for (const url of cache.keys()) {
    const parsed = parsePcUrl(url);
    if (parsed && parsed.kind === 'attachment' && parsed.ref === attachmentId) {
      cache.delete(url);
      dirty = true;
    }
  }
  if (dirty) notify();
}

// Test-only escape hatch — used if we ever wire a smoke test.
export function _resetRichLinkCacheForTests(): void {
  cache.clear();
  notify();
}
