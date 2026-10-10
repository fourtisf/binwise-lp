/**
 * Net vs hold, the product's core metric (CLAUDE.md §2).
 * holdValue = entryA * priceA + entryB * priceB
 * netVsHold = (positionValue + claimedFees) / holdValue − 1
 */
export function holdValue(entryA: number, entryB: number, priceA: number, priceB: number): number {
  return entryA * priceA + entryB * priceB;
}

/** Returns a fraction (0.068 = +6.8%). */
export function netVsHold(positionValue: number, claimedFees: number, hold: number): number {
  if (hold <= 0) throw new RangeError('holdValue must be positive');
  return (positionValue + claimedFees) / hold - 1;
}
