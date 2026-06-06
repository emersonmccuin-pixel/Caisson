// Slice 1 (Areas + context model) — dispatch-time scoped composition (door 1).
//
// `buildContextChain` produces the "## Project & area context" block that gets
// injected into the agent system prompt at materialise time. It walks the scope
// chain (project → area → ancestor work items → leaf work item) and applies
// the ~20k char budget: the chain INDEX is always included in full; full doc
// bodies are inlined closest-scope-first until the budget is exhausted; the
// rest of the index stays as index-only entries (title + one-liner + age).
//
// Budget constant: CONTEXT_CHAIN_BUDGET_CHARS. This is a "dial tuned from real
// runs" — exported as a named constant for easy adjustment. Current default 20k.

import { listContextChainDocs, type ContextDocWithRank } from '@pc/db';
import type { ULID } from '@pc/domain';

/** ~20k char budget for the full context chain block (index + inlined bodies).
 *  Tuned from real dispatch sizes; adjust as needed. */
export const CONTEXT_CHAIN_BUDGET_CHARS = 20_000;

/** A single entry in the rendered chain index. */
export interface IndexEntry {
  doc: ContextDocWithRank;
  /** First non-empty, non-heading line of the body — capped at 120 chars. */
  oneLiner: string;
  /** Human-readable age string (e.g. "3d ago", "<1h ago"). */
  age: string;
}

/** Build the "## Project & area context" markdown string for injection into the
 *  agent system prompt. Returns an empty string when there are no docs in the
 *  chain. The caller is responsible for the optional surrounding whitespace. */
export function buildContextChain(input: {
  workItemId: ULID;
  projectId: ULID;
  budgetChars?: number;
}): string {
  const budget = input.budgetChars ?? CONTEXT_CHAIN_BUDGET_CHARS;
  const docs = listContextChainDocs({ workItemId: input.workItemId, projectId: input.projectId });

  if (docs.length === 0) return '';

  const now = Date.now();
  const entries: IndexEntry[] = docs.map((doc) => ({
    doc,
    oneLiner: extractOneLiner(doc.body),
    age: formatAge(now - doc.updatedAt),
  }));

  return renderChain(entries, budget);
}

/** Pure renderer — accepts pre-computed entries + budget so it's unit-testable
 *  without DB fixtures. Returns the full markdown block. */
export function renderChain(entries: IndexEntry[], budgetChars: number): string {
  if (entries.length === 0) return '';

  // 1. Render the full index first (always included).
  const indexLines = renderIndex(entries);
  const indexBlock = indexLines.join('\n');

  // 2. If the index alone exceeds budget, still emit it (index is never dropped)
  //    but inline zero bodies.
  const remainingAfterIndex = budgetChars - indexBlock.length;

  // 3. Inline bodies closest-scope-first (lowest distanceRank first).
  //    entries are already sorted leaf-first by listContextChainDocs.
  const bodySections: string[] = [];
  let remaining = remainingAfterIndex;
  for (const entry of entries) {
    if (!entry.doc.body.trim()) continue; // no body to inline
    const section = renderBodySection(entry);
    if (remaining >= section.length) {
      bodySections.push(section);
      remaining -= section.length;
    }
    // else: this doc stays index-only (already in the index block)
  }

  const parts: string[] = [
    '## Project & area context',
    '',
    '> Chain index (title · scope · age). Full bodies follow for the closest scopes.',
    '',
    indexBlock,
  ];

  if (bodySections.length > 0) {
    parts.push('', '### Context doc bodies', '');
    parts.push(...bodySections);
  }

  return parts.join('\n');
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Render the chain index: one line per doc with title + scope + age. */
function renderIndex(entries: IndexEntry[]): string[] {
  const lines: string[] = [];
  for (const { doc, oneLiner, age } of entries) {
    const scope = scopeLabel(doc);
    const oneLinerPart = oneLiner ? ` — ${oneLiner}` : '';
    lines.push(`- **${doc.title}** (\`${doc.id}\`) · ${scope} · ${age}${oneLinerPart}`);
  }
  return lines;
}

/** Render the full body section for one doc. */
function renderBodySection(entry: IndexEntry): string {
  const { doc } = entry;
  const scope = scopeLabel(doc);
  return [
    `#### ${doc.title} (${scope} · ${entry.age})`,
    '',
    doc.body.trim(),
    '',
  ].join('\n');
}

/** Human-readable scope label. */
function scopeLabel(doc: ContextDocWithRank): string {
  if (doc.scopeKind === 'project') return 'project';
  if (doc.scopeKind === 'area') return 'area';
  return doc.distanceRank === 0 ? 'this task' : `ancestor (depth ${doc.distanceRank})`;
}

/** Extract the first non-empty, non-heading line from a markdown body.
 *  Caps at 120 chars. Returns '' when the body is empty or heading-only. */
export function extractOneLiner(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  }
  return '';
}

/** Format a duration (ms) into a human-readable relative age string. */
export function formatAge(ageMs: number): string {
  if (ageMs < 0) ageMs = 0;
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 1) return '<1m ago';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/** Wrap a non-empty context chain string for injection into the system prompt.
 *  Returns `''` when `chain` is empty so callers can safely concatenate. */
export function renderContextChain(chain: string): string {
  if (!chain.trim()) return '';
  return `\n\n${chain}`;
}
