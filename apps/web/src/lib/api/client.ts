import type {
  CycleState,
  Decision,
  DecisionType,
  DemoEvent,
  PerformanceRange,
  PerformanceSeries,
  PoolDetail,
  PoolRow,
  PositionView,
  StrategySettings,
  StreamEvent,
  VaultMode,
  VaultOverview,
} from '@binwise/core';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Everything the website reads or changes. Matches the API routes in CLAUDE.md §5. */
export interface BinwiseClient {
  readonly vaultId: string;
  overview(): Promise<VaultOverview>;
  performance(range: PerformanceRange): Promise<PerformanceSeries>;
  pools(): Promise<PoolRow[]>;
  pool(id: string): Promise<PoolDetail>;
  positions(): Promise<PositionView[]>;
  decisions(type?: DecisionType): Promise<Decision[]>;
  cycle(): Promise<CycleState>;
  strategy(): Promise<StrategySettings>;
  saveStrategy(s: StrategySettings): Promise<StrategySettings>;
  pause(): Promise<VaultOverview>;
  resume(): Promise<VaultOverview>;
  setMode(mode: VaultMode): Promise<VaultOverview>;
  deposit(token: string, amount: number): Promise<VaultOverview>;
  claim(positionId: string): Promise<{ amount: number }>;
  close(positionId: string): Promise<{ ok: true }>;
  /** Live vault stream. Returns an unsubscribe function. */
  subscribe(fn: (e: StreamEvent) => void): () => void;
  /** Public landing-page demo stream for one pair. */
  demo(pair: string, fn: (e: DemoEvent) => void): () => void;
}

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');
const WS_URL = (process.env.NEXT_PUBLIC_WS_URL ?? '').replace(/\/$/, '');

let instance: Promise<BinwiseClient> | null = null;

/**
 * Real API when NEXT_PUBLIC_API_URL is set; otherwise the simulated paper
 * vault runs in the browser so the site works with no backend.
 */
export function getClient(): Promise<BinwiseClient> {
  if (!instance)
    instance = API_URL
      ? import('./http').then((m) => m.createHttpClient(API_URL, WS_URL || API_URL.replace(/^http/, 'ws')))
      : import('./mock').then((m) => m.createMockClient());
  return instance;
}
