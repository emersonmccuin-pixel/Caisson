import { useMemo } from 'react';

import { collapseDiff, computeLineDiff, diffStats } from '@/features/chat/lineDiff';

export function DiffView({
  oldText,
  newText,
  path,
}: {
  oldText: string;
  newText: string;
  path?: string;
}) {
  const lines = useMemo(() => computeLineDiff(oldText, newText), [oldText, newText]);
  const rows = useMemo(() => collapseDiff(lines), [lines]);
  const stats = useMemo(() => diffStats(lines), [lines]);

  return (
    <div className="border border-border font-mono text-[11px]">
      {/* Header — file path + ±counts */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-2 py-0.5">
        <span
          className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
          title={path}
        >
          {path ?? ''}
        </span>
        <span className="shrink-0 text-[10px]">
          {stats.added > 0 && <span className="text-success">+{stats.added}</span>}
          {stats.added > 0 && stats.removed > 0 && (
            <span className="text-muted-foreground"> </span>
          )}
          {stats.removed > 0 && <span className="text-destructive">−{stats.removed}</span>}
        </span>
      </div>

      {/* Body — scrollable, no line-wrap */}
      <div className="max-h-80 overflow-auto">
        <div className="min-w-max">
          {rows.length === 0 && (
            <div className="px-2 py-0.5 text-[10px] italic text-muted-foreground/60">
              (no changes)
            </div>
          )}
          {rows.map((row, idx) => {
            if (row.type === 'collapse') {
              return (
                <div
                  key={idx}
                  className="flex items-center gap-1 bg-muted/10 px-2 py-0.5 text-[10px] text-muted-foreground/50"
                >
                  <span>…</span>
                  <span>
                    {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
                  </span>
                </div>
              );
            }

            if (row.type === 'add') {
              return (
                <div key={idx} className="flex bg-success/10">
                  <span className="w-8 shrink-0 select-none px-1 text-right text-[10px] text-success/50">
                    {row.newLineNo}
                  </span>
                  <span className="w-5 shrink-0 select-none text-center text-[10px] text-success">
                    +
                  </span>
                  <span className="whitespace-pre px-1 text-foreground">{row.text}</span>
                </div>
              );
            }

            if (row.type === 'remove') {
              return (
                <div key={idx} className="flex bg-destructive/10">
                  <span className="w-8 shrink-0 select-none px-1 text-right text-[10px] text-destructive/50">
                    {row.oldLineNo}
                  </span>
                  <span className="w-5 shrink-0 select-none text-center text-[10px] text-destructive">
                    −
                  </span>
                  <span className="whitespace-pre px-1 text-foreground">{row.text}</span>
                </div>
              );
            }

            // context
            return (
              <div key={idx} className="flex">
                <span className="w-8 shrink-0 select-none px-1 text-right text-[10px] text-muted-foreground/40">
                  {row.oldLineNo}
                </span>
                <span className="w-5 shrink-0 select-none text-center text-[10px] text-muted-foreground/40">
                  {' '}
                </span>
                <span className="whitespace-pre px-1 text-muted-foreground/70">{row.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
