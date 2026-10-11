import { describe, expect, it } from 'vitest';
import { isAllowed } from '@binwise/db';

const t = (symbol: string, isVerified: boolean, freezeAuthorityDisabled: boolean | null, allowed: boolean | null = null) => ({ symbol, isVerified, freezeAuthorityDisabled, allowed });

describe('allowlist', () => {
  it('lets verified stablecoins through despite their issuer freeze authority', () => {
    expect(isAllowed(t('USDC', true, false))).toBe(true);
    expect(isAllowed(t('USDT', true, false))).toBe(true);
  });
  it('still blocks other tokens with a live freeze authority, and unverified tokens', () => {
    expect(isAllowed(t('SCAM', true, false))).toBe(false);
    expect(isAllowed(t('USDC', false, false))).toBe(false); // a fake "USDC"
    expect(isAllowed(t('BONK', false, true))).toBe(false);
    expect(isAllowed(t('BONK', true, true))).toBe(true);
  });
  it('a manual override always wins', () => {
    expect(isAllowed(t('SCAM', true, false, true))).toBe(true);
    expect(isAllowed(t('BONK', true, true, false))).toBe(false);
  });
});
