import { describe, expect, it } from 'vitest';
import { MeteoraClient } from './meteora';

/** A fake API that rejects ranges over 3 days, like the live one rejecting 8 days of hourly candles. */
class FakeApi extends MeteoraClient {
  calls: [number, number][] = [];
  protected override async get<T>(path: string): Promise<T> {
    const q = new URL('http://x' + path).searchParams;
    const [start, end] = [Number(q.get('start_time')), Number(q.get('end_time'))];
    this.calls.push([start, end]);
    if (end - start > 3 * 86400) throw new Error(`HTTP 400 from ${path}: {"message":"time range too large"}`);
    const data = [];
    for (let t = Math.ceil(start / 3600) * 3600; t <= end; t += 3600) data.push({ timestamp: t, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    return { data } as T;
  }
}

describe('Meteora time series', () => {
  it('splits a range the API calls too large, and remembers the limit', async () => {
    const api = new FakeApi();
    const end = 1_791_705_600;
    const start = end - 8 * 86400;
    const rows = await api.ohlcv('pool', '1h', start, end);
    expect(rows).toHaveLength(8 * 24 + 1);
    expect(new Set(rows.map((r) => r.timestamp)).size).toBe(rows.length);
    expect(rows.map((r) => r.timestamp)).toEqual([...rows.map((r) => r.timestamp)].sort((a, b) => a - b));
    // Next time it asks in pieces straight away: no rejected request.
    api.calls = [];
    await api.ohlcv('pool2', '1h', start, end);
    expect(api.calls.every(([s, e]) => e - s <= 3 * 86400)).toBe(true);
  });
  it('passes other errors through', async () => {
    const api = new (class extends MeteoraClient {
      protected override async get<T>(): Promise<T> {
        throw new Error('HTTP 500 from x: boom');
      }
    })();
    await expect(api.ohlcv('p', '1h', 0, 86400)).rejects.toThrow(/boom/);
  });
});
