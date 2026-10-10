import type { DemoEvent, StreamEvent } from '@binwise/core';
import { ApiError, type BinwiseClient } from './client';

const VAULT = 'main';

/** Opens a WebSocket that reconnects with backoff until closed by the caller. */
function socket<T>(url: string, fn: (e: T) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => (delay = 1000);
    ws.onmessage = (m) => fn(JSON.parse(m.data as string) as T);
    ws.onclose = () => {
      if (closed) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 30000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    ws?.close();
  };
}

export function createHttpClient(api: string, ws: string): BinwiseClient {
  const req = async <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
    const res = await fetch(api + path, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : init?.method === 'POST' ? '{}' : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(json?.error ?? 'http_' + res.status, json?.message ?? 'Something went wrong.');
    return json as T;
  };
  const post = <T>(path: string, body: unknown = {}) => req<T>(path, { method: 'POST', body });
  const v = `/vaults/${VAULT}`;
  return {
    vaultId: VAULT,
    overview: () => req(`${v}/overview`),
    performance: (range) => req(`${v}/performance?range=${range}`),
    pools: () => req('/pools'),
    pool: (id) => req(`/pools/${encodeURIComponent(id)}`),
    positions: () => req(`${v}/positions`),
    decisions: (type) => req(`${v}/decisions${type ? `?type=${type}` : ''}`),
    cycle: () => req(`${v}/cycle`),
    strategy: () => req(`${v}/strategy`),
    saveStrategy: (s) => req(`${v}/strategy`, { method: 'PUT', body: s }),
    pause: () => post(`${v}/pause`),
    resume: () => post(`${v}/resume`),
    setMode: (mode) => post(`${v}/mode`, { mode }),
    deposit: (token, amount) => post(`${v}/deposit`, { token, amount }),
    claim: (id) => post(`/positions/${encodeURIComponent(id)}/claim`),
    close: (id) => post(`/positions/${encodeURIComponent(id)}/close`),
    subscribe: (fn) => socket<StreamEvent>(`${ws}/stream?vault=${VAULT}`, fn),
    demo: (pair, fn) => socket<DemoEvent>(`${ws}/demo?pair=${encodeURIComponent(pair)}`, fn),
  };
}
