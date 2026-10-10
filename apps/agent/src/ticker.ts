import { JupiterClient } from '@binwise/chain';
import type { StreamEvent } from '@binwise/core';
import type { PrismaClient } from '@binwise/db';
import { rangePrices } from './agent';

/**
 * Price ticker: every few seconds, push live prices for open positions so
 * charts move between agent cycles. Prices come from Jupiter (USD per token).
 */
export async function tickOnce(db: PrismaClient, jupiter: JupiterClient, emit: (vaultId: string, e: StreamEvent) => void) {
  const positions = await db.position.findMany({ where: { status: 'open', vault: { status: 'running' } }, include: { pool: true } });
  if (!positions.length) return 0;
  const mints = [...new Set(positions.flatMap((p) => [p.pool.mintA, p.pool.mintB]))];
  const prices = await jupiter.prices(mints);
  const tokens = new Map((await db.token.findMany({ where: { mint: { in: mints } } })).map((t) => [t.mint, t]));
  let n = 0;
  for (const p of positions) {
    const ux = prices[p.pool.mintA]?.usdPrice;
    const uy = prices[p.pool.mintB]?.usdPrice;
    const tx = tokens.get(p.pool.mintA);
    const ty = tokens.get(p.pool.mintB);
    if (!ux || !uy || !tx || !ty) continue;
    const price = ux / uy;
    const { lo, hi } = rangePrices(p, { decimalsX: tx.decimals, decimalsY: ty.decimals });
    const inRange = price >= lo && price < hi;
    emit(p.vaultId, {
      type: 'tick',
      tick: {
        positionId: p.id,
        price,
        lo,
        hi,
        inRange,
        event: inRange ? (p.inRange ? 'hold' : 'back') : p.inRange ? 'out' : 'wait',
        marker: false,
        fees: p.feesClaimedUsd + p.feesUnclaimedUsd,
        netVsHold: p.netVsHold,
        rebalances: p.rebalances,
      },
    });
    n++;
  }
  return n;
}
