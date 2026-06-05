// Generic "seed pod with drift-reseed" helper.
//
// Pulled out of orchestrator-pod-seed.ts (16a.2) so all stock pods share one
// trust model: insert if missing, else auto-update every field that has
// drifted from the canonical seed. The seed is the SINGLE SOURCE OF TRUTH for
// built-in (stock) pods — they are controlled centrally and cannot be
// user-edited (the PATCH /api/agents/pods/:id door rejects stock rows). To
// customize a built-in, clone it into a project; the clone is user-created and
// fully editable.
//
// Historical note: this helper used to SKIP rows a user had edited
// (`hasUserAuthoredEdit`), preserving their customization. That lock was
// removed when built-ins became non-editable — the seed now always wins, which
// also heals any install that diverged via the old edit path on its next boot.

import {
  createAgent,
  getAgentByName,
  updateAgent,
  type CreateAgentInput,
  type UpdateAgentInput,
} from '@pc/db';
import type { PodAgentRow } from '@pc/domain';
import { mergeRequiredAgentTools } from '@pc/domain';

// `skipped-user-edited` is retired — the seed never skips anymore (see header).
// Kept in the union so existing boot-log switch arms stay valid; never produced.
export type SeedPodAction = 'inserted' | 'unchanged' | 'reseeded' | 'skipped-user-edited';

export interface SeedPodResult {
  action: SeedPodAction;
  agentId: string;
  /** Fields that drifted from the seed. Populated on `reseeded` (the fields
   *  just updated) and `skipped-user-edited` (the fields we *would* have
   *  updated had the row not been user-edited). */
  reseededFields: string[];
}

export interface SeedPodOptions {
  /** Tag prepended to the audit-log `reason` so boot-time log readers can tell
   *  what triggered the seed (e.g., `"16a.1"`, `"17e"`). */
  reasonTag: string;
}

/** Insert `content` if no row by that name+scope exists; otherwise update
 *  every field that drifted from the canonical seed (built-ins are controlled
 *  centrally — no user-edit lock). */
export function seedPodWithDriftReseed(
  content: CreateAgentInput,
  opts: SeedPodOptions,
): SeedPodResult {
  const existing = getAgentByName({ name: content.name, scope: content.scope });
  if (!existing) {
    const row = createAgent(content, {
      actor: 'orchestrator',
      reason: `system-seed:${opts.reasonTag} — ${content.scope} ${content.name} pod created at boot`,
    });
    return { action: 'inserted', agentId: row.id, reseededFields: [] };
  }

  const drift = collectDriftedFields(existing, content);
  if (drift.length === 0) {
    return { action: 'unchanged', agentId: existing.id, reseededFields: [] };
  }

  // No user-edit lock: built-ins are controlled centrally, so the seed always
  // reseeds drifted fields (this also heals installs that diverged via the old
  // — now removed — stock-pod edit path).
  const patch: UpdateAgentInput = {};
  for (const key of drift) {
    (patch as Record<string, unknown>)[key] = (content as unknown as Record<string, unknown>)[key];
  }
  updateAgent(existing.id as PodAgentRow['id'], patch, {
    actor: 'orchestrator',
    reason: `system-reseed:${opts.reasonTag} — ${content.name} drift on fields [${drift.join(', ')}]`,
  });
  return { action: 'reseeded', agentId: existing.id, reseededFields: drift };
}

const SEED_OWNED_FIELDS = [
  'prompt',
  'tools',
  'model',
  'effort',
  'maxTurns',
  'description',
  // Section 36 — drift-reseed picks up source changes to dispatch_guidance.
  // origin is set at insert + not patchable through updateAgent, so it stays
  // off this list (the migration backfilled existing stock rows, and new
  // installs insert with origin: 'stock' from the start).
  'dispatchGuidance',
] as const;

/** Compare a live agent row against its canonical seed content and return the
 *  list of `SEED_OWNED_FIELDS` names that have drifted. Section 36+ exposes
 *  this for the Agents tab "Customized" pill + Specialists tab "Reset all to
 *  default" surfaces, so the same drift logic that drives boot-time reseeding
 *  also drives the UI affordances. */
export function collectDriftedFields(
  live: PodAgentRow,
  content: CreateAgentInput,
): string[] {
  const drift: string[] = [];
  // Section 26 — for the tools field, compare against the *merged* seed (the
  // repo layer auto-merges REQUIRED_AGENT_TOOLS at create/update time, so the
  // live row's tools always include them; the raw seed list usually doesn't).
  // Without this, every boot would false-positive a `tools` drift on every pod.
  const seed = {
    ...content,
    tools: mergeRequiredAgentTools(content.tools ?? []),
  } as unknown as Record<string, unknown>;
  const liveAny = live as unknown as Record<string, unknown>;
  for (const f of SEED_OWNED_FIELDS) {
    // Normalize undefined → null so a seed content that omits the field
    // matches a live row whose column defaulted to null. Without this,
    // dispatchGuidance (seed = undefined, live = null) false-drifts on every
    // unrelated boot for pods that don't set it.
    const seedVal = seed[f] ?? null;
    const liveVal = liveAny[f] ?? null;
    if (JSON.stringify(seedVal) !== JSON.stringify(liveVal)) drift.push(f);
  }
  return drift;
}
