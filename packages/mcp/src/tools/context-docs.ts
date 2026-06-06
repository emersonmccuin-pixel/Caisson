// Slice 1 (Areas + context model) — pc-rig context-doc tool handlers.
// Routes the 5 context-doc tools to the server HTTP routes.

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

      // Build query string.
      let path = ctx.projectPath('context-docs');
      const params = new URLSearchParams({ scope });
      if (scopeId) params.set('scopeId', scopeId);
      path = `${path}?${params.toString()}`;

      try {
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
      if (!docId) {
        return {
          content: [{ type: 'text', text: 'pc_get_context_doc: doc_id required' }],
          isError: true,
        };
      }
      try {
        const res = await ctx.getServer(ctx.projectPath(`context-docs/${encodeURIComponent(docId)}`));
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
      const payload: Record<string, unknown> = {
        scope,
        title,
      };
      if (scopeId) payload.scopeId = scopeId;
      if (typeof args.body === 'string') payload.body = args.body;
      // Default author to orchestrator since this is orchestrator-held.
      payload.author = typeof args.author === 'string' ? args.author : 'orchestrator';

      try {
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

    case 'pc_search': {
      const query = typeof args.query === 'string' ? args.query : '';
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
        const res = await ctx.getServer(
          `${ctx.projectPath('context-docs/search')}?${params.toString()}`,
        );
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
