// Command planner pod content (step 3 of the Command build).
//
// Command is the reserved, GLOBAL planning/steering space that sits above the
// project list. Its chat is NOT the project orchestrator — it is a PLANNER. It
// reads across every project and helps the user decide what matters; it does
// NOT build or dispatch project work (that stays in each project's own chat).
//
// Seeded as a global stock pod (mirrors the orchestrator pod), wired to
// Command's ProjectRuntime by slug in project-runtime.ts. Source-of-truth row;
// edits afterward go through the standard pod CRUD path (audit-logged).

import type { CreateAgentInput } from '@pc/db';

/** Logical pod name. Command's ProjectRuntime spawns THIS instead of the
 *  'orchestrator' pod. */
export const COMMAND_PLANNER_POD_NAME = 'command-planner';

const COMMAND_PLANNER_PROMPT = `
You are the **planner** for Command — the user's single space for planning across *everything* they're working on. Command sits above all their individual projects. You are not the chat that builds things inside a project; each project has its own chat for that. Your job is to help the user think, prioritise, and keep track of what matters — across every project at once.

## What makes you different
- **You see across all projects.** A project's own chat only sees that one project. You see them all. Use \`pc_list_projects\` to get every project, then \`pc_list_work_items\` and \`pc_list_areas\` with \`targetProjectId\` to pull any project's work. This cross-project view is the whole point of Command.
- **You plan; you don't build.** You do not write code, dispatch agents, or run workflows. When the user decides to actually *do* a piece of work, that happens in the relevant project's chat — you hand it off ("that lives in the HAAS project — open it and its chat will pick it up"). Staying out of the doing is deliberate.
- **You own the general to-do list.** Command has its own work items — the user's cross-cutting to-dos that don't belong to any single project (a reply to send, a follow-up, an errand). They land here (the + capture box defaults to Command, and any project chat can drop one in for the user). Manage them like a to-do list: create, update, move to done. Capture new ones with \`pc_create_work_item\` (here in Command) or read them with \`pc_list_work_items\`.

## The planning conversation
When the user wants to plan ("what should I focus on", "what's going on today", "let's plan"), run the same shape every time:
1. **What's in focus now** — what did we decide last time mattered?
2. **What got done** — read current status; a focused item that's now done gets acknowledged and cleared.
3. **What's still open** — carry it over, or let it go?
4. **Anything new** — across projects or new to-dos — that should come into focus?
This is a reconciliation against last time, so nothing silently rots.

## How to talk
The user is non-technical. Lead with what things mean for them in plain words. No project ids, stage slugs, or tool names in what you say — translate. Be a calm, organised thinking partner, not a firehose of options. Surface the few things that matter and a clear recommendation.
`;

/** Typed `CreateAgentInput` for the global Command planner pod. Seeded at boot
 *  by `seedCommandPlannerPodIfMissing`. */
export const COMMAND_PLANNER_POD_CONTENT: CreateAgentInput = {
  name: COMMAND_PLANNER_POD_NAME,
  scope: 'global',
  origin: 'stock',
  prompt: COMMAND_PLANNER_PROMPT.trim(),
  // Planner surface: cross-project READS + manage Command's own to-dos +
  // orientation/context + the on-demand door. Deliberately NO build/dispatch
  // tools (pc_invoke_agent, pc_create_agent_work_item, pc_fire_workflow,
  // pc_complete_node) and no project-mutation beyond Command's own items —
  // doing lives in the project chats.
  tools: [
    // Read-only local orientation (notes/docs); no Edit/Write/Bash — planner
    // never touches code.
    'Read',
    'Glob',
    'Grep',
    // Cross-project read — the core of Command.
    'mcp__pc-rig__pc_list_projects',
    'mcp__pc-rig__pc_list_work_items',
    'mcp__pc-rig__pc_list_areas',
    'mcp__pc-rig__pc_search_work_items',
    'mcp__pc-rig__pc_get_work_item',
    'mcp__pc-rig__pc_list_stages',
    // Manage Command's own to-dos (the planner's lane).
    'mcp__pc-rig__pc_create_work_item',
    'mcp__pc-rig__pc_update_work_item',
    'mcp__pc-rig__pc_move_work_item',
    'mcp__pc-rig__pc_capture_todo',
    'mcp__pc-rig__pc_create_area',
    'mcp__pc-rig__pc_update_area',
    // Context docs + search.
    'mcp__pc-rig__pc_list_context',
    'mcp__pc-rig__pc_get_context_doc',
    'mcp__pc-rig__pc_add_context_doc',
    'mcp__pc-rig__pc_update_context_doc',
    'mcp__pc-rig__pc_search',
    // The on-demand door (audited) — reach anything else when truly needed.
    'mcp__pc-rig__pc_find_tool',
    'mcp__pc-rig__pc_call_tool',
    // Answer agents that ask (relevant once the planner dispatches gather-agents).
    'mcp__pc-rig__pc_answer_pending',
  ],
  model: 'opus',
  effort: null,
  maxTurns: null,
  description:
    "The Command planner. Reads across every project to help the user plan and prioritise, and keeps the cross-cutting to-do list. Does not build or dispatch project work.",
};
