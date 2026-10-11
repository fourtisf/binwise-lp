import type { IconId } from '../Sprite';

export type PageKey = 'overview' | 'pools' | 'positions' | 'strategy' | 'activity' | 'report' | 'portfolio';

export const PAGES: { key: PageKey; href: string; icon: IconId; title: string; sub: string }[] = [
  { key: 'overview', href: '/app', icon: 'i-home', title: 'Overview', sub: 'Your vault and what the agent is doing right now.' },
  { key: 'pools', href: '/app/pools', icon: 'i-pools', title: 'Pools', sub: 'Every pool the agent tracks, ranked by its score.' },
  { key: 'positions', href: '/app/positions', icon: 'i-pos', title: 'Positions', sub: 'Your open liquidity, live.' },
  { key: 'strategy', href: '/app/strategy', icon: 'i-strat', title: 'Strategy', sub: 'Set the limits. The agent works inside them.' },
  { key: 'activity', href: '/app/activity', icon: 'i-act', title: 'Activity', sub: 'Every action the agent took, and why.' },
];

/** Pages reachable from ⌘K (and the account menu) but not shown in the navigation. */
export const HIDDEN_PAGES: typeof PAGES = [
  { key: 'portfolio', href: '/app/portfolio', icon: 'i-wallet', title: 'Portfolio', sub: 'Everything in your vault, and how it did against holding.' },
  { key: 'report', href: '/app/report', icon: 'i-act', title: 'Backtest report', sub: 'How the rules would have done against holding, after costs.' },
];

export const pageFor = (pathname: string) => [...PAGES, ...HIDDEN_PAGES].find((p) => p.href === pathname) ?? PAGES[0];
export const hrefFor = (key: PageKey) => PAGES.find((p) => p.key === key)!.href;
