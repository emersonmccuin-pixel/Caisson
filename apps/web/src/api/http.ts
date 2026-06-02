// T2.1 — bounded retry so cold-load reads survive the ~1s API-restart window.
// Two transient signals: a 503 (server says "not ready" — retry any method,
// honoring Retry-After) and a thrown fetch error (connection refused — retry
// GET only; a refused connection never landed, but a POST might have, so we
// don't risk a double-submit on writes).

interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  retryNetworkErrors: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('Retry-After');
  if (!header) return null;
  const secs = Number(header);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

async function fetchWithRetry(
  path: string,
  init: RequestInit | undefined,
  opts: RetryOptions,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt += 1) {
    const isLast = attempt === opts.attempts - 1;
    try {
      const res = await fetch(path, init);
      if (res.status === 503 && !isLast) {
        await sleep(retryAfterMs(res) ?? backoffMs(attempt, opts.baseMs, opts.maxMs));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (!opts.retryNetworkErrors || isLast) throw err;
      await sleep(backoffMs(attempt, opts.baseMs, opts.maxMs));
    }
  }
  throw lastErr;
}

const READ_RETRY: RetryOptions = { attempts: 4, baseMs: 120, maxMs: 1000, retryNetworkErrors: true };
const WRITE_RETRY: RetryOptions = { attempts: 4, baseMs: 120, maxMs: 1000, retryNetworkErrors: false };

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetchWithRetry(path, undefined, READ_RETRY);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithRetry(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    WRITE_RETRY,
  );
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `${path} → ${res.status}`);
  }
  return data;
}

export async function postJsonMethod<T>(
  path: string,
  body: unknown,
  method: 'POST' | 'PATCH' | 'PUT',
): Promise<T> {
  const res = await fetchWithRetry(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    WRITE_RETRY,
  );
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `${path} → ${res.status}`);
  }
  return data;
}
