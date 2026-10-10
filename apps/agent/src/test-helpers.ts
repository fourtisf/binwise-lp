import type { MeteoraClient, MeteoraOhlcv, MeteoraPool, MeteoraTimeframe } from '@binwise/chain';
import { getDb } from '@binwise/db';

export const JUP = 'JUPmint1111111111111111111111111111111111111';
export const USDC = 'USDCmint111111111111111111111111111111111111';
export const POOL = 'Pool111111111111111111111111111111111111111';

/** A fake Meteora Data API with the documented response shapes. */
export class FakeMeteora {
  price = 1.0;
  /** Hourly drift used to generate history (positive = uptrend) */
  drift = 0.0005;
  tvl = 5_000_000;
  volume24h = 8_000_000;
  /** List the pool as USDC/JUP (stablecoin as X): the pool price is then JUP per USDC = 1 / JUP price */
  flip = false;

  pool(): MeteoraPool {
    const token = (address: string, symbol: string, price: number, mcap: number, decimals: number) => ({
      address,
      name: symbol,
      symbol,
      decimals,
      is_verified: true,
      holders: 500_000,
      freeze_authority_disabled: true,
      total_supply: mcap / price,
      price,
      market_cap: mcap,
    });
    return {
      address: POOL,
      name: 'JUP-USDC',
      token_x: this.flip ? token(USDC, 'USDC', 1, 6e10, 6) : token(JUP, 'JUP', this.price, 1.3e9, 6),
      token_y: this.flip ? token(JUP, 'JUP', this.price, 1.3e9, 6) : token(USDC, 'USDC', 1, 6e10, 6),
      pool_config: { bin_step: 20, base_fee_pct: 0.2, max_fee_pct: 5, protocol_fee_pct: 5, collect_fee_mode: 0 },
      tvl: this.tvl,
      current_price: this.flip ? 1 / this.price : this.price,
      token_x_amount: 0,
      token_y_amount: 0,
      volume: { '24h': this.volume24h, '1h': this.volume24h / 24 },
      fees: { '24h': this.volume24h * 0.002 },
      fee_tvl_ratio: {},
      is_blacklisted: false,
      tags: [],
    };
  }

  async topPools() {
    return [this.pool()];
  }

  async ohlcv(_a: string, tf: MeteoraTimeframe, start: number, end: number): Promise<MeteoraOhlcv[]> {
    const step = tf === '1h' ? 3600 : 300;
    const out: MeteoraOhlcv[] = [];
    for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
      const hoursAgo = (end - t) / 3600;
      const jup = this.price * Math.exp(-this.drift * hoursAgo) * (1 + 0.002 * Math.sin(t / 7000));
      const p = this.flip ? 1 / jup : jup;
      out.push({ timestamp: t, open: p, high: p * 1.001, low: p * 0.999, close: p, volume: (this.volume24h / 86400) * step });
    }
    return out;
  }
}

export const asMeteora = (f: FakeMeteora) => f as unknown as MeteoraClient;

export async function resetDb() {
  const db = getDb();
  await db.$executeRawUnsafe(
    'TRUNCATE "Tx","Decision","PositionMark","Position","VaultSnapshot","Strategy","Vault","User","Candle","PoolSnapshot","Pool","Token","BacktestRun","ParamSet","TokenEvent","Proposal" CASCADE',
  );
  return db;
}
