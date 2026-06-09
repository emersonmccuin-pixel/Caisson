// Section 17d.7 — Settings tab.
//
// Top half: model / effort / maxTurns / tools edit controls. These bind into
// the modal-root draft state (saved on the modal footer's Save button
// alongside Prompt edits). ☠ outputDestination (M5/FD-5 — dead knob deleted).
//
// Bottom half: MCP servers subsection. Per-row Delete + raw-JSON "Add"
// form. No inline edit — replace via delete + add (matches the secrets
// pattern; keeps the surface small for v1 power-user use).

import { useCallback, useEffect, useState } from 'react';

import type { ULID } from '@/features/projects/client';
import { agentsApi, type PodBundle, type PodMcpServer, type PodMcpServerConfig } from '@/features/agents/client';
import { mcpAttachmentsApi, mcpServersApi, type AgentMcpAttachment, type McpServer } from '@/features/mcp-servers/client';

interface SettingsDraftSlice {
  model: string;
  effort: string;
  maxTurns: string;
  tools: string;
}

interface SettingsTabProps {
  podId: ULID;
  /** Project id for loading project-scoped registry servers. Null for global agents. */
  projectId?: ULID | null;
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
  projectId,
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
      <RegistryMcpSection podId={podId} projectId={projectId ?? null} />
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

// ── Registry MCP Section ─────────────────────────────────────────────────────
//
// Lets the user attach registered MCP servers (from the global/project
// registry) to this agent, and choose which tools the agent gets from each.
// Backed by the agent_mcp_attachments table (P3 — pc-pty-chat-359.3).

function RegistryMcpSection({
  podId,
  projectId,
}: {
  podId: ULID;
  projectId: string | null;
}) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [attachments, setAttachments] = useState<AgentMcpAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [opError, setOpError] = useState<string | null>(null);
  // Track which server is currently open for tool selection (its id, or null).
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setOpError(null);
    // Load global + project registry servers in parallel with current attachments.
    Promise.all([
      mcpServersApi.listGlobal(),
      projectId ? mcpServersApi.listForProject(projectId) : Promise.resolve<McpServer[]>([]),
      mcpAttachmentsApi.listForAgent(podId),
    ])
      .then(([globals, project, attachs]) => {
        // Deduplicate by id (in case a server is somehow in both lists).
        const seen = new Set<string>();
        const all: McpServer[] = [];
        for (const s of [...globals, ...project]) {
          if (!seen.has(s.id)) { seen.add(s.id); all.push(s); }
        }
        setServers(all);
        setAttachments(attachs);
        setLoading(false);
      })
      .catch((e: Error) => {
        setOpError(e.message);
        setLoading(false);
      });
  }, [podId, projectId]);

  useEffect(() => { reload(); }, [reload]);

  const attachmentByServerId = new Map(attachments.map((a) => [a.mcpServerId, a]));

  async function toggleAttach(server: McpServer) {
    if (busy) return;
    setBusy(true);
    setOpError(null);
    try {
      const existing = attachmentByServerId.get(server.id);
      if (existing) {
        await mcpAttachmentsApi.detach(podId, server.id);
        setExpandedServerId(null);
      } else {
        // Attach with '*' (all tools) by default — user can narrow after.
        await mcpAttachmentsApi.upsert(podId, server.id, { enabledTools: '*' });
        setExpandedServerId(server.id);
      }
      reload();
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function updateToolSelection(server: McpServer, enabledTools: string[] | '*') {
    if (busy) return;
    setBusy(true);
    setOpError(null);
    try {
      await mcpAttachmentsApi.upsert(podId, server.id, { enabledTools });
      reload();
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Registry MCP Servers
      </h3>
      <p className="text-[10px] text-muted-foreground">
        Attach servers from the global registry. Tick which tools this agent can use.
      </p>

      {loading && <div className="text-xs text-muted-foreground">Loading…</div>}
      {opError && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {opError}
        </div>
      )}

      {!loading && servers.length === 0 && (
        <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No servers in the registry. Add them in Global Settings → MCP Servers.
        </div>
      )}

      {!loading && servers.length > 0 && (
        <div className="flex flex-col gap-1">
          {servers.map((server) => {
            const attachment = attachmentByServerId.get(server.id);
            const attached = !!attachment;
            const expanded = expandedServerId === server.id;
            return (
              <div
                key={server.id}
                className="border border-border bg-card"
              >
                {/* Server row */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <input
                    type="checkbox"
                    id={`reg-attach-${server.id}`}
                    checked={attached}
                    disabled={busy}
                    onChange={() => void toggleAttach(server)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <label
                    htmlFor={`reg-attach-${server.id}`}
                    className="flex-1 cursor-pointer select-none font-mono text-xs font-medium text-foreground"
                  >
                    {server.name}
                    {server.scope === 'project' && (
                      <span className="ml-1.5 text-[9px] text-muted-foreground">(project)</span>
                    )}
                  </label>
                  {attached && (
                    <button
                      type="button"
                      onClick={() => setExpandedServerId(expanded ? null : server.id)}
                      className="text-[10px] text-muted-foreground underline hover:text-foreground"
                    >
                      {expanded ? 'hide tools' : 'tools'}
                    </button>
                  )}
                  {attached && attachment && (
                    <span className="text-[9px] text-muted-foreground">
                      {attachment.enabledTools === '*' ? 'all tools' : `${(attachment.enabledTools as string[]).length} tool(s)`}
                    </span>
                  )}
                </div>

                {/* Tool selector — only when attached and expanded */}
                {attached && expanded && attachment && (
                  <ToolSelector
                    server={server}
                    enabledTools={attachment.enabledTools}
                    busy={busy}
                    onUpdate={(sel) => void updateToolSelection(server, sel)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ToolSelector({
  server,
  enabledTools,
  busy,
  onUpdate,
}: {
  server: McpServer;
  enabledTools: string[] | '*';
  busy: boolean;
  onUpdate: (selection: string[] | '*') => void;
}) {
  const tools = server.discoveredTools ?? [];
  const allSelected = enabledTools === '*';

  function toggleAll() {
    onUpdate(allSelected ? [] : '*');
  }

  function toggleTool(tool: string) {
    if (enabledTools === '*') {
      // Switch from '*' to explicit list minus this tool
      onUpdate(tools.filter((t) => t !== tool));
    } else {
      const current = enabledTools as string[];
      if (current.includes(tool)) {
        onUpdate(current.filter((t) => t !== tool));
      } else {
        const next = [...current, tool];
        // If all tools are selected, simplify to '*'
        onUpdate(next.length === tools.length ? '*' : next);
      }
    }
  }

  function isToolEnabled(tool: string): boolean {
    if (enabledTools === '*') return true;
    return (enabledTools as string[]).includes(tool);
  }

  return (
    <div className="border-t border-border px-3 py-2">
      {tools.length === 0 && server.discoveryStatus !== 'ok' && (
        <p className="text-[10px] text-muted-foreground italic">
          No tools discovered yet. Run a probe on this server in the registry settings.
        </p>
      )}
      {tools.length === 0 && server.discoveryStatus === 'ok' && (
        <p className="text-[10px] text-muted-foreground italic">
          Server reports no tools.
        </p>
      )}
      {tools.length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={busy}
              onChange={toggleAll}
              className="h-3 w-3 accent-primary"
            />
            <span className="text-[10px] font-medium text-foreground">All tools</span>
          </label>
          <div className="ml-4 flex flex-col gap-0.5 max-h-40 overflow-y-auto">
            {tools.map((tool) => (
              <label key={tool} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isToolEnabled(tool)}
                  disabled={busy}
                  onChange={() => toggleTool(tool)}
                  className="h-3 w-3 accent-primary"
                />
                <span className="font-mono text-[10px] text-foreground">{tool}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Field helper ──────────────────────────────────────────────────────────────

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
