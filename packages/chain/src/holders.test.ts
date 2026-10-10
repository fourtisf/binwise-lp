import { describe, expect, it } from 'vitest';
import { metadataCheck, runHolderChecks } from './holders';

const base = { mint: 'M', isVerified: true, freezeAuthorityDisabled: true, holders: 100_000 };

describe('holder safety', () => {
  it('passes a verified, widely held token', async () => {
    expect((await metadataCheck.check(base)).quality).toBe(1);
  });
  it('fails tokens whose freeze authority is still live', async () => {
    expect((await metadataCheck.check({ ...base, freezeAuthorityDisabled: false })).quality).toBe(0);
  });
  it('scores top-holder concentration from the Jupiter audit', async () => {
    expect((await metadataCheck.check({ ...base, topHoldersPct: 15 })).quality).toBe(1);
    expect((await metadataCheck.check({ ...base, topHoldersPct: 40 })).quality).toBeCloseTo(0.5);
    expect((await metadataCheck.check({ ...base, topHoldersPct: 75 })).quality).toBe(0);
  });
  it('treats a failing check as unknown, not safe', async () => {
    const v = await runHolderChecks([{ name: 'broken', check: async () => { throw new Error('rpc down'); } }], base);
    expect(v.quality).toBe(0.5);
  });
});
