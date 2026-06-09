// Chat-text segmentation. Splits raw user/assistant text into a list of typed
// UserPart segments that the chat renderer consumes:
//
//   1. <channel> blocks are extracted as channel/workflow-event/agent-event parts.
//   2. Remaining text is sub-parsed for markdown links + bare URLs.
//      - pc://work-item|file|attachment|inbox/<ref>  → rich-link
//      - https?://...                                 → external-link
//
// Pure module. No React imports. Lives in apps/web/src/lib/ so the parser can
// move (or be tested) without dragging the chat surface along.

export type RichLinkKind = 'work-item' | 'file' | 'attachment' | 'inbox' | 'workflow';

export interface UserPart {
  kind:
    | 'text'
    | 'channel'
    | 'workflow-event'
    | 'agent-event'
    | 'rich-link'
    | 'external-link';
  text: string;
  // channel
  source?: string;
  // workflow-event
  workflowEventKind?: string;
  workflowRunId?: string;
  // agent-event
  agentEventKind?: string;
  agentRunId?: string;
  agentName?: string;
  // rich-link + external-link
  linkText?: string;
  url?: string;
  // rich-link
  richLinkKind?: RichLinkKind;
  richLinkRef?: string;
  // external-link
  externalInsecure?: boolean;
}

const CHANNEL_RE = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
const WORKFLOW_EVENT_HEADER_RE = /^\[pc:workflow-event\s+kind=([\w-]+)/;
const WORKFLOW_RUN_ID_RE = /\[workflowRunId:\s*([A-Za-z0-9_-]+)\]/;
const AGENT_EVENT_HEADER_RE = /^\[pc:agent-event\s+kind=([\w-]+)/;
const AGENT_RUN_ID_RE = /\[runId:\s*([A-Za-z0-9_-]+)\]/;
const AGENT_NAME_RE = /\[agentName:\s*([\w-]+)\]/;

// Combined link regex. Order matters — markdown-link alternative comes first so
// a URL inside an already-matched [text](url) doesn't double-match as a bare URL.
//
// Group 1: markdown-link text
// Group 2: markdown-link URL (pc:// or http(s)://)
// Group 3: bare URL
//
// URL bodies forbid whitespace + closing-paren so links inside parens stay
// bounded; trailing punctuation on bare URLs is trimmed post-match (see below).
const LINK_RE =
  /\[([^\]\n]+)\]\((pc:\/\/[^)\s]+|https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"'`]+)/g;

const PC_URL_RE = /^pc:\/\/([\w-]+)\/(.+)$/;
const TRAILING_PUNCT = /[.,;:!?)\]]+$/;
const VALID_RICH_KINDS = new Set<RichLinkKind>([
  'work-item',
  'file',
  'attachment',
  'inbox',
  'workflow',
]);

/**
 * Classify a text block whose first line is a `[pc:agent-event …]` /
 * `[pc:workflow-event …]` header into a typed event part. Returns null when no
 * known header leads the block. Shared by the top-level (mailbox) path and the
 * legacy <channel>-wrapped path so both yield identical parts.
 */
function classifyEventBlock(body: string): UserPart | null {
  const wfMatch = body.match(WORKFLOW_EVENT_HEADER_RE);
  if (wfMatch) {
    const runMatch = body.match(WORKFLOW_RUN_ID_RE);
    const part: UserPart = { kind: 'workflow-event', text: body, workflowEventKind: wfMatch[1] };
    if (runMatch?.[1]) part.workflowRunId = runMatch[1];
    return part;
  }
  const agMatch = body.match(AGENT_EVENT_HEADER_RE);
  if (agMatch) {
    const runMatch = body.match(AGENT_RUN_ID_RE);
    const nameMatch = body.match(AGENT_NAME_RE);
    const part: UserPart = { kind: 'agent-event', text: body, agentEventKind: agMatch[1] };
    if (runMatch?.[1]) part.agentRunId = runMatch[1];
    if (nameMatch?.[1]) part.agentName = nameMatch[1];
    return part;
  }
  return null;
}

/**
 * Split a chat text body into typed parts. A mailbox-delivered agent/workflow
 * event arrives as a bare turn whose body leads with a `[pc:agent-event …]`
 * header (no <channel> wrapper) — detected first. Otherwise the outer pass
 * extracts any legacy <channel> blocks; the inner pass splits remaining text
 * segments on markdown + bare URLs.
 */
export function parseUserText(text: string): UserPart[] {
  if (!text) return [{ kind: 'text', text: '' }];
  const topLevel = classifyEventBlock(text.trim());
  if (topLevel) return [topLevel];
  const parts: UserPart[] = [];
  let last = 0;
  let sawChannel = false;
  for (const m of text.matchAll(CHANNEL_RE)) {
    sawChannel = true;
    const idx = m.index ?? 0;
    if (idx > last) {
      const slice = text.slice(last, idx).trim();
      if (slice) pushTextWithLinks(parts, slice);
    }
    const attrs = m[1] ?? '';
    const body = (m[2] ?? '').trim();
    last = idx + m[0].length;
    const eventPart = classifyEventBlock(body);
    if (eventPart) {
      parts.push(eventPart);
      continue;
    }
    const sourceMatch = attrs.match(/source\s*=\s*"([^"]+)"/);
    parts.push({ kind: 'channel', text: body, source: sourceMatch?.[1] ?? 'channel' });
  }
  if (last < text.length) {
    const tail = text.slice(last).trim();
    if (tail) pushTextWithLinks(parts, tail);
  }
  if (parts.length === 0 && !sawChannel) pushTextWithLinks(parts, text);
  return parts;
}

/**
 * Split a plain-text segment into text + rich-link + external-link parts.
 * Whitespace BETWEEN matches is preserved (links are inline; surrounding
 * spacing matters). Empty leading/trailing segments are dropped.
 */
function pushTextWithLinks(into: UserPart[], segment: string): void {
  if (!segment) return;
  let cursor = 0;
  // Reset lastIndex on the shared regex before iterating — matchAll resets it
  // internally but we use exec semantics via matchAll() so it's safe.
  for (const m of segment.matchAll(LINK_RE)) {
    const idx = m.index ?? 0;
    if (idx > cursor) {
      const between = segment.slice(cursor, idx);
      if (between) into.push({ kind: 'text', text: between });
    }
    const mdText = m[1];
    const mdUrlRaw = m[2];
    const bareUrlRaw = m[3];
    if (mdText && mdUrlRaw) {
      const url = trimTrailingPunct(mdUrlRaw);
      const part = makeLinkPart(mdText, url);
      into.push(part);
      cursor = idx + m[0].length;
      continue;
    }
    if (bareUrlRaw) {
      const url = trimTrailingPunct(bareUrlRaw);
      // If trimming dropped chars, push them back into cursor calc so the
      // trailing punctuation lands in the following text segment.
      const consumed = url.length;
      const part = makeLinkPart(url, url);
      into.push(part);
      cursor = idx + consumed;
      continue;
    }
    cursor = idx + m[0].length;
  }
  if (cursor < segment.length) {
    const tail = segment.slice(cursor);
    if (tail) into.push({ kind: 'text', text: tail });
  }
}

function trimTrailingPunct(url: string): string {
  let out = url;
  // Loop to strip multiple trailing chars (e.g. ".)" at end of sentence).
  while (TRAILING_PUNCT.test(out)) {
    out = out.replace(TRAILING_PUNCT, '');
  }
  return out;
}

function makeLinkPart(linkText: string, url: string): UserPart {
  const pcMatch = url.match(PC_URL_RE);
  if (pcMatch) {
    const kind = pcMatch[1] as RichLinkKind;
    const ref = pcMatch[2] ?? '';
    if (VALID_RICH_KINDS.has(kind) && ref) {
      return {
        kind: 'rich-link',
        text: linkText,
        linkText,
        url,
        richLinkKind: kind,
        richLinkRef: decodeURIComponent(ref),
      };
    }
    // Unknown pc:// kind — fall through to external-link rendering so the
    // text is still clickable / visible. Treat as external since we can't
    // resolve it; renderer will surface the raw URL.
    return {
      kind: 'external-link',
      text: linkText,
      linkText,
      url,
      externalInsecure: false,
    };
  }
  const insecure = url.startsWith('http://');
  return {
    kind: 'external-link',
    text: linkText,
    linkText,
    url,
    externalInsecure: insecure,
  };
}
