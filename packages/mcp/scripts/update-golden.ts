import { TOOLS, PC_RIG_TOOL_NAMES } from '../src/server.ts';
import { TOOL_CATALOG } from '@pc/domain';
import { PC_RIG_TOOL_REGISTRY } from '@pc/domain/tool-registry';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const golden = {
  listTools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  pcRigToolNames: [...PC_RIG_TOOL_NAMES],
  toolCatalog: TOOL_CATALOG,
  capabilities: Object.fromEntries(PC_RIG_TOOL_REGISTRY.map(d => [d.name, { family: d.family }])),
};

writeFileSync(join(__dirname, '../test/__golden__.json'), JSON.stringify(golden, null, 2));
console.log('Golden updated');
