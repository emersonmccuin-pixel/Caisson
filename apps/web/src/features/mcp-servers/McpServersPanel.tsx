// pc-pty-chat-359 P1/P2 — MCP Server Registry panel.
//
// Shared between Global Settings (scope='global') and Project Settings
// (scope='project'). Shows a list of registered servers; supports Add, Edit,
// and Delete via structured form fields (no raw-JSON textarea).
//
// Transport is split into two modes:
//   stdio: command (required) + args (optional) + env (optional key=value rows)
//   http:  url (required) + headers (optional key=value rows)
//
// Vault-stored secrets (headers/env values that the boot-time migration has
// encrypted) are shown as ••••••••. Re-saving a masked value passes the
// original $secretRef through unchanged — it never overwrites the vaulted
// credential with the mask string (Risk R1 from the build plan).

import { useCallback, useEffect, useState } from 'react';

import type { CreateMcpServerInput, McpDiscoveryStatus, McpServer, McpTransport } from './client';
import { mcpServersApi } from './client';

// -- Props --------------------------------------------------------------------

interface McpServersPanelProps {
  scope: 'global' | 'project';
  projectId?: string;
}

// -- Panel --------------------------------------------------------------------

export function McpServersPanel({ scope, projectId }: McpServersPanelProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [formState, setFormState] = useState<FormState | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    const req =
      scope === 'global'
        ? mcpServersApi.listGlobal()
        : mcpServersApi.listForProject(projectId!);
    req
      .then(setServers)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [scope, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  function openAdd() {
    setFormState({ mode: 'add', id: null, draft: emptyDraft() });
  }

  function openEdit(s: McpServer) {
    setFormState({ mode: 'edit', id: s.id, draft: draftFromServer(s) });
  }

  async function handleDelete(s: McpServer) {
    if (!confirm(`Delete "${s.name}"? This cannot be undone.`)) return;
    try {
      await mcpServersApi.deleteServer(s.id);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function handleSave(draft: ServerDraft) {
    setErr(null);
    try {
      const input = draftToInput(draft);
      if (formState?.mode === 'add') {
        if (scope === 'global') {
          await mcpServersApi.createGlobal(input);
        } else {
          await mcpServersApi.createForProject(projectId!, input);
        }
      } else if (formState?.mode === 'edit' && formState.id) {
        await mcpServersApi.patchServer(formState.id, input);
      }
      setFormState(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="text-sm font-medium text-foreground">MCP Servers</div>
          <div className="text-xs text-muted-foreground">
            Register MCP servers once here; attach them to agents in a later step.
          </div>
        </div>
        <button
          type="button"
          onClick={openAdd}
          className="border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted"
        >
          + Add server
        </button>
      </div>

      {err && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {err}
        </div>
      )}

      {loading && (
        <div className="text-xs text-muted-foreground">Loading...</div>
      )}

      {!loading && servers.length === 0 && !formState && (
        <div className="border border-dashed border-border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
          No servers registered yet. Click &quot;+ Add server&quot; to register one.
        </div>
      )}

      {servers.length > 0 && (
        <div className="flex flex-col divide-y divide-border border border-border">
          {servers.map((s) => (
            <ServerRow
              key={s.id}
              server={s}
              isEditing={formState?.mode === 'edit' && formState.id === s.id}
              onEdit={() => openEdit(s)}
              onDelete={() => void handleDelete(s)}
              onServerUpdated={(updated) =>
                setServers((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
              }
            />
          ))}
        </div>
      )}

      {formState && (
        <ServerForm
          mode={formState.mode}
          draft={formState.draft}
          onDraftChange={(d) => setFormState((prev) => (prev ? { ...prev, draft: d } : prev))}
          onSave={() => void handleSave(formState.draft)}
          onCancel={() => setFormState(null)}
        />
      )}
    </div>
  );
}

// -- Row -----------------------------------------------------------------------

function ServerRow({
  server,
  isEditing,
  onEdit,
  onDelete,
  onServerUpdated,
}: {
  server: McpServer;
  isEditing: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onServerUpdated: (updated: McpServer) => void;
}) {
  const [probing, setProbing] = useState(false);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const [toolsExpanded, setToolsExpanded] = useState(false);

  const transportSummary = server.transport.command
    ? `stdio: ${server.transport.command}`
    : `http: ${server.transport.url ?? ''}`;

  async function handleProbe() {
    setProbing(true);
    setProbeErr(null);
    try {
      const updated = await mcpServersApi.probeServer(server.id);
      onServerUpdated(updated);
    } catch (e) {
      setProbeErr((e as Error).message);
    } finally {
      setProbing(false);
    }
  }

  return (
    <div
      className={`flex flex-col gap-1 px-3 py-2 ${
        isEditing ? 'bg-muted/40' : 'hover:bg-muted/20'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">{server.name}</span>
            <DiscoveryBadge status={server.discoveryStatus} toolCount={server.discoveredTools?.length ?? null} />
          </div>
          {server.description && (
            <div className="truncate text-xs text-muted-foreground">{server.description}</div>
          )}
          <div className="font-mono text-[10px] text-muted-foreground">{transportSummary}</div>
        </div>
        <div className="flex shrink-0 items-start gap-1">
          <button
            type="button"
            onClick={() => void handleProbe()}
            disabled={probing}
            title="Re-probe for tool list"
            className="border border-border bg-card px-2 py-0.5 text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
          >
            {probing ? 'Probing…' : 'Re-probe'}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="border border-border bg-card px-2 py-0.5 text-[11px] text-foreground hover:bg-muted"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/20"
          >
            Delete
          </button>
        </div>
      </div>

      {probeErr && (
        <div className="text-[10px] text-destructive">{probeErr}</div>
      )}

      {server.discoveredTools && server.discoveredTools.length > 0 && (
        <div className="mt-0.5">
          <button
            type="button"
            onClick={() => setToolsExpanded((v) => !v)}
            className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {toolsExpanded ? '▾ hide tools' : `▸ ${server.discoveredTools.length} tool${server.discoveredTools.length === 1 ? '' : 's'}`}
          </button>
          {toolsExpanded && (
            <div className="mt-1 flex flex-wrap gap-1">
              {server.discoveredTools.map((t) => (
                <span
                  key={t}
                  className="border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// -- Discovery badge ----------------------------------------------------------

function DiscoveryBadge({
  status,
  toolCount,
}: {
  status: McpDiscoveryStatus;
  toolCount: number | null;
}) {
  if (status === 'ok') {
    return (
      <span className="inline-flex items-center border border-green-700/40 bg-green-900/20 px-1 py-0 font-mono text-[9px] font-medium text-green-400">
        ✓ {toolCount ?? 0} tools
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center border border-destructive/40 bg-destructive/10 px-1 py-0 font-mono text-[9px] font-medium text-destructive">
        ✕ probe failed
      </span>
    );
  }
  // stale
  return (
    <span className="inline-flex items-center border border-border bg-muted/30 px-1 py-0 font-mono text-[9px] text-muted-foreground">
      · not probed
    </span>
  );
}

// -- Form ---------------------------------------------------------------------

interface ServerFormProps {
  mode: 'add' | 'edit';
  draft: ServerDraft;
  onDraftChange: (d: ServerDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}

function ServerForm({ mode, draft, onDraftChange, onSave, onCancel }: ServerFormProps) {
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  function set(patch: Partial<ServerDraft>) {
    onDraftChange({ ...draft, ...patch });
  }

  async function handleSave() {
    setLocalErr(null);
    if (!draft.name.trim()) {
      setLocalErr('Name is required.');
      return;
    }
    if (draft.transportMode === 'stdio' && !draft.command.trim()) {
      setLocalErr('Command is required for stdio transport.');
      return;
    }
    if (draft.transportMode === 'http' && !draft.url.trim()) {
      setLocalErr('URL is required for HTTP transport.');
      return;
    }
    setBusy(true);
    try {
      await Promise.resolve(onSave());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border border-primary/40 bg-card p-4">
      <div className="text-sm font-medium text-foreground">
        {mode === 'add' ? 'Add MCP server' : 'Edit MCP server'}
      </div>

      {localErr && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {localErr}
        </div>
      )}

      <FormRow label="Name" required>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="my-mcp-server"
          className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground/60"
        />
      </FormRow>

      <FormRow label="Description">
        <input
          type="text"
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="Optional description"
          className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground/60"
        />
      </FormRow>

      <FormRow label="Transport">
        <div className="inline-flex self-start border border-border bg-background p-0.5">
          {(['stdio', 'http'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => set({ transportMode: m })}
              className={
                'px-3 py-1 text-xs font-medium uppercase ' +
                (draft.transportMode === m
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground')
              }
            >
              {m}
            </button>
          ))}
        </div>
      </FormRow>

      {draft.transportMode === 'stdio' && (
        <>
          <FormRow
            label="Command"
            required
            help="The executable to launch (e.g. node, python, npx)"
          >
            <input
              type="text"
              value={draft.command}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="node"
              className="w-full border border-border bg-background px-2 py-1 font-mono text-sm text-foreground placeholder:text-muted-foreground/60"
            />
          </FormRow>

          <FormRow label="Args" help="Space-separated arguments (e.g. server.js --port 3000)">
            <input
              type="text"
              value={draft.args}
              onChange={(e) => set({ args: e.target.value })}
              placeholder="server.js"
              className="w-full border border-border bg-background px-2 py-1 font-mono text-sm text-foreground placeholder:text-muted-foreground/60"
            />
          </FormRow>

          <FormRow
            label="Env vars"
            help="One KEY=value per line. Values are stored in plaintext."
          >
            <textarea
              value={draft.env}
              onChange={(e) => set({ env: e.target.value })}
              placeholder={'TOKEN=abc123\nPORT=3000'}
              rows={3}
              className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/60"
            />
          </FormRow>

          <FormRow
            label="Working directory (cwd)"
            help="Absolute path the server launches from — needed for servers that resolve relative paths / .env from their package dir."
          >
            <input
              type="text"
              value={draft.cwd}
              onChange={(e) => set({ cwd: e.target.value })}
              placeholder="/home/user/my-mcp-server"
              className="w-full border border-border bg-background px-2 py-1 font-mono text-sm text-foreground placeholder:text-muted-foreground/60"
            />
          </FormRow>
        </>
      )}

      {draft.transportMode === 'http' && (
        <>
          <FormRow label="URL" required help="Full URL of the MCP HTTP endpoint">
            <input
              type="url"
              value={draft.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="http://localhost:3000/mcp"
              className="w-full border border-border bg-background px-2 py-1 font-mono text-sm text-foreground placeholder:text-muted-foreground/60"
            />
          </FormRow>

          <FormRow
            label="Headers"
            help="One Key=Value per line (e.g. Authorization=Bearer sk-…). Values are encrypted at rest. Vault-stored secrets appear as ••••••••."
          >
            <textarea
              value={draft.headers}
              onChange={(e) => set({ headers: e.target.value })}
              placeholder={'Authorization=Bearer sk-...\nX-API-Key=abc123'}
              rows={3}
              className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/60"
            />
          </FormRow>
        </>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy}
          className="bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Saving...' : mode === 'add' ? 'Add' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function FormRow({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </div>
      {children}
      {help && <div className="text-[11px] text-muted-foreground">{help}</div>}
    </div>
  );
}

// -- Draft helpers ------------------------------------------------------------

type TransportMode = 'stdio' | 'http';

interface ServerDraft {
  name: string;
  description: string;
  transportMode: TransportMode;
  // stdio fields
  command: string;
  args: string;
  env: string; // KEY=VALUE per line; vault-stored values show as KEY=••••••••
  cwd: string;
  // http fields
  url: string;
  headers: string; // KEY=Value per line; vault-stored values show as KEY=••••••••
  // Vault ref maps — hold credential IDs so round-trip saves don't overwrite
  // a vaulted secret with the mask string (Risk R1).
  headersVaultRefs: Record<string, string>; // header key → credId
  envVaultRefs: Record<string, string>;     // env key → credId
}

interface FormState {
  mode: 'add' | 'edit';
  id: string | null;
  draft: ServerDraft;
}

function emptyDraft(): ServerDraft {
  return {
    name: '',
    description: '',
    transportMode: 'stdio',
    command: '',
    args: '',
    env: '',
    cwd: '',
    url: '',
    headers: '',
    headersVaultRefs: {},
    envVaultRefs: {},
  };
}

/** Sentinel displayed in the textarea for vault-stored (encrypted) values.
 *  Only characters outside printable ASCII are used so a real header/env
 *  value can never collide with this mask string. */
const VAULT_MASK = '••••••••';

function isVaultRef(v: unknown): v is { $secretRef: string } {
  return typeof v === 'object' && v !== null && '$secretRef' in v;
}

function draftFromServer(s: McpServer): ServerDraft {
  const isHttp = !!s.transport.url;

  // For any env/header value that is a vault ref, show the mask string and
  // record the credential id so round-trip saves can pass the ref through
  // unchanged (never overwrite the vault entry with the mask string).
  const envVaultRefs: Record<string, string> = {};
  const headersVaultRefs: Record<string, string> = {};

  const envLines = Object.entries(s.transport.env ?? {})
    .map(([k, v]) => {
      if (isVaultRef(v)) {
        envVaultRefs[k] = v.$secretRef;
        return `${k}=${VAULT_MASK}`;
      }
      return `${k}=${String(v)}`;
    })
    .join('\n');

  const headersLines = Object.entries(s.transport.headers ?? {})
    .map(([k, v]) => {
      if (isVaultRef(v)) {
        headersVaultRefs[k] = v.$secretRef;
        return `${k}=${VAULT_MASK}`;
      }
      return `${k}=${String(v)}`;
    })
    .join('\n');

  return {
    name: s.name,
    description: s.description,
    transportMode: isHttp ? 'http' : 'stdio',
    command: s.transport.command ?? '',
    args: (s.transport.args ?? []).join(' '),
    env: envLines,
    cwd: s.transport.cwd ?? '',
    url: s.transport.url ?? '',
    headers: headersLines,
    headersVaultRefs,
    envVaultRefs,
  };
}

function draftToInput(draft: ServerDraft): CreateMcpServerInput {
  let transport: McpTransport;
  if (draft.transportMode === 'stdio') {
    const argsArr = draft.args.trim() ? draft.args.trim().split(/\s+/) : undefined;
    const envObj: Record<string, string | { $secretRef: string }> = {};
    for (const line of draft.env.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq);
        const val = trimmed.slice(eq + 1);
        // If the user left a masked vault value unchanged, pass the ref through
        // so the vault credential is not overwritten with the mask string.
        if (val === VAULT_MASK && draft.envVaultRefs[key]) {
          envObj[key] = { $secretRef: draft.envVaultRefs[key] };
        } else {
          envObj[key] = val;
        }
      }
    }
    const cwdTrimmed = draft.cwd.trim();
    transport = {
      command: draft.command.trim(),
      ...(argsArr ? { args: argsArr } : {}),
      ...(Object.keys(envObj).length ? { env: envObj } : {}),
      ...(cwdTrimmed ? { cwd: cwdTrimmed } : {}),
    };
  } else {
    const headersObj: Record<string, string | { $secretRef: string }> = {};
    for (const line of draft.headers.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq);
        const val = trimmed.slice(eq + 1);
        // If the user left a masked vault value unchanged, pass the ref through.
        if (val === VAULT_MASK && draft.headersVaultRefs[key]) {
          headersObj[key] = { $secretRef: draft.headersVaultRefs[key] };
        } else {
          headersObj[key] = val;
        }
      }
    }
    transport = {
      url: draft.url.trim(),
      ...(Object.keys(headersObj).length ? { headers: headersObj } : {}),
    };
  }
  return {
    name: draft.name.trim(),
    description: draft.description,
    transport,
  };
}
