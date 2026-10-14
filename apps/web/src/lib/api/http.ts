import type { DemoEvent, StreamEvent } from '@kovra/core';
import { ApiError, type KovraClient } from './client';

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
    ws.onclose = (ev) => {
      // 4404 = unknown vault/pair: don't hammer the server.
      if (closed || ev.code === 4404) return;
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

export function createHttpClient(api: string, ws: string): KovraClient {
  let vault = '';
  const req = async <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
    const res = await fetch(api + path, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const json = await res.json().catch(() => null);
    // 429: the API's rate limit (its body says "Too Many Requests"); callers that poll wait and ask again.
    if (!res.ok) throw new ApiError(res.status === 429 ? 'rate_limited' : (json?.error ?? 'http_' + res.status), json?.message ?? 'Something went wrong.');
    return json as T;
  };
  const post = <T>(path: string, body: unknown = {}) => req<T>(path, { method: 'POST', body });
  const v = () => `/vaults/${vault}`;
  const orNull = <T>(p: Promise<T>) => p.catch(() => null);
  return {
    kind: 'http',
    get vaultId() {
      return vault;
    },
    useVault: (id) => (vault = id),
    me: () => orNull(req('/me')),
    demoVaultId: async () => (await orNull(req<{ id: string }>('/vaults/demo')))?.id ?? null,
    signInChallenge: (wallet) => req(`/auth/nonce${wallet ? `?wallet=${encodeURIComponent(wallet)}` : ''}`),
    signIn: async (wallet, message, signature) => {
      await post('/auth/verify', { wallet, message, signature });
    },
    signOut: async () => {
      await post('/auth/logout');
    },
    overview: () => req(`${v()}/overview`),
    portfolio: () => req(`${v()}/portfolio`),
    setPublic: (enabled, showAmounts) => req(`${v()}/public`, { method: 'PUT', body: { enabled, ...(showAmounts !== undefined ? { showAmounts } : {}) } }),
    publicPortfolio: (id) => req(`/public/${encodeURIComponent(id)}`),
    publicList: () => req('/public'),
    balance: (poolId) => req(`${v()}/balance${poolId ? `?pool=${encodeURIComponent(poolId)}` : ''}`),
    performance: (range) => req(`${v()}/performance?range=${range}`),
    pools: () => req(`/pools?vault=${vault}`),
    pool: (id) => req(`/pools/${encodeURIComponent(id)}?vault=${vault}`),
    positions: () => req(`${v()}/positions`),
    decisions: (f) => {
      const q = new URLSearchParams();
      if (f?.types?.length) q.set('type', f.types.join(','));
      if (f?.exclude?.length) q.set('exclude', f.exclude.join(','));
      return req(`${v()}/decisions${q.size ? `?${q}` : ''}`);
    },
    cycle: () => req(`${v()}/cycle`),
    strategy: () => req(`${v()}/strategy`),
    saveStrategy: (s) => req(`${v()}/strategy`, { method: 'PUT', body: s }),
    pause: () => post(`${v()}/pause`),
    resume: () => post(`${v()}/resume`),
    setMode: (mode, confirm) => post(`${v()}/mode`, { mode, confirm }),
    claim: (id) => post(`/positions/${encodeURIComponent(id)}/claim`),
    close: (id) => post(`/positions/${encodeURIComponent(id)}/close`),
    deploy: (poolId, usd, override, opts) => post(`/vaults/${vault}/deploy`, { poolId, usd, override, ...opts }),
    walletPrepare: (action, legacyOnly) => post(`${v()}/wallet/prepare`, { ...action, legacyOnly }),
    walletSend: (tx, planId, step) => post(`${v()}/wallet/send`, { tx, planId, step }),
    walletCancel: async (planId) => {
      await post(`${v()}/wallet/plans/${encodeURIComponent(planId)}/cancel`);
    },
    walletTx: (sig) => req(`${v()}/wallet/tx/${encodeURIComponent(sig)}`),
    walletPending: () => req(`${v()}/wallet/pending`),
    walletDone: (planId, signatures) => post(`${v()}/wallet/plans/${encodeURIComponent(planId)}/done`, { signatures }),
    depositLive: (signature) => post(`${v()}/deposit`, { signature }),
    depositScan: () => post(`${v()}/deposit/scan`, {}),
    releaseCustody: () => post(`${v()}/custody/release`, { confirm: true }),
    withdrawable: () => req(`${v()}/withdrawable`),
    withdraw: (mint, token, amount) => post(`${v()}/withdraw`, { mint, token, amount }),
    telegramLink: () => post('/me/telegram/link'),
    proposals: () => req(`${v()}/proposals`),
    approve: (id) => post(`/proposals/${encodeURIComponent(id)}/approve`),
    reject: (id) => post(`/proposals/${encodeURIComponent(id)}/reject`),
    latestBacktest: () => orNull(req('/backtests/latest')),
    subscribe: (fn) => socket<StreamEvent>(`${ws}/stream?vault=${vault}`, fn),
    demoPairs: async () => (await orNull(req('/demo/pairs'))) ?? [],
    demo: (pair, fn) => socket<DemoEvent>(`${ws}/demo?pair=${encodeURIComponent(pair)}`, fn),
  };
}
