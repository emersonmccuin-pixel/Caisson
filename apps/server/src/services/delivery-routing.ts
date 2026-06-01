// Slice 008 — per-flow delivery selector (Channel ↔ mailbox cutover gate).
// Slice 017 Phase A — default flipped Channel → mailbox.
//
// THE DEFAULT: every flow now DEFAULTS to `'mailbox'`. An absent or unknown env
// value resolves to `'mailbox'` (mirrors `readTransportMode()` in
// agent-delivery.ts). Setting `PC_DELIVERY_*=channel` still forces the legacy
// Channel path — flipping back stays possible until Phase C deletes the gate.
//
// The three flows are independent and individually reversible:
//   - PC_DELIVERY_AGENT          — agent completed/failed/queued-started/asks
//   - PC_DELIVERY_WORKFLOW_REVIEW — workflow orchestrator-review
//   - PC_DELIVERY_WEBHOOK         — external /channel/:slug/:source webhook
//
// The gate selects ONE path (no double delivery). The resolver is injectable
// so tests can flip a flow without touching process.env.

export type DeliveryMode = 'channel' | 'mailbox';

export type DeliveryFlow = 'agent' | 'workflow-review' | 'webhook';

const ENV_KEY: Record<DeliveryFlow, string> = {
  agent: 'PC_DELIVERY_AGENT',
  'workflow-review': 'PC_DELIVERY_WORKFLOW_REVIEW',
  webhook: 'PC_DELIVERY_WEBHOOK',
};

/** Resolve a flow's mode. Unknown/missing ⟹ `'mailbox'` (Phase A default).
 *  `PC_DELIVERY_*=channel` still forces the legacy Channel path. */
export function readDeliveryMode(flow: DeliveryFlow): DeliveryMode {
  const raw = (process.env[ENV_KEY[flow]] ?? '').trim().toLowerCase();
  return raw === 'channel' ? 'channel' : 'mailbox';
}

/** A pure per-flow resolver. The env-backed default is used in production;
 *  tests inject a fixed map so they don't depend on env. */
export interface DeliveryRouter {
  mode(flow: DeliveryFlow): DeliveryMode;
}

export function envDeliveryRouter(): DeliveryRouter {
  return { mode: (flow) => readDeliveryMode(flow) };
}

/** Build a router from a fixed map (test seam). Any unspecified flow ⟹ channel. */
export function fixedDeliveryRouter(modes: Partial<Record<DeliveryFlow, DeliveryMode>>): DeliveryRouter {
  return { mode: (flow) => modes[flow] ?? 'channel' };
}
