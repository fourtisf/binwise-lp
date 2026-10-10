import type { IconId } from '../Sprite';

export type PageKey = 'overview' | 'pools' | 'positions' | 'strategy' | 'activity';

export const PAGES: { key: PageKey; href: string; icon: IconId; title: string; sub: string }[] = [
  { key: 'overview', href: '/app', icon: 'i-home', title: 'Overview', sub: 'Your vault and what the agent is doing right now.' },
  { key: 'pools', href: '/app/pools', icon: 'i-pools', title: 'Pools', sub: 'Every pool the agent tracks, ranked by its score.' },
  { key: 'positions', href: '/app/positions', icon: 'i-pos', title: 'Positions', sub: 'Your open liquidity, live.' },
  { key: 'strategy', href: '/app/strategy', icon: 'i-strat', title: 'Strategy', sub: 'Set the limits. The agent works inside them.' },
  { key: 'activity', href: '/app/activity', icon: 'i-act', title: 'Activity', sub: 'Every action the agent took, and why.' },
];

export const pageFor = (pathname: string) => PAGES.find((p) => p.href === pathname) ?? PAGES[0];
export const hrefFor = (key: PageKey) => PAGES.find((p) => p.key === key)!.href;
