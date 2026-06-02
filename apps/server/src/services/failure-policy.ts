// T2.1 — failure taxonomy + bounded transient retry. Server-side only (all
// consumers live in apps/server). Distinct from the workflow-node retry-policy:
// this classifies infra throws (db-busy / host-blip / network) so cold-load
// routes can answer 503+Retry-After instead of a blanket 500.

export type FailureKind = 'transient' | 'terminal';

export type FailureReason = 'db-busy' | 'host-blip' | 'network' | 'terminal';

export interface FailureClassification {
  kind: FailureKind;
  reason: FailureReason;
}

const TRANSIENT_NET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

function errCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function errName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : '';
}

/** Classify a thrown error into transient (worth retrying / 503) vs terminal. */
function classifyThrow(err: unknown): FailureClassification {
  const code = errCode(err);
  const msg = errMessage(err);

  // SQLite contention — the write/read didn't land; safe to retry.
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /SQLITE_(BUSY|LOCKED)/.test(msg)) {
    return { kind: 'transient', reason: 'db-busy' };
  }

  // Aborted / timed-out in-flight call (e.g. a host blip).
  if (errName(err) === 'AbortError' || code === 'ABORT_ERR' || /timed? ?out/i.test(msg)) {
    return { kind: 'transient', reason: 'host-blip' };
  }

  // Connection-level failures (the dominant API-restart symptom).
  if ((code && TRANSIENT_NET_CODES.has(code)) || /ECONNREFUSED|ECONNRESET|socket hang up/i.test(msg)) {
    return { kind: 'transient', reason: 'network' };
  }

  return { kind: 'terminal', reason: 'terminal' };
}

export function isTransient(err: unknown): boolean {
  return classifyThrow(err).kind === 'transient';
}
