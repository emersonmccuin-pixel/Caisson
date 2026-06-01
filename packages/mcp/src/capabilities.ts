// Slice 011 (11A) — derived capability registry.
//
// A lookup layer keyed by tool name → { family } metadata used to reason about
// which contract family a tool belongs to. It is NOT the catalog: `TOOLS` in
// `server.ts` stays the SOLE source of truth for the tool list, ListTools
// ordering, and `PC_RIG_TOOL_NAMES`. The parity test
// (`test/capabilities.test.ts`) asserts every TOOLS name has a registry entry
// and every registry key is a TOOLS name — that test PROTECTS the ordering
// coupling rather than altering it.

/** The contract family a tool's internals route through. `none` = the tool has
 *  no apps/server HTTP round-trip whose response a contract covers (pure local
 *  acknowledgement, or pod-CRUD whose responses `@pc/contracts` does not yet
 *  model — left raw per the slice-011 plan §16). */
export type CapabilityFamily =
  | 'work-item'
  | 'project'
  | 'workflow'
  | 'agent'
  | 'agent-run'
  | 'none';

export interface ToolCapability {
  family: CapabilityFamily;
}

/** name → capability. Keyed by the bare tool name (matches `TOOL.name`). */
export const CAPABILITIES: Record<string, ToolCapability> = {
  // work-item family (handleWorkItemTool)
  pc_create_work_item: { family: 'work-item' },
  pc_create_agent_work_item: { family: 'work-item' },
  pc_approve_work_item: { family: 'work-item' },
  pc_reject_work_item: { family: 'work-item' },
  pc_log_bug: { family: 'work-item' },
  pc_move_work_item: { family: 'work-item' },
  pc_update_work_item: { family: 'work-item' },
  pc_get_work_item: { family: 'work-item' },
  pc_list_work_items: { family: 'work-item' },
  pc_list_areas: { family: 'work-item' },
  pc_attach_to_work_item: { family: 'work-item' },

  // project-config family (handleProjectConfigTool)
  pc_get_stages: { family: 'project' },
  pc_write_claude_md: { family: 'project' },
  pc_list_stages: { family: 'project' },
  pc_list_field_schemas: { family: 'project' },
  pc_replace_stages: { family: 'project' },
  pc_replace_field_schemas: { family: 'project' },

  // workflow family (handleWorkflowTool)
  pc_save_workflow_draft: { family: 'workflow' },
  pc_read_workflow_draft: { family: 'workflow' },
  pc_publish_workflow: { family: 'workflow' },
  pc_list_workflows: { family: 'workflow' },
  pc_fire_workflow: { family: 'workflow' },
  pc_complete_node: { family: 'workflow' },
  pc_node_failed: { family: 'none' }, // local ack only — no HTTP round-trip
  pc_create_workflow: { family: 'workflow' },
  pc_update_workflow: { family: 'workflow' },
  pc_delete_workflow: { family: 'workflow' },
  pc_get_workflow: { family: 'workflow' },

  // agent (pod-CRUD) family (handleAgentTool) — pod-CRUD responses have no
  // dedicated @pc/contracts DTO (pods.ts is live-events only), so these stay
  // raw per plan §16; family tag is for routing/lookup, not response parsing.
  pc_create_agent: { family: 'agent' },
  pc_get_agent: { family: 'agent' },
  pc_update_agent_prompt: { family: 'agent' },
  pc_update_agent_settings: { family: 'agent' },
  pc_delete_agent: { family: 'agent' },
  pc_create_knowledge: { family: 'agent' },
  pc_update_knowledge: { family: 'agent' },
  pc_delete_knowledge: { family: 'agent' },
  pc_knowledge_read: { family: 'agent' },
  pc_create_agent_secret: { family: 'agent' },
  pc_delete_agent_secret: { family: 'agent' },
  pc_add_agent_mcp_server: { family: 'agent' },
  pc_delete_agent_mcp_server: { family: 'agent' },
  pc_list_agent_audit: { family: 'agent' },
  pc_list_agents: { family: 'agent' },

  // agent-run / pending family (handleAgentRunTool)
  pc_invoke_agent: { family: 'agent-run' },
  pc_continue_agent: { family: 'agent-run' },
  pc_list_my_runs: { family: 'agent-run' },
  pc_inspect_agent_run: { family: 'agent-run' },
  pc_kill_agent_run: { family: 'agent-run' },
  pc_ask_orchestrator: { family: 'agent-run' },
  pc_ask_user: { family: 'agent-run' },
  pc_request_approval: { family: 'agent-run' },
  pc_answer_pending: { family: 'agent-run' },
};

/** All tool names the registry covers. */
export const CAPABILITY_NAMES: readonly string[] = Object.keys(CAPABILITIES);
