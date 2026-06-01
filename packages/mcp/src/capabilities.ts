// Slice 011 (11A) → Slice 016 — DERIVED capability registry.
//
// A lookup layer keyed by tool name → { family } metadata used to reason about
// which contract family a tool belongs to. Slice 016: it now DERIVES from the
// canonical `PC_RIG_TOOL_REGISTRY` (@pc/domain) — `family` is carried per
// registry record, so the family map can no longer drift from the tool list.
// The slice-016 parity test asserts capabilities keys === registry names.

import { PC_RIG_TOOL_REGISTRY, type CapabilityFamily } from '@pc/domain';

export type { CapabilityFamily };

export interface ToolCapability {
  family: CapabilityFamily;
}

/** name → capability. Derived from the registry (bare tool name → { family }). */
export const CAPABILITIES: Record<string, ToolCapability> = Object.fromEntries(
  PC_RIG_TOOL_REGISTRY.map((d) => [d.name, { family: d.family }]),
);

/** All tool names the registry covers. */
export const CAPABILITY_NAMES: readonly string[] = Object.keys(CAPABILITIES);
