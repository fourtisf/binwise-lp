'use client';

import { useAppData } from '@/lib/store';
import { BOT_URL, LIVE_DEFAULT, WALLET_LOGIN } from '@/lib/site';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { shortWallet } from './Wallet';

export function Topbar({ title }: { title: string }) {
  const { overview, setMode, client, me } = useAppData();
  const { openPalette, openConnect } = useUi();
  const api = client?.kind === 'http';
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
        {LIVE_DEFAULT ? (
          // Mainnet site: every vault trades real funds; there is no paper switch.
          <div className="modeseg" role="group" aria-label="Trading mode">
            <button aria-pressed data-mode="live" tabIndex={-1}>
              Mainnet
            </button>
          </div>
        ) : (
          <div className="modeseg" role="group" aria-label="Trading mode">
            <button aria-pressed={mode === 'paper'} data-mode="paper" onClick={() => setMode('paper')}>
              Paper
            </button>
            <button aria-pressed={mode === 'live'} data-mode="live" onClick={() => setMode('live')}>
              Live
            </button>
          </div>
        )}
        {!WALLET_LOGIN && (
          // Vaults live in the Telegram bot: create or import a wallet, deposit and add LP there.
          <a className="btn btn-white btn-sm" href={BOT_URL} target="_blank" rel="noreferrer">
            <Icon id="i-plus" />
            Open Telegram bot
          </a>
        )}
        {!WALLET_LOGIN ? null : api && !me ? (
          <button className="btn btn-dark btn-sm" onClick={openConnect}>
            Connect wallet
          </button>
        ) : (
          <span className="avatar" title={me ? shortWallet(me.wallet) : 'Demo'}></span>
        )}
      </div>
    </header>
  );
}
