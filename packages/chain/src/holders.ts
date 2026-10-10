import { PublicKey, type Connection } from '@solana/web3.js';
import { withRetry } from './http';

/**
 * Holder safety check (CLAUDE.md §2). Pluggable: the owner's BundleScan /
 * DevRadar tools can be wired in as extra HolderCheck implementations.
 */
export interface HolderInfo {
  mint: string;
  isVerified: boolean;
  freezeAuthorityDisabled: boolean | null;
  holders: number | null;
}

export interface HolderVerdict {
  /** 0 = unsafe … 1 = clean */
  quality: number;
  topHoldersPct?: number;
  notes: string[];
}

export interface HolderCheck {
  name: string;
  check(token: HolderInfo): Promise<HolderVerdict>;
}

/** Uses token facts from the Meteora API: verification, freeze authority, holder count. */
export const metadataCheck: HolderCheck = {
  name: 'metadata',
  async check(t) {
    const notes: string[] = [];
    let q = 1;
    if (t.freezeAuthorityDisabled === false) {
      notes.push('Freeze authority is still enabled.');
      q = 0;
    }
    if (!t.isVerified) {
      notes.push('Token is not verified.');
      q = Math.min(q, 0.4);
    }
    if (t.holders != null && t.holders < 2000) {
      notes.push(`Only ${t.holders} holders.`);
      q = Math.min(q, 0.3);
    }
    return { quality: q, notes };
  },
};

/**
 * Concentration of the largest wallets, from RPC. Token accounts whose owner is
 * off-curve (a program PDA: pools, vaults, bridges) are ignored.
 * quality = 1 at ≤20% held by the top 10 wallets, 0 at ≥60%.
 */
export function rpcConcentrationCheck(conn: Connection): HolderCheck {
  return {
    name: 'rpc-concentration',
    async check(t) {
      const mint = new PublicKey(t.mint);
      const [largest, supply] = await Promise.all([
        withRetry(() => conn.getTokenLargestAccounts(mint), 2, 'getTokenLargestAccounts'),
        withRetry(() => conn.getTokenSupply(mint), 2, 'getTokenSupply'),
      ]);
      const accounts = largest.value;
      const infos = await withRetry(() => conn.getMultipleParsedAccounts(accounts.map((a) => a.address)), 2, 'getMultipleParsedAccounts');
      const total = Number(supply.value.uiAmount ?? 0);
      let held = 0;
      let counted = 0;
      accounts.forEach((a, i) => {
        const data = infos.value[i]?.data;
        const owner = data && 'parsed' in data ? (data.parsed?.info?.owner as string | undefined) : undefined;
        if (!owner || counted >= 10 || !PublicKey.isOnCurve(new PublicKey(owner))) return;
        held += Number(a.uiAmount ?? 0);
        counted++;
      });
      const pct = total > 0 ? (held / total) * 100 : 100;
      const quality = Math.max(0, Math.min(1, (60 - pct) / 40));
      return { quality, topHoldersPct: pct, notes: pct > 20 ? [`Top 10 wallets hold ${pct.toFixed(1)}% of supply.`] : [] };
    },
  };
}

/** Runs every check; the weakest result wins. A failing check counts as unknown (0.5), not safe. */
export async function runHolderChecks(checks: HolderCheck[], token: HolderInfo): Promise<HolderVerdict> {
  let quality = 1;
  let topHoldersPct: number | undefined;
  const notes: string[] = [];
  for (const c of checks) {
    try {
      const v = await c.check(token);
      quality = Math.min(quality, v.quality);
      topHoldersPct = v.topHoldersPct ?? topHoldersPct;
      notes.push(...v.notes);
    } catch (e) {
      quality = Math.min(quality, 0.5);
      notes.push(`${c.name} check failed: ${(e as Error).message}`);
    }
  }
  return { quality, topHoldersPct, notes };
}
