// Slice 1 (Areas + context model) — pc-rig context-doc tool handlers.
// Routes the context-doc tools to the server HTTP routes. Migration 0055:
// scope 'agent' (a pod's attached reference docs) routes list/add through the
// pod route family — same context_docs table underneath, one repo.

import { resolvePodId } from './agents.ts';
import type { ToolContext, ToolResult } from './context.ts';

export async function handleContextDocTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'pc_list_context': {
      const scope = typeof args.scope === 'string' ? args.scope : 'project';
      const scopeId = typeof args.scope_id === 'string' ? args.scope_id.trim() : '';
      const targetProjectId =
        typeof args.targetProjectId === 'string' && args.targetProjectId.trim().length > 0
          ? args.targetProjectId.trim()
          : null;

      try {
        let path: string;
        if (scope === 'agent') {
          if (!scopeId) {
            return {
              content: [
                { type: 'text', text: "pc_list_context: scope_id (pod id or name) required for scope='agent'" },
              ],
              isError: true,
            };
          }
          // scope_id may be a pod name or a ULID. Try name resolution first;
          // when no pod carries that name, pass it through as an id (the
          // route 404s with a clear error if it's neither).
          const byName = await resolvePodId({ name: scopeId }, ctx);
          const podId = byName.ok ? byName.id : scopeId;
          path = `/api/agents/pods/${encodeURIComponent(podId)}/context-docs`;
        } else {
          // Cross-project read: when targetProjectId is set use that project's route.
          const baseProjectPath = targetProjectId
            ? `/api/projects/${targetProjectId}/context-docs`
            : ctx.projectPath('context-docs');
          const params = new URLSearchParams({ scope });
          if (scopeId) params.set('scopeId', scopeId);
          path = `${baseProjectPath}?${params.toString()}`;
        }
        const res = await ctx.getServer(path);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_context failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_context failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_get_context_doc': {
      const docId = typeof args.doc_id === 'string' ? args.doc_id.trim() : '';
      const targetProjectId =
        typeof args.targetProjectId === 'string' && args.targetProjectId.trim().length > 0
          ? args.targetProjectId.trim()
          : null;
      if (!docId) {
        return {
          content: [{ type: 'text', text: 'pc_get_context_doc: doc_id required' }],
          isError: true,
        };
      }
      try {
        const docPath = targetProjectId
          ? `/api/projects/${targetProjectId}/context-docs/${encodeURIComponent(docId)}`
          : ctx.projectPath(`context-docs/${encodeURIComponent(docId)}`);
        const res = await ctx.getServer(docPath);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_get_context_doc failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_context_doc failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_add_context_doc': {
      const scope = typeof args.scope === 'string' ? args.scope : 'project';
      const scopeId = typeof args.scope_id === 'string' ? args.scope_id.trim() : '';
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) {
        return {
          content: [{ type: 'text', text: 'pc_add_context_doc: title required' }],
          isError: true,
        };
      }
      try {
        if (scope === 'agent') {
          if (!scopeId) {
            return {
              content: [
                { type: 'text', text: "pc_add_context_doc: scope_id (pod id or name) required for scope='agent'" },
              ],
              isError: true,
            };
          }
          const byName = await resolvePodId({ name: scopeId }, ctx);
          const podId = byName.ok ? byName.id : scopeId;
          const payload: Record<string, unknown> = {
            title,
            body: typeof args.body === 'string' ? args.body : '',
            author: typeof args.author === 'string' ? args.author : 'orchestrator',
            actor: 'orchestrator',
          };
          if (typeof args.reason === 'string' && args.reason.trim()) {
            payload.reason = args.reason.trim();
          }
          const res = await ctx.postServer(
            `/api/agents/pods/${encodeURIComponent(podId)}/context-docs`,
            payload,
          );
          if (res.status >= 200 && res.status < 300) {
            return { content: [{ type: 'text', text: res.body }] };
          }
          return {
            content: [{ type: 'text', text: `pc_add_context_doc failed (${res.status}): ${res.body}` }],
            isError: true,
          };
        }

        const payload: Record<string, unknown> = {
          scope,
          title,
        };
        if (scopeId) payload.scopeId = scopeId;
        if (typeof args.body === 'string') payload.body = args.body;
        // Default author to orchestrator since this is orchestrator-held.
        payload.author = typeof args.author === 'string' ? args.author : 'orchestrator';

        const res = await ctx.postServer(ctx.projectPath('context-docs'), payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_add_context_doc failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_add_context_doc failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_context_doc': {
      const docId = typeof args.doc_id === 'string' ? args.doc_id.trim() : '';
      if (!docId) {
        return {
          content: [{ type: 'text', text: 'pc_update_context_doc: doc_id required' }],
          isError: true,
        };
      }
      const patch: Record<string, unknown> = {};
      if (typeof args.title === 'string') patch.title = args.title;
      if (typeof args.body === 'string') patch.body = args.body;
      if (!Object.keys(patch).length) {
        return {
          content: [{ type: 'text', text: 'pc_update_context_doc: at least one of title or body required' }],
          isError: true,
        };
      }
      // Audit identity for agent-scoped docs; ignored on other scopes.
      patch.actor = 'orchestrator';
      if (typeof args.reason === 'string' && args.reason.trim()) {
        patch.reason = args.reason.trim();
      }
      try {
        const res = await ctx.patchServer(
          ctx.projectPath(`context-docs/${encodeURIComponent(docId)}`),
          patch,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_update_context_doc failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_update_context_doc failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_delete_context_doc': {
      const docId = typeof args.doc_id === 'string' ? args.doc_id.trim() : '';
      if (!docId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_context_doc: doc_id required' }],
          isError: true,
        };
      }
      try {
        const params = new URLSearchParams({ actor: 'orchestrator' });
        if (typeof args.reason === 'string' && args.reason.trim()) {
          params.set('reason', args.reason.trim());
        }
        const res = await ctx.deleteServer(
          `${ctx.projectPath(`context-docs/${encodeURIComponent(docId)}`)}?${params.toString()}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_delete_context_doc failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_delete_context_doc failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_search': {
      const query = typeof args.query === 'string' ? args.query : '';
      const targetProjectId =
        typeof args.targetProjectId === 'string' && args.targetProjectId.trim().length > 0
          ? args.targetProjectId.trim()
          : null;
      if (!query.trim()) {
        return {
          content: [{ type: 'text', text: 'pc_search: query required' }],
          isError: true,
        };
      }
      const params = new URLSearchParams({ q: query });
      if (typeof args.area_id === 'string' && args.area_id.trim()) {
        params.set('areaId', args.area_id.trim());
      }
      if (typeof args.scope === 'string') {
        params.set('scope', args.scope);
      }
      try {
        const searchBase = targetProjectId
          ? `/api/projects/${targetProjectId}/context-docs/search`
          : ctx.projectPath('context-docs/search');
        const res = await ctx.getServer(`${searchBase}?${params.toString()}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_search failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_search failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
