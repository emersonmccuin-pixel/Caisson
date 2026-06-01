import { useMemo, useState, type ReactNode } from 'react';

import { DiffView } from '@/features/chat/DiffView';
import { summarizeInput } from '@/features/chat/runtimeState';
import type { ToolCall } from '@/features/chat/types';

function resultToString(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function ToolCallDetails({ call }: { call: ToolCall }) {
  const inputStr = useMemo(() => {
    if (call.input == null) return '';
    if (typeof call.input === 'string') return call.input;
    try {
      return JSON.stringify(call.input, null, 2);
    } catch {
      return String(call.input);
    }
  }, [call.input]);
  const resultStr = resultToString(call.result);
  const isEdit = call.tool === 'Edit' && call.input && typeof call.input === 'object';
  const isWrite = call.tool === 'Write' && call.input && typeof call.input === 'object';
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-2">
      {isEdit ? (
        <EditDiff input={call.input as Record<string, unknown>} />
      ) : isWrite ? (
        <WritePreview input={call.input as Record<string, unknown>} />
      ) : inputStr ? (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            input
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-1.5 font-mono text-[11px] text-foreground">
            {inputStr}
          </pre>
        </div>
      ) : null}
      {call.ended ? (
        resultStr ? (
          <div>
            <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              result
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-1.5 font-mono text-[11px] text-foreground">
              {resultStr}
            </pre>
          </div>
        ) : (
          <div className="text-[11px] italic text-muted-foreground">(no result text)</div>
        )
      ) : (
        <div className="text-[11px] italic text-muted-foreground">running…</div>
      )}
    </div>
  );
}

export function EditBubble({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const input = (call.input ?? {}) as Record<string, unknown>;
  const path =
    typeof input.file_path === 'string'
      ? (input.file_path as string)
      : typeof input.notebook_path === 'string'
        ? (input.notebook_path as string)
        : '';
  const running = !call.ended;

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-muted-foreground hover:text-foreground"
      >
        <span className="font-mono text-[10px]">{open ? '▼' : '▶'}</span>
        <span className="font-medium uppercase tracking-wider">{call.tool}</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px]"
          title={path}
        >
          {path || '(no path)'}
        </span>
        {running ? (
          <span className="thinking-dots inline-flex shrink-0 items-center gap-0.5">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[10px] text-success">✓</span>
        )}
      </button>
      {open && (
        <div className="mt-1.5 border border-border bg-card px-3 py-2">
          <ToolCallDetails call={call} />
        </div>
      )}
    </div>
  );
}

export function EditDiff({ input }: { input: Record<string, unknown> }) {
  const path = typeof input.file_path === 'string' ? (input.file_path as string) : '';
  const oldStr = typeof input.old_string === 'string' ? (input.old_string as string) : '';
  const newStr = typeof input.new_string === 'string' ? (input.new_string as string) : '';
  return <DiffView oldText={oldStr} newText={newStr} path={path || undefined} />;
}

export function WritePreview({ input }: { input: Record<string, unknown> }) {
  const path = typeof input.file_path === 'string' ? (input.file_path as string) : '';
  const content = typeof input.content === 'string' ? (input.content as string) : '';
  // Write = new file: show as all-additions diff (oldText = "")
  return <DiffView oldText="" newText={content} path={path || undefined} />;
}

function ExpandCollapseChips({
  onExpandAll,
  onCollapseAll,
  scope,
}: {
  onExpandAll: () => void;
  onCollapseAll: () => void;
  scope: string;
}) {
  return (
    <div className="flex gap-1 text-[10px] uppercase tracking-wider">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onExpandAll();
        }}
        className="border border-border bg-background px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
        title={`Expand every ${scope}`}
      >
        expand all
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCollapseAll();
        }}
        className="border border-border bg-background px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
        title={`Collapse every ${scope}`}
      >
        collapse all
      </button>
    </div>
  );
}

export function ToolCallRow({
  call,
  open,
  onToggle,
}: {
  call: ToolCall;
  open: boolean;
  onToggle: () => void;
}) {
  const summary = summarizeInput(call.tool, call.input);
  return (
    <div className="border-l border-border pl-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-baseline gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="font-mono text-[10px]">{open ? '▼' : '▶'}</span>
        <span className="font-medium text-foreground">{call.tool}</span>
        {summary && <span className="truncate font-mono text-[11px] text-muted-foreground">{summary}</span>}
        {!call.ended && (
          <span className="ml-auto flex items-baseline gap-1.5 text-[10px] italic text-warning">
            running…
            {typeof call.progressElapsedSeconds === 'number' && (
              <span className="not-italic font-mono text-muted-foreground">
                · {formatElapsedSeconds(call.progressElapsedSeconds)}
              </span>
            )}
          </span>
        )}
      </button>
      {open && <ToolCallDetails call={call} />}
    </div>
  );
}

function formatElapsedSeconds(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}m${r.toString().padStart(2, '0')}s`;
}

export function ToolSubgroup({
  tool,
  calls,
  open,
  onToggle,
  onExpandAll,
  onCollapseAll,
  isRowOpen,
  toggleRow,
}: {
  tool: string;
  calls: ToolCall[];
  open: boolean;
  onToggle: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  isRowOpen: (c: ToolCall) => boolean;
  toggleRow: (c: ToolCall) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-baseline gap-1.5 text-left text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <span className="font-mono text-[10px]">{open ? '▼' : '▶'}</span>
          <span>{tool}</span>
          <span className="text-muted-foreground/70">({calls.length})</span>
        </button>
        {open && calls.length > 1 && (
          <ExpandCollapseChips
            onExpandAll={onExpandAll}
            onCollapseAll={onCollapseAll}
            scope={`${tool} call`}
          />
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-1 pl-3">
          {calls.map((c, i) => (
            <ToolCallRow
              key={`${c.toolUseId ?? c.startedAt}-${i}`}
              call={c}
              open={isRowOpen(c)}
              onToggle={() => toggleRow(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export type EventGroupStatusTone = 'info' | 'warning' | 'success' | 'error';

export function CollapsibleEventGroup({
  label,
  count,
  status,
  controls,
  open,
  onToggle,
  children,
}: {
  label: string;
  count?: number | string;
  status?: { text: string; tone?: EventGroupStatusTone };
  controls?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const toneCls: Record<EventGroupStatusTone, string> = {
    info: 'text-muted-foreground',
    warning: 'text-warning',
    success: 'text-success',
    error: 'text-destructive',
  };
  const tone = status?.tone ?? 'info';
  return (
    <div className="text-sm">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-baseline gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <span className="font-mono text-[10px]">{open ? '▼' : '▶'}</span>
          <span className="font-medium uppercase tracking-wider text-foreground">{label}</span>
          {count !== undefined && (
            <span className="text-muted-foreground/70">({count})</span>
          )}
          {status && (
            <span className={`text-[10px] italic ${toneCls[tone]}`}>· {status.text}</span>
          )}
        </button>
        {open && controls}
      </div>
      {open && <div className="mt-2 flex flex-col gap-2">{children}</div>}
    </div>
  );
}

export function ToolGroupBubble({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  const [rowsOpen, setRowsOpen] = useState<Record<string, boolean>>({});
  const [subgroupsOpen, setSubgroupsOpen] = useState<Record<string, boolean>>({});

  const byTool = useMemo(() => {
    const map = new Map<string, ToolCall[]>();
    for (const c of calls) {
      const list = map.get(c.tool) ?? [];
      list.push(c);
      map.set(c.tool, list);
    }
    return Array.from(map.entries());
  }, [calls]);

  const total = calls.length;
  const running = calls.filter((c) => !c.ended).length;

  const rowKey = (c: ToolCall) => `${c.toolUseId ?? c.startedAt}`;
  const isRowOpen = (c: ToolCall) => {
    const k = rowKey(c);
    return k in rowsOpen ? rowsOpen[k]! : false;
  };
  const toggleRow = (c: ToolCall) => {
    const k = rowKey(c);
    setRowsOpen((prev) => ({ ...prev, [k]: !isRowOpen(c) }));
  };
  const isSubgroupOpen = (tool: string) =>
    tool in subgroupsOpen ? subgroupsOpen[tool]! : true;
  const toggleSubgroup = (tool: string) =>
    setSubgroupsOpen((prev) => ({ ...prev, [tool]: !isSubgroupOpen(tool) }));

  function expandAll() {
    setOpen(true);
    const r: Record<string, boolean> = {};
    const s: Record<string, boolean> = {};
    for (const c of calls) {
      r[rowKey(c)] = true;
      s[c.tool] = true;
    }
    setRowsOpen(r);
    setSubgroupsOpen(s);
  }
  function collapseAll() {
    const r: Record<string, boolean> = {};
    const s: Record<string, boolean> = {};
    for (const c of calls) {
      r[rowKey(c)] = false;
      s[c.tool] = false;
    }
    setRowsOpen(r);
    setSubgroupsOpen(s);
  }
  function expandSubgroup(tool: string) {
    setSubgroupsOpen((prev) => ({ ...prev, [tool]: true }));
    setRowsOpen((prev) => {
      const next = { ...prev };
      for (const c of calls) if (c.tool === tool) next[rowKey(c)] = true;
      return next;
    });
  }
  function collapseSubgroup(tool: string) {
    setRowsOpen((prev) => {
      const next = { ...prev };
      for (const c of calls) if (c.tool === tool) next[rowKey(c)] = false;
      return next;
    });
  }

  return (
    <CollapsibleEventGroup
      label="Tool calls"
      count={total}
      status={running > 0 ? { text: `${running} running`, tone: 'warning' } : undefined}
      controls={
        <ExpandCollapseChips
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
          scope="call"
        />
      }
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {byTool.map(([tool, list]) => (
        <ToolSubgroup
          key={tool}
          tool={tool}
          calls={list}
          open={isSubgroupOpen(tool)}
          onToggle={() => toggleSubgroup(tool)}
          onExpandAll={() => expandSubgroup(tool)}
          onCollapseAll={() => collapseSubgroup(tool)}
          isRowOpen={isRowOpen}
          toggleRow={toggleRow}
        />
      ))}
    </CollapsibleEventGroup>
  );
}
