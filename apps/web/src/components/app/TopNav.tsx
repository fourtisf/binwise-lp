'use client';

import Link from 'next/link';
import { BRAND } from '@kovra/core/brand';
import { useAppData } from '@/lib/store';
import { BOT_URL, LIVE_DEFAULT, WALLET_LOGIN } from '@/lib/site';
import { useUi } from '@/lib/ui';
import { BrandMark } from '../BrandMark';
import { Icon } from '../Sprite';
import { AccountMenu } from './AccountMenu';
import { AgentDock } from './AgentDock';
import { PAGES, type PageKey } from './pages';

/** The app's floating top bar: name (back to the site), the pages, search, trading mode and the account. */
export function TopNav({ current }: { current: PageKey }) {
  const { overview, pools, positions, setMode, client, me } = useAppData();
  const { openPalette, openConnect } = useUi();
  const api = client?.kind === 'http';
  const mode = overview?.mode ?? 'paper';
  const counts: Partial<Record<PageKey, number>> = { pools: pools.length, positions: positions.length };
  return (
    <header className="deckbar">
      <Link className="deck-brand" id="toLanding" title="Back to site" href="/">
        <BrandMark />
        <b>{BRAND}</b>
      </Link>
      <nav className="deck-tabs" aria-label="App">
        {PAGES.map((p) => (
          <Link className="dtab" key={p.key} href={p.href} aria-current={p.key === current ? 'page' : undefined}>
            {p.nav ?? p.title}
            {counts[p.key] ? <span className="cnt">{counts[p.key]}</span> : null}
          </Link>
        ))}
      </nav>
      <div className="acts">
        <AgentDock compact />
        <button className="deck-search" onClick={openPalette} aria-label="Search">
          <Icon id="i-search" />
          <span className="lbl">Search</span>
          <span className="kbd">⌘K</span>
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
        {!WALLET_LOGIN && BOT_URL && (
          // Vaults live in the Telegram bot: create or import a wallet, deposit and add LP there.
          <a className="btn btn-white btn-sm" href={BOT_URL} target="_blank" rel="noreferrer" aria-label="Open Telegram bot">
            <Icon id="i-plus" />
            <span className="lbl">Open Telegram bot</span>
          </a>
        )}
        {!WALLET_LOGIN ? null : api && !me ? (
          <button className="btn btn-white btn-sm" onClick={openConnect}>
            <span className="lbl">Connect wallet</span>
            <span className="lbl-sm">Connect</span>
          </button>
        ) : (
          <AccountMenu />
        )}
      </div>
    </header>
  );
}
