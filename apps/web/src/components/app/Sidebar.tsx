'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { PairIcon } from '../Tokens';
import { AgentCard } from './AgentCard';
import { PAGES, hrefFor, type PageKey } from './pages';

export function Sidebar({ current }: { current: PageKey }) {
  const { pools, positions } = useAppData();
  const { openPalette, scrollTarget } = useUi();
  const router = useRouter();
  const counts: Partial<Record<PageKey, number>> = { pools: pools.length, positions: positions.length };
  return (
    <aside className="side">
      <Link className="ws-switch" id="toLanding" title="Back to site" href="/">
        <span className="mark">
          <Icon id="i-mark" />
        </span>
        <div>
          <b>Main vault</b>
          <small>Binwise</small>
        </div>
        <Icon id="i-updown" className="ch" />
      </Link>
      <button className="cmdk" onClick={openPalette}>
        <Icon id="i-search" />
        Search<span className="kbd">⌘K</span>
      </button>
      {PAGES.map((p) => (
        <Link className="navi" key={p.key} href={p.href} aria-current={p.key === current ? 'page' : undefined}>
          <Icon id={p.icon} />
          {p.title}
          {counts[p.key] ? <span className="cnt">{counts[p.key]}</span> : null}
        </Link>
      ))}
      <div className="sgroup">Live positions</div>
      <div id="sidePos">
        {positions.map((p) => (
          <button
            className="navi"
            key={p.id}
            onClick={() => {
              scrollTarget.current = p.id;
              if (current === 'positions') document.getElementById('pc-' + p.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              else router.push(hrefFor('positions'));
            }}
          >
            <PairIcon a={p.tokenA} b={p.tokenB} />
            {p.pair}
            <span className={`sd${p.inRange ? '' : ' out'}`}></span>
          </button>
        ))}
      </div>
      <AgentCard />
    </aside>
  );
}
