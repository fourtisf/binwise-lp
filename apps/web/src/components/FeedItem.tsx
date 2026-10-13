import type { Decision, DecisionType } from '@kovra/core';
import { hhmm } from '@/lib/format';
import { Icon, type IconId } from './Sprite';

const LOOK: Record<DecisionType, [string, IconId]> = {
  deploy: ['deploy', 'i-plus'],
  rebalance: ['rebalance', 'i-swap'],
  exit: ['exit', 'i-exit'],
  compound: ['compound', 'i-comp'],
  scan: ['scan', 'i-search'],
  skip: ['scan', 'i-search'],
  hold: ['scan', 'i-dot'],
};

/** One row in the activity feed: what the agent did and why. */
export function FeedItem({ d }: { d: Decision }) {
  const [cls, icon] = LOOK[d.type];
  // Paper-mode fills are simulated, so there is no explorer page to open.
  const simulated = d.txSig?.startsWith('sim-');
  return (
    <div className="fi">
      <span className={`fic ${cls}`}>
        <Icon id={icon} />
      </span>
      <div>
        <b>{d.title}</b>
        <span>{d.reason}</span>
        {d.txSig &&
          (simulated ? (
            <a className="tx" href="#" onClick={(e) => e.preventDefault()} title="Simulated in paper mode">
              View transaction
            </a>
          ) : (
            <a className="tx" href={`https://solscan.io/tx/${d.txSig}`} target="_blank" rel="noreferrer">
              View transaction
            </a>
          ))}
      </div>
      <time>{hhmm(d.ts)}</time>
    </div>
  );
}
