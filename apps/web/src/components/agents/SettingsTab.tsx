// Section 17d.7 — Settings tab.
//
// Top half: model / effort / maxTurns / tools edit controls. These bind into
// the modal-root draft state (saved on the modal footer's Save button
// alongside Prompt edits). ☠ outputDestination (M5/FD-5 — dead knob deleted).
//
// Bottom half: MCP servers subsection. Per-row Delete + raw-JSON "Add"
// form. No inline edit — replace via delete + add (matches the secrets
// pattern; keeps the surface small for v1 power-user use).

import { useState } from 'react';

import type { ULID } from '@/features/projects/client';
import { agentsApi, type PodBundle, type PodMcpServer, type PodMcpServerConfig } from '@/features/agents/client';

interface SettingsDraftSlice {
  model: string;
  effort: string;
  maxTurns: string;
  tools: string;
}

interface SettingsTabProps {
  podId: ULID;
  draft: SettingsDraftSlice;
  bundle: PodBundle | null;
  bundleLoading: boolean;
  bundleErr: string | null;
  onDraftChange: (patch: Partial<SettingsDraftSlice>) => void;
  onBundleChanged: () => void;
}

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function SettingsTab({
  podId,
  draft,
  bundle,
  bundleLoading,
  bundleErr,
  onDraftChange,
  onBundleChanged,
}: SettingsTabProps) {
  return (
    <div className="flex flex-col gap-6">
      <ScalarSettings draft={draft} onChange={onDraftChange} />
      <McpServersSection
        podId={podId}
        bundle={bundle}
        loading={bundleLoading}
        error={bundleErr}
        onChanged={onBundleChanged}
      />
    </div>
  );
}

function ScalarSettings({
  draft,
  onChange,
}: {
  draft: SettingsDraftSlice;
  onChange: (patch: Partial<SettingsDraftSlice>) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Agent settings
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Model">
          <input
            type="text"
            value={draft.model}
            onChange={(e) => onChange({ model: e.target.value })}
            placeholder="opus / sonnet / haiku / claude-opus-4-7"
            className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
          />
        </Field>
        <Field label="Effort">
          <select
            value={draft.effort}
            onChange={(e) => onChange({ effort: e.target.value })}
            className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
          >
            {EFFORTS.map((opt) => (
              <option key={opt || '__none__'} value={opt}>
                {opt || '(default)'}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Max turns" hint="Positive integer; blank = no cap.">
          <input
            type="number"
            min={1}
            value={draft.maxTurns}
            onChange={(e) => onChange({ maxTurns: e.target.value })}
            placeholder="(no cap)"
            className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
          />
        </Field>
      </div>
      <Field
        label="Tools allowlist"
        hint="Comma-separated. Leave empty to inherit CC defaults. mcp__server__* wildcards expand at materialise time."
      >
        <input
          type="text"
          value={draft.tools}
          onChange={(e) => onChange({ tools: e.target.value })}
          placeholder="Read, Glob, Grep, mcp__pc-rig__pc_get_work_item"
          className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
        />
      </Field>
      <p className="text-[10px] text-muted-foreground italic">
        Edits to these fields save via the modal's Save button (alongside
        Prompt edits).
      </p>
    </section>
  );
}

function McpServersSection({
  podId,
  bundle,
  loading,
  error,
  onChanged,
}: {
  podId: ULID;
  bundle: PodBundle | null;
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [configJson, setConfigJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  async function addServer() {
    if (busy) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setOpError('Server name is required.');
      return;
    }
    let config: PodMcpServerConfig;
    try {
      const parsed = JSON.parse(configJson) as PodMcpServerConfig;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Config must be a JSON object.');
      }
      config = parsed;
    } catch (e) {
      setOpError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    setBusy(true);
    setOpError(null);
    try {
      await agentsApi.createPodMcpServer(podId, { name: trimmedName, config });
      setAdding(false);
      setName('');
      setConfigJson('');
      onChanged();
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeServer(s: PodMcpServer) {
    const ok = window.confirm(`Delete MCP server "${s.name}"?`);
    if (!ok) return;
    setBusy(true);
    setOpError(null);
    try {
      await agentsApi.deletePodMcpServer(podId, s.id);
      onChanged();
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          MCP servers
        </h3>
        <button
          type="button"
          onClick={() => {
            setOpError(null);
            setAdding(true);
          }}
          disabled={busy || adding || loading}
          className="border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          + Add server
        </button>
      </div>

      {loading && <div className="text-xs text-muted-foreground">Loading…</div>}
      {error && <div className="text-xs text-destructive">{error}</div>}
      {opError && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {opError}
        </div>
      )}

      {adding && (
        <div className="border border-primary/60 bg-card px-3 py-2">
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Name
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="gmail / jira / pc-rig"
                className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Config (JSON)
              </span>
              <textarea
                value={configJson}
                onChange={(e) => setConfigJson(e.target.value)}
                rows={6}
                placeholder='{"command":"node","args":["/path/to/server.mjs"],"env":{"TOKEN":"…"}}'
                className="w-full border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none focus:border-primary"
              />
            </label>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setName('');
                setConfigJson('');
                setOpError(null);
              }}
              disabled={busy}
              className="border border-border bg-card px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={addServer}
              disabled={busy}
              className="border border-primary bg-primary/30 px-2 py-1 text-xs font-medium text-foreground hover:bg-primary/50 disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}

      {bundle && bundle.mcpServers.length === 0 && !adding && (
        <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No MCP servers attached to this pod. The pod inherits PC's session
          runtime MCP baseline on spawn.
        </div>
      )}

      {bundle && bundle.mcpServers.length > 0 && (
        <div className="flex flex-col gap-1">
          {bundle.mcpServers.map((s) => (
            <div key={s.id} className="border border-border bg-card px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs font-medium text-foreground">
                    {s.name}
                  </div>
                  <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
                    {JSON.stringify(s.config, null, 2)}
                  </pre>
                </div>
                <button
                  type="button"
                  onClick={() => void removeServer(s)}
                  disabled={busy}
                  className="border border-destructive/60 bg-card px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </label>
  );
}
