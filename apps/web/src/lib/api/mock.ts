import { MockEngine, MockError, startDemo, TOKENS } from '@kovra/mock';
import type { DemoPair } from '@kovra/core';
import { ApiError, type KovraClient } from './client';

export const MOCK_DEMO_PAIRS: DemoPair[] = [
  { id: 'jup-sol', pair: 'JUP / SOL', tokenA: TOKENS.JUP, tokenB: TOKENS.SOL, shape: 'spot' },
  { id: 'sol-usdc', pair: 'SOL / USDC', tokenA: TOKENS.SOL, tokenB: TOKENS.USDC, shape: 'curve' },
  { id: 'pengu-sol', pair: 'PENGU / SOL', tokenA: TOKENS.PENGU, tokenB: TOKENS.SOL, shape: 'spot' },
];

/** In-browser simulated vault. Each visitor gets their own. */
export function createMockClient(): KovraClient {
  const engine = new MockEngine().start();
  const call = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e instanceof MockError ? new ApiError(e.code, e.message) : e);
    }
  };
  const unsupported = () => Promise.reject(new ApiError('mock', 'Not available in the demo.'));
  return {
    kind: 'mock',
    vaultId: engine.vaultId,
    useVault: () => {},
    me: () => Promise.resolve(null),
    demoVaultId: () => Promise.resolve(engine.vaultId),
    signInChallenge: unsupported,
    signIn: unsupported,
    signOut: () => Promise.resolve(),
    overview: () => call(() => engine.getOverview()),
    // The portfolio and Add LP by hand need the real API.
    portfolio: unsupported,
    balance: unsupported,
    performance: (range) => call(() => engine.getPerformance(range)),
    pools: () => call(() => engine.getPools()),
    pool: (id) => call(() => engine.getPool(id)),
    positions: () => call(() => engine.getPositions()),
    decisions: (f) =>
      call(() => engine.getDecisions().filter((d) => (!f?.types || f.types.includes(d.type)) && !f?.exclude?.includes(d.type))),
    cycle: () => call(() => engine.getCycle()),
    strategy: () => call(() => engine.getStrategy()),
    saveStrategy: (s) => call(() => engine.putStrategy(s)),
    pause: () => call(() => engine.pause()),
    resume: () => call(() => engine.resume()),
    setMode: (m) => call(() => engine.setMode(m)),
    claim: (id) => call(() => engine.claim(id)),
    close: (id) => call(() => engine.close(id)),
    deploy: unsupported,
    walletPrepare: unsupported,
    walletSend: unsupported,
    walletCancel: unsupported,
    walletTx: unsupported,
    walletPending: () => Promise.resolve([]),
    walletDone: unsupported,
    depositLive: unsupported,
    depositScan: unsupported,
    releaseCustody: unsupported,
    withdrawable: unsupported,
    withdraw: unsupported,
    telegramLink: unsupported,
    // The built-in simulation trades automatically; approvals need the real API.
    proposals: () => Promise.resolve([]),
    approve: unsupported,
    reject: unsupported,
    latestBacktest: () => Promise.resolve(null),
    subscribe: (fn) => engine.subscribe(fn),
    demoPairs: () => Promise.resolve(MOCK_DEMO_PAIRS),
    demo: (pair, fn) => startDemo(pair, fn),
  };
}
