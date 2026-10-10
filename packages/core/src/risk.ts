/** Pool risk signals. Each returns a plain-language reason when it trips. */

export interface RiskInputs {
  /** Price of each stablecoin in the pair (USD) */
  stablePrices: { symbol: string; priceUsd: number }[];
  /** Pool price vs. price implied by the two tokens' market prices, percent */
  priceDeviationPct: number | null;
  /** TVL change versus about an hour ago, percent (negative = drained) */
  tvlChange1hPct: number | null;
  /** Token unlocks within the warning window */
  upcomingUnlocks: { symbol: string; at: Date; note?: string | null }[];
}

export const RISK_LIMITS = {
  depegPct: 1.5,
  priceDeviationPct: 3,
  tvlDropPct: 40,
  unlockWarnHours: 48,
};

export function riskFlags(r: RiskInputs, l = RISK_LIMITS): string[] {
  const flags: string[] = [];
  for (const s of r.stablePrices) {
    const off = (s.priceUsd - 1) * 100;
    if (Math.abs(off) >= l.depegPct) flags.push(`${s.symbol} is off its peg (${s.priceUsd.toFixed(3)}).`);
  }
  if (r.priceDeviationPct != null && Math.abs(r.priceDeviationPct) >= l.priceDeviationPct)
    flags.push(`Pool price is ${Math.abs(r.priceDeviationPct).toFixed(1)}% away from the market price.`);
  if (r.tvlChange1hPct != null && r.tvlChange1hPct <= -l.tvlDropPct)
    flags.push(`TVL fell ${Math.abs(r.tvlChange1hPct).toFixed(0)}% in the last hour.`);
  for (const u of r.upcomingUnlocks) flags.push(`${u.symbol} unlock on ${u.at.toISOString().slice(0, 10)}${u.note ? ` (${u.note})` : ''}.`);
  return flags;
}

/** Flags that mean "get out now", not just "don't enter". */
export const isUrgent = (flag: string) => /off its peg|TVL fell|away from the market/.test(flag);
