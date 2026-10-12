'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppDataProvider } from '@/lib/store';
import { ErrorBoundary } from '../ErrorBoundary';
import { UiProvider, useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { Palette } from './Palette';
import { PoolDrawer } from './PoolDrawer';
import { Sidebar } from './Sidebar';
import { Toast } from './Toast';
import { Topbar } from './Topbar';
import { WALLET_LOGIN } from '@/lib/site';
import { ConfirmLiveModal, ConnectModal } from './Wallet';
import { WalletTaskCard } from './WalletTask';
import { WithdrawModal } from './WithdrawModal';
import { PAGES, pageFor } from './pages';

function Shell({ children }: { children: ReactNode }) {
  const page = pageFor(usePathname());
  const { layer, closeLayers } = useUi();
  return (
    <>
      <div id="app">
        <div className="shell">
          <ErrorBoundary area="sidebar">
            <Sidebar current={page.key} />
          </ErrorBoundary>
          <div className="main">
            <ErrorBoundary area="top bar">
              <Topbar title={page.title} />
            </ErrorBoundary>
            <div className="phead">
              <h1 id="pgTitle">{page.title}</h1>
              <p id="pgSub">{page.sub}</p>
            </div>
            {/* A new page starts without the last page's error. */}
            <ErrorBoundary area={page.title} key={page.key}>
              {children}
            </ErrorBoundary>
          </div>
        </div>
        <nav className="bnav" aria-label="App">
          {PAGES.map((p) => (
            <Link key={p.key} href={p.href} aria-current={p.key === page.key ? 'page' : undefined}>
              <Icon id={p.icon} />
              {p.title}
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
