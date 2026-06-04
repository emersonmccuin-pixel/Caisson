// Typed model for a Claude Code subagent definition.
//
// Covers every frontmatter field PC surfaces today plus the dead-config fields
// we still need to round-trip safely. Unknown fields not enumerated here are
// preserved verbatim by the parser/serializer (forward-compat with CC
// additions) — see `agent-file.ts`.
//
// Per the Section 3 buildout, `pc.role` is intentionally NOT modelled here.
// Tools list + the `isolation` flag carry the actual constraints — there is
// no abstract role layer between agent definition and dispatch.

export type AgentColor =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan';

export const AGENT_COLORS: readonly AgentColor[] = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
];

export type AgentModelShort = 'haiku' | 'sonnet' | 'opus';

/** Either a short alias (haiku/sonnet/opus) or a full model ID
 *  (e.g. `claude-opus-4-7`). Validator accepts both. */
export type AgentModel = AgentModelShort | string;

export const AGENT_MODEL_SHORTCUTS: readonly AgentModelShort[] = ['haiku', 'sonnet', 'opus'];

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const AGENT_EFFORTS: readonly AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type AgentMemoryScope = 'user' | 'project' | 'local';

export const AGENT_MEMORY_SCOPES: readonly AgentMemoryScope[] = ['user', 'project', 'local'];

export type AgentPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'plan';

export const AGENT_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
];

export type AgentIsolation = 'worktree';

/** One hook entry (matcher + command). Mirrors CC's per-agent hook config. */
export interface AgentHookEntry {
  matcher?: string;
  command: string;
}

/** Per-event hook config. Event name (e.g. "PreToolUse", "Stop") → list of
 *  matcher/command pairs. */
export type AgentHooks = Record<string, AgentHookEntry[]>;

/** Inline MCP server (matches `.mcp.json` schema). The parser preserves
 *  unknown keys via the `extras` bucket so future CC additions round-trip
 *  cleanly. */
export interface InlineMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** Bucket for unknown keys — round-tripped verbatim. */
  extras?: Record<string, unknown>;
}

export type AgentMcpServerRef = string | InlineMcpServer;

// M5 (FD-5, 2026-06-04) — ☠ AgentOutputDestination / AGENT_OUTPUT_DESTINATIONS /
// AgentPcMetadata (`pc:` frontmatter block). output_destination was a dead knob:
// stored + editable + seeded, consumed by ZERO runtime code. Results route via
// the terminal envelope → orchestrator relay; prose placement is
// `expectedOutput.store`. Old agent files' `pc:` blocks round-trip verbatim as
// unknown frontmatter.

/** Typed view of an agent file's YAML frontmatter. Every field is optional
 *  except `name` + `description` — those are required by CC. Fields not
 *  enumerated here live in `unknown` on the parse result and are preserved
 *  verbatim on serialize. */
export interface AgentDef {
  // Identity
  name: string;
  description: string;
  color?: AgentColor;

  // Behavior
  model?: AgentModel;
  effort?: AgentEffort;
  maxTurns?: number;
  background?: boolean;

  // Capabilities
  tools?: string[];
  disallowedTools?: string[];
  mcpServers?: AgentMcpServerRef[];
  isolation?: AgentIsolation;

  // State + persistence
  memory?: AgentMemoryScope;
  hooks?: AgentHooks;
  skills?: string[];

  // Dead config — kept so PC round-trips raw YAML cleanly even though PC
  // never honors these.
  permissionMode?: AgentPermissionMode;
  initialPrompt?: string;
}

export interface AgentValidationIssue {
  /** Field key path. Top-level fields are `"name"`, `"tools"`, etc.
   *  Nested fields use dot notation (`"mcpServers[0].command"`). */
  field: string;
  message: string;
}

export interface AgentValidationOk {
  ok: true;
}

export interface AgentValidationErr {
  ok: false;
  errors: AgentValidationIssue[];
}

export type AgentValidationResult = AgentValidationOk | AgentValidationErr;

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const NAME_MAX = 64;
const DESCRIPTION_SOFT_MAX = 280;

/** Validate a parsed AgentDef. Returns the full list of field-level errors;
 *  never throws. The serializer is responsible for round-trip; this is purely
 *  about whether PC considers the def well-formed for dispatch + UI. */
export function validateAgentDef(def: AgentDef): AgentValidationResult {
  const errors: AgentValidationIssue[] = [];

  // name
  if (typeof def.name !== 'string' || def.name.trim() === '') {
    errors.push({ field: 'name', message: 'name is required' });
  } else if (def.name.length > NAME_MAX) {
    errors.push({ field: 'name', message: `name must be ≤ ${NAME_MAX} chars` });
  } else if (!NAME_PATTERN.test(def.name)) {
    errors.push({
      field: 'name',
      message: 'name must be kebab-case (lowercase letters, digits, dashes)',
    });
  }

  // description
  if (typeof def.description !== 'string' || def.description.trim() === '') {
    errors.push({ field: 'description', message: 'description is required' });
  } else if (def.description.length > DESCRIPTION_SOFT_MAX) {
    errors.push({
      field: 'description',
      message: `description should be ≤ ${DESCRIPTION_SOFT_MAX} chars`,
    });
  }

  // color
  if (def.color !== undefined && !AGENT_COLORS.includes(def.color)) {
    errors.push({ field: 'color', message: `color must be one of: ${AGENT_COLORS.join(', ')}` });
  }

  // model — accept shortcut OR any non-empty string (treated as full ID).
  if (def.model !== undefined) {
    if (typeof def.model !== 'string' || def.model.trim() === '') {
      errors.push({ field: 'model', message: 'model must be a non-empty string' });
    }
  }

  // effort
  if (def.effort !== undefined && !AGENT_EFFORTS.includes(def.effort)) {
    errors.push({ field: 'effort', message: `effort must be one of: ${AGENT_EFFORTS.join(', ')}` });
  }

  // maxTurns
  if (def.maxTurns !== undefined) {
    if (!Number.isInteger(def.maxTurns) || def.maxTurns < 1) {
      errors.push({ field: 'maxTurns', message: 'maxTurns must be an integer ≥ 1' });
    }
  }

  // background
  if (def.background !== undefined && typeof def.background !== 'boolean') {
    errors.push({ field: 'background', message: 'background must be a boolean' });
  }

  // tools
  if (def.tools !== undefined) {
    if (!Array.isArray(def.tools)) {
      errors.push({ field: 'tools', message: 'tools must be a list of strings' });
    } else {
      for (let i = 0; i < def.tools.length; i++) {
        if (typeof def.tools[i] !== 'string' || def.tools[i].trim() === '') {
          errors.push({ field: `tools[${i}]`, message: 'tool entry must be a non-empty string' });
        }
      }
    }
  }

  // disallowedTools
  if (def.disallowedTools !== undefined) {
    if (!Array.isArray(def.disallowedTools)) {
      errors.push({
        field: 'disallowedTools',
        message: 'disallowedTools must be a list of strings',
      });
    } else {
      for (let i = 0; i < def.disallowedTools.length; i++) {
        if (typeof def.disallowedTools[i] !== 'string' || def.disallowedTools[i].trim() === '') {
          errors.push({
            field: `disallowedTools[${i}]`,
            message: 'disallowedTools entry must be a non-empty string',
          });
        }
      }
    }
  }

  // mcpServers
  if (def.mcpServers !== undefined) {
    if (!Array.isArray(def.mcpServers)) {
      errors.push({ field: 'mcpServers', message: 'mcpServers must be a list' });
    } else {
      for (let i = 0; i < def.mcpServers.length; i++) {
        const entry = def.mcpServers[i];
        if (typeof entry === 'string') {
          if (entry.trim() === '') {
            errors.push({
              field: `mcpServers[${i}]`,
              message: 'mcpServers entry must be a non-empty string',
            });
          }
        } else if (entry === null || typeof entry !== 'object') {
          errors.push({
            field: `mcpServers[${i}]`,
            message: 'mcpServers entry must be a string or an inline-server object',
          });
        }
      }
    }
  }

  // isolation
  if (def.isolation !== undefined && def.isolation !== 'worktree') {
    errors.push({ field: 'isolation', message: 'isolation must be "worktree" if set' });
  }

  // memory
  if (def.memory !== undefined && !AGENT_MEMORY_SCOPES.includes(def.memory)) {
    errors.push({
      field: 'memory',
      message: `memory must be one of: ${AGENT_MEMORY_SCOPES.join(', ')}`,
    });
  }

  // hooks
  if (def.hooks !== undefined) {
    if (def.hooks === null || typeof def.hooks !== 'object' || Array.isArray(def.hooks)) {
      errors.push({ field: 'hooks', message: 'hooks must be an object' });
    } else {
      for (const [event, entries] of Object.entries(def.hooks)) {
        if (!Array.isArray(entries)) {
          errors.push({ field: `hooks.${event}`, message: 'hook event must be a list of entries' });
          continue;
        }
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (e === null || typeof e !== 'object' || typeof e.command !== 'string') {
            errors.push({
              field: `hooks.${event}[${i}]`,
              message: 'hook entry must be an object with a command string',
            });
          }
        }
      }
    }
  }

  // skills
  if (def.skills !== undefined) {
    if (!Array.isArray(def.skills)) {
      errors.push({ field: 'skills', message: 'skills must be a list of strings' });
    } else {
      for (let i = 0; i < def.skills.length; i++) {
        if (typeof def.skills[i] !== 'string' || def.skills[i].trim() === '') {
          errors.push({ field: `skills[${i}]`, message: 'skill entry must be a non-empty string' });
        }
      }
    }
  }

  // permissionMode
  if (def.permissionMode !== undefined && !AGENT_PERMISSION_MODES.includes(def.permissionMode)) {
    errors.push({
      field: 'permissionMode',
      message: `permissionMode must be one of: ${AGENT_PERMISSION_MODES.join(', ')}`,
    });
  }

  // initialPrompt
  if (def.initialPrompt !== undefined) {
    if (typeof def.initialPrompt !== 'string' || def.initialPrompt.trim() === '') {
      errors.push({ field: 'initialPrompt', message: 'initialPrompt must be a non-empty string' });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
