/**
 * API contract shared by the web app, the API server and the agent.
 * Every number the UI shows comes through one of these shapes.
 */

export type VaultMode = 'paper' | 'live';
export type VaultStatus = 'running' | 'paused';
export type RiskProfile = 'conservative' | 'balanced' | 'aggressive';
export type DecisionType = 'scan' | 'deploy' | 'rebalance' | 'exit' | 'compound' | 'hold' | 'skip';
/** Agent call on a pool: in = Deploy, watch = Watch, out = Avoid. */
export type AgentCall = 'in' | 'watch' | 'out';
/** What happened to a position's range on one price tick. */
export type RangeEvent = 'hold' | 'out' | 'wait' | 'back' | 'rebalance';
/** DLMM liquidity shape. */
export type LiquidityShape = 'spot' | 'curve' | 'bidask';
export type PerformanceRange = 7 | 30 | 90;

export interface TokenRef {
  symbol: string;
  /** One-letter badge shown in the token circle (and when the logo can't load). */
  letter: string;
  color: string;
  /** Token logo URL */
  logo?: string;
  mint?: string;
}

export interface PoolRow {
  id: string;
  pair: string;
  tokenA: TokenRef;
  tokenB: TokenRef;
  tvl: number;
  volume24h: number;
  /** volume24h / tvl */
  volTvl: number;
  /** Fee APR in percent. Never the headline number. */
  feeApr: number;
  /** Base fee in percent. */
  baseFee: number;
  /** 7-day price change in percent. */
  trend7d: number;
  /** Daily realized volatility in percent. */
  volatility: number;
  /** Token market cap in $M (circulating supply). */
  mcapM: number;
  /** Fully diluted value in $M (total supply), as GMGN / Dexscreener show it; 0 when unknown. */
  fdvM: number;
  /** Recent price points for the trend sparkline. */
  spark: number[];
  score: number;
  call: AgentCall;
  callLabel: string;
}

export interface ScoreComponent {
  label: string;
  value: number;
}

export interface PoolDetail extends PoolRow {
  breakdown: ScoreComponent[];
  /** Plain-language reason for the agent call. */
  reason: string;
  /**
   * For Add LP by hand: the pool's price (second token per first token), bin step, and what the agent
   * itself would pick for this vault (shape, bins each side of the price).
   */
  /**
   * For Add LP by hand: the price and bins, and what the agent itself would do here (its recommendation):
   * the shape, width and side (null: the pool is trending down and the agent adds nothing), and why.
   */
  lp?: {
    price: number;
    binStep: number;
    shape: LiquidityShape;
    binsEachSide: number;
    maxBins: number;
    side: 'both' | 'x' | 'y' | null;
    /** The risky token's market regime the side comes from */
    regime: 'range' | 'up' | 'down';
    /** Daily volatility, percent */
    volatility: number;
    profile: RiskProfile;
    /** Both tokens are stablecoins */
    stable: boolean;
  };
}

export interface DepositAsset {
  /** Token mint (live deposits need it to build the transfer) */
  mint?: string;
  decimals?: number;
  symbol: string;
  letter: string;
  color: string;
  logo?: string;
  priceUsd: number;
  /** Wallet balance available to deposit. */
  balance: number;
}

export interface VaultOverview {
  id: string;
  name: string;
  mode: VaultMode;
  status: VaultStatus;
  cycle: number;
  value: number;
  /** Value at the start of the day, for the "today" change. */
  openValue: number;
  fees30d: number;
  /** Net return vs holding the same tokens, 30d, percent. The headline metric. */
  netVsHold30d: number;
  /** Share of time positions stayed in range, 30d, percent (null before any position). */
  timeInRange30d: number | null;
  spark: number[];
  depositAssets: DepositAsset[];
  /** Live mode: the vault's agent wallet that deposits are sent to */
  depositAddress?: string | null;
  /** True when the viewer can't change this vault (the public demo vault) */
  readOnly?: boolean;
  pausedReason?: string | null;
}

/** What Add LP can draw on: the vault's idle funds (GET /vaults/:id/balance). */
export interface VaultBalance {
  /** USD the agent can put into new positions now (live: after the SOL kept for fees and rent). */
  availableUsd: number;
  /** Idle tokens, largest first (SOL first). Live: SOL without the reserve. */
  assets: { symbol: string; mint: string; amount: number; usd: number }[];
  /** Live: SOL the vault wallet keeps for network fees and rent, not available for LP. */
  reserveSol: number;
  /** 'chain': read from Solana just now. 'agent': as of the agent's last cycle (Solana unreachable, or paper). */
  source: 'chain' | 'agent';
  /** Asked for one pool (?pool=): the most Add LP puts in it now, the limit that decides it, and the minimum. */
  pool?: {
    maxUsd: number;
    minUsd: number;
    limit: 'balance' | 'strategy' | 'cap' | 'live' | 'positions' | 'held';
    /** The strategy's max share of the vault in one pool, percent */
    allocPct: number;
    /** What more funds in the vault can't raise (2% of the pool, the per-position cap, the live limits); null: none */
    ceilingUsd: number | null;
  };
  /** Live: SOL in the owner's own wallet, which Add LP can move into the vault first (the owner approves in the wallet) */
  wallet?: { address: string; sol: number; solPriceUsd: number };
  /** Live: SOL the vault wallet itself holds right now (the reserve for fees and rent comes out of this) */
  vaultSol?: number;
}

/** One line of a portfolio: an idle token, or an open position (value includes unclaimed fees). */
export type PortfolioHolding =
  | {
      kind: 'token';
      token: TokenRef;
      amount: number;
      /** Null when no price is known for the token (it doesn't count in the value) */
      value: number | null;
      /** Live SOL kept for fees and rent (inside amount) */
      reserve?: number;
    }
  | { kind: 'position'; positionId: string; pair: string; tokenA: TokenRef; tokenB: TokenRef; value: number; inRange: boolean; manual: boolean };

export interface ClosedPosition {
  id: string;
  pair: string;
  tokenA: TokenRef;
  tokenB: TokenRef;
  /** Unix ms */
  openedAt: number;
  closedAt: number;
  entryValue: number;
  /** Value at the last mark before closing */
  exitValue: number;
  fees: number;
  /** Percent, at the last mark */
  netVsHold: number;
  manual: boolean;
}

/** Everything in a vault and how it did against holding (GET /vaults/:id/portfolio). */
export interface Portfolio {
  wallet: string;
  /** Live: the vault's own wallet on Solana, to check its holdings on an explorer */
  vaultWallet: string | null;
  name: string;
  mode: VaultMode;
  /** Unix ms the vault was created */
  since: number;
  telegramLinked: boolean;
  /** Idle tokens + open positions with unclaimed fees. Live: the vault wallet read on Solana just now. */
  value: number;
  /** 'chain': the vault wallet was read on Solana just now. 'agent': as of the agent's last cycle. */
  source: 'chain' | 'agent';
  /** Everything deposited, held instead, at today's prices */
  holdValue: number;
  /** value / holdValue − 1, percent, since the start. The headline. Null until a deposit is recorded. */
  netVsHold: number | null;
  /** Funds in the vault wallet the agent hasn't recorded as a deposit yet (it does within a few minutes) */
  pendingUsd: number;
  /** Every token the owner's own wallet holds, largest value first (null: no known price). Not in the vault, so the agent doesn't use it. */
  ownWallet: { token: TokenRef; amount: number; value: number | null }[];
  /** Fees earned by every position, all time */
  fees: number;
  /** Network fees, tips and slippage paid, all time */
  costs: number;
  /** Largest first */
  holdings: PortfolioHolding[];
  /** Latest first (up to 50) */
  closed: ClosedPosition[];
  closedCount: number;
  /** Closed positions that ended ahead of holding */
  beatHold: number;
  /** Deposits (+) and withdrawals (−) in USD at the time, newest first (up to 30) */
  flows: { ts: number; title: string; usd: number; txSig?: string }[];
}

export interface Me {
  wallet: string;
  vaults: { id: string; name: string; mode: VaultMode }[];
  telegramLinked: boolean;
}

/** A pair shown in the landing page's live window (a position of the public demo vault). */
export interface DemoPair {
  id: string;
  pair: string;
  tokenA: TokenRef;
  tokenB: TokenRef;
  shape: LiquidityShape;
}

export interface BacktestSummary {
  createdAt: number;
  report: string;
  summary: Record<string, number>;
}

export interface PerformanceSeries {
  range: PerformanceRange;
  /** Unix ms per point, one per day. */
  ts: number[];
  vault: number[];
  hold: number[];
}

export interface PositionChart {
  /** Recent prices, oldest first. */
  history: number[];
  lo: number;
  hi: number;
  /** Indexes into history where a rebalance happened. */
  markers: number[];
  /** Decimals to show for this pair's price. */
  decimals: number;
}

export interface PositionView {
  id: string;
  poolId: string;
  pair: string;
  tokenA: TokenRef;
  tokenB: TokenRef;
  shape: LiquidityShape;
  value: number;
  fees: number;
  /** Impermanent loss in percent. */
  il: number;
  netVsHold: number;
  rebalances: number;
  inRange: boolean;
  chart: PositionChart;
}

export interface Decision {
  id: string;
  vaultId: string;
  poolId?: string;
  /** Unix ms */
  ts: number;
  type: DecisionType;
  title: string;
  reason: string;
  txSig?: string;
}

export interface StrategyToggles {
  autoCompound: boolean;
  rebalanceOnlyProfitable: boolean;
  holderSafety: boolean;
  pauseOnVolSpikes: boolean;
  telegramAlerts: boolean;
  /** Manual mode: the agent proposes trades and waits for the owner's approval */
  askBeforeTrading: boolean;
}

export type ProposalKind = 'deploy' | 'rebalance' | 'exit' | 'compound';

/** A trade the agent wants to make, waiting for the owner's approval (manual mode). */
export interface Proposal {
  id: string;
  vaultId: string;
  kind: ProposalKind;
  poolId?: string;
  positionId?: string;
  pair: string;
  title: string;
  reason: string;
  /** Unix ms */
  createdAt: number;
  expiresAt: number;
}

export interface StrategySettings {
  profile: RiskProfile;
  maxAllocPct: number;
  /** Minimum token market cap in $M. */
  minMcapM: number;
  /** Exit when the 7-day trend is below this percent (negative). */
  trendExitPct: number;
  dailyStopPct: number;
  /** Most USD the agent puts into one position (the user's own cap). 0 = no cap: sized by maxAllocPct. */
  maxPositionUsd: number;
  toggles: StrategyToggles;
}

export interface CycleStep {
  title: string;
  /** Shown while the step is waiting or running. */
  running: string;
  /** Shown once the step is done. */
  done: string;
}

export interface CycleDecision {
  short: string;
  text: string;
  tx: boolean;
}

/** Agent cycle: Scan → Score → Check positions → Decide → Execute. */
export interface CycleState {
  cycle: number;
  /** Index of the running step; steps.length means the cycle finished; -1 means idle. */
  step: number;
  paused: boolean;
  intervalMs: number;
  /** Time since this cycle started. */
  elapsedMs: number;
  steps: CycleStep[];
  decision?: CycleDecision;
}

export type VaultLive = Pick<
  VaultOverview,
  'value' | 'openValue' | 'fees30d' | 'netVsHold30d' | 'status' | 'mode' | 'cycle'
>;

export interface PositionTick {
  positionId: string;
  price: number;
  lo: number;
  hi: number;
  inRange: boolean;
  event: RangeEvent;
  /** True when this tick is a rebalance; the chart drops a marker. */
  marker: boolean;
  fees: number;
  netVsHold: number;
  rebalances: number;
}

export type StreamEvent =
  | { type: 'tick'; tick: PositionTick }
  | { type: 'vault'; vault: VaultLive }
  | { type: 'cycle'; cycle: CycleState }
  | { type: 'decision'; decision: Decision }
  /** Manual mode: the list of proposals waiting for approval changed */
  | { type: 'proposals'; pending: number };

/** Public read-only demo stream for the landing page window. */
export interface DemoStats {
  fees: number;
  netVsHold: number;
  rebalances: number;
  timeInRange: number;
  inRange: boolean;
}

export type DemoEvent =
  | {
      type: 'demo:snapshot';
      chart: PositionChart;
      stats: DemoStats;
      mode: string;
      thought: string;
      log: [string, string][];
    }
  | {
      type: 'demo:tick';
      price: number;
      lo: number;
      hi: number;
      marker: boolean;
      stats: DemoStats;
      mode: string;
      thought?: string;
      log?: [string, string];
    }
  | {
      /** The agent's reasoning changed; no new price */
      type: 'demo:thought';
      mode: string;
      thought: string;
      log?: [string, string];
    };

export interface ApiError {
  error: string;
  message: string;
}
