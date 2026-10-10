import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STRATEGY, type StreamEvent } from '@binwise/core';
import { MockEngine, MockError, startDemo } from './engine';
import { PriceSim } from './price-sim';
import { DEMO_PAIRS } from './data';

describe('PriceSim', () => {
  it('is deterministic for a seed', () => {
    const a = new PriceSim(DEMO_PAIRS['jup-sol']);
    const b = new PriceSim(DEMO_PAIRS['jup-sol']);
    for (let i = 0; i < 50; i++) expect(a.tick()).toEqual(b.tick());
    expect(a.price).toBe(b.price);
  });

  it('never rebalances while the agent is paused', () => {
    const sim = new PriceSim({ ...DEMO_PAIRS['pengu-sol'], width: 0.001 });
    for (let i = 0; i < 200; i++) expect(sim.tick(false).event).not.toBe('rebalance');
    expect(sim.reb).toBe(0);
  });
});

describe('MockEngine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scores every pool and flags downtrends as Avoid', () => {
    const pools = new MockEngine().getPools();
    expect(pools).toHaveLength(9);
    expect(pools.every((p) => p.score >= 3 && p.score <= 99)).toBe(true);
    expect(pools.find((p) => p.id === 'wif-sol')?.call).toBe('out');
  });

  it('refuses live mode unless live trading is enabled', () => {
    const e = new MockEngine();
    expect(() => e.setMode('live')).toThrow(MockError);
    expect(e.getOverview().mode).toBe('paper');
    expect(new MockEngine({ liveTradingEnabled: true }).setMode('live').mode).toBe('live');
  });

  it('rejects strategies outside the limits', () => {
    expect(() => new MockEngine().putStrategy({ ...DEFAULT_STRATEGY, dailyStopPct: 40 })).toThrow(MockError);
  });

  it('runs a five-step cycle and logs a decision', () => {
    const e = new MockEngine({ random: () => 0.9 });
    const events: StreamEvent[] = [];
    e.subscribe((ev) => events.push(ev));
    e.start();
    vi.advanceTimersByTime(900 * 5 + 10);
    const steps = events.filter((ev) => ev.type === 'cycle').map((ev) => (ev.type === 'cycle' ? ev.cycle.step : -1));
    expect(steps).toEqual([0, 1, 2, 3, 4, 5]);
    e.stop();
  });

  it('pauses and resumes the agent', () => {
    const e = new MockEngine().start();
    expect(e.pause().status).toBe('paused');
    expect(e.getCycle().step).toBe(-1);
    expect(e.resume().status).toBe('running');
    e.stop();
  });

  it('deposits reduce the wallet balance and grow the vault', () => {
    const e = new MockEngine();
    const before = e.getOverview();
    const after = e.deposit('SOL', 10);
    expect(after.value).toBeCloseTo(before.value + 1824.6);
    expect(after.depositAssets[0].balance).toBeCloseTo(32.8);
    expect(() => e.deposit('SOL', 1000)).toThrow('Not enough SOL');
    expect(e.getDecisions('deploy')[0].title).toBe('Deposited 10.00 SOL');
  });
});

describe('startDemo', () => {
  it('sends a snapshot, then ticks', () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const stop = startDemo('sol-usdc', (e) => events.push(e.type));
    vi.advanceTimersByTime(1400 * 3);
    stop();
    vi.useRealTimers();
    expect(events).toEqual(['demo:snapshot', 'demo:tick', 'demo:tick', 'demo:tick']);
  });
});
