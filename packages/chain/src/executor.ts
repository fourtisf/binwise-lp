import {
  DEFAULT_COSTS,
  DEFAULT_FEE_MODEL,
  composition,
  feesEarnedUsd,
  inRange,
  openPosition,
  slippageUsd,
  type CostModel,
  type FeeModel,
  farmRewardsUsd,
  type LiquidityShape,
  type LiquiditySide,
  type PositionBins,
} from '@binwise/core';

/**
 * Executor: the only part that differs between paper and live mode
 * (CLAUDE.md §3). The agent's decision code calls this interface.
 */

/** Token balances outside positions, by mint, in UI units. */
export type Holdings = Record<string, number>;

export interface PoolCtx {
  address: string;
  binStep: number;
  mintX: string;
  mintY: string;
  decimalsX: number;
  decimalsY: number;
  /** Quote (Y) per base (X), UI units */
  price: number;
  usdX: number;
  usdY: number;
  tvlUsd: number;
  baseFeePct: number;
  volume24hUsd: number;
  protocolFeePct?: number | null;
  /** Real active-bin liquidity when known (live RPC), USD */
  activeBinLiqUsd?: number | null;
  /** Liquidity-mining reward APR, percent */
  farmAprPct?: number | null;
}

export interface PositionRef {
  /** On-chain position account (live) */
  address: string | null;
  lowerBin: number;
  upperBin: number;
  binStep: number;
  shape: LiquidityShape;
  /** Paper: liquidity per bin in Y units */
  bins: number[] | null;
  feesUnclaimedUsd: number;
}

export interface OpenRequest {
  pool: PoolCtx;
  valueUsd: number;
  binsEachSide: number;
  shape: LiquidityShape;
  /** both = around price; x = one-sided above price (holds X); y = one-sided below price (holds Y) */
  side?: LiquiditySide;
  /** Live: skip the open when new bin-array rent exceeds this share of the position, percent */
  maxBinArrayCostPct?: number;
  /** Idempotency key for this action */
  key: string;
}

export interface OpenResult {
  address: string | null;
  lowerBin: number;
  upperBin: number;
  bins: number[] | null;
  amountX: number;
  amountY: number;
  costUsd: number;
  txSigs: string[];
}

export interface MarkResult {
  amountX: number;
  amountY: number;
  valueUsd: number;
  /** Unclaimed fees, USD */
  feesUsd: number;
  inRange: boolean;
}

export interface ActionResult {
  amountX: number;
  amountY: number;
  feesUsd: number;
  costUsd: number;
  txSigs: string[];
}

export interface Executor {
  readonly mode: 'paper' | 'live';
  holdings(): Promise<Holdings>;
  open(req: OpenRequest): Promise<OpenResult>;
  /** Re-values a position; paper mode also accrues fees for `minutes` of pool volume. */
  mark(pos: PositionRef, pool: PoolCtx, minutes: number): Promise<MarkResult>;
  close(pos: PositionRef, pool: PoolCtx, key: string): Promise<ActionResult>;
  claim(pos: PositionRef, pool: PoolCtx, key: string): Promise<ActionResult>;
  /** Claim fees and add them back into the same position. Paper mode returns the new bins. */
  compound(pos: PositionRef, pool: PoolCtx, key: string): Promise<ActionResult & { bins: number[] | null }>;
  /** Swap `uiAmount` of one token into another (exits step aside into the quote token). */
  swap(fromMint: string, toMint: string, uiAmount: number, usd: { from: number; to: number; poolTvlUsd?: number }, key: string): Promise<ActionResult>;
  /** USD cost of sending `n` transactions */
  txCostUsd(n: number): number;
}

/** Number of transactions each action takes, used by cost estimates. */
export const TX_COUNT = { open: 2, close: 2, claim: 1, swap: 1 };

const toPositionBins = (p: PositionRef): PositionBins => ({
  binStep: p.binStep,
  lowerBin: p.lowerBin,
  upperBin: p.upperBin,
  liquidity: p.bins ?? [],
});

/**
 * Paper executor: same inputs as live, simulated fills. Swaps pay route
 * fee + size-based slippage; every action pays network fees. Fees accrue from
 * real pool volume with the fee model in packages/core.
 */
export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const;

  constructor(
    private cash: Holdings,
    private costs: CostModel = DEFAULT_COSTS,
    private feeModel: FeeModel = DEFAULT_FEE_MODEL,
  ) {}

  /** Current simulated cash (mutated by actions; persist it after the cycle). */
  get balances(): Holdings {
    return this.cash;
  }

  async holdings() {
    return { ...this.cash };
  }

  txCostUsd(n: number) {
    return (n * (this.costs.lamportsPerTx + this.costs.tipLamports) * this.costs.solUsd) / 1e9;
  }

  private add(mint: string, amt: number) {
    this.cash[mint] = (this.cash[mint] ?? 0) + amt;
    if (Math.abs(this.cash[mint]) < 1e-12) delete this.cash[mint];
  }

  private simSwap(from: string, to: string, uiAmount: number, usdFrom: number, usdTo: number, tvlUsd: number): number {
    const amt = Math.min(uiAmount, this.cash[from] ?? 0);
    if (amt <= 0) return 0;
    const usd = amt * usdFrom;
    const slip = slippageUsd(usd, tvlUsd, this.costs.swapFixedBps);
    this.add(from, -amt);
    this.add(to, (usd - slip) / usdTo);
    return slip;
  }

  async swap(fromMint: string, toMint: string, uiAmount: number, usd: { from: number; to: number; poolTvlUsd?: number }) {
    const slip = this.simSwap(fromMint, toMint, uiAmount, usd.from, usd.to, usd.poolTvlUsd ?? 5e6);
    const fee = this.txCostUsd(TX_COUNT.swap);
    this.add(toMint, -fee / usd.to);
    return { amountX: 0, amountY: 0, feesUsd: 0, costUsd: slip + fee, txSigs: [] };
  }

  /** Makes sure the vault holds `usdNeeded` of `mint`, swapping from its largest other holdings. */
  private acquire(mint: string, usdNeeded: number, prices: Record<string, number>, tvlUsd: number): number {
    let cost = 0;
    const have = (this.cash[mint] ?? 0) * (prices[mint] ?? 0);
    let missing = usdNeeded - have;
    const others = Object.keys(this.cash)
      .filter((m) => m !== mint && prices[m])
      .sort((a, b) => this.cash[b] * prices[b] - this.cash[a] * prices[a]);
    for (const m of others) {
      if (missing <= 0.01) break;
      const availUsd = this.cash[m] * prices[m];
      const takeUsd = Math.min(availUsd, missing * 1.01);
      cost += this.simSwap(m, mint, takeUsd / prices[m], prices[m], prices[mint], tvlUsd);
      missing = usdNeeded - (this.cash[mint] ?? 0) * prices[mint];
    }
    return cost;
  }

  async open(req: OpenRequest): Promise<OpenResult> {
    const { pool } = req;
    const prices = { ...this.knownPrices, [pool.mintX]: pool.usdX, [pool.mintY]: pool.usdY };
    const side = req.side ?? 'both';
    const build = (usd: number) => openPosition(usd / pool.usdY, pool.price, pool.binStep, req.binsEachSide, req.shape, side);
    // Acquire exactly the token mix this range needs (all X above price, all Y below).
    const want = composition(build(req.valueUsd), pool.price);
    let cost = want.x > 0 ? this.acquire(pool.mintX, want.x * pool.usdX, prices, pool.tvlUsd) : 0;
    cost += want.y > 0 ? this.acquire(pool.mintY, want.y * pool.usdY, prices, pool.tvlUsd) : 0;
    const fx = want.x > 0 ? ((this.cash[pool.mintX] ?? 0) * pool.usdX) / (want.x * pool.usdX) : Infinity;
    const fy = want.y > 0 ? ((this.cash[pool.mintY] ?? 0) * pool.usdY) / (want.y * pool.usdY) : Infinity;
    const valueUsd = req.valueUsd * Math.min(1, fx, fy);
    if (valueUsd <= 1) throw new Error('Not enough balance to open a position.');
    const pos = build(valueUsd);
    const c = composition(pos, pool.price);
    this.add(pool.mintX, -c.x);
    this.add(pool.mintY, -c.y);
    // Slippage is already reflected in the swapped balances; only network fees are deducted here.
    const fee = this.txCostUsd(TX_COUNT.open);
    this.add(pool.mintY, -fee / pool.usdY);
    cost += fee;
    return { address: null, lowerBin: pos.lowerBin, upperBin: pos.upperBin, bins: pos.liquidity, amountX: c.x, amountY: c.y, costUsd: cost, txSigs: [] };
  }

  async mark(p: PositionRef, pool: PoolCtx, minutes: number): Promise<MarkResult> {
    const pos = toPositionBins(p);
    const c = composition(pos, pool.price);
    const earned =
      minutes > 0
        ? feesEarnedUsd({
            pos,
            price: pool.price,
            quoteUsd: pool.usdY,
            volumeUsd: (pool.volume24hUsd * minutes) / 1440,
            baseFeePct: pool.baseFeePct,
            poolTvlUsd: pool.tvlUsd,
            poolActiveLiqUsd: pool.activeBinLiqUsd,
            model: pool.protocolFeePct != null ? { ...this.feeModel, protocolFeeShare: pool.protocolFeePct / 100 } : this.feeModel,
          })
        : 0;
    const valueUsd = c.x * pool.usdX + c.y * pool.usdY;
    const live = inRange(pos, pool.price);
    const farm = minutes > 0 && pool.farmAprPct ? farmRewardsUsd(valueUsd, pool.farmAprPct, minutes, live) : 0;
    return {
      amountX: c.x,
      amountY: c.y,
      valueUsd,
      feesUsd: p.feesUnclaimedUsd + earned + farm,
      inRange: live,
    };
  }

  async close(p: PositionRef, pool: PoolCtx, _key?: string): Promise<ActionResult> {
    const c = composition(toPositionBins(p), pool.price);
    const cost = this.txCostUsd(TX_COUNT.close);
    this.add(pool.mintX, c.x);
    this.add(pool.mintY, c.y + (p.feesUnclaimedUsd - cost) / pool.usdY);
    return { amountX: c.x, amountY: c.y, feesUsd: p.feesUnclaimedUsd, costUsd: cost, txSigs: [] };
  }

  async claim(p: PositionRef, pool: PoolCtx, _key?: string): Promise<ActionResult> {
    const cost = this.txCostUsd(TX_COUNT.claim);
    this.add(pool.mintY, (p.feesUnclaimedUsd - cost) / pool.usdY);
    return { amountX: 0, amountY: 0, feesUsd: p.feesUnclaimedUsd, costUsd: cost, txSigs: [] };
  }

  async compound(p: PositionRef, pool: PoolCtx, _key?: string) {
    const pos = toPositionBins(p);
    const cost = this.txCostUsd(TX_COUNT.claim + 1);
    const value = composition(pos, pool.price);
    const valueUsd = value.x * pool.usdX + value.y * pool.usdY;
    const addUsd = Math.max(0, p.feesUnclaimedUsd - cost);
    const k = valueUsd > 0 ? 1 + addUsd / valueUsd : 1;
    return { amountX: 0, amountY: 0, feesUsd: p.feesUnclaimedUsd, costUsd: cost, txSigs: [], bins: pos.liquidity.map((L) => L * k) };
  }

  /** USD prices for cash tokens outside the current pool (set by the agent each cycle). */
  knownPrices: Record<string, number> = {};
}
