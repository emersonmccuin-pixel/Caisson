// Section 17d.8 — History tab.
//
// Reverse-chronological audit-log view with:
//   - Actor + field filter chips
//   - Change-set grouping (multi-field updates render as one card)
//   - Per-field rendering: prompt = before/after blocks; settings = side-by-
//     side; secrets = event-only (never values); knowledge/mcp = key + event
//   - Per-row revert (PATCH-back the prior_value)
//
// Revert is implemented for scalar agent fields (prompt / description /
// model / effort / max_turns / tools / name). Reverts of knowledge / secret /
// mcp_server / created / deleted rows are not supported — the buildout's
// revert scope is the scalar fields; restoring a deleted knowledge row is a
// recreate-by-hand path. ☠ output_destination (M5/FD-5): historical audit
// rows still render, but the field is gone — no filter chip, no revert.

import { useCallback, useEffect, useState } from 'react';

import type { ULID } from '@/features/projects/client';
import { agentsApi, type PodAuditActor, type PodAuditEntry, type PodAuditField } from '@/features/agents/client';

interface HistoryTabProps {
  podId: ULID;
}

const ALL_ACTORS = ['orchestrator', 'user'] as const;

const FIELD_FILTERS: { value: '' | PodAuditField; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'prompt', label: 'Prompt' },
  { value: 'description', label: 'Description' },
  { value: 'model', label: 'Model' },
  { value: 'effort', label: 'Effort' },
  { value: 'max_turns', label: 'Max turns' },
  { value: 'tools', label: 'Tools' },
  { value: 'name', label: 'Name' },
  { value: 'context-doc', label: 'Context doc' },
  // Legacy filter — pre-0055 rows only (knowledge merged into context docs).
  { value: 'knowledge', label: 'Knowledge (legacy)' },
  { value: 'secret', label: 'Secret' },
  { value: 'mcp_server', label: 'MCP server' },
];

/** Scalar agent fields where revert (PATCH prior_value back) is supported. */
const REVERTABLE_FIELDS: ReadonlySet<PodAuditField> = new Set([
  'prompt',
  'description',
  'model',
  'effort',
  'max_turns',
  'tools',
  'name',
]);

const AUDIT_FIELD_TO_PATCH_KEY: Record<string, string> = {
  max_turns: 'maxTurns',
};

interface Group {
  /** changeSetId or `solo:<rowId>` */
  key: string;
  rows: PodAuditEntry[];
  /** Newest row in the group (rows are newest-first within the group). */
  createdAt: number;
  actor: PodAuditActor;
}

function groupRows(rows: PodAuditEntry[]): Group[] {
  // Rows arrive newest-first. Walk in order and bucket by changeSetId; solo
  // rows (changeSetId === null) get their own key.
  const map = new Map<string, Group>();
  const order: Group[] = [];
  for (const r of rows) {
    const key = r.changeSetId ? `cs:${r.changeSetId}` : `solo:${r.id}`;
    let g = map.get(key);
    if (!g) {
      g = { key, rows: [], createdAt: r.createdAt, actor: r.actor };
      map.set(key, g);
      order.push(g);
    }
    g.rows.push(r);
  }
  return order;
}

export function HistoryTab({ podId }: HistoryTabProps) {
  const [rows, setRows] = useState<PodAuditEntry[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [actor, setActor] = useState<'' | PodAuditActor>('');
  const [field, setField] = useState<'' | PodAuditField>('');
  const [revertBusy, setRevertBusy] = useState(false);
  const [revertErr, setRevertErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setRows(null);
    setLoadErr(null);
    const opts: Parameters<typeof agentsApi.listPodAudit>[1] = { limit: 100 };
    if (actor) opts.actor = actor;
    if (field) opts.field = field;
    agentsApi.listPodAudit(podId, opts)
      .then((r) => setRows(r))
      .catch((e: unknown) => setLoadErr((e as Error).message));
  }, [podId, actor, field]);

  useEffect(() => {
    load();
  }, [load]);

  async function revert(row: PodAuditEntry) {
    if (revertBusy) return;
    if (!REVERTABLE_FIELDS.has(row.field)) {
      window.alert(`Revert isn't supported for field type "${row.field}".`);
      return;
    }
    const ok = window.confirm(
      `Revert this ${row.field} edit?\n\nThe field will be patched back to its prior value.`,
    );
    if (!ok) return;
    setRevertBusy(true);
    setRevertErr(null);
    try {
      const patchKey = AUDIT_FIELD_TO_PATCH_KEY[row.field] ?? row.field;
      // The audit prior_value is a JSON-encoded string. For null fields it's
      // the literal "null"; for strings it's the quoted form; for arrays it's
      // a JSON array. Unwrap with JSON.parse.
      const priorRaw = row.priorValue;
      const decoded = priorRaw === null ? null : JSON.parse(priorRaw);
      await agentsApi.patchPod(podId, { [patchKey]: decoded });
      load();
    } catch (e) {
      setRevertErr((e as Error).message);
    } finally {
      setRevertBusy(false);
    }
  }

  async function revertChangeSet(group: Group) {
    if (revertBusy) return;
    const revertable = group.rows.filter((r) => REVERTABLE_FIELDS.has(r.field));
    if (revertable.length === 0) {
      window.alert('No revertable fields in this change set.');
      return;
    }
    const ok = window.confirm(
      `Revert all ${revertable.length} field${
        revertable.length === 1 ? '' : 's'
      } in this change set?`,
    );
    if (!ok) return;
    setRevertBusy(true);
    setRevertErr(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const r of revertable) {
        const patchKey = AUDIT_FIELD_TO_PATCH_KEY[r.field] ?? r.field;
        patch[patchKey] = r.priorValue === null ? null : JSON.parse(r.priorValue);
      }
      await agentsApi.patchPod(podId, patch);
      load();
    } catch (e) {
      setRevertErr((e as Error).message);
    } finally {
      setRevertBusy(false);
    }
  }

  if (loadErr) return <div className="text-xs text-destructive">{loadErr}</div>;
  if (rows === null) return <div className="text-xs text-muted-foreground">Loading…</div>;
  const groups = groupRows(rows);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Actor:</span>
        <FilterChip
          active={actor === ''}
          onClick={() => setActor('')}
          label="All"
        />
        {ALL_ACTORS.map((a) => (
          <FilterChip
            key={a}
            active={actor === a}
            onClick={() => setActor(a)}
            label={a}
          />
        ))}
        <span className="ml-2 text-muted-foreground">Field:</span>
        <select
          value={field}
          onChange={(e) => setField(e.target.value as '' | PodAuditField)}
          className="border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
        >
          {FIELD_FILTERS.map((opt) => (
            <option key={opt.value || '__all__'} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {revertErr && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {revertErr}
          <button onClick={() => setRevertErr(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No audit entries match the active filters.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((g) => (
            <GroupCard
              key={g.key}
              group={g}
              revertBusy={revertBusy}
              onRevertRow={revert}
              onRevertChangeSet={revertChangeSet}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'border px-2 py-0.5 text-[10px] uppercase tracking-wider ' +
        (active
          ? 'border-primary bg-primary/30 text-foreground'
          : 'border-border bg-card text-muted-foreground hover:bg-muted')
      }
    >
      {label}
    </button>
  );
}

function GroupCard({
  group,
  revertBusy,
  onRevertRow,
  onRevertChangeSet,
}: {
  group: Group;
  revertBusy: boolean;
  onRevertRow: (row: PodAuditEntry) => void;
  onRevertChangeSet: (group: Group) => void;
}) {
  const isChangeSet = group.rows.length > 1;
  const head = group.rows[0]!;
  return (
    <div className="border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className="font-medium">{head.actor}</span>
        <span>·</span>
        <span>{new Date(head.createdAt).toLocaleString()}</span>
        {isChangeSet && (
          <>
            <span>·</span>
            <span>change set ({group.rows.length} fields)</span>
          </>
        )}
        {head.reason && (
          <>
            <span>·</span>
            <span className="italic">{head.reason}</span>
          </>
        )}
        {isChangeSet && (
          <button
            type="button"
            onClick={() => onRevertChangeSet(group)}
            disabled={revertBusy}
            className="ml-auto border border-border bg-card px-2 py-0.5 text-[10px] normal-case tracking-normal hover:bg-muted disabled:opacity-50"
          >
            Revert all
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {group.rows.map((r) => (
          <FieldRow
            key={r.id}
            row={r}
            revertBusy={revertBusy}
            onRevertRow={onRevertRow}
          />
        ))}
      </div>
    </div>
  );
}

function FieldRow({
  row,
  revertBusy,
  onRevertRow,
}: {
  row: PodAuditEntry;
  revertBusy: boolean;
  onRevertRow: (row: PodAuditEntry) => void;
}) {
  const revertable = REVERTABLE_FIELDS.has(row.field);
  return (
    <div className="border-l-2 border-primary/40 pl-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono font-medium text-foreground">{row.field}</span>
        {row.fieldRef && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono text-[10px] text-muted-foreground">{row.fieldRef}</span>
          </>
        )}
        {revertable && (
          <button
            type="button"
            onClick={() => onRevertRow(row)}
            disabled={revertBusy}
            className="ml-auto border border-border bg-card px-2 py-0.5 text-[10px] hover:bg-muted disabled:opacity-50"
          >
            Revert
          </button>
        )}
      </div>
      <ValueDiff row={row} />
    </div>
  );
}

/** Render the row's prior/new values based on the field type. */
function ValueDiff({ row }: { row: PodAuditEntry }) {
  if (row.field === 'secret') {
    // Event-only — values never enter the audit table.
    const verb = row.priorValue === null ? 'added' : 'removed';
    return (
      <div className="mt-1 text-[11px] text-muted-foreground">
        Secret <span className="font-mono">{row.fieldRef ?? '(unnamed)'}</span> {verb}.
      </div>
    );
  }
  if (row.field === 'created') {
    return (
      <div className="mt-1 text-[11px] text-muted-foreground">Agent created.</div>
    );
  }
  if (row.field === 'deleted') {
    return (
      <div className="mt-1 text-[11px] text-muted-foreground">Agent soft-deleted.</div>
    );
  }
  if (row.field === 'knowledge' || row.field === 'context-doc') {
    const noun = row.field === 'knowledge' ? 'Knowledge doc' : 'Context doc';
    if (row.priorValue === null) {
      return (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {noun} <span className="font-mono">{row.fieldRef ?? '(unnamed)'}</span> created.
        </div>
      );
    }
    if (row.newValue === null) {
      return (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {noun} <span className="font-mono">{row.fieldRef ?? '(unnamed)'}</span> deleted.
        </div>
      );
    }
    return (
      <div className="mt-1 text-[11px] text-muted-foreground">
        {noun} <span className="font-mono">{row.fieldRef ?? '(unnamed)'}</span> updated.
      </div>
    );
  }
  if (row.field === 'mcp_server') {
    if (row.priorValue === null) {
      return (
        <div className="mt-1 text-[11px] text-muted-foreground">
          MCP server <span className="font-mono">{row.fieldRef ?? '(unnamed)'}</span> added.
        </div>
      );
    }
    return (
      <div className="mt-1 text-[11px] text-muted-foreground">
        MCP server <span className="font-mono">{row.fieldRef ?? '(unnamed)'}</span> removed.
      </div>
    );
  }
  // Scalar fields — prompt gets before/after blocks (multiline-friendly),
  // others get a compact inline "X → Y" rendering.
  if (row.field === 'prompt') {
    return <PromptDiff prior={row.priorValue} next={row.newValue} />;
  }
  return <InlineDiff prior={row.priorValue} next={row.newValue} />;
}

function PromptDiff({
  prior,
  next,
}: {
  prior: string | null;
  next: string | null;
}) {
  return (
    <div className="mt-1 grid grid-cols-1 gap-1">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Before
        </div>
        <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground">
          {unwrapJson(prior) ?? '(empty)'}
        </pre>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          After
        </div>
        <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap border border-border bg-background px-2 py-1 font-mono text-[10px] text-foreground">
          {unwrapJson(next) ?? '(empty)'}
        </pre>
      </div>
    </div>
  );
}

function InlineDiff({
  prior,
  next,
}: {
  prior: string | null;
  next: string | null;
}) {
  const before = unwrapJson(prior) ?? '(none)';
  const after = unwrapJson(next) ?? '(none)';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[10px]">
      <span className="text-muted-foreground line-through">{before}</span>
      <span className="text-muted-foreground">→</span>
      <span className="text-foreground">{after}</span>
    </div>
  );
}

/** Audit values are JSON-encoded — strings come back quoted, arrays as
 *  JSON arrays, etc. This helper unwraps for display so quotes don't
 *  leak into the UI. */
function unwrapJson(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw);
    if (v === null) return '(null)';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  } catch {
    return raw;
  }
}
