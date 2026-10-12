import { createRequire } from 'node:module';
import { PublicKey, type Connection } from '@solana/web3.js';
import type DLMMClass from '@meteora-ag/dlmm';
import { withRetry } from './http';

/**
 * The @meteora-ag/dlmm ESM build imports a directory path that Node's ESM loader
 * rejects, so load its CommonJS build, and only when it's actually needed.
 */
type DlmmModule = typeof import('@meteora-ag/dlmm');
let sdkModule: DlmmModule | null = null;
export const sdk = (): DlmmModule => (sdkModule ??= createRequire(import.meta.url)('@meteora-ag/dlmm') as DlmmModule);

/**
 * The DLMM class. The CommonJS build (1.9.x) makes it the module itself, with the named exports attached
 * and no `default`; older builds had it under `default`. Either way, this is the class.
 */
export const dlmmClass = (): typeof DLMMClass => {
  const m = sdk() as unknown as { default?: typeof DLMMClass };
  return m.default ?? (m as unknown as typeof DLMMClass);
};

export const DLMM = {
  create: (...a: Parameters<typeof DLMMClass.create>) => dlmmClass().create(...a),
};

/** Real liquidity sitting in a pool's active bin, in USD (read from chain). */
export async function activeBinLiquidityUsd(
  conn: Connection,
  pool: { address: string; decimalsX: number; decimalsY: number; usdX: number; usdY: number },
): Promise<number> {
  const dlmm = await withRetry(() => DLMM.create(conn, new PublicKey(pool.address)), 2, 'DLMM.create');
  const bin = await withRetry(() => dlmm.getActiveBin(), 2, 'getActiveBin');
  const x = Number(bin.xAmount.toString()) / 10 ** pool.decimalsX;
  const y = Number(bin.yAmount.toString()) / 10 ** pool.decimalsY;
  return x * pool.usdX + y * pool.usdY;
}
