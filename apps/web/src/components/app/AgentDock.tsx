'use client';

import { useEffect, useState } from 'react';
import { fmt } from '@/lib/format';
import { useAppData } from '@/lib/store';
import { Icon } from '../Sprite';

/**
 * Floating capsule at the bottom of every app page: agent state, time to the next cycle, pause/resume.
 * `compact` is the phone version in the top bar: the state and the countdown only (pause lives in ⌘K there).
 */
export function AgentDock({ compact }: { compact?: boolean }) {
  const { overview, cycle, cycleStart, togglePause } = useAppData();
  const paused = overview?.status === 'paused';
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (cycle) setT((performance.now() - cycleStart) / cycle.intervalMs);
    }, 200);
    return () => clearInterval(id);
  }, [cycle, cycleStart]);
  const interval = cycle?.intervalMs ?? 9000;
  const done = paused || !cycle ? 0 : Math.min(1, Math.max(0, t));
  const left = Math.max(1, Math.ceil(((1 - t) * interval) / 1000));
  const ring = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" />
      <circle className="v" cx="12" cy="12" r="9.5" pathLength={100} strokeDasharray={`${(done * 100).toFixed(1)} 100`} />
    </svg>
  );
  if (compact)
    return (
      <span className={`amini${paused ? ' paused' : ''}`} title={paused ? 'Agent paused' : `Agent running, next cycle in ${left}s`}>
        <span className="orb"></span>
        {ring}
        <span className="num">{paused ? 'Paused' : `${left}s`}</span>
      </span>
    );
  return (
    <div className={`adock${paused ? ' paused' : ''}`}>
      <span className="orb"></span>
      <div className="adock-t">
        <b id="agState">{paused ? 'Agent paused' : 'Agent running'}</b>
        {/* The live cycle number from the stream; the vault's stored one only until the first update. */}
        <small id="agCycle">Cycle {fmt(cycle?.cycle ?? overview?.cycle ?? 0)}</small>
      </div>
      <span className="adock-next">
        {ring}
        {paused ? 'Paused' : `Next cycle in ${left}s`}
      </span>
      <button className="btn btn-white btn-sm" id="pauseBtn" onClick={togglePause} aria-label={paused ? 'Resume agent' : 'Pause agent'}>
        <Icon id={paused ? 'i-play' : 'i-pause'} />
        <span className="lbl">{paused ? 'Resume agent' : 'Pause agent'}</span>
      </button>
    </div>
  );
}
