// Section 17d.7 — Settings tab.
//
// Top half: model / effort / maxTurns / tools edit controls. These bind into
// the modal-root draft state (saved on the modal footer's Save button
// alongside Prompt edits). ☠ outputDestination (M5/FD-5 — dead knob deleted).
//
// Bottom half: MCP registry attachment picker. Lets the user attach registered
// MCP servers (from the global/project registry) to this agent.
// pc-pty-chat-359 P4b: the old raw-JSON inline form was deleted.

import { useCallback, useEffect, useState } from 'react';

import type { ULID } from '@/features/projects/client';
import { type PodBundle } from '@/features/agents/client';
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
  /** Kept for interface compatibility — called after registry attachment changes. */
  onBundleChanged: () => void;
}

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function SettingsTab({
  podId,
  projectId,
  draft,
  bundle: _bundle,
  bundleLoading: _bundleLoading,
  bundleErr: _bundleErr,
  onDraftChange,
  onBundleChanged: _onBundleChanged,
}: SettingsTabProps) {
  return (
    <div className="flex flex-col gap-6">
      <ScalarSettings draft={draft} onChange={onDraftChange} />
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
