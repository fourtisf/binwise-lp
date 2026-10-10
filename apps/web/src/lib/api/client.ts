import type {
  BacktestSummary,
  CycleState,
  Decision,
  DecisionType,
  DemoEvent,
  DemoPair,
  Me,
  PerformanceRange,
  PerformanceSeries,
  PoolDetail,
  PoolRow,
  PositionView,
  Proposal,
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

export interface DecisionFilter {
  types?: DecisionType[];
  exclude?: DecisionType[];
}

/** Everything the website reads or changes. Matches the API routes in CLAUDE.md §5. */
export interface BinwiseClient {
  /** 'mock' runs the simulated vault in the browser; 'http' talks to the real API */
  readonly kind: 'mock' | 'http';
  readonly vaultId: string;
  /** Point the vault-scoped calls at a vault (the user's own, or the public demo). */
  useVault(id: string): void;
  me(): Promise<Me | null>;
  demoVaultId(): Promise<string | null>;
  signInMessage(wallet: string): Promise<string>;
  signIn(wallet: string, message: string, signatureB58: string): Promise<void>;
  signOut(): Promise<void>;
  overview(): Promise<VaultOverview>;
  performance(range: PerformanceRange): Promise<PerformanceSeries>;
  pools(): Promise<PoolRow[]>;
  pool(id: string): Promise<PoolDetail>;
  positions(): Promise<PositionView[]>;
  decisions(filter?: DecisionFilter): Promise<Decision[]>;
  cycle(): Promise<CycleState>;
  strategy(): Promise<StrategySettings>;
  saveStrategy(s: StrategySettings): Promise<StrategySettings>;
  pause(): Promise<VaultOverview>;
  resume(): Promise<VaultOverview>;
  setMode(mode: VaultMode, confirm?: boolean): Promise<VaultOverview>;
  deposit(token: string, amount: number): Promise<VaultOverview>;
  /** Live mode: record a deposit the user's wallet already sent */
  depositLive(signature: string): Promise<VaultOverview>;
  /** Returns the claimed amount (mock) or that the request was queued (API). */
  claim(positionId: string): Promise<{ amount?: number; queued?: boolean }>;
  close(positionId: string): Promise<{ ok?: true; queued?: boolean }>;
  telegramLink(): Promise<{ url: string | null; code: string }>;
  /** Manual mode: trades waiting for the owner's approval */
  proposals(): Promise<Proposal[]>;
  approve(id: string): Promise<Proposal[]>;
  reject(id: string): Promise<Proposal[]>;
  latestBacktest(): Promise<BacktestSummary | null>;
  /** Live vault stream. Returns an unsubscribe function. */
  subscribe(fn: (e: StreamEvent) => void): () => void;
  /** Pairs shown in the landing page window */
  demoPairs(): Promise<DemoPair[]>;
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
