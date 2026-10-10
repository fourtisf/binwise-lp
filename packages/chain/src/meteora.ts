import { fetchJson } from './http';

/**
 * Meteora DLMM Data API (https://dlmm.datapi.meteora.ag, OpenAPI in MeteoraAg/docs
 * developer-guides/dlmm/api-reference). No key; 30 req/s across DLMM APIs.
 */

export interface MeteoraToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  is_verified: boolean;
  holders: number | null;
  freeze_authority_disabled: boolean | null;
  total_supply: number | null;
  price: number | null;
  market_cap: number | null;
}

type Windowed = Partial<Record<'30m' | '1h' | '2h' | '4h' | '12h' | '24h', number>>;

export interface MeteoraPool {
  address: string;
  name: string;
  token_x: MeteoraToken;
  token_y: MeteoraToken;
  pool_config: {
    bin_step: number;
    base_fee_pct: number;
    max_fee_pct: number;
    protocol_fee_pct: number;
    collect_fee_mode: number;
  };
  tvl: number;
  current_price: number;
  token_x_amount: number;
  token_y_amount: number;
  volume: Windowed;
  fees: Windowed;
  fee_tvl_ratio: Windowed;
  is_blacklisted: boolean;
  tags: string[];
  /** Current dynamic fee (base + variable), percent */
  dynamic_fee_pct?: number;
  has_farm?: boolean;
  /** Farm reward APR, percent */
  farm_apr?: number;
}

export interface MeteoraVolumePoint {
  timestamp: number;
  volume: number;
  fees: number;
  protocol_fees?: number;
}

export interface MeteoraPage<T> {
  total: number;
  pages: number;
  current_page: number;
  page_size: number;
  data: T[];
}

export type MeteoraTimeframe = '5m' | '30m' | '1h' | '2h' | '4h' | '12h' | '24h';

export interface MeteoraOhlcv {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class MeteoraClient {
  constructor(readonly baseUrl = process.env.METEORA_API_URL || 'https://dlmm.datapi.meteora.ag') {}

  private get<T>(path: string) {
    // Stay well under 30 req/s.
    return fetchJson<T>(this.baseUrl + path, { minIntervalMs: 100 });
  }

  /** One page of pools, sorted by 24h volume (highest first). */
  pools(page = 1, pageSize = 1000, sortBy = 'volume_24h:desc') {
    return this.get<MeteoraPage<MeteoraPool>>(`/pools?page=${page}&page_size=${pageSize}&sort_by=${encodeURIComponent(sortBy)}`);
  }

  /** Top pools by volume, up to `limit`, skipping blacklisted ones. */
  async topPools(limit = 300): Promise<MeteoraPool[]> {
    const out: MeteoraPool[] = [];
    for (let page = 1; out.length < limit; page++) {
      const r = await this.pools(page, Math.min(1000, limit));
      out.push(...r.data.filter((p) => !p.is_blacklisted));
      if (page >= r.pages || !r.data.length) break;
    }
    return out.slice(0, limit);
  }

  pool(address: string) {
    return this.get<MeteoraPool>(`/pools/${address}`);
  }

  /** Volume and LP fees per period (unix seconds). */
  async volumeHistory(address: string, timeframe: MeteoraTimeframe, startTime: number, endTime: number): Promise<MeteoraVolumePoint[]> {
    const r = await this.get<{ data: MeteoraVolumePoint[] }>(
      `/pools/${address}/volume/history?timeframe=${timeframe}&start_time=${Math.floor(startTime)}&end_time=${Math.floor(endTime)}`,
    );
    return r.data ?? [];
  }

  /** Candles with USD volume. Times are unix seconds. */
  async ohlcv(address: string, timeframe: MeteoraTimeframe, startTime: number, endTime: number): Promise<MeteoraOhlcv[]> {
    const r = await this.get<{ data: MeteoraOhlcv[] }>(
      `/pools/${address}/ohlcv?timeframe=${timeframe}&start_time=${Math.floor(startTime)}&end_time=${Math.floor(endTime)}`,
    );
    return r.data ?? [];
  }
}
