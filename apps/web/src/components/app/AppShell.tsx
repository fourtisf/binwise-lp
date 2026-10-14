'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppDataProvider } from '@/lib/store';
import { ErrorBoundary } from '../ErrorBoundary';
import { UiProvider, useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { AgentDock } from './AgentDock';
import { LiveStrip } from './LiveStrip';
import { Palette } from './Palette';
import { PoolDrawer } from './PoolDrawer';
import { Toast } from './Toast';
import { TopNav } from './TopNav';
import { LIVE_DEFAULT, WALLET_LOGIN } from '@/lib/site';
import { useAppData } from '@/lib/store';
import { ConfirmLiveModal, ConnectModal } from './Wallet';
import { WalletTaskCard } from './WalletTask';
import { WithdrawModal } from './WithdrawModal';
import { PAGES, pageFor } from './pages';

function Shell({ children }: { children: ReactNode }) {
  const page = pageFor(usePathname());
  const { layer, closeLayers } = useUi();
  const { overview } = useAppData();
  const live = LIVE_DEFAULT || overview?.mode === 'live';
  return (
    <>
      <div id="app">
        <div className="deck">
          <ErrorBoundary area="top bar">
            <TopNav current={page.key} />
          </ErrorBoundary>
          <div className="phead">
            <div className="phead-t">
              <span className="kicker">
                <i className={live ? undefined : 'paper'}></i>
                {overview?.name ?? 'Main vault'} · {live ? 'Mainnet, real funds' : 'Paper, simulated funds'}
              </span>
              <h1 id="pgTitle">{page.title}</h1>
              <p id="pgSub">{page.sub}</p>
            </div>
            <ErrorBoundary area="live positions" fallback="quiet">
              <LiveStrip />
            </ErrorBoundary>
          </div>
          {/* A new page starts without the last page's error. */}
          <ErrorBoundary area={page.title} key={page.key}>
            {children}
          </ErrorBoundary>
        </div>
        <ErrorBoundary area="agent" fallback="quiet">
          <AgentDock />
        </ErrorBoundary>
        <nav className="bnav" aria-label="App">
          {PAGES.map((p) => (
            <Link key={p.key} href={p.href} aria-current={p.key === page.key ? 'page' : undefined}>
              <Icon id={p.icon} />
              {p.nav ?? p.title}
            </Link>
          ))}
        </nav>
      </div>
      <div className={`scrim${layer ? ' on' : ''}`} id="scrim" onClick={closeLayers}></div>
      <PoolDrawer />
      {WALLET_LOGIN && (
        <ErrorBoundary area="wallet sign-in">
          <ConnectModal />
        </ErrorBoundary>
      )}
      <ErrorBoundary area="live mode" fallback="quiet">
        <ConfirmLiveModal />
      </ErrorBoundary>
      <ErrorBoundary area="withdraw">
        <WithdrawModal />
      </ErrorBoundary>
      <ErrorBoundary area="wallet approval">
        <WalletTaskCard />
      </ErrorBoundary>
      <ErrorBoundary area="search" fallback="quiet">
        <Palette />
      </ErrorBoundary>
      <ErrorBoundary area="notice" fallback="quiet">
        <Toast />
      </ErrorBoundary>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <UiProvider>
      <AppDataProvider>
        <Shell>{children}</Shell>
      </AppDataProvider>
    </UiProvider>
  );
}
