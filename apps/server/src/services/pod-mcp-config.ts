import type { PodMcpServerConfig } from '@pc/domain';

// Slice 011 (11F) — boundary validation for an external/per-pod MCP server
// config entry. Validates the { command, args, env, url } SHAPE only (config
// shape only; capability discovery is out — plan section 14/16). Hardened to
// reject contradictory / empty / under-specified entries that the prior lax
// validator silently accepted, without changing any valid stdio ({command[,
// args][, env]}) or HTTP ({url}) config's acceptance or output shape.

export function parsePodMcpServerConfig(v: unknown): PodMcpServerConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('mcp server config must be an object');
  }
  const cfg = v as Record<string, unknown>;
  const out: PodMcpServerConfig = {};
  if (cfg.command !== undefined) {
    if (typeof cfg.command !== 'string') throw new Error('mcp.command must be a string');
    if (cfg.command.trim().length === 0) throw new Error('mcp.command must not be empty');
    out.command = cfg.command;
  }
  if (cfg.args !== undefined) {
    if (!Array.isArray(cfg.args) || !cfg.args.every((a) => typeof a === 'string')) {
      throw new Error('mcp.args must be string[]');
    }
    out.args = cfg.args as string[];
  }
  if (cfg.env !== undefined) {
    if (!cfg.env || typeof cfg.env !== 'object' || Array.isArray(cfg.env)) {
      throw new Error('mcp.env must be an object of string=string');
    }
    const env: Record<string, string> = {};
    for (const [k, val] of Object.entries(cfg.env as Record<string, unknown>)) {
      if (typeof val !== 'string') throw new Error(`mcp.env.${k} must be a string`);
      env[k] = val;
    }
    out.env = env;
  }
  if (cfg.url !== undefined) {
    if (typeof cfg.url !== 'string') throw new Error('mcp.url must be a string');
    if (cfg.url.trim().length === 0) throw new Error('mcp.url must not be empty');
    out.url = cfg.url;
  }
  // Transport must be specified and unambiguous: a stdio entry uses `command`
  // (+ optional args/env); an HTTP entry uses `url`. Reject entries that pick
  // neither or both, and stdio-only fields paired with a `url`.
  if (out.command === undefined && out.url === undefined) {
    throw new Error('mcp server config requires either command (stdio) or url (http)');
  }
  if (out.command !== undefined && out.url !== undefined) {
    throw new Error('mcp server config must not set both command and url');
  }
  if (out.url !== undefined && (out.args !== undefined || out.env !== undefined)) {
    throw new Error('mcp.args / mcp.env are only valid with command (stdio), not url');
  }
  return out;
}
