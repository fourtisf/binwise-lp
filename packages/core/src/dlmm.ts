import type { LiquidityShape } from './types';

/**
 * DLMM position math (Meteora liquidity book).
 *
 * Price of bin b is (1 + binStep/10000)^b (verified against @meteora-ag/dlmm
 * getPriceOfBinByBinId). Prices here are in UI units: quote token (Y) per base
 * token (X). Each bin is constant-sum: liquidity L = x * P_bin + y (in Y units).
 * Bins above the active bin hold only X, bins below hold only Y.
 */

export const binBase = (binStep: number) => 1 + binStep / 10_000;
export const binPrice = (binId: number, binStep: number) => Math.pow(binBase(binStep), binId);
export const binIdForPrice = (price: number, binStep: number) =>
  Math.floor(Math.log(price) / Math.log(binBase(binStep)) + 1e-9);

/** Number of bins on each side of the active bin needed to cover ±halfWidth (fraction). */
export const binsForHalfWidth = (halfWidth: number, binStep: number) =>
  Math.max(1, Math.ceil(Math.log(1 + halfWidth) / Math.log(binBase(binStep))));

export interface PositionBins {
  binStep: number;
  lowerBin: number;
  upperBin: number;
  /** Liquidity per bin in Y units, index 0 = lowerBin. */
  liquidity: number[];
}

/** Relative liquidity weights across bins for a DLMM strategy shape. */
export function shapeWeights(shape: LiquidityShape, count: number): number[] {
  const mid = (count - 1) / 2;
  const sigma = Math.max(1, count / 4);
  return Array.from({ length: count }, (_, i) => {
    const d = Math.abs(i - mid) / Math.max(1, mid);
    if (shape === 'curve') return Math.exp(-((i - mid) ** 2) / (2 * sigma ** 2));
    if (shape === 'bidask') return 0.2 + d;
    return 1;
  });
}

/** A range chosen by hand: bins below and above the active bin (re-centred on the price when it opens). */
export interface CustomRange {
  below: number;
  above: number;
}

/** Most bins one DLMM position covers here (34 each side of the active bin). */
export const MAX_POSITION_BINS = 69;

/** The side a custom range implies: all above the price holds X, all below holds Y, across it holds both. */
export const sideOfRange = (r: CustomRange): 'both' | 'x' | 'y' => (r.below === 0 && r.above > 0 ? 'x' : r.above === 0 && r.below > 0 ? 'y' : 'both');

/** Why a custom range can't be used, or null when it can. */
export function customRangeError(r: CustomRange): string | null {
  if (!Number.isInteger(r.below) || !Number.isInteger(r.above) || r.below < 0 || r.above < 0) return 'The range must be whole bins on each side.';
  if (r.below + r.above + 1 > MAX_POSITION_BINS) return `A position covers at most ${MAX_POSITION_BINS} bins. Narrow the range.`;
  return null;
}

/**
 * Bins below and above the price for a min/max price range (Y per X), snapped to whole bins, and the
 * prices those bins really cover. One-sided: `side` x starts at the price and goes up, y goes down.
 */
export function rangeFromPrices(price: number, binStep: number, minPrice: number, maxPrice: number, side: 'both' | 'x' | 'y' = 'both') {
  const active = binIdForPrice(price, binStep);
  const below = side === 'x' ? 0 : Math.max(side === 'y' ? 1 : 0, active - binIdForPrice(Math.min(minPrice, price), binStep));
  const above = side === 'y' ? 0 : Math.max(side === 'x' ? 1 : 0, binIdForPrice(Math.max(maxPrice, price), binStep) - active);
  return {
    below,
    above,
    bins: below + above + 1,
    minPrice: binPrice(active - below, binStep),
    maxPrice: binPrice(active + above + 1, binStep),
  };
}

/**
 * Opens a position worth `valueY` (in Y units) centred on `price`,
 * with `binsEachSide` bins below and above the active bin, or the bins of a custom `range`.
 */
export function openPosition(
  valueY: number,
  price: number,
  binStep: number,
  binsEachSide: number,
  shape: LiquidityShape,
  side: 'both' | 'x' | 'y' = 'both',
  range?: CustomRange,
): PositionBins {
  const active = binIdForPrice(price, binStep);
  if (range) side = sideOfRange(range);
  // One-sided ranges use the same number of bins (2n+1) starting at the active bin and going up (x) or down (y).
  const count = range ? range.below + range.above + 1 : binsEachSide * 2 + 1;
  const w = shapeWeights(shape, count);
  const sum = w.reduce((s, x) => s + x, 0);
  const lowerBin = range ? active - range.below : side === 'both' ? active - binsEachSide : side === 'x' ? active : active - count + 1;
  // Weights split the deposit by value at today's price. Bins above hold X bought at `price`,
  // so their liquidity at bin price is x × P_bin; bins below hold Y. The active bin is half/half.
  const liquidity = w.map((x, i) => {
    const v = (valueY * x) / sum;
    const b = lowerBin + i;
    if (b > active || (b === active && side === 'x')) return (v / price) * binPrice(b, binStep);
    if (b < active || (b === active && side === 'y')) return v;
    const pb = binPrice(b, binStep);
    // L = x·P + y with x = (v/2)/price and y = v/2
    return (v / 2 / price) * pb + v / 2;
  });
  return { binStep, lowerBin, upperBin: lowerBin + count - 1, liquidity };
}

export const inRange = (pos: PositionBins, price: number) => {
  const b = binIdForPrice(price, pos.binStep);
  return b >= pos.lowerBin && b <= pos.upperBin;
};

/** Token amounts the position holds at `price`. The active bin is treated as half X, half Y. */
export function composition(pos: PositionBins, price: number): { x: number; y: number } {
  const a = binIdForPrice(price, pos.binStep);
  let x = 0;
  let y = 0;
  pos.liquidity.forEach((L, i) => {
    const b = pos.lowerBin + i;
    const pb = binPrice(b, pos.binStep);
    if (b > a) x += L / pb;
    else if (b < a) y += L;
    else {
      // Active bin: split value evenly between the two tokens.
      x += L / 2 / pb;
      y += L / 2;
    }
  });
  return { x, y };
}

/** Position value in Y units at `price` (excluding unclaimed fees). */
export function positionValueY(pos: PositionBins, price: number): number {
  const { x, y } = composition(pos, price);
  return x * price + y;
}

/** Our liquidity in the active bin (Y units); zero when out of range. */
export function activeBinLiquidity(pos: PositionBins, price: number): number {
  const i = binIdForPrice(price, pos.binStep) - pos.lowerBin;
  return i >= 0 && i < pos.liquidity.length ? pos.liquidity[i] : 0;
}

export interface FeeModel {
  /** Fraction of pool TVL sitting in the active bin, used when the real figure is unknown. */
  activeBinShareOfTvl: number;
  /** Share of swap fees kept by the protocol. */
  protocolFeeShare: number;
}

export const DEFAULT_FEE_MODEL: FeeModel = { activeBinShareOfTvl: 0.05, protocolFeeShare: 0.05 };

/**
 * Fees earned over a period: volume × base fee × our share of active-bin liquidity.
 * Only base fee is counted (DLMM's variable fee is ignored), so this errs low.
 * @param poolActiveLiqUsd real active-bin liquidity if known, else estimated from TVL.
 */
export function feesEarnedUsd(args: {
  pos: PositionBins;
  price: number;
  quoteUsd: number;
  volumeUsd: number;
  baseFeePct: number;
  poolTvlUsd: number;
  poolActiveLiqUsd?: number | null;
  model?: FeeModel;
}): number {
  const m = args.model ?? DEFAULT_FEE_MODEL;
  const ours = activeBinLiquidity(args.pos, args.price) * args.quoteUsd;
  if (ours <= 0) return 0;
  const poolActive = args.poolActiveLiqUsd ?? args.poolTvlUsd * m.activeBinShareOfTvl;
  const share = ours / (poolActive + ours);
  return args.volumeUsd * (args.baseFeePct / 100) * (1 - m.protocolFeeShare) * share;
}

/** Liquidity-mining rewards for a period, USD. DLMM farms pay liquidity in the active bin, so only in range. */
export const farmRewardsUsd = (positionValueUsd: number, farmAprPct: number, minutes: number, inRangeNow: boolean) =>
  inRangeNow ? positionValueUsd * (farmAprPct / 100) * (minutes / 525_600) : 0;
