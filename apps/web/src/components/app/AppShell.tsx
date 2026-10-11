'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppDataProvider } from '@/lib/store';
import { UiProvider, useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { DepositModal } from './DepositModal';
import { Palette } from './Palette';
import { PoolDrawer } from './PoolDrawer';
import { Sidebar } from './Sidebar';
import { Toast } from './Toast';
import { Topbar } from './Topbar';
import { WALLET_LOGIN } from '@/lib/site';
import { ConfirmLiveModal, ConnectModal, WalletProviders } from './Wallet';
import { PAGES, pageFor } from './pages';

function Shell({ children }: { children: ReactNode }) {
  const page = pageFor(usePathname());
  const { layer, closeLayers } = useUi();
  return (
    <>
      <div id="app">
        <div className="shell">
          <Sidebar current={page.key} />
          <div className="main">
            <Topbar title={page.title} />
            <div className="phead">
              <h1 id="pgTitle">{page.title}</h1>
              <p id="pgSub">{page.sub}</p>
            </div>
            {children}
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
      {WALLET_LOGIN && <DepositModal />}
      {WALLET_LOGIN && <ConnectModal />}
      <ConfirmLiveModal />
      <Palette />
      <Toast />
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <WalletProviders>
      <UiProvider>
        <AppDataProvider>
          <Shell>{children}</Shell>
        </AppDataProvider>
      </UiProvider>
    </WalletProviders>
  );
}
