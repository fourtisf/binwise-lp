'use client';

import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState, type WalletError, type WalletName } from '@solana/wallet-adapter-base';
import bs58 from 'bs58';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { connectInjected, impostorOf, injectedFor, phantomDiagnostics, signMessageInjected } from '@/lib/injected';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';

const RPC = process.env.NEXT_PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com';

const WALLET_ERROR = 'binwise:wallet-error';
const WALLET_ADVICE =
  'The wallet itself refused (internal error). Most often another wallet extension (Trust, Bitget, MetaMask) is interfering: turn the others off in chrome://extensions, reload, and connect again. Also check Phantom → Settings → Connected apps and remove binwise.org.';

/** The wallet's own error code, e.g. " · code -32603", when it gives one. */
const codeOf = (e: unknown) => {
  const x = e as { code?: unknown; error?: { code?: unknown } } | null;
  const c = x?.code ?? x?.error?.code;
  return c != null ? ` · code ${String(c)}` : '';
};

/** Set when the user picks a wallet in this page; until then nothing talks to a wallet. */
const intent = { picked: false };

/**
 * Wallet Standard wallets (Phantom, Backpack, Solflare…) register themselves; no adapters needed.
 *
 * No silent reconnect on page load: sign-in is a cookie, so the wallet is only needed when the user
 * acts. A silent reconnect to a locked Phantom stays pending, and the user's own connect then fails
 * with "Unexpected error" (two connects at once). After the user picks a wallet, the provider
 * connects it (exactly once); the modal only calls connect() for a wallet that was already picked.
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [], []);
  const autoConnect = useCallback(async () => intent.picked, []);
  const onError = useCallback((e: WalletError) => {
    console.error('[binwise] wallet', e);
    window.dispatchEvent(new CustomEvent(WALLET_ERROR, { detail: `${e?.message || e?.name || 'Wallet error'}${codeOf(e)}` }));
  }, []);
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect={autoConnect} onError={onError}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}

/**
 * Wallets we list even when they aren't installed, with their logos (web3icons, MIT) and sites.
 * Installed ones are detected through Wallet Standard and use the icon the wallet itself provides.
 */
export const KNOWN_WALLETS: { name: string; logo: string; url: string }[] = [
  { name: 'Phantom', logo: '/wallets/phantom.svg', url: 'https://phantom.com' },
  { name: 'Backpack', logo: '/wallets/backpack.svg', url: 'https://backpack.app' },
  { name: 'Solflare', logo: '/wallets/solflare.svg', url: 'https://solflare.com' },
  { name: 'OKX Wallet', logo: '/wallets/okx.svg', url: 'https://www.okx.com/web3' },
  { name: 'Coinbase Wallet', logo: '/wallets/coinbase.svg', url: 'https://www.coinbase.com/wallet' },
  { name: 'Trust', logo: '/wallets/trust.svg', url: 'https://trustwallet.com' },
  { name: 'Exodus', logo: '/wallets/exodus.svg', url: 'https://www.exodus.com' },
  { name: 'Glow', logo: '/wallets/glow.svg', url: 'https://glow.app' },
];

const sameWallet = (a: string, b: string) => a.toLowerCase().split(' ')[0] === b.toLowerCase().split(' ')[0];

export const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

/** Sign-in modal: pick a wallet, approve one message, done. No transaction, no cost. */
export function ConnectModal() {
  const { layer, closeLayers, toast } = useUi();
  const { client, reload } = useAppData();
  const { wallets, select, connect, connecting, wallet, connected, publicKey, signMessage, signIn, disconnect } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  // Installed wallets are only known in the browser; render the lists after mount to avoid a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const pending = useRef<string | null>(null);
  // Bumped on every click, so a wallet that is already connected signs in straight away.
  const [attempt, setAttempt] = useState(0);
  const on = layer === 'connect';
  const installed = mounted ? wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable) : [];
  const others = KNOWN_WALLETS.filter((k) => !installed.some((w) => sameWallet(k.name, w.adapter.name)));

  const friendly = (m: string) =>
    /rejected|cancel|denied/i.test(m)
      ? 'cancelled in the wallet. Try again and approve the request.'
      : /unexpected|internal|-32603/i.test(m)
        ? `${m}. ${WALLET_ADVICE}`
        : m;

  /** Sign-in through the wallet's own injected provider (window.phantom.solana, …). */
  /** Classic-API attempt already made for this click (its error, if it failed). */
  const classicTried = useRef<string | null>(null);

  /**
   * Sign-in through the wallet's own injected provider (window.phantom.solana, …), the API GMGN and
   * most Solana sites use. quiet: on a non-user failure, say nothing and return 'failed' so the
   * caller can try the Wallet Standard way next.
   */
  const injectedSignIn = useCallback(
    async (name: string, quiet = false): Promise<'ok' | 'stopped' | 'failed' | 'none'> => {
      const p = injectedFor(name);
      if (!p || !client) return 'none';
      let step = 'The wallet did not connect';
      try {
        const address = await connectInjected(p);
        step = 'Could not reach Binwise';
        const c = await client.signInChallenge(address);
        step = 'The wallet did not sign';
        const signature = await signMessageInjected(p, new TextEncoder().encode(c.message));
        step = 'Binwise did not accept the sign-in';
        await client.signIn(address, c.message, bs58.encode(signature));
        closeLayers();
        toast(`Signed in as ${shortWallet(address)}`);
        reload();
        return 'ok';
      } catch (e) {
        console.error('[binwise] classic wallet API', e, '|', phantomDiagnostics());
        const m = (e as Error)?.message || 'cancelled';
        const thief = /phantom/i.test(name) ? impostorOf(p) : null;
        const text = thief
          ? `${thief} is answering in place of Phantom on this page, so Phantom never sees the request. Turn off "${thief}" in chrome://extensions (or its "use as default wallet" setting), reload, and connect again.`
          : `${step} (classic API${codeOf(e)}): ${friendly(m)}`;
        // The user said no, another wallet took over, or the wallet connected but a later step failed: stop here.
        const stop = thief || /reject|cancel|denied/i.test(m) || step !== 'The wallet did not connect';
        if (quiet && !stop) {
          classicTried.current = `${m}${codeOf(e)}`;
          return 'failed';
        }
        toast(text);
        return 'stopped';
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, closeLayers, toast, reload],
  );

  // Connection errors come from the provider (it connects the picked wallet itself). A generic
  // wallet error on the standard connect falls back to the wallet's classic injected API.
  useEffect(() => {
    const onErr = (e: Event) => {
      const name = pending.current;
      if (!name) return;
      pending.current = null;
      const msg = String((e as CustomEvent).detail ?? '');
      (async () => {
        if (!classicTried.current && !/reject|cancel|denied/i.test(msg) && (await injectedSignIn(name)) !== 'none') return;
        toast(
          classicTried.current
            ? `The wallet refused both ways (classic: ${classicTried.current}; standard: ${msg}). ${WALLET_ADVICE}`
            : `The wallet did not connect: ${friendly(msg)}`,
        );
      })().finally(() => setBusy(null));
    };
    window.addEventListener(WALLET_ERROR, onErr);
    return () => window.removeEventListener(WALLET_ERROR, onErr);
  }, [toast, injectedSignIn]);

  // Once the picked wallet is connected, sign in.
  useEffect(() => {
    if (!pending.current || wallet?.adapter.name !== pending.current) return;
    if (!connected) return; // the provider is connecting it
    if (!publicKey || (!signMessage && !signIn) || !client) return;
    pending.current = null;
    (async () => {
      // Each step says what failed, so a wallet error is never a mystery.
      let step = 'Could not reach Binwise';
      try {
        const address = publicKey.toBase58();
        const c = await client.signInChallenge(address);
        let message: string;
        let signature: Uint8Array;
        if (signIn) {
          // Standard Sign In With Solana (Phantom, Backpack, Solflare): the wallet builds and shows the message.
          step = 'The wallet did not sign';
          const out = await signIn({
            domain: c.domain,
            address,
            statement: c.statement,
            uri: window.location.origin,
            version: '1',
            chainId: 'mainnet',
            nonce: c.nonce,
            issuedAt: c.issuedAt,
          });
          if (out.account.address !== address) throw new Error('The wallet signed with a different account. Switch to the connected account and try again.');
          message = new TextDecoder().decode(out.signedMessage);
          signature = out.signature;
        } else {
          step = 'The wallet did not sign';
          message = c.message;
          signature = await signMessage!(new TextEncoder().encode(message));
        }
        step = 'Binwise did not accept the sign-in';
        await client.signIn(address, message, bs58.encode(signature));
        closeLayers();
        toast(`Signed in as ${shortWallet(address)}`);
        reload();
      } catch (e) {
        const m = (e as Error)?.message || 'cancelled';
        toast(`${step}: ${friendly(m)}`);
        await disconnect().catch(() => {});
      } finally {
        setBusy(null);
      }
    })();
  }, [attempt, wallet, connected, publicKey, signMessage, signIn, client, disconnect, closeLayers, toast, reload]);

  return (
    <div
      className={`modal${on ? ' on' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cTitle"
      aria-hidden={!on}
      style={{ maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto' }}
    >
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
        {installed.map((w) => (
          <div key={w.adapter.name}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: 'var(--text)' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="wlogo" src={w.adapter.icon || KNOWN_WALLETS.find((k) => sameWallet(k.name, w.adapter.name))?.logo} alt="" />
              {w.adapter.name}
              <span className="pill in" style={{ padding: '2px 8px', fontSize: 11 }}>
                Detected
              </span>
            </span>
            <button
              className="btn btn-dark btn-sm"
              disabled={!!busy}
              onClick={async () => {
                const name = w.adapter.name;
                setBusy(name);
                classicTried.current = null;
                // Classic injected API first (what GMGN and most Solana sites use); Wallet Standard next.
                const first = await injectedSignIn(name, true);
                if (first === 'ok' || first === 'stopped') return setBusy(null);
                pending.current = w.adapter.name;
                intent.picked = true;
                setAttempt((n) => n + 1);
                // Already picked earlier but not connected (no new selection to trigger autoConnect): connect it directly.
                if (wallet?.adapter.name === w.adapter.name && !connected && !connecting)
                  connect().catch((e) => {
                    const name = pending.current;
                    pending.current = null;
                    const msg = (e as Error)?.message ?? '';
                    (async () => {
                      if (name && !classicTried.current && !/reject|cancel|denied/i.test(msg) && (await injectedSignIn(name)) !== 'none') return;
                      toast(
                        classicTried.current
                          ? `The wallet refused both ways (classic: ${classicTried.current}; standard: ${msg}). ${WALLET_ADVICE}`
                          : `The wallet did not connect: ${friendly(msg)}`,
                      );
                    })().finally(() => setBusy(null));
                  });
                else select(w.adapter.name as WalletName);
              }}
            >
              {busy === w.adapter.name ? 'Check your wallet' : 'Connect'}
            </button>
          </div>
        ))}
      </div>
      {mounted && others.length > 0 && (
        <>
          <div className="dsec" style={{ margin: '18px 0 4px' }}>
            {installed.length ? 'Other wallets' : 'Install a Solana wallet to continue'}
          </div>
          <div className="rows">
            {others.map((k) => (
              <div key={k.name}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: 'var(--soft)' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="wlogo" src={k.logo} alt="" />
                  {k.name}
                </span>
                <a className="btn btn-dark btn-sm" href={k.url} target="_blank" rel="noreferrer">
                  Install
                </a>
              </div>
            ))}
          </div>
        </>
      )}
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
