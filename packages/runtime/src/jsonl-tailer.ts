// Tails CC's per-session JSONL file (~/.claude/projects/<encoded-cwd>/<uuid>.jsonl)
// and emits typed canonical events. Source of truth for turn lifecycle + tool
// calls; replaces the hook-driven derivation that misses the four documented
// Stop-skip cases (see the chat reliability design).
//
// Section 31 extends the catalog to surface every kept JSONL signal claude.exe
// emits — see the JSONL signal catalog for the locked render
// placements and the cut list. Cut signals stay un-decoded; kept signals get
// typed envelopes (the ones that drive distinct UI shapes) or richer formatter
// strings inside the generic jsonl-system pass-through (the ones that render
// as system rows).
//
// Pure module: no PtySession / WS / DB awareness. Tested by pointing at a real
// JSONL file and reading the emitted events.

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';

export type JsonlEvent =
  | {
      kind: 'jsonl-user';
      text: string;
      /** True when CC flagged this entry as a non-conversational meta injection
       *  (e.g. a webhook channel event written by PC itself). Read-only decode —
       *  the field is already on-disk; the tailer just surfaces it. */
      isMeta?: boolean;
      /** Channel / origin metadata. `kind === 'channel'` identifies messages
       *  injected via the PC channel server rather than typed by the user. */
      origin?: { kind?: string; server?: string } | null;
    }
  | { kind: 'jsonl-queue-enqueue'; timestamp: string | null }
  | { kind: 'jsonl-queue-dequeue'; timestamp: string | null }
  | {
      kind: 'jsonl-tool-call';
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      kind: 'jsonl-tool-result';
      toolUseId: string;
      result: unknown;
      isError: boolean;
    }
  | { kind: 'jsonl-turn-end'; text: string; stopReason: string | null }
  | {
      kind: 'jsonl-usage';
      // Per-API-call token usage from the assistant message's `usage` field.
      // Each assistant entry (mid-loop OR turn-end) carries one of these.
      // Client sums across entries to get session totals — sidechain entries
      // short-circuit before this fires, so subagent tokens don't pollute
      // orchestrator totals. Section 31 extended with `speed` (turn-footer
      // chip when ≠ standard) and `cacheMissReason` (turn-footer warning chip
      // when a miss happens) — both ride on the same usage envelope so the
      // client only has to subscribe once.
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      model: string | null;
      speed: string | null;
      cacheMissReason: string | null;
    }
  | { kind: 'jsonl-sidechain'; raw: unknown }
  /**
   * `type: 'system'` rows from CC's JSONL. claude.exe writes these for any
   * non-turn event the user would see in the CLI's stderr / status line:
   *   - `subtype: 'api_error'` — Anthropic API failure, with retry metadata.
   *     Surfaces the "Overloaded — retrying in 8s (attempt 5/10)" status line
   *     that the CLI shows but our chat panel was previously eating.
   *   - `subtype: 'init'` — session boot banner.
   *   - other subtypes claude.exe adds over time — we emit them all and let
   *     the chat panel decide what to render (default: dump the raw entry).
   * Per [[hand-user-everything]] / 2026-05-19 ask: the user must see EVERY
   * system message a claude code CLI user would see; missing this surface is
   * how "stuck in Thinking" with no diagnosis becomes a frustrating bug.
   *
   * Section 31: kept subtypes that warrant distinct rendering shapes also emit
   * their own typed envelopes (`jsonl-session-state`, `jsonl-compact`,
   * `jsonl-microcompact`, `jsonl-turn-duration`, `jsonl-post-turn-summary`).
   * The generic `jsonl-system` envelope still fires for them so legacy
   * consumers keep working — the web side knows which subtypes to render via
   * their typed envelope instead of the generic system row.
   */
  | {
      kind: 'jsonl-system';
      subtype: string;
      level: string;
      message: string;
      timestamp: string | null;
      raw: unknown;
    }
  /** Section 31 — CC's auto-generated session title. Drives the left-rail
   *  session row title and the chat title bar. Fires repeatedly through a
   *  session as the title is refined. */
  | { kind: 'jsonl-ai-title'; title: string }
  /** Section 31 — leaf-pointer metadata. Internal use only (resume
   *  correctness, "jump to last prompt"); never directly rendered. */
  | { kind: 'jsonl-last-prompt'; uuid: string | null; raw: unknown }
  /** Section 31 — per-message file-state snapshot for diff tracking. Internal
   *  use only ("what files did this session touch"); never directly rendered. */
  | { kind: 'jsonl-file-history'; snapshotId: string | null; raw: unknown }
  /** Section 31 — links session to a `/remote-control` `bridgeSessionId`.
   *  Combined with `system:bridge_status`, drives the center-column lower-right
   *  remote-control corner indicator. */
  | { kind: 'jsonl-bridge-session'; bridgeSessionId: string | null; raw: unknown }
  /** Section 31 — long-running tool progress mid-execution. Renders as a live
   *  progress line inside the tool-group child card. */
  | {
      kind: 'jsonl-tool-progress';
      toolUseId: string;
      toolName: string;
      parentToolUseId: string | null;
      elapsedSeconds: number | null;
      taskId: string | null;
      raw: unknown;
    }
  /** Section 31 — partial assistant tokens for smoother live streaming.
   *  Empirical pass found zero `stream_event` rows in 22,738 records; emit
   *  anyway and let the renderer gate on actual fires. */
  | { kind: 'jsonl-stream-event'; event: unknown; parentToolUseId: string | null; raw: unknown }
  /** Section 31 — session state flips between idle / running / requires_action.
   *  Drives composer disable/enable AND an inline state-transition divider.
   *  Replaces the hook-event scan / sessionEnded heuristic. */
  | {
      kind: 'jsonl-session-state';
      state: string;
      permissionMode: string | null;
      timestamp: string | null;
      raw: unknown;
    }
  /** Section 31 — automatic context compaction boundary. Renders as a
   *  centered dashed-rule boundary marker in chat. */
  | {
      kind: 'jsonl-compact';
      trigger: string | null;
      preTokens: number | null;
      messagesSummarized: number | null;
      timestamp: string | null;
      raw: unknown;
    }
  /** Section 31 — silent micro-compaction (tool-result cleanup). Renders as
   *  an inline state-transition divider. */
  | {
      kind: 'jsonl-microcompact';
      trigger: string | null;
      preTokens: number | null;
      tokensSaved: number | null;
      timestamp: string | null;
      raw: unknown;
    }
  /** Section 31 — completion-time turn duration. Rides the PM bubble
   *  timestamp header. Fires AFTER the preceding `jsonl-turn-end`. */
  | {
      kind: 'jsonl-turn-duration';
      durationMs: number | null;
      budgetTokens: number | null;
      messageCount: number | null;
      timestamp: string | null;
      raw: unknown;
    }
  /** Section 31 — model-generated post-turn summary. `needs_action`,
   *  `artifact_urls`, `title`, `description`, etc. TBD render surface; logged
   *  to a per-project table per the buildout. */
  | {
      kind: 'jsonl-post-turn-summary';
      summarizesUuid: string | null;
      statusCategory: string | null;
      statusDetail: string | null;
      isNoteworthy: boolean;
      title: string | null;
      description: string | null;
      recentAction: string | null;
      needsAction: boolean;
      artifactUrls: unknown;
      timestamp: string | null;
      raw: unknown;
    }
  /** Mid-loop or preamble assistant text. Emitted for assistant entries whose
   *  stop_reason is `tool_use` or `pause_turn` (the model wrote text blocks
   *  as a preamble before its tool calls). Previously this text was dropped
   *  entirely — the turn-end extraction only ran for !isMidLoop entries.
   *  `midLoop: true` on every emission from this path. */
  | { kind: 'jsonl-assistant-text'; text: string; midLoop: boolean }
  /** Extended-thinking block emitted by the model. Present when the model's
   *  response includes a `type: 'thinking'` content block (Claude 3.7+
   *  extended-thinking). Fires for both mid-loop and turn-end assistant
   *  entries. Rendered as a collapsible Thinking block in chat. */
  | { kind: 'jsonl-thinking'; text: string };

export interface JsonlTailerOptions {
  filePath: string;
  /** Skip this many leading lines on first read. Used to resume past a
   *  persisted cursor after server restart. Defaults to 0 (process all). */
  startLine?: number;
  /** Poll interval ms for the read loop. Defaults to 200. */
  pollIntervalMs?: number;
}

export interface JsonlEventMeta {
  /** 1-based line cursor in Claude's source JSONL that produced this event.
   *  Multiple normalized events can share a cursor when one provider row
   *  expands into tool-call + usage + turn-end events. */
  sourceCursor: number;
}

// Replay envelope metadata for re-persisted JSONL events (the orchestrator
// adapter's server-side replay + the runtime-host WS payloads). Moved here
// from pty-session.ts when Step 6 deleted it — the shape describes tailed
// JSONL rows, so the tailer module owns it.

export interface JsonlReplaySource {
  kind: 'claude-jsonl';
  cursor: number | null;
}

export interface JsonlReplayMeta {
  id: string;
  sessionId: string;
  seq: number;
  kind: JsonlEvent['kind'];
  source: JsonlReplaySource;
}

/**
 * One tailer = one JSONL file. Emits:
 *   'event' (JsonlEvent) — one per canonical event derived from a line
 *   'error' (Error)      — file read / parse infra failures (per-line parse
 *                          errors are swallowed + cursor still advances)
 */
export class JsonlTailer extends EventEmitter {
  private filePath: string;
  private cursor: number;
  private pollIntervalMs: number;
  private poller: ReturnType<typeof setInterval> | null = null;
  private currentSourceCursor: number | null = null;

  constructor(opts: JsonlTailerOptions) {
    super();
    this.filePath = opts.filePath;
    this.cursor = opts.startLine ?? 0;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
  }

  /** Begin tailing. Reads any current tail past the cursor immediately, then
   *  polls. Idempotent — calling twice does nothing. */
  start(): void {
    if (this.poller) return;
    this.poller = setInterval(() => this.readTail(), this.pollIntervalMs);
    this.poller.unref?.();
    // Initial read — the poller only fires on the next interval, so drain any
    // already-present content past the cursor before returning.
    this.readTail();
  }

  /** Release the poller. Safe to call multiple times. */
  stop(): void {
    if (!this.poller) return;
    clearInterval(this.poller);
    this.poller = null;
  }

  /** Current line count consumed. Persist this to resume past a restart. */
  getCursor(): number {
    return this.cursor;
  }

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    if (eventName === 'event' && args.length === 1 && this.currentSourceCursor !== null) {
      return super.emit(eventName, args[0], {
        sourceCursor: this.currentSourceCursor,
      } satisfies JsonlEventMeta);
    }
    return super.emit(eventName, ...args);
  }

  private readTail(): void {
    if (!existsSync(this.filePath)) return;
    let content: string;
    try {
      content = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      this.emit('error', err);
      return;
    }
    // Newline-delimited records. If the file does NOT end with '\n' the last
    // segment is mid-write — leave it for the next tick when it's terminated.
    const endsWithNewline = content.endsWith('\n');
    const segments = content.split('\n');
    if (endsWithNewline) segments.pop(); // drop empty trailing element
    const completeLines = endsWithNewline ? segments : segments.slice(0, -1);

    if (completeLines.length <= this.cursor) return;

    for (let i = this.cursor; i < completeLines.length; i++) {
      const line = completeLines[i];
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        // Malformed line — skip but still advance the cursor below.
        continue;
      }
      this.processEntry(obj, i + 1);
    }
    this.cursor = completeLines.length;
  }

  private processEntry(obj: unknown, sourceCursor: number): void {
    const priorSourceCursor = this.currentSourceCursor;
    this.currentSourceCursor = sourceCursor;
    try {
      this.processEntryWithCursor(obj);
    } finally {
      this.currentSourceCursor = priorSourceCursor;
    }
  }

  private processEntryWithCursor(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return;
    const entry = obj as Record<string, unknown>;

    // isSidechain entries short-circuit all other rendering. Section 0
    // captures them; Section 6 (Activity panel) decides how to render.
    if (entry.isSidechain === true) {
      this.emit('event', { kind: 'jsonl-sidechain', raw: entry } satisfies JsonlEvent);
      return;
    }

    const type = entry.type;

    if (type === 'queue-operation') {
      const op = entry.operation;
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      if (op === 'enqueue') {
        this.emit('event', { kind: 'jsonl-queue-enqueue', timestamp } satisfies JsonlEvent);
      } else if (op === 'dequeue' || op === 'remove') {
        // CC's queue protocol logs two consumption operations:
        //   - `dequeue` when a command is pulled for processing via the normal
        //     consume path (messageQueueManager.dequeue)
        //   - `remove` when a command leaves the queue via reference / filter
        //     removal (messageQueueManager.remove / removeByFilter). The
        //     "queued command processed at turn-end" path on CC ≥2.1 fires
        //     `remove`. Both mean "this queue slot is gone" — collapse into
        //     our single `jsonl-queue-dequeue` envelope so the UI pops it.
        this.emit('event', { kind: 'jsonl-queue-dequeue', timestamp } satisfies JsonlEvent);
      }
      return;
    }

    // CC persists a processed queued command as a `type: "attachment"` row
    // with `attachment.type === "queued_command"`. There is NO separate
    // `type: "user"` row — the attachment is the only place the prompt body
    // lives in JSONL. Without surfacing it, the user types a message while
    // CC is busy, the queue chip pops on remove, but the message itself
    // never appears in chat. Synthesize a `jsonl-user` envelope from the
    // attachment's `prompt` field so the chat renders the queued message
    // as a fresh user bubble. (attachments.ts:1046 getQueuedCommandAttachments
    // in CC source confirms the shape.)
    if (type === 'attachment') {
      const a = entry.attachment as Record<string, unknown> | undefined;
      if (a && a.type === 'queued_command') {
        const prompt = a.prompt;
        let text = '';
        if (typeof prompt === 'string') {
          text = prompt;
        } else if (Array.isArray(prompt)) {
          // ContentBlockParam[] shape: text + image blocks. Collect text parts.
          for (const block of prompt) {
            if (
              block &&
              typeof block === 'object' &&
              (block as { type?: unknown }).type === 'text' &&
              typeof (block as { text?: unknown }).text === 'string'
            ) {
              text += (block as { text: string }).text;
            }
          }
        }
        if (text) {
          this.emit('event', { kind: 'jsonl-user', text } satisfies JsonlEvent);
        }
      }
      return;
    }

    if (type === 'user') {
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message) return;
      const content = message.content;
      // User prompt: content is a plain string.
      if (typeof content === 'string') {
        if (content) {
          this.emit('event', { kind: 'jsonl-user', text: content } satisfies JsonlEvent);
        }
        return;
      }
      // Tool-result wrapper: content is an array of tool_result blocks.
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type !== 'tool_result') continue;
          this.emit('event', {
            kind: 'jsonl-tool-result',
            toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
            result: b.content,
            isError: b.is_error === true,
          } satisfies JsonlEvent);
        }
      }
      return;
    }

    if (type === 'assistant') {
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message) return;
      const content = message.content;
      // Tool calls are individual content blocks within an assistant message.
      // Emit each as its own event so the chat panel can render them
      // incrementally.
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type !== 'tool_use') continue;
          this.emit('event', {
            kind: 'jsonl-tool-call',
            toolUseId: typeof b.id === 'string' ? b.id : '',
            name: typeof b.name === 'string' ? b.name : '',
            input: b.input ?? null,
          } satisfies JsonlEvent);
        }
      }

      // Thinking blocks (extended thinking). Emit for any assistant entry
      // regardless of stop_reason — thinking appears in both mid-loop and
      // turn-end messages. `block.thinking` is the text field (not `text`).
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type !== 'thinking') continue;
          const thinkingText = typeof b.thinking === 'string' ? b.thinking : '';
          if (thinkingText) {
            this.emit('event', {
              kind: 'jsonl-thinking',
              text: thinkingText,
            } satisfies JsonlEvent);
          }
        }
      }

      // Usage block — Anthropic SDK response shape. Emit once per assistant
      // entry (whether mid-loop or turn-end), client sums for the session.
      // Section 31 enriches with `speed` (downgrade indicator) + the message's
      // top-level `diagnostics.cache_miss_reason` (cache-miss warning).
      const usage = message.usage;
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        const diagnostics =
          message.diagnostics && typeof message.diagnostics === 'object'
            ? (message.diagnostics as Record<string, unknown>)
            : null;
        this.emit('event', {
          kind: 'jsonl-usage',
          inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
          outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
          cacheCreationTokens:
            typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0,
          cacheReadTokens:
            typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0,
          model: typeof message.model === 'string' ? (message.model as string) : null,
          speed: typeof u.speed === 'string' ? (u.speed as string) : null,
          cacheMissReason:
            diagnostics && typeof diagnostics.cache_miss_reason === 'string'
              ? (diagnostics.cache_miss_reason as string)
              : null,
        } satisfies JsonlEvent);
      }
      // Turn-end fires for any stop_reason that means "model is no longer
      // working" — covers the four documented Stop-skip cases from CC's
      // src/query.ts:1267 (user interrupt, API error, max_tokens, reactive
      // compact). Mid-loop signals are `tool_use` (continuing with tool
      // execution) and `pause_turn` (extended thinking pause). Everything
      // else — including `null` (verified empirically as the user-interrupt
      // signature: assistant line lands with stop_reason:null, followed
      // immediately by a user message containing "[Request interrupted by
      // user]") — is treated as a turn-end.
      const stopReason = message.stop_reason as string | null | undefined;
      const isMidLoop = stopReason === 'tool_use' || stopReason === 'pause_turn';
      const hasStopReasonField = 'stop_reason' in message;
      // Mid-loop assistant text (preamble written before tool calls). Previously
      // dropped — the turn-end branch below only runs for !isMidLoop entries.
      if (isMidLoop && Array.isArray(content)) {
        const midText = content
          .filter(
            (b): b is Record<string, unknown> =>
              !!b &&
              typeof b === 'object' &&
              (b as Record<string, unknown>).type === 'text' &&
              typeof (b as Record<string, unknown>).text === 'string',
          )
          .map((b) => b.text as string)
          .join('\n');
        if (midText) {
          this.emit('event', {
            kind: 'jsonl-assistant-text',
            text: midText,
            midLoop: true,
          } satisfies JsonlEvent);
        }
      }
      if (hasStopReasonField && !isMidLoop) {
        const text = Array.isArray(content)
          ? content
              .filter(
                (b): b is Record<string, unknown> =>
                  !!b &&
                  typeof b === 'object' &&
                  (b as Record<string, unknown>).type === 'text' &&
                  typeof (b as Record<string, unknown>).text === 'string',
              )
              .map((b) => b.text as string)
              .join('\n')
          : '';
        this.emit('event', {
          kind: 'jsonl-turn-end',
          text,
          stopReason: stopReason ?? null,
        } satisfies JsonlEvent);
      }
      return;
    }

    if (type === 'system') {
      const subtype = typeof entry.subtype === 'string' ? entry.subtype : '';
      if (!subtype) return;
      const level = typeof entry.level === 'string' ? entry.level : 'info';
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;

      // Section 31 — kept subtypes that warrant distinct rendering shapes also
      // get their own typed envelope. The generic jsonl-system below still
      // fires so legacy consumers keep working.
      if (subtype === 'session_state_changed') {
        const state = typeof entry.state === 'string' ? entry.state : '';
        const permissionMode =
          typeof entry.permissionMode === 'string' ? entry.permissionMode : null;
        if (state) {
          this.emit('event', {
            kind: 'jsonl-session-state',
            state,
            permissionMode,
            timestamp,
            raw: entry,
          } satisfies JsonlEvent);
        }
      } else if (subtype === 'compact_boundary') {
        const meta =
          entry.compactMetadata && typeof entry.compactMetadata === 'object'
            ? (entry.compactMetadata as Record<string, unknown>)
            : null;
        this.emit('event', {
          kind: 'jsonl-compact',
          trigger: meta && typeof meta.trigger === 'string' ? (meta.trigger as string) : null,
          preTokens:
            meta && typeof meta.preTokens === 'number' ? (meta.preTokens as number) : null,
          messagesSummarized:
            meta && typeof meta.messagesSummarized === 'number'
              ? (meta.messagesSummarized as number)
              : null,
          timestamp,
          raw: entry,
        } satisfies JsonlEvent);
      } else if (subtype === 'microcompact_boundary') {
        const meta =
          entry.microcompactMetadata && typeof entry.microcompactMetadata === 'object'
            ? (entry.microcompactMetadata as Record<string, unknown>)
            : null;
        this.emit('event', {
          kind: 'jsonl-microcompact',
          trigger: meta && typeof meta.trigger === 'string' ? (meta.trigger as string) : null,
          preTokens:
            meta && typeof meta.preTokens === 'number' ? (meta.preTokens as number) : null,
          tokensSaved:
            meta && typeof meta.tokensSaved === 'number' ? (meta.tokensSaved as number) : null,
          timestamp,
          raw: entry,
        } satisfies JsonlEvent);
      } else if (subtype === 'turn_duration') {
        this.emit('event', {
          kind: 'jsonl-turn-duration',
          durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : null,
          budgetTokens: typeof entry.budgetTokens === 'number' ? entry.budgetTokens : null,
          messageCount: typeof entry.messageCount === 'number' ? entry.messageCount : null,
          timestamp,
          raw: entry,
        } satisfies JsonlEvent);
      } else if (subtype === 'post_turn_summary') {
        this.emit('event', {
          kind: 'jsonl-post-turn-summary',
          summarizesUuid:
            typeof entry.summarizes_uuid === 'string' ? (entry.summarizes_uuid as string) : null,
          statusCategory:
            typeof entry.status_category === 'string' ? (entry.status_category as string) : null,
          statusDetail:
            typeof entry.status_detail === 'string' ? (entry.status_detail as string) : null,
          isNoteworthy: entry.is_noteworthy === true,
          title: typeof entry.title === 'string' ? (entry.title as string) : null,
          description: typeof entry.description === 'string' ? (entry.description as string) : null,
          recentAction:
            typeof entry.recent_action === 'string' ? (entry.recent_action as string) : null,
          needsAction: entry.needs_action === true,
          artifactUrls: entry.artifact_urls ?? null,
          timestamp,
          raw: entry,
        } satisfies JsonlEvent);
      }

      // Generic jsonl-system fires for EVERY subtype with the formatter's
      // best-effort label. The chat panel decides what to render based on
      // subtype (subtypes with typed envelopes get rendered through those
      // instead). Per [[hand-user-everything]]: the user must see every
      // status-line surface, so we don't pre-filter at the tailer.
      this.emit('event', {
        kind: 'jsonl-system',
        subtype,
        level,
        message: formatSystemMessage(subtype, entry),
        timestamp,
        raw: entry,
      } satisfies JsonlEvent);
      return;
    }

    // Section 31 — top-level metadata types CC writes alongside conversation
    // rows. Previously dropped at this fall-through; now decoded into typed
    // envelopes so the web side can drive session title, remote-control
    // corner indicator, and internal plumbing surfaces.
    if (type === 'ai-title') {
      // CC writes the title as `aiTitle` (camelCase), NOT `title`. Verified
      // 2026-05-25 against live JSONL — every captured ai-title row carries
      // `aiTitle`. Tolerate `title` as a fallback in case the field renames
      // upstream.
      const titleVal =
        typeof entry.aiTitle === 'string'
          ? (entry.aiTitle as string)
          : typeof entry.title === 'string'
            ? (entry.title as string)
            : '';
      if (titleVal) {
        this.emit('event', { kind: 'jsonl-ai-title', title: titleVal } satisfies JsonlEvent);
      }
      return;
    }

    if (type === 'last-prompt') {
      this.emit('event', {
        kind: 'jsonl-last-prompt',
        uuid: typeof entry.uuid === 'string' ? (entry.uuid as string) : null,
        raw: entry,
      } satisfies JsonlEvent);
      return;
    }

    if (type === 'file-history-snapshot') {
      this.emit('event', {
        kind: 'jsonl-file-history',
        snapshotId: typeof entry.snapshotId === 'string' ? (entry.snapshotId as string) : null,
        raw: entry,
      } satisfies JsonlEvent);
      return;
    }

    if (type === 'bridge-session') {
      this.emit('event', {
        kind: 'jsonl-bridge-session',
        bridgeSessionId:
          typeof entry.bridgeSessionId === 'string' ? (entry.bridgeSessionId as string) : null,
        raw: entry,
      } satisfies JsonlEvent);
      return;
    }

    if (type === 'tool_progress') {
      this.emit('event', {
        kind: 'jsonl-tool-progress',
        toolUseId: typeof entry.tool_use_id === 'string' ? (entry.tool_use_id as string) : '',
        toolName: typeof entry.tool_name === 'string' ? (entry.tool_name as string) : '',
        parentToolUseId:
          typeof entry.parent_tool_use_id === 'string'
            ? (entry.parent_tool_use_id as string)
            : null,
        elapsedSeconds:
          typeof entry.elapsed_time_seconds === 'number'
            ? (entry.elapsed_time_seconds as number)
            : null,
        taskId: typeof entry.task_id === 'string' ? (entry.task_id as string) : null,
        raw: entry,
      } satisfies JsonlEvent);
      return;
    }

    if (type === 'stream_event') {
      this.emit('event', {
        kind: 'jsonl-stream-event',
        event: entry.event ?? null,
        parentToolUseId:
          typeof entry.parent_tool_use_id === 'string'
            ? (entry.parent_tool_use_id as string)
            : null,
        raw: entry,
      } satisfies JsonlEvent);
      return;
    }

    // Cut signals (permission-mode, agent-setting, etc.) + truly unknown
    // shapes — drop silently. CC adds shapes over time; we tolerate the
    // unknown without bloating the event surface.
  }
}

/** Build a one-line plain-English summary of a `type: 'system'` row. Used
 *  for the chat-bubble label; the raw entry rides along so the panel can
 *  expand for the technically curious. Per [[hand-user-everything]]: this
 *  is what the user would have seen in the CLI's status line, so phrase it
 *  like a status line — short, factual, no jargon. */
function formatSystemMessage(subtype: string, entry: Record<string, unknown>): string {
  if (subtype === 'api_error') {
    const errOuter = entry.error as Record<string, unknown> | undefined;
    const status =
      errOuter && typeof errOuter.status === 'number' ? (errOuter.status as number) : null;
    // Anthropic SDK shape: error.error.error.{type,message}.
    let innerType = '';
    let innerMsg = '';
    if (errOuter && typeof errOuter.error === 'object' && errOuter.error) {
      const lvl1 = errOuter.error as Record<string, unknown>;
      if (typeof lvl1.error === 'object' && lvl1.error) {
        const lvl2 = lvl1.error as Record<string, unknown>;
        innerType = typeof lvl2.type === 'string' ? (lvl2.type as string) : '';
        innerMsg = typeof lvl2.message === 'string' ? (lvl2.message as string) : '';
      }
    }
    const retryInMs = typeof entry.retryInMs === 'number' ? (entry.retryInMs as number) : null;
    const attempt =
      typeof entry.retryAttempt === 'number' ? (entry.retryAttempt as number) : null;
    const maxRetries =
      typeof entry.maxRetries === 'number' ? (entry.maxRetries as number) : null;
    const head = innerMsg || innerType || 'API error';
    const statusBit = status !== null ? ` (HTTP ${status})` : '';
    if (attempt !== null && maxRetries !== null && retryInMs !== null) {
      const secs = (retryInMs / 1000).toFixed(1);
      return `${head}${statusBit} — retrying in ${secs}s (attempt ${attempt}/${maxRetries})`;
    }
    if (attempt !== null && maxRetries !== null) {
      return `${head}${statusBit} (attempt ${attempt}/${maxRetries})`;
    }
    return `${head}${statusBit}`;
  }

  if (subtype === 'api_retry') {
    // SDK-emitted retry envelope. Carries `attempt`, `max_retries`,
    // `retry_delay_ms`, `error_status`, `error`. Surface the same shape as
    // api_error so the chat reads consistently regardless of which path
    // claude.exe takes.
    const attempt = typeof entry.attempt === 'number' ? (entry.attempt as number) : null;
    const maxRetries =
      typeof entry.max_retries === 'number' ? (entry.max_retries as number) : null;
    const delayMs =
      typeof entry.retry_delay_ms === 'number' ? (entry.retry_delay_ms as number) : null;
    const errStatus =
      typeof entry.error_status === 'number' ? (entry.error_status as number) : null;
    const errMsg = typeof entry.error === 'string' ? (entry.error as string) : '';
    const head = errMsg || 'API retry';
    const statusBit = errStatus !== null ? ` (HTTP ${errStatus})` : '';
    if (attempt !== null && maxRetries !== null && delayMs !== null) {
      const secs = (delayMs / 1000).toFixed(1);
      return `${head}${statusBit} — retrying in ${secs}s (attempt ${attempt}/${maxRetries})`;
    }
    if (attempt !== null && maxRetries !== null) {
      return `${head}${statusBit} (attempt ${attempt}/${maxRetries})`;
    }
    return `${head}${statusBit}`;
  }

  if (subtype === 'memory_saved') {
    // CC writes `writtenPaths: string[]` when auto-memory writes files.
    // Surface as "Saved to memory: <files>" — the user is about to wonder
    // why their conversation has changed.
    const written = Array.isArray(entry.writtenPaths) ? (entry.writtenPaths as unknown[]) : [];
    if (written.length === 0) return 'Saved to memory';
    if (written.length === 1) return `Saved to memory: ${written[0]}`;
    return `Saved ${written.length} entries to memory`;
  }

  if (subtype === 'files_persisted') {
    // CC writes `files: [{filename, file_id}], failed: [{filename, error}]`.
    // Surface count + the failure tail if any.
    const files = Array.isArray(entry.files) ? (entry.files as unknown[]) : [];
    const failed = Array.isArray(entry.failed) ? (entry.failed as unknown[]) : [];
    if (failed.length > 0) {
      return `Wrote ${files.length} file${files.length === 1 ? '' : 's'} (${failed.length} failed)`;
    }
    return `Wrote ${files.length} file${files.length === 1 ? '' : 's'}`;
  }

  if (subtype === 'init') {
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : '';
    return cwd ? `Session started — cwd ${cwd}` : 'Session started';
  }

  // Generic fallback: surface whatever scalar fields the row carries.
  const message = typeof entry.message === 'string' ? (entry.message as string) : '';
  if (message) return `[${subtype}] ${message}`;
  return `[${subtype}]`;
}
