import { describe, expect, it } from 'vitest';
import { LiveTradingBlocked, assertLiveTradingAllowed, assertLiveWallet, liveLimits } from './safety';

describe('assertLiveTradingAllowed', () => {
  it('blocks when the env flag is missing', () => {
    expect(() => assertLiveTradingAllowed({ mode: 'live' }, {})).toThrow(LiveTradingBlocked);
  });

  it('blocks paper vaults even with the flag on', () => {
    expect(() => assertLiveTradingAllowed({ mode: 'paper' }, { LIVE_TRADING_ENABLED: 'true' })).toThrow(LiveTradingBlocked);
  });

  it('allows only flag + live opt-in', () => {
    expect(() => assertLiveTradingAllowed({ mode: 'live' }, { LIVE_TRADING_ENABLED: 'true', RPC_URL: 'https://rpc' })).not.toThrow();
  });
});

describe('live safety limits', () => {
  it('needs a private RPC', () => {
    expect(() => assertLiveTradingAllowed({ mode: 'live' }, { LIVE_TRADING_ENABLED: 'true' })).toThrow(/RPC_URL/);
  });
  it('allows only listed wallets, and nobody when the list is empty', () => {
    expect(() => assertLiveWallet('A', {})).toThrow(LiveTradingBlocked);
    expect(() => assertLiveWallet('B', { LIVE_WALLETS: 'A, C' })).toThrow(LiveTradingBlocked);
    expect(() => assertLiveWallet('C', { LIVE_WALLETS: 'A, C' })).not.toThrow();
  });
  it('caps capital and positions, with safe defaults', () => {
    expect(liveLimits({})).toEqual({ maxUsd: 200, maxPositions: 1 });
    expect(liveLimits({ LIVE_MAX_USD: '500', LIVE_MAX_POSITIONS: '2' })).toEqual({ maxUsd: 500, maxPositions: 2 });
    expect(liveLimits({ LIVE_MAX_USD: 'lots' })).toEqual({ maxUsd: 200, maxPositions: 1 });
  });
});
