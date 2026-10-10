'use client';

import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';

export function Topbar({ title }: { title: string }) {
  const { overview, setMode } = useAppData();
  const { openPalette, openDeposit } = useUi();
  const mode = overview?.mode ?? 'paper';
  return (
    <header className="topbar">
      <div className="crumbs">
        <span className="wsname">{overview?.name ?? 'Main vault'}</span>
        <Icon id="i-chev" className="wsname" />
        <b id="pgCrumb">{title}</b>
      </div>
      <div className="acts">
        <button className="btn btn-dark btn-sm mob-only" onClick={openPalette} aria-label="Search">
          <Icon id="i-search" />
        </button>
        <div className="modeseg" role="group" aria-label="Trading mode">
          <button aria-pressed={mode === 'paper'} data-mode="paper" onClick={() => setMode('paper')}>
            Paper
          </button>
          <button aria-pressed={mode === 'live'} data-mode="live" onClick={() => setMode('live')}>
            Live
          </button>
        </div>
        <button className="btn btn-white btn-sm" onClick={openDeposit}>
          <Icon id="i-plus" />
          Deposit
        </button>
        <span className="avatar" title="7xKp…9fQa"></span>
      </div>
    </header>
  );
}
