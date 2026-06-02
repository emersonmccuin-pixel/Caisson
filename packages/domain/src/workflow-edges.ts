// Typed-edge data shapes (Section 4h / 4h.3).
//
// Replaces today's free-form `$node.field` / `$inputs.X` string substitution
// with structured edges drawn against the closed-world catalog (4h.1) and
// the per-kind port schemas (4h.2).
//
// EdgeRef captures where a value comes from — another node's output, the
// fire-trigger context, or an env var. Literals never become EdgeRefs;
// they stay as plain values on the node body.
//
// NodeEdges layers per-node edge data onto the existing Workflow shape:
//   - `inputs[portName]`: typed-port wires (D77 A — compact `'@X.Y'` form
//     desugars into a structured edge).
//   - `wire[localName]`: template-field wires (D77 B — local placeholder
//     names referenced by `{{ name }}` inside template-text fields).
//   - `output_schema[fieldName]`: subagent's author-declared output shape
//     (D78). Other kinds ignore this field.
//
// This file is data + types only. The actual YAML parser lives in
// `@pc/workflows`'s `typed-parser.ts`.

/** Primitive types carried by catalog entries + node-port schemas. */
export type CatalogType =
  | 'ulid'
  | 'string'
  | 'text'
  | 'int'
  | 'bool'
  | 'object'
  | 'array';

/** Where a typed-edge value originates. Literals are not EdgeRefs — they
 *  remain on the node body as plain values. */
export type EdgeRef =
  /** Wired from another node's output port. `@<nodeId>.<output>`. */
  | { readonly kind: 'node'; readonly nodeId: string; readonly output: string }
  /** Wired from the synthetic trigger root node (D76). `@trigger.<output>`. */
  | { readonly kind: 'trigger'; readonly output: string }
  /** Read from an environment variable. `@env.<NAME>`. Special-cased — not
   *  a catalog entry, no upstream node. */
  | { readonly kind: 'env'; readonly name: string };

/** Per-node typed-edge data. Layered onto the existing Workflow shape via a
 *  flat map keyed by node id. */
export interface NodeEdges {
  /** Typed input port wires. Port names match the kind's
   *  NODE_PORT_SCHEMAS[kind].inputs.ports[].name. Absent entries mean the
   *  port carries a literal value (read from the node body directly). */
  readonly inputs?: Readonly<Record<string, EdgeRef>>;
  /** Template-field wires. Local names referenced by `{{ name }}` inside the
   *  kind's template-text fields. */
  readonly wire?: Readonly<Record<string, EdgeRef>>;
  /** Author-declared output schema. Subagent kind only (D78). Maps output
   *  field name to its catalog type. */
  readonly output_schema?: Readonly<Record<string, CatalogType>>;
}
