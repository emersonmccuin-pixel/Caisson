import type { McpServerTransport, PodMcpServerConfig, SecretRef, TransportValue } from '@pc/domain';

// Slice 011 (11F) — boundary validation for an external/per-pod MCP server
// config entry. Validates the { command, args, env, url } SHAPE only (config
// shape only; capability discovery is out — plan section 14/16). Hardened to
// reject contradictory / empty / under-specified entries that the prior lax
// validator silently accepted, without changing any valid stdio ({command[,
// args][, env]}) or HTTP ({url}) config's acceptance or output shape.
//
// Slice 2 (pc-pty-chat-400.3): adds parseMcpServerTransport which also
// accepts { $secretRef: string } values in headers/env (registry form).

/** True when `v` is a `{ $secretRef: string }` sentinel. */
function isSecretRefValue(v: unknown): v is SecretRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).$secretRef === 'string'
  );
}

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

/** Parse and validate a registry MCP server transport — the STORED form that
 *  may contain `{ $secretRef: "<credId>" }` sentinel values in `headers`/`env`.
 *
 *  Accepts the same structural rules as `parsePodMcpServerConfig` (must have
 *  exactly one of `command` or `url`) plus:
 *  - HTTP configs may include `headers` — each value is either a plain string
 *    or a `{ $secretRef: string }` object.
 *  - Stdio configs may include `env` — each value follows the same rule.
 *
 *  Used at the API boundary when a user submits a transport that may already
 *  contain refs (e.g. copy-paste from another server config). */
export function parseMcpServerTransport(v: unknown): McpServerTransport {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('mcp server config must be an object');
  }
  const cfg = v as Record<string, unknown>;
  const out: McpServerTransport = {};
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
      throw new Error('mcp.env must be an object');
    }
    const env: Record<string, TransportValue> = {};
    for (const [k, val] of Object.entries(cfg.env as Record<string, unknown>)) {
      if (typeof val === 'string') {
        env[k] = val;
      } else if (isSecretRefValue(val)) {
        env[k] = val;
      } else {
        throw new Error(`mcp.env.${k} must be a string or { "$secretRef": "<id>" }`);
      }
    }
    out.env = env;
  }
  if (cfg.headers !== undefined) {
    if (!cfg.headers || typeof cfg.headers !== 'object' || Array.isArray(cfg.headers)) {
      throw new Error('mcp.headers must be an object');
    }
    const headers: Record<string, TransportValue> = {};
    for (const [k, val] of Object.entries(cfg.headers as Record<string, unknown>)) {
      if (typeof val === 'string') {
        headers[k] = val;
      } else if (isSecretRefValue(val)) {
        headers[k] = val;
      } else {
        throw new Error(`mcp.headers.${k} must be a string or { "$secretRef": "<id>" }`);
      }
    }
    out.headers = headers;
  }
  if (cfg.url !== undefined) {
    if (typeof cfg.url !== 'string') throw new Error('mcp.url must be a string');
    if (cfg.url.trim().length === 0) throw new Error('mcp.url must not be empty');
    out.url = cfg.url;
  }
  if (out.command === undefined && out.url === undefined) {
    throw new Error('mcp server config requires either command (stdio) or url (http)');
  }
  if (out.command !== undefined && out.url !== undefined) {
    throw new Error('mcp server config must not set both command and url');
  }
  if (out.url !== undefined && (out.args !== undefined || out.env !== undefined)) {
    throw new Error('mcp.args / mcp.env are only valid with command (stdio), not url');
  }
  if (out.command !== undefined && out.headers !== undefined) {
    throw new Error('mcp.headers is only valid with url (http), not command');
  }
  return out;
}
