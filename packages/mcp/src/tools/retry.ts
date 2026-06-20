// T2.1 — bounded retry for the pc-rig localhost client to the API. An agent's
// tool call hits the API over 127.0.0.1; during an API restart the raw
// http.request rejects (ECONNREFUSED) with no retry. This mirrors the web
// client's retry contract but lives here because @pc/mcp can't import
// apps/server. Retries on a transient connection error; a 503 is retried ONLY
// when it carries a Retry-After header (explicit server backpressure on a
// safe-to-retry-identical request). A bare 503 (no Retry-After) is returned
// immediately to the caller — it is a deterministic refusal, not a transient
// failure, and the endpoint may be non-idempotent.

const TRANSIENT_CONN_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

export function isTransientConnError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_CONN_CODES.has(code)) return true;
  }
  const msg = err instanceof Error ? err.message : '';
  return /ECONNREFUSED|ECONNRESET|socket hang up/i.test(msg);
}

export interface ConnRetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number, baseMs: number, maxMs: number, jitter: () => number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(exp * (0.5 + jitter() * 0.5));
}

/**
 * Run `attempt`, retrying when it throws a transient connection error or
 * resolves with a 503 that carries a Retry-After header. A 503 without
 * Retry-After (deterministic server refusal on a potentially non-idempotent
 * endpoint) returns immediately — NOT retried. Any other non-2xx response also
 * returns immediately. The last transient throw propagates after the attempt
 * budget is spent.
 */
export async function withConnRetry<T extends { status: number; retryAfter?: string | null }>(
  attempt: () => Promise<T>,
  options: ConnRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseMs = options.baseMs ?? 80;
  const maxMs = options.maxMs ?? 1000;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? Math.random;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    const isLast = i === attempts - 1;
    try {
      const result = await attempt();
      if (result.status === 503 && result.retryAfter && !isLast) {
        await sleep(backoffMs(i, baseMs, maxMs, jitter));
        continue;
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientConnError(err) || isLast) throw err;
      await sleep(backoffMs(i, baseMs, maxMs, jitter));
    }
  }
  throw lastErr;
}
