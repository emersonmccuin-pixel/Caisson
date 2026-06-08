import type { ToolContext, ToolResult } from './context.ts';

// Slice 016 — the per-tool *_TOOL consts (name + description + inputSchema)
// were relocated VERBATIM into @pc/domain PC_RIG_TOOL_REGISTRY (the single
// canonical pc-rig tool metadata source). This file now owns only the helpers
// and the executable handler (localhost-HTTP dispatch).

/** Project a ResolvedAgent (web-UI-shaped) down to a slim listing entry.
 *  Falls through to the original body string on any parse / shape mismatch
 *  so a server-side response change can't crash the tool. */
function slimAgentList(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      ok?: unknown;
      globals?: unknown;
      overrides?: unknown;
      projectOnly?: unknown;
      [k: string]: unknown;
    };
    const slimOne = (entry: unknown) => {
      if (!entry || typeof entry !== 'object') return entry;
      const r = entry as Record<string, unknown>;
      const def = (r.def && typeof r.def === 'object' ? r.def : {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {
        name: typeof r.name === 'string' ? r.name : def.name,
      };
      if (typeof def.description === 'string') out.description = def.description;
      if (typeof def.model === 'string') out.model = def.model;
      if (Array.isArray(def.tools) && def.tools.length > 0) out.tools = def.tools;
      return out;
    };
    const slimArr = (v: unknown) => (Array.isArray(v) ? v.map(slimOne) : v);
    return JSON.stringify({
      ...parsed,
      globals: slimArr(parsed.globals),
      overrides: slimArr(parsed.overrides),
      projectOnly: slimArr(parsed.projectOnly),
    });
  } catch {
    return body;
  }
}

/** Knowledge / secret / mcp-server tools accept { agentId } / { agentName }
 *  while agent tools use { id } / { name }. Adapt the former to the shape
 *  resolvePodId expects. */
function agentArgs(args: Record<string, unknown>): Record<string, unknown> {
  return {
    id: args.agentId,
    name: args.agentName,
  };
}

/** Auto-derive a knowledge-doc name from the content body. Priority: first
 *  H1 (`# Heading`) → first non-empty line → fallback to a timestamp slug.
 *  Whitespace trimmed; capped at 64 chars; kebab-cased. */
function deriveKnowledgeName(content: string): string {
  const lines = content.split(/\r?\n/);
  let candidate = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      candidate = line.replace(/^#+\s*/, '').trim();
    } else {
      candidate = line;
    }
    if (candidate) break;
  }
  if (!candidate) {
    return `knowledge-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }
  const slug = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || `knowledge-${Date.now()}`;
}

/** Resolve a pod by either { id } or { name }. Name lookup searches the
 *  project's visible pods first (project-scope + stock globals) then the full
 *  global list, so pods of ANY scope — project, stock-global, or
 *  global-user-created — resolve by name. Used by every pc_*_agent /
 *  pc_*_knowledge MCP tool so the orchestrator can refer to pods by their
 *  human name without juggling ULIDs across turns. */
async function resolvePodId(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (typeof args.id === 'string' && args.id.trim().length > 0) {
    return { ok: true, id: args.id.trim() };
  }
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    return { ok: false, error: 'either id or name required' };
  }
  // Name lookup must cover BOTH the project's pods (project-scope rows + stock
  // globals, returned only with ?projectId) AND global user-created pods (the
  // project view deliberately excludes those). Search project-visible first so
  // a project pod wins over a same-named global (override semantics), then fall
  // back to the full global list. Without the projectId pass, project-scoped
  // pods (e.g. a project's build-qa-tester) were unresolvable by name at all.
  const listPods = async (
    path: string,
  ): Promise<
    | { ok: true; pods: Array<{ id: string; name: string }> }
    | { ok: false; error: string }
  > => {
    const res = await ctx.getServer(path);
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `pod-list lookup failed (${res.status}): ${res.body}` };
    }
    try {
      const parsed = JSON.parse(res.body) as { pods?: Array<{ id: string; name: string }> };
      return { ok: true, pods: parsed.pods ?? [] };
    } catch (err) {
      return { ok: false, error: `pod-list parse failed: ${(err as Error).message}` };
    }
  };

  const projList = await listPods(
    `/api/agents/pods?projectId=${encodeURIComponent(ctx.projectId)}`,
  );
  if (!projList.ok) return projList;
  let pod = projList.pods.find((p) => p.name === name);
  if (!pod) {
    const globalList = await listPods('/api/agents/pods');
    if (!globalList.ok) return globalList;
    pod = globalList.pods.find((p) => p.name === name);
  }
  if (!pod) return { ok: false, error: `no pod named '${name}'` };
  return { ok: true, id: pod.id };
}

// Slice 011 (11E) — pod-CRUD responses are LEFT RAW. `@pc/contracts/pods.ts`
// only models pod live-events (PodChanged*), not the pod-CRUD HTTP response
// bodies (create/get/update/delete pod, knowledge, secret, mcp-server, audit,
// list). Adding a pod-response DTO to @pc/contracts is a STOP-and-confirm per
// the plan §16, so these handlers keep emitting the raw res.body via the
// existing ctx.* helpers — byte-identical, no typed-client seam.
export async function handleAgentTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'pc_create_agent': {
      const agentName = typeof args.name === 'string' ? args.name.trim() : '';
      if (!agentName) {
        return { content: [{ type: 'text', text: 'pc_create_agent: name required' }], isError: true };
      }
      const scope = args.scope === 'global' ? 'global' : 'project';
      if (scope === 'project' && !ctx.projectId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_create_agent: scope="project" but PC_PROJECT_ID is not set — pass scope="global" if you really want a global pod, or call from inside a project context.',
            },
          ],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = {
          name: agentName,
          scope,
          ...(scope === 'project' ? { projectId: ctx.projectId } : {}),
          actor: 'orchestrator',
          reason: 'mcp-create',
        };
        if (typeof args.prompt === 'string') payload.prompt = args.prompt;
        if (typeof args.description === 'string') payload.description = args.description;
        if (typeof args.model === 'string') payload.model = args.model;
        if (typeof args.effort === 'string') payload.effort = args.effort;
        if (typeof args.maxTurns === 'number') payload.maxTurns = args.maxTurns;
        if (Array.isArray(args.tools)) payload.tools = args.tools;
        const res = await ctx.postServer('/api/agents/pods', payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_create_agent failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_agent failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_get_agent': {
      try {
        const id = await resolvePodId(args, ctx);
        if (!id.ok) {
          return { content: [{ type: 'text', text: `pc_get_agent: ${id.error}` }], isError: true };
        }
        const res = await ctx.getServer(`/api/agents/pods/${encodeURIComponent(id.id)}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_get_agent failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_agent failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_agent': {
      try {
        const id = await resolvePodId(args, ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_update_agent: ${id.error}` }],
            isError: true,
          };
        }
        // Unified prompt + settings edit — both halves PATCH the same pod route.
        const payload: Record<string, unknown> = {
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-edit-agent',
        };
        if (typeof args.prompt === 'string') payload.prompt = args.prompt;
        if (typeof args.newName === 'string') payload.name = args.newName.trim();
        if (typeof args.description === 'string') payload.description = args.description;
        if (typeof args.model === 'string') payload.model = args.model;
        if (typeof args.effort === 'string') payload.effort = args.effort;
        if (typeof args.maxTurns === 'number') payload.maxTurns = args.maxTurns;
        if (Array.isArray(args.tools)) payload.tools = args.tools;
        // Body must contain at least one mutating field — the `actor` + `reason`
        // alone produces a no-op update.
        const fieldKeys = Object.keys(payload).filter(
          (k) => k !== 'actor' && k !== 'reason',
        );
        if (fieldKeys.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'pc_update_agent: at least one field required (prompt / newName / description / model / effort / maxTurns / tools)',
              },
            ],
            isError: true,
          };
        }
        const res = await ctx.patchServer(`/api/agents/pods/${encodeURIComponent(id.id)}`, payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_update_agent failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_update_agent failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_agent': {
      try {
        const id = await resolvePodId(args, ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_agent: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await ctx.deleteServer(`/api/agents/pods/${encodeURIComponent(id.id)}?${qs}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_delete_agent failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_delete_agent failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    // Agent-mgmt toolkit audit (2026-06-04) — the three pod lifecycle routes
    // that were UI-only. Thin proxies over the existing HTTP doors.
    case 'pc_promote_agent_to_global': {
      try {
        const id = await resolvePodId(args, ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_promote_agent_to_global: ${id.error}` }],
            isError: true,
          };
        }
        const res = await ctx.postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/promote-to-global`,
          {
            actor: 'orchestrator',
            reason:
              typeof args.reason === 'string' && args.reason.trim()
                ? args.reason.trim()
                : 'mcp-promote',
          },
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_promote_agent_to_global failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_promote_agent_to_global failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_clone_agent_to_project': {
      try {
        const id = await resolvePodId(args, ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_clone_agent_to_project: ${id.error}` }],
            isError: true,
          };
        }
        const projectId =
          typeof args.projectId === 'string' && args.projectId.trim()
            ? args.projectId.trim()
            : ctx.projectId;
        if (!projectId) {
          return {
            content: [
              {
                type: 'text',
                text: 'pc_clone_agent_to_project: projectId required (none passed and PC_PROJECT_ID is not set)',
              },
            ],
            isError: true,
          };
        }
        const res = await ctx.postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/clone-to-project`,
          {
            projectId,
            ...(typeof args.newName === 'string' && args.newName.trim()
              ? { name: args.newName.trim() }
              : {}),
            actor: 'orchestrator',
            reason:
              typeof args.reason === 'string' && args.reason.trim()
                ? args.reason.trim()
                : 'mcp-clone',
          },
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_clone_agent_to_project failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_clone_agent_to_project failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_reset_agent_to_default': {
      try {
        const id = await resolvePodId(args, ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_reset_agent_to_default: ${id.error}` }],
            isError: true,
          };
        }
        const res = await ctx.postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/reset-to-default`,
          {
            actor: 'orchestrator',
            reason:
              typeof args.reason === 'string' && args.reason.trim()
                ? args.reason.trim()
                : 'mcp-reset',
          },
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_reset_agent_to_default failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_reset_agent_to_default failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_create_knowledge': {
      const content = typeof args.content === 'string' ? args.content : '';
      if (typeof args.content !== 'string') {
        return {
          content: [{ type: 'text', text: 'pc_create_knowledge: content required (string)' }],
          isError: true,
        };
      }
      const explicitName =
        typeof args.docName === 'string' && args.docName.trim().length > 0
          ? args.docName.trim()
          : null;
      const docName = explicitName ?? deriveKnowledgeName(content);
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_create_knowledge: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          name: docName,
          content,
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-create-knowledge',
        };
        const res = await ctx.postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_create_knowledge failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_create_knowledge failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_update_knowledge': {
      const knowledgeId = typeof args.knowledgeId === 'string' ? args.knowledgeId.trim() : '';
      if (!knowledgeId) {
        return {
          content: [{ type: 'text', text: 'pc_update_knowledge: knowledgeId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_update_knowledge: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-edit-knowledge',
        };
        if (typeof args.content === 'string') payload.content = args.content;
        if (typeof args.docName === 'string') payload.name = args.docName.trim();
        const fieldKeys = Object.keys(payload).filter(
          (k) => k !== 'actor' && k !== 'reason',
        );
        if (fieldKeys.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'pc_update_knowledge: at least one of { content, docName } required',
              },
            ],
            isError: true,
          };
        }
        const res = await ctx.patchServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge/${encodeURIComponent(knowledgeId)}`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_update_knowledge failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_update_knowledge failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_knowledge': {
      const knowledgeId = typeof args.knowledgeId === 'string' ? args.knowledgeId.trim() : '';
      if (!knowledgeId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_knowledge: knowledgeId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_knowledge: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete-knowledge';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await ctx.deleteServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge/${encodeURIComponent(knowledgeId)}?${qs}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_delete_knowledge failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_delete_knowledge failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_knowledge_read': {
      const knowledgeId = typeof args.knowledgeId === 'string' ? args.knowledgeId.trim() : '';
      if (!knowledgeId) {
        return {
          content: [{ type: 'text', text: 'pc_knowledge_read: knowledgeId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_knowledge_read: ${id.error}` }],
            isError: true,
          };
        }
        const res = await ctx.getServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge/${encodeURIComponent(knowledgeId)}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_knowledge_read failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_knowledge_read failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_create_agent_secret': {
      const envVarName = typeof args.envVarName === 'string' ? args.envVarName.trim() : '';
      const valuePlaintext = typeof args.valuePlaintext === 'string' ? args.valuePlaintext : '';
      if (!envVarName) {
        return {
          content: [{ type: 'text', text: 'pc_create_agent_secret: envVarName required' }],
          isError: true,
        };
      }
      if (typeof args.valuePlaintext !== 'string') {
        return {
          content: [
            { type: 'text', text: 'pc_create_agent_secret: valuePlaintext required (string)' },
          ],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_create_agent_secret: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          envVarName,
          valuePlaintext,
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-create-secret',
        };
        const res = await ctx.postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/secrets`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_create_agent_secret failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_create_agent_secret failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_agent_secret': {
      const secretId = typeof args.secretId === 'string' ? args.secretId.trim() : '';
      if (!secretId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_agent_secret: secretId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_agent_secret: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete-secret';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await ctx.deleteServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/secrets/${encodeURIComponent(secretId)}?${qs}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_delete_agent_secret failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_delete_agent_secret failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_add_agent_mcp_server': {
      const serverName = typeof args.serverName === 'string' ? args.serverName.trim() : '';
      const config = args.config && typeof args.config === 'object' ? args.config : null;
      if (!serverName) {
        return {
          content: [{ type: 'text', text: 'pc_add_agent_mcp_server: serverName required' }],
          isError: true,
        };
      }
      if (!config) {
        return {
          content: [{ type: 'text', text: 'pc_add_agent_mcp_server: config required (object)' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_add_agent_mcp_server: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          name: serverName,
          config,
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-add-server',
        };
        const res = await ctx.postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/mcp-servers`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_add_agent_mcp_server failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_add_agent_mcp_server failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_list_agent_audit': {
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_list_agent_audit: ${id.error}` }],
            isError: true,
          };
        }
        const params: string[] = [];
        if (typeof args.actor === 'string' && args.actor.trim()) {
          params.push(`actor=${encodeURIComponent(args.actor.trim())}`);
        }
        if (typeof args.field === 'string' && args.field.trim()) {
          params.push(`field=${encodeURIComponent(args.field.trim())}`);
        }
        if (typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0) {
          params.push(`limit=${args.limit}`);
        }
        if (
          typeof args.beforeCreatedAt === 'number' &&
          Number.isFinite(args.beforeCreatedAt)
        ) {
          params.push(`beforeCreatedAt=${args.beforeCreatedAt}`);
        }
        const qs = params.length > 0 ? `?${params.join('&')}` : '';
        const res = await ctx.getServer(`/api/agents/pods/${encodeURIComponent(id.id)}/audit${qs}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_list_agent_audit failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_list_agent_audit failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_agent_mcp_server': {
      const mcpServerId = typeof args.mcpServerId === 'string' ? args.mcpServerId.trim() : '';
      if (!mcpServerId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_agent_mcp_server: mcpServerId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_agent_mcp_server: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete-server';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await ctx.deleteServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/mcp-servers/${encodeURIComponent(mcpServerId)}?${qs}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            {
              type: 'text',
              text: `pc_delete_agent_mcp_server failed (${res.status}): ${res.body}`,
            },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `pc_delete_agent_mcp_server failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case 'pc_list_agents': {
      try {
        const res = await ctx.getServer(ctx.projectPath('agents'));
        if (res.status >= 200 && res.status < 300) {
          // Route returns ResolvedAgent[] shaped for the web UI's agent
          // editor (`body` + `markdown` each carry the entire prompt;
          // `def.name` duplicates the top-level `name`). For MCP callers
          // the only useful fields are name + description + a couple of
          // hints for picking an agent — slim it before returning so a
          // 10-pod project doesn't ship 90k chars into the caller's
          // context every call.
          const slim = slimAgentList(res.body);
          return { content: [{ type: 'text', text: slim }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_agents failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_agents failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
