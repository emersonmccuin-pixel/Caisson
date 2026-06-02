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
export function classifyThrow(err: unknown): FailureClassification {
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

export interface TransientRetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Test seam — supply a deterministic sleep / no-jitter source. */
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number, baseMs: number, maxMs: number, jitter: () => number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  // Full jitter: random point in [0, exp].
  return Math.floor(exp * jitter());
}

/**
 * Run `fn`, retrying only on transient throws with exponential backoff + jitter.
 * Terminal throws propagate immediately; the last transient throw propagates
 * after the attempt budget is spent.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseMs = options.baseMs ?? 50;
  const maxMs = options.maxMs ?? 1000;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === attempts - 1) throw err;
      await sleep(backoffMs(attempt, baseMs, maxMs, jitter));
    }
  }
  throw lastErr;
}
