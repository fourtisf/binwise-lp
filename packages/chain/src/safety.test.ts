import { describe, expect, it } from 'vitest';
import { LiveTradingBlocked, assertLiveTradingAllowed } from './safety';

describe('assertLiveTradingAllowed', () => {
  it('blocks when the env flag is missing', () => {
    expect(() => assertLiveTradingAllowed({ mode: 'live' }, {})).toThrow(LiveTradingBlocked);
  });

  it('blocks paper vaults even with the flag on', () => {
    expect(() => assertLiveTradingAllowed({ mode: 'paper' }, { LIVE_TRADING_ENABLED: 'true' })).toThrow(LiveTradingBlocked);
  });

  it('allows only flag + live opt-in', () => {
    expect(() => assertLiveTradingAllowed({ mode: 'live' }, { LIVE_TRADING_ENABLED: 'true' })).not.toThrow();
  });
});
