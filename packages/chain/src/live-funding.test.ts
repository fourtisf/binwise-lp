import { describe, expect, it } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import { LiveExecutor } from './live';
import type { Holdings } from './executor';

/** Live funding logic without the network: holdings and swaps are stubbed. */
class FundingProbe extends LiveExecutor {
  bal: Holdings;
  swaps: { from: string; to: string; ui: number }[] = [];
  constructor(bal: Holdings) {
    super({
      conn: new Connection('http://127.0.0.1:1'),
      agent: Keypair.generate(),
      ownerWallet: Keypair.generate().publicKey,
      killSwitch: { isKilled: async () => false },
      idempotency: { claim: async () => true },
    });
    this.bal = { ...bal };
  }
  override async holdings() {
    return { ...this.bal };
  }
  override async swap(from: string, to: string, ui: number, usd: { from: number; to: number }) {
    this.swaps.push({ from, to, ui });
    this.bal[from] -= ui;
    this.bal[to] = (this.bal[to] ?? 0) + (ui * usd.from) / usd.to;
    return { amountX: 0, amountY: 0, feesUsd: 0, costUsd: 0, txSigs: ['sig'] };
  }
  fund(mint: string, usd: number, prices: Record<string, number>, keep: string[]) {
    return (this as unknown as { acquire: (m: string, u: number, p: Record<string, number>, k: string, keep: string[]) => Promise<string[]> }).acquire(mint, usd, prices, 'k', keep);
  }
}

const prices = { JUP: 0.5, SOL: 150, USDC: 1 };

describe('LiveExecutor funding', () => {
  it('swaps idle USDC into both pool tokens for a JUP/SOL position', async () => {
    const ex = new FundingProbe({ USDC: 1000 });
    await ex.fund('JUP', 400, prices, ['SOL']);
    await ex.fund('SOL', 400, prices, ['JUP']);
    expect(ex.bal.JUP * 0.5).toBeGreaterThanOrEqual(399);
    expect(ex.bal.SOL * 150).toBeGreaterThanOrEqual(399);
    expect(ex.swaps.every((s) => s.from === 'USDC')).toBe(true);
  });

  it('does nothing when the vault already holds enough', async () => {
    const ex = new FundingProbe({ JUP: 1000, SOL: 4 });
    expect(await ex.fund('JUP', 400, prices, ['SOL'])).toEqual([]);
  });

  it('only spends the other pool token beyond what the position needs from it', async () => {
    const ex = new FundingProbe({ SOL: 4 }); // $600
    await ex.fund('JUP', 300, prices, ['SOL']);
    expect(ex.bal.SOL * 150).toBeGreaterThanOrEqual(299);
  });
});
