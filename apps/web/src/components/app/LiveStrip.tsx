'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { PairIcon } from '../Tokens';
import { hrefFor } from './pages';

/** The vault's open positions as chips beside the page title; a chip opens that position. */
export function LiveStrip() {
  const { positions } = useAppData();
  const { scrollTarget } = useUi();
  const router = useRouter();
  const onPositions = usePathname() === hrefFor('positions');
  if (!positions.length) return null;
  return (
    <div className="lstrip">
      <small>Live positions</small>
      <div id="sidePos">
        {positions.map((p) => (
          <button
            className="lchip"
            key={p.id}
            onClick={() => {
              scrollTarget.current = p.id;
              if (onPositions) document.getElementById('pc-' + p.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              else router.push(hrefFor('positions'));
            }}
          >
            <PairIcon a={p.tokenA} b={p.tokenB} />
            {p.pair}
            <span className={`sd${p.inRange ? '' : ' out'}`} title={p.inRange ? 'In range' : 'Out of range'}></span>
          </button>
        ))}
      </div>
    </div>
  );
}
