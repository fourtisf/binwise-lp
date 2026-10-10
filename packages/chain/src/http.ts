/**
 * JSON over HTTP with timeouts, retries with exponential backoff + jitter,
 * and a per-host minimum spacing between requests (simple rate limit).
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
  }
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Minimum ms between requests to the same host */
  minIntervalMs?: number;
}

const nextSlot = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitTurn(host: string, minIntervalMs: number) {
  if (!minIntervalMs) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + minIntervalMs);
  if (at > now) await sleep(at - now);
}

const retryable = (status: number) => status === 429 || status >= 500;

export async function fetchJson<T>(url: string, o: FetchOptions = {}): Promise<T> {
  const host = new URL(url).host;
  const retries = o.retries ?? 4;
  let attempt = 0;
  for (;;) {
    await waitTurn(host, o.minIntervalMs ?? 0);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15_000);
    try {
      const res = await fetch(url, {
        method: o.method ?? 'GET',
        headers: { accept: 'application/json', ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new HttpError(res.status, url, text);
        if (!retryable(res.status) || attempt >= retries) throw err;
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      } else {
        return (text ? JSON.parse(text) : null) as T;
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (attempt >= retries) throw e;
      await sleep(backoff(attempt));
    } finally {
      clearTimeout(timer);
    }
    attempt++;
  }
}

/** 0.5s, 1s, 2s, 4s… capped at 30s, with ±25% jitter. */
export function backoff(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base * (0.75 + Math.random() * 0.5);
}

/** Retries any async call with backoff (used around RPC calls). */
export async function withRetry<T>(fn: () => Promise<T>, retries = 4, label = 'call'): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw new Error(`${label} failed after ${attempt + 1} attempts: ${(e as Error).message}`);
      await sleep(backoff(attempt));
      attempt++;
    }
  }
}
