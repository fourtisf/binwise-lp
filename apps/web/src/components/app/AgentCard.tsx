'use client';

import { useEffect, useState } from 'react';
import { fmt } from '@/lib/format';
import { useAppData } from '@/lib/store';
import { Icon } from '../Sprite';

/** Sidebar card: agent state, cycle progress and pause/resume. */
export function AgentCard() {
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
  return (
    <div className="agentcard card">
      <div className="ah">
        <span className="orb"></span>
        <div>
          <b id="agState">{paused ? 'Agent paused' : 'Agent running'}</b>
          <small id="agCycle">Cycle {fmt(overview?.cycle ?? cycle?.cycle ?? 0)}</small>
        </div>
      </div>
      <div className="cycle">
        <i style={{ width: paused || !cycle ? '0%' : Math.min(100, t * 100) + '%' }}></i>
      </div>
      <small className="muted" style={{ fontSize: 12 }}>
        {paused ? 'Paused' : `Next cycle in ${Math.max(1, Math.ceil(((1 - t) * interval) / 1000))}s`}
      </small>
      <button className="btn btn-dark btn-sm" id="pauseBtn" onClick={togglePause}>
        <Icon id={paused ? 'i-play' : 'i-pause'} />
        {paused ? 'Resume agent' : 'Pause agent'}
      </button>
    </div>
  );
}
