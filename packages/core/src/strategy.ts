import type { RiskProfile, StrategySettings } from './types';

/** Slider limits on the Strategy page; the API rejects values outside them. */
export const STRATEGY_LIMITS = {
  maxAllocPct: [10, 60],
  minMcapM: [50, 5000],
  trendExitPct: [-30, -3],
  dailyStopPct: [1, 15],
} as const;

export const STRATEGY_PRESETS: Record<
  RiskProfile,
  Omit<StrategySettings, 'profile' | 'toggles'> & { rebalancesPerDay: number }
> = {
  conservative: { maxAllocPct: 20, minMcapM: 2000, trendExitPct: -8, dailyStopPct: 2, rebalancesPerDay: 0.6 },
  balanced: { maxAllocPct: 25, minMcapM: 500, trendExitPct: -12, dailyStopPct: 4, rebalancesPerDay: 1.4 },
  aggressive: { maxAllocPct: 40, minMcapM: 100, trendExitPct: -20, dailyStopPct: 8, rebalancesPerDay: 3.1 },
};

export const DEFAULT_STRATEGY: StrategySettings = {
  profile: 'balanced',
  maxAllocPct: 25,
  minMcapM: 500,
  trendExitPct: -12,
  dailyStopPct: 4,
  toggles: {
    autoCompound: true,
    rebalanceOnlyProfitable: true,
    holderSafety: true,
    pauseOnVolSpikes: false,
    telegramAlerts: false,
  },
};

const PROFILES: RiskProfile[] = ['conservative', 'balanced', 'aggressive'];
const TOGGLE_KEYS = Object.keys(DEFAULT_STRATEGY.toggles) as (keyof StrategySettings['toggles'])[];

/** Returns a list of problems; empty means the settings are valid. */
export function validateStrategy(s: unknown): string[] {
  const errors: string[] = [];
  if (typeof s !== 'object' || s === null) return ['Strategy must be an object.'];
  const v = s as Record<string, unknown>;
  if (!PROFILES.includes(v.profile as RiskProfile)) errors.push('Unknown risk profile.');
  for (const [key, [min, max]] of Object.entries(STRATEGY_LIMITS)) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
      errors.push(`${key} must be a number from ${min} to ${max}.`);
  }
  const t = v.toggles as Record<string, unknown> | undefined;
  if (typeof t !== 'object' || t === null) errors.push('toggles must be an object.');
  else for (const k of TOGGLE_KEYS) if (typeof t[k] !== 'boolean') errors.push(`toggles.${k} must be true or false.`);
  return errors;
}
