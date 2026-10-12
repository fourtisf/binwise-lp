import type {
  BacktestSummary,
  CustomRange,
  LiquidityShape,
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
  Portfolio,
  PositionView,
  Proposal,
  StrategySettings,
  StreamEvent,
  VaultBalance,
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
  /**
   * Sign-in challenge: our message for signMessage, and the fields for a standard Sign In With Solana
   * request. Without a wallet there is no message: only the one-step Sign In With Solana request works.
   */
  signInChallenge(wallet?: string): Promise<{ message: string | null; nonce: string; domain: string; issuedAt: string; statement: string }>;
  signIn(wallet: string, message: string, signatureB58: string): Promise<void>;
  signOut(): Promise<void>;
  overview(): Promise<VaultOverview>;
  /** Everything in the vault and how it did against holding (the owner's portfolio). */
  portfolio(): Promise<Portfolio>;
  /** The vault's idle funds; with a pool, the most Add LP puts into it now. */
  balance(poolId?: string): Promise<VaultBalance>;
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
  /** Returns the claimed amount (mock) or that the request was queued (API). */
  claim(positionId: string): Promise<{ amount?: number; queued?: boolean }>;
  close(positionId: string): Promise<{ ok?: true; queued?: boolean }>;
  /**
   * Add LP by hand. override: into a pool the agent wouldn't enter (the owner accepted the risk).
   * opts: the owner's own shape and price range (bins below / above the price); the agent picks when absent.
   */
  deploy(poolId: string, usd: number, override: boolean, opts?: { shape?: LiquidityShape; range?: CustomRange }): Promise<{ queued: boolean; pair: string }>;
  /** Live: an unsigned SOL transfer from the owner's wallet to the vault wallet (base64), for the wallet to approve */
  depositTx(sol: number): Promise<{ tx: string; lamports: number; to: string }>;
  /** Live: broadcast that transfer once the wallet signed it but couldn't send it (base64); returns its signature */
  depositSend(tx: string): Promise<{ signature: string }>;
  /** Live: record a transfer the owner's wallet sent to the vault (checked on-chain) */
  depositLive(signature: string): Promise<VaultOverview>;
  /** Live: record transfers the owner sent to the vault address by hand (found on-chain); what it recorded now, by mint */
  depositScan(): Promise<{ recorded: Record<string, number> }>;
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
