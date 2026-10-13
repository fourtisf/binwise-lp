import type { PositionChart, RangeEvent } from '@kovra/core';
import { gauss, rng } from './random';

export interface SimConfig {
  /** Starting / mean-reverting price. */
  price: number;
  /** Per-tick log volatility. */
  vol: number;
  /** Half-width of the range as a fraction of price. */
  width: number;
  decimals: number;
  seed: number;
  /** Fees earned per in-range tick, in USD (scaled by a random factor). */
  feeRate: number;
  points?: number;
}

/**
 * Simulated price feed for one position, with the prototype's range logic:
 * out of range → wait one tick → rebalance on the second tick out.
 */
export class PriceSim {
  readonly cfg: Required<SimConfig>;
  private r: () => number;
  data: number[] = [];
  markers: number[] = [];
  lo = 0;
  hi = 0;
  out = 0;
  inR = true;
  reb = 0;
  ticks = 0;
  inTicks = 0;
  fees = 0;
  net = 0;

  constructor(cfg: SimConfig) {
    this.cfg = { points: 70, ...cfg };
    this.r = rng(this.cfg.seed);
    let p = this.cfg.price;
    for (let i = 0; i < this.cfg.points; i++) {
      p = p * Math.exp(this.cfg.vol * gauss(this.r)) + (this.cfg.price - p) * 0.03;
      this.data.push(p);
    }
    const last = this.price;
    this.lo = last * (1 - this.cfg.width);
    this.hi = last * (1 + this.cfg.width);
  }

  get price(): number {
    return this.data[this.data.length - 1];
  }

  /**
   * Advances one tick. With `canRebalance` false (agent paused) the position
   * stays out of range instead of being re-centered.
   */
  tick(canRebalance = true): { event: RangeEvent; marker: boolean } {
    const { cfg, r } = this;
    let p = this.price;
    p = p * Math.exp(cfg.vol * gauss(r)) + (cfg.price - p) * 0.02;
    this.data.push(p);
    this.data.shift();
    this.markers = this.markers.map((i) => i - 1).filter((i) => i >= 0);
    this.ticks++;
    const inR = p >= this.lo && p <= this.hi;
    let event: RangeEvent = 'hold';
    if (inR) {
      this.out = 0;
      this.inTicks++;
      this.fees += cfg.feeRate * (0.5 + r());
      this.net += 0.006 + r() * 0.008;
      if (!this.inR) event = 'back';
    } else {
      this.out++;
      this.net -= 0.004;
      event = this.inR ? 'out' : 'wait';
      if (this.out >= 2 && canRebalance) {
        this.lo = p * (1 - cfg.width);
        this.hi = p * (1 + cfg.width);
        this.reb++;
        this.out = 0;
        this.fees -= cfg.feeRate * 0.25;
        this.net -= 0.012;
        this.markers.push(this.data.length - 1);
        event = 'rebalance';
      }
    }
    this.inR = event === 'rebalance' ? true : inR;
    return { event, marker: event === 'rebalance' };
  }

  chart(): PositionChart {
    return {
      history: [...this.data],
      lo: this.lo,
      hi: this.hi,
      markers: [...this.markers],
      decimals: this.cfg.decimals,
    };
  }
}
