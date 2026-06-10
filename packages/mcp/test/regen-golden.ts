// Regenerate test/__golden__.json from the LIVE registry-derived arrays.
//
// The golden is a wire-frozen snapshot; refactors that change the tool
// surface ON PURPOSE (e.g. migration 0055's knowledge→context-doc merge)
// regenerate it with this script instead of hand-editing JSON:
//
//   npx tsx test/regen-golden.ts   (from packages/mcp)
//
// Review the diff before committing — every changed byte is a wire change.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS, PC_RIG_TOOL_NAMES } from '../src/server.ts';
import { TOOL_CATALOG, PC_RIG_TOOL_REGISTRY } from '@pc/domain';

const golden = {
  listTools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
  pcRigToolNames: [...PC_RIG_TOOL_NAMES],
  toolCatalog: TOOL_CATALOG,
  capabilities: Object.fromEntries(
    PC_RIG_TOOL_REGISTRY.map((d) => [d.name, { family: d.family }]),
  ),
};

const out = fileURLToPath(new URL('./__golden__.json', import.meta.url));
writeFileSync(out, JSON.stringify(golden, null, 2) + '\n');
console.log(
  `regenerated ${out}: ${golden.listTools.length} tools, ${golden.toolCatalog.length} catalog entries`,
);
