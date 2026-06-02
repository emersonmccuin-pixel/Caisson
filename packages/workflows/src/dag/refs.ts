// Section 19.4 — `$nodeId.output[.field]` reference resolution. Pure, I/O-free.
//
// The regex + grammar are lifted from Archon's substituteNodeOutputRefs, but
// the VALUE source is swapped: instead of an in-memory NodeOutput map, a
// `RefResolver` callback returns the resolved string for a (nodeId, field)
// pair. The server provides a resolver that reads the child work item's body
// (`.output`) or a structured field (`.output.field`) — see the port map's
// "stateless over work items" note. `$self` resolves to the current node.

/**
 * Resolve `$nodeId.output` (field = undefined) or `$nodeId.output.field` to a
 * string. Return '' for a missing/empty value (callers fail-closed on that).
 * Pure — no DB access; the server closes over the work-item reads.
 */
export type RefResolver = (nodeId: string, field: string | undefined) => string;

/** Matches `$nodeId.output` optionally followed by `.field`. nodeId allows
 *  hyphens (slugs); field is a plain identifier. */
const REF_PATTERN = /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?/g;

/** POSIX single-quote escape: wrap in '…' and replace ' with '\''. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Extract every `$nodeId.output[.field]` reference from a template. Used by the
 *  save-time validator (§4) to check refs point at a strictly-earlier step.
 *  Returns one entry per match (duplicates preserved). */
export function extractRefs(template: string): { nodeId: string; field?: string }[] {
  const out: { nodeId: string; field?: string }[] = [];
  const re = new RegExp(REF_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    out.push(m[2] !== undefined ? { nodeId: m[1]!, field: m[2] } : { nodeId: m[1]! });
  }
  return out;
}

/**
 * Replace every `$nodeId.output[.field]` in `template` with the resolver's
 * value. With `escapedForBash`, each substituted value is single-quoted so it
 * lands as one shell argument.
 */
export function substituteRefs(
  template: string,
  resolve: RefResolver,
  opts: { escapedForBash?: boolean } = {}
): string {
  const escaped = opts.escapedForBash ?? false;
  return template.replace(REF_PATTERN, (_match, nodeId: string, field: string | undefined) => {
    const value = resolve(nodeId, field) ?? '';
    return escaped ? shellQuote(value) : value;
  });
}
