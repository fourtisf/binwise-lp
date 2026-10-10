import { MockEngine, MockError, startDemo } from '@binwise/mock';
import { ApiError, type BinwiseClient } from './client';

/** In-browser simulated vault. Each visitor gets their own. */
export function createMockClient(): BinwiseClient {
  const engine = new MockEngine().start();
  const call = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e instanceof MockError ? new ApiError(e.code, e.message) : e);
    }
  };
  return {
    vaultId: engine.vaultId,
    overview: () => call(() => engine.getOverview()),
    performance: (range) => call(() => engine.getPerformance(range)),
    pools: () => call(() => engine.getPools()),
    pool: (id) => call(() => engine.getPool(id)),
    positions: () => call(() => engine.getPositions()),
    decisions: (type) => call(() => engine.getDecisions(type)),
    cycle: () => call(() => engine.getCycle()),
    strategy: () => call(() => engine.getStrategy()),
    saveStrategy: (s) => call(() => engine.putStrategy(s)),
    pause: () => call(() => engine.pause()),
    resume: () => call(() => engine.resume()),
    setMode: (m) => call(() => engine.setMode(m)),
    deposit: (t, a) => call(() => engine.deposit(t, a)),
    claim: (id) => call(() => engine.claim(id)),
    close: (id) => call(() => engine.close(id)),
    subscribe: (fn) => engine.subscribe(fn),
    demo: (pair, fn) => startDemo(pair, fn),
  };
}
