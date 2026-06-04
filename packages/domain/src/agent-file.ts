// Round-trip-safe parser/serializer for agent .md files. Uses the `yaml`
// package's Document API so unknown frontmatter fields, comments, key order,
// and YAML node style (block vs flow, quote style) all survive a parse/emit
// cycle byte-for-byte when the AgentDef hasn't changed.
//
// Contract for callers:
//   - `parseAgentFile(text)` returns the typed view plus the original text
//     and an opaque Document handle for serialization.
//   - `serializeAgentFile({ def, body, original })` re-emits the file. If
//     `original` is supplied it acts as the basis — only fields the caller
//     actually changed get written back, everything else (including unknown
//     keys + comments) stays exactly as it was.

import { parseDocument, Document, isMap } from 'yaml';

import {
  type AgentColor,
  type AgentDef,
  type AgentEffort,
  type AgentHookEntry,
  type AgentHooks,
  type AgentMcpServerRef,
  type AgentMemoryScope,
  type AgentPermissionMode,
  type InlineMcpServer,
} from './agent.ts';

const FRONTMATTER_DELIM = '---';

/** Set of frontmatter keys this module manages. Unknown keys are preserved
 *  verbatim by reading directly from the `yaml` Document on serialize. */
const KNOWN_KEYS = new Set<string>([
  'name',
  'description',
  'color',
  'model',
  'effort',
  'maxTurns',
  'background',
  'tools',
  'disallowedTools',
  'mcpServers',
  'isolation',
  'memory',
  'hooks',
  'skills',
  // M5 — ☠ 'pc' (outputDestination was its only field). Old files' pc: blocks
  // round-trip verbatim as unknown keys.
  'permissionMode',
  'initialPrompt',
]);

export interface ParsedAgentFile {
  /** Typed view of the frontmatter. Required fields (`name`, `description`)
   *  may be the empty string when missing — `validateAgentDef` is what
   *  surfaces "missing required" errors. */
  def: AgentDef;
  /** Markdown body below the closing `---`. Verbatim, including leading and
   *  trailing whitespace. */
  body: string;
  /** Original full file text. */
  text: string;
}

export interface AgentParseError {
  ok: false;
  reason:
    | 'no-frontmatter'
    | 'unterminated-frontmatter'
    | 'frontmatter-not-mapping'
    | 'yaml-error';
  message: string;
}

export interface AgentParseOk extends ParsedAgentFile {
  ok: true;
}

export type AgentParseResult = AgentParseOk | AgentParseError;

/** Parse the file text. Returns either a typed parse result or a structured
 *  error — never throws. */
export function parseAgentFile(text: string): AgentParseResult {
  const split = splitFrontmatter(text);
  if (split.kind === 'error') {
    return { ok: false, reason: split.reason, message: split.message };
  }

  let doc: Document;
  try {
    doc = parseDocument(split.frontmatter);
  } catch (err) {
    return {
      ok: false,
      reason: 'yaml-error',
      message: (err as Error).message ?? 'failed to parse YAML frontmatter',
    };
  }

  if (doc.errors.length > 0) {
    return {
      ok: false,
      reason: 'yaml-error',
      message: doc.errors.map((e) => e.message).join('; '),
    };
  }

  if (!isMap(doc.contents)) {
    return {
      ok: false,
      reason: 'frontmatter-not-mapping',
      message: 'frontmatter must be a YAML mapping',
    };
  }

  const def = readDefFromDocument(doc);
  return { ok: true, def, body: split.body, text };
}

export interface SerializeAgentFileInput {
  def: AgentDef;
  body: string;
  /** Original file text — when supplied, used as the round-trip basis so
   *  comments, key order, and unknown keys are preserved. */
  original?: string;
}

/** Emit a fresh file text from the typed inputs. Round-trips byte-for-byte
 *  through parse → serialize when `original` is supplied AND no field on
 *  `def` has changed AND `body` is unchanged. */
export function serializeAgentFile(input: SerializeAgentFileInput): string {
  const { def, body, original } = input;

  if (original) {
    const split = splitFrontmatter(original);
    if (split.kind === 'ok') {
      let doc: Document;
      try {
        doc = parseDocument(split.frontmatter);
      } catch {
        doc = freshDocument(def);
      }
      if (doc.errors.length > 0 || !isMap(doc.contents)) {
        doc = freshDocument(def);
      } else {
        applyDefDiff(doc, def);
      }
      return assemble(doc, body, split.opener, split.closer);
    }
  }

  const doc = freshDocument(def);
  return assemble(doc, body, FRONTMATTER_DELIM + '\n', FRONTMATTER_DELIM + '\n');
}

// ─── internals ───────────────────────────────────────────────────────────────

interface FrontmatterSplitOk {
  kind: 'ok';
  /** Frontmatter region WITHOUT the surrounding `---` lines. */
  frontmatter: string;
  /** Body region (everything after the closing `---` line). */
  body: string;
  /** Opening delimiter line, including the trailing newline. Captures the
   *  exact bytes so round-trip preserves it (`---\n` vs `---\r\n`). */
  opener: string;
  /** Closing delimiter line, including the trailing newline. */
  closer: string;
}

interface FrontmatterSplitErr {
  kind: 'error';
  reason: 'no-frontmatter' | 'unterminated-frontmatter';
  message: string;
}

function splitFrontmatter(text: string): FrontmatterSplitOk | FrontmatterSplitErr {
  if (!text.startsWith(FRONTMATTER_DELIM)) {
    return {
      kind: 'error',
      reason: 'no-frontmatter',
      message: 'agent file must start with a `---` frontmatter opener',
    };
  }

  const firstNl = text.indexOf('\n');
  if (firstNl < 0) {
    return { kind: 'error', reason: 'unterminated-frontmatter', message: 'frontmatter not closed' };
  }
  const openerLine = text.slice(0, firstNl + 1);
  // Require the opener line to be exactly `---` (optionally with \r before \n).
  if (openerLine.replace(/\r?\n$/, '').trim() !== FRONTMATTER_DELIM) {
    return {
      kind: 'error',
      reason: 'no-frontmatter',
      message: 'agent file must start with a `---` line',
    };
  }

  // Find a closing `---` line. Match either `\n---\n` or `\n---\r\n` or EOF
  // (file ends with `\n---`).
  const after = text.slice(firstNl + 1);
  const closerPattern = /(^|\n)---(\r?\n|$)/;
  const m = closerPattern.exec(after);
  if (!m || m.index === undefined) {
    return {
      kind: 'error',
      reason: 'unterminated-frontmatter',
      message: 'frontmatter not closed by a `---` line',
    };
  }

  // m.index points at the leading newline (or 0 if `---` is at the start of `after`).
  const closerStart = m[1] === '\n' ? m.index + 1 : m.index;
  const frontmatter = after.slice(0, closerStart);
  const closerLine = m[0].startsWith('\n') ? m[0].slice(1) : m[0];
  const body = after.slice(closerStart + closerLine.length);

  return { kind: 'ok', frontmatter, body, opener: openerLine, closer: closerLine };
}

function readDefFromDocument(doc: Document): AgentDef {
  const json = (doc.toJS({ maxAliasCount: -1 }) ?? {}) as Record<string, unknown>;

  const def: AgentDef = {
    name: readString(json, 'name') ?? '',
    description: readString(json, 'description') ?? '',
  };

  const color = readString(json, 'color');
  if (color !== undefined) def.color = color as AgentColor;

  const model = readString(json, 'model');
  if (model !== undefined) def.model = model;

  const effort = readString(json, 'effort');
  if (effort !== undefined) def.effort = effort as AgentEffort;

  const maxTurns = readNumber(json, 'maxTurns');
  if (maxTurns !== undefined) def.maxTurns = maxTurns;

  const background = readBoolean(json, 'background');
  if (background !== undefined) def.background = background;

  const tools = readStringList(json, 'tools');
  if (tools !== undefined) def.tools = tools;

  const disallowedTools = readStringList(json, 'disallowedTools');
  if (disallowedTools !== undefined) def.disallowedTools = disallowedTools;

  const mcpServers = readMcpServers(json);
  if (mcpServers !== undefined) def.mcpServers = mcpServers;

  const isolation = readString(json, 'isolation');
  if (isolation !== undefined) def.isolation = isolation as 'worktree';

  const memory = readString(json, 'memory');
  if (memory !== undefined) def.memory = memory as AgentMemoryScope;

  const hooks = readHooks(json);
  if (hooks !== undefined) def.hooks = hooks;

  const skills = readStringList(json, 'skills');
  if (skills !== undefined) def.skills = skills;

  const permissionMode = readString(json, 'permissionMode');
  if (permissionMode !== undefined) def.permissionMode = permissionMode as AgentPermissionMode;

  const initialPrompt = readString(json, 'initialPrompt');
  if (initialPrompt !== undefined) def.initialPrompt = initialPrompt;

  return def;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (typeof v === 'string') return v;
  if (v == null) return undefined;
  return String(v);
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (typeof v === 'number') return v;
  return undefined;
}

function readBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (typeof v === 'boolean') return v;
  return undefined;
}

function readStringList(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (v == null) return undefined;
  // Inline-form `tools: a, b, c` is a plain YAML scalar that parses as a
  // string. Split on commas for the typed view; the original node still
  // round-trips verbatim via the Document.
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry != null) out.push(String(entry));
  }
  return out;
}

function readMcpServers(obj: Record<string, unknown>): AgentMcpServerRef[] | undefined {
  const v = obj.mcpServers;
  if (v == null) return undefined;
  if (!Array.isArray(v)) return undefined;
  const out: AgentMcpServerRef[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const entry = item as Record<string, unknown>;
      const obj: InlineMcpServer = {};
      const extras: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(entry)) {
        if (k === 'command' && typeof val === 'string') obj.command = val;
        else if (k === 'args' && Array.isArray(val)) obj.args = val.map(String);
        else if (k === 'env' && val && typeof val === 'object' && !Array.isArray(val)) {
          obj.env = {} as Record<string, string>;
          for (const [ek, ev] of Object.entries(val as Record<string, unknown>)) {
            obj.env[ek] = String(ev);
          }
        } else if (k === 'url' && typeof val === 'string') obj.url = val;
        else extras[k] = val;
      }
      if (Object.keys(extras).length > 0) obj.extras = extras;
      out.push(obj);
    }
  }
  return out;
}

function readHooks(obj: Record<string, unknown>): AgentHooks | undefined {
  const v = obj.hooks;
  if (v == null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: AgentHooks = {};
  for (const [event, entries] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const list: AgentHookEntry[] = [];
    for (const entry of entries) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { command?: unknown }).command === 'string'
      ) {
        const e: AgentHookEntry = { command: (entry as { command: string }).command };
        const matcher = (entry as { matcher?: unknown }).matcher;
        if (typeof matcher === 'string') e.matcher = matcher;
        list.push(e);
      }
    }
    out[event] = list;
  }
  return out;
}

function applyDefDiff(doc: Document, def: AgentDef): void {
  // Read the current parsed view from the same Document and only mutate the
  // keys whose typed values differ. Skipping no-op writes is what keeps
  // round-trip byte-exact when nothing changed (mutations rebuild the node,
  // losing flow-style + quote style).
  const current = readDefFromDocument(doc);

  for (const key of KNOWN_KEYS) {
    const k = key as keyof AgentDef;
    const next = def[k];
    const prev = current[k];

    if (next === undefined) {
      if (prev !== undefined) doc.delete(key);
      continue;
    }

    if (deepEqual(next, prev)) continue;

    doc.set(key, next as unknown);
  }
}

function freshDocument(def: AgentDef): Document {
  const obj: Record<string, unknown> = {};
  for (const key of KNOWN_KEYS) {
    const v = def[key as keyof AgentDef];
    if (v !== undefined) obj[key] = v;
  }
  return new Document(obj);
}

function assemble(doc: Document, body: string, opener: string, closer: string): string {
  // `lineWidth: 0` disables line folding so long descriptions / comma-form
  // tools lists round-trip byte-for-byte instead of wrapping at 80 cols.
  let yamlText = doc.toString({ lineWidth: 0 });
  if (!yamlText.endsWith('\n')) yamlText += '\n';
  return opener + yamlText + closer + body;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
        return false;
      }
    }
    return true;
  }
  return false;
}
