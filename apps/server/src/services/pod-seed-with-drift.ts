// Generic "seed pod with drift-reseed" helper.
//
// Pulled out of orchestrator-pod-seed.ts (16a.2) so all stock pods can share
// the same trust model: insert if missing, auto-update if the live row has
// drifted from the seed and has only system-authored audit rows, skip + warn
// if the user has edited it.
//
// User edits are preserved by design — `hasUserAuthoredEdit` returns true if
// any audit row was written by something other than the orchestrator with a
// `system-seed:` / `system-reseed:` reason prefix. Once a user touches a
// stock pod through the UI, the seed stops updating it; source changes have
// to be applied manually via "Reset to default."

import {
  createAgent,
  getAgentByName,
  listAgentAudit,
  updateAgent,
  type CreateAgentInput,
  type UpdateAgentInput,
} from '@pc/db';
import type { PodAgentRow, PodAuditRow } from '@pc/domain';
import { mergeRequiredAgentTools } from '@pc/domain';

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

const SYSTEM_SEED_REASON_PREFIXES = ['system-seed:', 'system-reseed:'];

/** Reasons that count as system-authored regardless of `actor`. A
 *  "Reset to default" click is recorded with `actor='user'` (the user clicked
 *  the button) but the EFFECT is a reset back to canonical seed content — it
 *  is NOT a user customization. Without this carve-out the row's audit log
 *  permanently blocks future drift-reseeds. */
const SYSTEM_DRIVEN_USER_REASONS = ['ui-reset-to-default'];

/** Insert `content` if no row by that name+scope exists; otherwise update any
 *  drifted fields (unless the row has user-authored audit rows, in which case
 *  the live row is left alone and the drift is reported). */
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

  if (hasUserAuthoredEdit(existing.id as PodAgentRow['id'])) {
    return { action: 'skipped-user-edited', agentId: existing.id, reseededFields: drift };
  }

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

function hasUserAuthoredEdit(agentId: PodAgentRow['id']): boolean {
  // Walk newest-first. The drift-reseed lock applies only when an ACTIVE user
  // customization is still in effect — a user edit that has since been
  // followed by a "Reset to default" (or any other system-driven row) is no
  // longer in effect, so future seed reseeds should resume. Returns true at
  // the first user-authored row encountered; returns false the moment a
  // system-driven row breaks the chain.
  const rows = listAgentAudit({ agentId, limit: 1000 });
  for (const r of rows) {
    if (isSystemAuthored(r)) return false;
    if (r.actor === 'user') return true;
  }
  return false;
}

function isSystemAuthored(row: PodAuditRow): boolean {
  const reason = row.reason ?? '';
  // System-driven actions recorded with actor=user (e.g. Reset to default —
  // the user clicked the button, but the EFFECT is a reset back to canonical,
  // not a customization). Don't block future reseeds.
  if (SYSTEM_DRIVEN_USER_REASONS.some((r) => reason === r || reason.startsWith(`${r}:`))) {
    return true;
  }
  if (row.actor !== 'orchestrator') return false;
  return SYSTEM_SEED_REASON_PREFIXES.some((p) => reason.startsWith(p));
}
