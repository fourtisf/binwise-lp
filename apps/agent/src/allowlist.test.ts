import { describe, expect, it } from 'vitest';
import { isAllowed } from '@kovra/db';

const t = (symbol: string, isVerified: boolean, freezeAuthorityDisabled: boolean | null, allowed: boolean | null = null, mcapUsd: number | null = 5e6) => ({ symbol, isVerified, freezeAuthorityDisabled, allowed, mcapUsd });

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
  it('lets established tokens (verified, $100M+) keep an issuer freeze authority', () => {
    expect(isAllowed(t('cbBTC', true, false, null, 242e6))).toBe(true);
    expect(isAllowed(t('JLP', true, false, null, 893e6))).toBe(true);
    expect(isAllowed(t('SMALL', true, false, null, 20e6))).toBe(false);
    expect(isAllowed(t('FAKE', false, false, null, 900e6))).toBe(false);
  });
  it('a manual override always wins', () => {
    expect(isAllowed(t('SCAM', true, false, true))).toBe(true);
    expect(isAllowed(t('BONK', true, true, false))).toBe(false);
  });
});
