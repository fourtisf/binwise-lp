'use client';

import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState, type WalletName } from '@solana/wallet-adapter-base';
import bs58 from 'bs58';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';

const RPC = process.env.NEXT_PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com';

/** Wallet Standard wallets (Phantom, Backpack, Solflare…) register themselves; no adapters needed. */
export function WalletProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}

const INSTALL = [
  ['Phantom', 'https://phantom.com/download'],
  ['Backpack', 'https://backpack.app/downloads'],
  ['Solflare', 'https://solflare.com/download'],
];

export const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

/** Sign-in modal: pick a wallet, approve one message, done. No transaction, no cost. */
export function ConnectModal() {
  const { layer, closeLayers, toast } = useUi();
  const { client, reload } = useAppData();
  const { wallets, select, connect, wallet, connected, publicKey, signMessage, disconnect } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const on = layer === 'connect';
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);

  // After select(), connect once the adapter is switched; then sign in.
  useEffect(() => {
    if (!pending.current || wallet?.adapter.name !== pending.current) return;
    if (!connected) {
      connect().catch((e) => {
        toast(e?.message ?? 'Wallet connection was cancelled.');
        pending.current = null;
        setBusy(null);
      });
      return;
    }
    if (!publicKey || !signMessage || !client) return;
    pending.current = null;
    (async () => {
      try {
        const address = publicKey.toBase58();
        const message = await client.signInMessage(address);
        const sig = await signMessage(new TextEncoder().encode(message));
        await client.signIn(address, message, bs58.encode(sig));
        closeLayers();
        toast(`Signed in as ${shortWallet(address)}`);
        reload();
      } catch (e) {
        toast((e as Error).message || 'Sign-in was cancelled.');
        await disconnect().catch(() => {});
      } finally {
        setBusy(null);
      }
    })();
  }, [wallet, connected, publicKey, signMessage, client, connect, disconnect, closeLayers, toast, reload]);

  return (
    <div className={`modal${on ? ' on' : ''}`} role="dialog" aria-modal="true" aria-labelledby="cTitle" aria-hidden={!on}>
      <div className="dh">
        <h3 id="cTitle" style={{ fontSize: 19, letterSpacing: '-.03em' }}>
          Connect a wallet
        </h3>
        <button className="x" onClick={closeLayers} aria-label="Close">
          <Icon id="i-x" />
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
        You sign one message to prove the wallet is yours. It doesn&apos;t send a transaction or cost anything.
      </p>
      <div className="rows">
        {installed.length ? (
          installed.map((w) => (
            <div key={w.adapter.name}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: 'var(--text)' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={w.adapter.icon} alt="" width={22} height={22} style={{ borderRadius: 6 }} />
                {w.adapter.name}
              </span>
              <button
                className="btn btn-dark btn-sm"
                disabled={!!busy}
                onClick={() => {
                  setBusy(w.adapter.name);
                  pending.current = w.adapter.name;
                  select(w.adapter.name as WalletName);
                }}
              >
                {busy === w.adapter.name ? 'Check your wallet' : 'Connect'}
              </button>
            </div>
          ))
        ) : (
          INSTALL.map(([name, url]) => (
            <div key={name}>
              <span>{name}</span>
              <a className="btn btn-dark btn-sm" href={url} target="_blank" rel="noreferrer">
                Install
              </a>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Live mode means real money. Ask once, clearly. */
export function ConfirmLiveModal() {
  const { layer, closeLayers } = useUi();
  const { setMode } = useAppData();
  const on = layer === 'confirmLive';
  return (
    <div className={`modal${on ? ' on' : ''}`} role="dialog" aria-modal="true" aria-labelledby="lTitle" aria-hidden={!on}>
      <div className="dh">
        <h3 id="lTitle" style={{ fontSize: 19, letterSpacing: '-.03em' }}>
          Switch to live mode?
        </h3>
        <button className="x" onClick={closeLayers} aria-label="Close">
          <Icon id="i-x" />
        </button>
      </div>
      <div className="verdict stop" style={{ marginTop: 0 }}>
        Live mode trades real funds on Solana. DeFi carries risk, including total loss. No strategy is guaranteed to profit.
      </div>
      <div className="rows">
        <div>
          <span>Where funds go</span>
          <b>A vault wallet only you can withdraw from</b>
        </div>
        <div>
          <span>Withdrawals</span>
          <b>Only to your connected wallet</b>
        </div>
      </div>
      <button
        className="btn btn-white"
        style={{ width: '100%', marginTop: 16 }}
        onClick={() => {
          closeLayers();
          setMode('live', true);
        }}
      >
        I understand, use real funds
      </button>
    </div>
  );
}
