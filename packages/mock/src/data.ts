import type {
  AgentCall,
  LiquidityShape,
  PoolDetail,
  PoolRow,
  ScoreComponent,
  StrategySettings,
  TokenRef,
} from '@binwise/core';
import { clamp, walk } from './random';
import type { SimConfig } from './price-sim';

// Logos are served by the website from /tokens (sources: Trust Wallet assets, MIT).
const t = (symbol: string, letter: string, color: string): TokenRef => ({ symbol, letter, color, logo: `/tokens/${symbol}.png` });
export const TOKENS = {
  JUP: t('JUP', 'J', '#4BE3CF'),
  SOL: t('SOL', 'S', '#A19BFF'),
  USDC: t('USDC', 'U', '#5B95FF'),
  JTO: t('JTO', 'J', '#B9F2E6'),
  BONK: t('BONK', 'B', '#F6A93B'),
  WIF: t('WIF', 'W', '#D9B38C'),
  PENGU: t('PENGU', 'P', '#9ADFFF'),
  RAY: t('RAY', 'R', '#C792FF'),
  POPCAT: t('POPCAT', 'P', '#FF9EC3'),
} satisfies Record<string, TokenRef>;

export interface MockPool {
  id: string;
  tokenA: TokenRef;
  tokenB: TokenRef;
  tvl: number;
  volume24h: number;
  /** percent */
  baseFee: number;
  trend7d: number;
  volatility: number;
  mcapM: number;
  seed: number;
}

const pool = (
  a: TokenRef,
  b: TokenRef,
  tvl: number,
  volume24h: number,
  baseFee: number,
  trend7d: number,
  volatility: number,
  mcapM: number,
  seed: number,
): MockPool => ({
  id: `${a.symbol}-${b.symbol}`.toLowerCase(),
  tokenA: a,
  tokenB: b,
  tvl,
  volume24h,
  baseFee,
  trend7d,
  volatility,
  mcapM,
  seed,
});

const T = TOKENS;
export const POOLS: MockPool[] = [
  pool(T.JUP, T.SOL, 8.4e6, 16.1e6, 0.25, 4.2, 3.1, 1300, 3),
  pool(T.SOL, T.USDC, 42e6, 58e6, 0.05, 2.1, 2.4, 88000, 4),
  pool(T.JTO, T.SOL, 3.9e6, 6.2e6, 0.3, 1.4, 3.6, 410, 5),
  pool(T.BONK, T.SOL, 6.1e6, 19.4e6, 0.4, -3.8, 6.9, 1600, 6),
  pool(T.WIF, T.SOL, 5.2e6, 14.8e6, 0.4, -14.6, 8.2, 900, 7),
  pool(T.PENGU, T.SOL, 4.4e6, 9.9e6, 0.3, 6.8, 5.4, 1100, 8),
  pool(T.RAY, T.SOL, 2.8e6, 2.1e6, 0.25, -1.2, 3.8, 620, 9),
  pool(T.JUP, T.USDC, 3.1e6, 4.4e6, 0.3, 4.0, 3.3, 1300, 10),
  pool(T.POPCAT, T.SOL, 1.2e6, 5.1e6, 0.6, -6.2, 9.8, 240, 12),
];

export const pairName = (p: { tokenA: TokenRef; tokenB: TokenRef }) =>
  `${p.tokenA.symbol} / ${p.tokenB.symbol}`;

/** Prototype display scoring. The real scorer lands in packages/core in build step 4. */
export function scoreParts(p: MockPool): ScoreComponent[] {
  const vt = p.volume24h / p.tvl;
  return [
    { label: 'Volume / TVL', value: Math.min(40, vt * 13) },
    { label: 'Fee tier', value: Math.min(16, p.baseFee * 30) },
    { label: 'Volatility', value: -p.volatility * 2 },
    { label: '7-day trend', value: clamp(p.trend7d * 1.4, -25, 12) },
    { label: 'Holder quality', value: p.mcapM > 500 ? 11 : 6 },
  ];
}

export const scorePool = (p: MockPool) =>
  Math.round(clamp(30 + scoreParts(p).reduce((s, c) => s + c.value, 0), 3, 99));

export const DEPLOY_THRESHOLD = 62;

export function callFor(p: MockPool, s: StrategySettings): [AgentCall, string] {
  const sc = scorePool(p);
  if (p.trend7d <= s.trendExitPct) return ['out', 'Avoid, downtrend'];
  if (p.mcapM < s.minMcapM) return ['watch', 'Below cap floor'];
  if (sc >= DEPLOY_THRESHOLD) return ['in', 'Deploy'];
  return ['watch', 'Watch'];
}

export const fmtMcap = (v: number) =>
  v >= 1000 ? '$' + (v / 1000).toFixed(1).replace('.0', '') + 'B' : '$' + v + 'M';

const pctStr = (n: number, d: number) =>
  (n >= 0 ? '+' : '−') +
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) +
  '%';

export function poolRow(p: MockPool, s: StrategySettings): PoolRow {
  const volTvl = p.volume24h / p.tvl;
  const [call, callLabel] = callFor(p, s);
  return {
    id: p.id,
    pair: pairName(p),
    tokenA: p.tokenA,
    tokenB: p.tokenB,
    tvl: p.tvl,
    volume24h: p.volume24h,
    volTvl,
    feeApr: volTvl * p.baseFee * 365,
    baseFee: p.baseFee,
    trend7d: p.trend7d,
    volatility: p.volatility,
    mcapM: p.mcapM,
    fdvM: p.mcapM,
    spark: walk(p.seed, 24, p.trend7d / 100 / 24, 0.012, 100),
    score: scorePool(p),
    call,
    callLabel,
  };
}

export function poolDetail(p: MockPool, s: StrategySettings): PoolDetail {
  const row = poolRow(p, s);
  const sc = row.score;
  const reason =
    row.call === 'out'
      ? `7-day trend ${pctStr(p.trend7d, 1)} is below your ${s.trendExitPct}% exit rule. The agent won't farm a falling token.`
      : row.call === 'in'
        ? `Score ${sc} clears the ${DEPLOY_THRESHOLD} threshold and the trend is healthy. Eligible for up to ${s.maxAllocPct}% of the vault.`
        : p.mcapM < s.minMcapM
          ? `Market cap is below your ${fmtMcap(s.minMcapM)} floor.`
          : `Score ${sc} is under ${DEPLOY_THRESHOLD}. The agent keeps watching and deploys if volume picks up.`;
  return { ...row, breakdown: scoreParts(p), reason };
}

/** Landing-page demo pairs and the price feeds behind them. */
export interface DemoConfig extends SimConfig {
  name: string;
  shape: LiquidityShape;
}

export const DEMO_PAIRS: Record<string, DemoConfig> = {
  'jup-sol': { name: 'JUP / SOL', price: 0.004128, vol: 0.0042, width: 0.028, decimals: 6, seed: 11, feeRate: 2.1, shape: 'spot' },
  'sol-usdc': { name: 'SOL / USDC', price: 182.46, vol: 0.0026, width: 0.016, decimals: 2, seed: 23, feeRate: 3.4, shape: 'curve' },
  'pengu-sol': { name: 'PENGU / SOL', price: 0.0002142, vol: 0.0085, width: 0.05, decimals: 7, seed: 37, feeRate: 4.2, shape: 'spot' },
};
DEMO_PAIRS.bento = { ...DEMO_PAIRS['pengu-sol'], seed: 77 };

export interface MockPosition {
  id: string;
  poolId: string;
  shape: LiquidityShape;
  value: number;
  fees: number;
  il: number;
  net: number;
  rebalances: number;
  sim: SimConfig;
}

export const POSITIONS: MockPosition[] = [
  { id: 'pos-jup-sol', poolId: 'jup-sol', shape: 'spot', value: 4180, fees: 612.4, il: -2.1, net: 6.8, rebalances: 7, sim: { ...DEMO_PAIRS['jup-sol'], seed: 99 } },
  { id: 'pos-sol-usdc', poolId: 'sol-usdc', shape: 'curve', value: 5050, fees: 288.9, il: -0.6, net: 3.9, rebalances: 4, sim: { ...DEMO_PAIRS['sol-usdc'], seed: 52 } },
  { id: 'pos-pengu-sol', poolId: 'pengu-sol', shape: 'bidask', value: 2215, fees: 401.7, il: -7.4, net: 4.6, rebalances: 9, sim: { ...DEMO_PAIRS['pengu-sol'], seed: 53 } },
];
