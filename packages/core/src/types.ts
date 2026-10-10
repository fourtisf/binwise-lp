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
  /** Token market cap in $M. */
  mcapM: number;
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
}

export interface DepositAsset {
  /** Token mint (live deposits need it to build the transfer) */
  mint?: string;
  decimals?: number;
  symbol: string;
  letter: string;
  color: string;
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
}

export interface StrategySettings {
  profile: RiskProfile;
  maxAllocPct: number;
  /** Minimum token market cap in $M. */
  minMcapM: number;
  /** Exit when the 7-day trend is below this percent (negative). */
  trendExitPct: number;
  dailyStopPct: number;
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
  | { type: 'decision'; decision: Decision };

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
