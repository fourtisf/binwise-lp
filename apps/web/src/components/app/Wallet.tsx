'use client';

import { useEffect, useRef, useState } from 'react';
import { SignInError, rememberWallet, signInWithWallet, watchSolanaWallets, type Wallet } from '@/lib/wallets';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';

/**
 * Wallets we list even when they aren't installed, with their logos (web3icons, MIT) and sites.
 * Installed ones are detected through Wallet Standard and use the icon the wallet itself provides.
 * `browse`: the wallet's app opens a page in its own browser, where the wallet works (phones).
 */
export const KNOWN_WALLETS: { name: string; logo: string; url: string; browse?: (page: string, origin: string) => string }[] = [
  {
    name: 'Phantom',
    logo: '/wallets/phantom.svg',
    url: 'https://phantom.com',
    browse: (page, origin) => `https://phantom.app/ul/browse/${encodeURIComponent(page)}?ref=${encodeURIComponent(origin)}`,
  },
  { name: 'Backpack', logo: '/wallets/backpack.svg', url: 'https://backpack.app' },
  {
    name: 'Solflare',
    logo: '/wallets/solflare.svg',
    url: 'https://solflare.com',
    browse: (page, origin) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(page)}?ref=${encodeURIComponent(origin)}`,
  },
  { name: 'OKX Wallet', logo: '/wallets/okx.svg', url: 'https://www.okx.com/web3' },
  { name: 'Coinbase Wallet', logo: '/wallets/coinbase.svg', url: 'https://www.coinbase.com/wallet' },
  { name: 'Trust', logo: '/wallets/trust.svg', url: 'https://trustwallet.com' },
  { name: 'Exodus', logo: '/wallets/exodus.svg', url: 'https://www.exodus.com' },
  { name: 'Glow', logo: '/wallets/glow.svg', url: 'https://glow.app' },
];

const sameWallet = (a: string, b: string) => a.toLowerCase().split(' ')[0] === b.toLowerCase().split(' ')[0];

export const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

/** Installed Solana wallets, following wallets that load after the page. Empty until mounted (no hydration mismatch). */
export function useSolanaWallets() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  useEffect(() => watchSolanaWallets(setWallets), []);
  return wallets;
}

/** What went wrong, in plain words, and what to do about it. */
function Problem({ wallet, err, others }: { wallet: string; err: SignInError; others: string[] }) {
  if (err.kind === 'rejected')
    return (
      <div className="verdict wt" style={{ marginTop: 0, marginBottom: 12 }}>
        Cancelled in {wallet}. Click Connect and approve the request in the wallet.
      </div>
    );
  if (err.kind === 'pending')
    return (
      <div className="verdict wt" style={{ marginTop: 0, marginBottom: 12 }}>
        {wallet} already has a request open. Open the {wallet} extension, approve or close it, then click Connect again.
      </div>
    );
  const body = { color: 'var(--soft)', fontWeight: 400, fontSize: 13, marginTop: 6 } as const;
  if (err.kind === 'binwise')
    return (
      <div className="verdict stop" style={{ marginTop: 0, marginBottom: 12 }}>
        Binwise didn&apos;t finish the sign-in.
        <div style={body}>{err.message}</div>
      </div>
    );
  if (err.kind === 'impostor')
    return (
      <div className="verdict stop" style={{ marginTop: 0, marginBottom: 12 }}>
        {err.message} is answering in place of {wallet}, so {wallet} never sees the request.
        <div style={body}>
          Turn off {err.message} at <b>chrome://extensions</b> (or its &quot;default wallet&quot; setting), reload this page and connect again.
        </div>
      </div>
    );
  return (
    <div className="verdict stop" style={{ marginTop: 0, marginBottom: 12 }}>
      {wallet} refused to connect. The error comes from inside the wallet, not from Binwise.
      <ol style={{ ...body, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {others.length > 0 && (
          <li>
            Turn off the other wallet extensions ({others.join(', ')}) at <b>chrome://extensions</b>, or use a browser profile with only {wallet}. They can
            take over {wallet}&apos;s connection.
          </li>
        )}
        <li>Quit the browser completely and open it again. Reloading the page doesn&apos;t restart a stuck wallet.</li>
        <li>
          Update {wallet}. In {wallet} → Settings → Connected apps, remove binwise.org if it&apos;s there.
        </li>
      </ol>
      {err.tried.length > 0 && (
        <details style={{ ...body, marginTop: 8 }}>
          <summary style={{ cursor: 'pointer' }}>What the wallet said</summary>
          {err.tried.map((t) => (
            <div key={t} style={{ marginTop: 4, wordBreak: 'break-word' }}>
              {t}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/** Sign-in modal: pick a wallet, approve one request, done. No transaction, no cost. */
export function ConnectModal() {
  const { layer, closeLayers, toast } = useUi();
  const { client, reload } = useAppData();
  const installed = useSolanaWallets();
  const [busy, setBusy] = useState<string | null>(null);
  /** 0 while the wallet is asked the first way; more when an earlier way failed. */
  const [tryN, setTryN] = useState(0);
  const [problem, setProblem] = useState<{ wallet: string; err: SignInError } | null>(null);
  /** Bumped by Cancel, so a late failure of an abandoned request stays quiet. */
  const run = useRef(0);
  const [mobile, setMobile] = useState(false);
  useEffect(() => setMobile(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)), []);
  const on = layer === 'connect';
  const others = KNOWN_WALLETS.filter((k) => !installed.some((w) => sameWallet(k.name, w.name)));

  const connect = async (w: Wallet) => {
    if (!client || busy) return;
    const id = ++run.current;
    setBusy(w.name);
    setTryN(0);
    setProblem(null);
    try {
      const address = await signInWithWallet(
        w,
        { challenge: (wallet) => client.signInChallenge(wallet), verify: (wallet, message, sig) => client.signIn(wallet, message, sig) },
        (n) => run.current === id && setTryN(n),
      );
      // Signed in (the session cookie is set) even if the user pressed Cancel meanwhile.
      rememberWallet(w.name);
      closeLayers();
      toast(`Signed in as ${shortWallet(address)}`);
      reload();
    } catch (e) {
      if (run.current !== id) return;
      setProblem({ wallet: w.name, err: e instanceof SignInError ? e : new SignInError('binwise', (e as Error)?.message || 'Something went wrong. Try again.') });
    } finally {
      if (run.current === id) setBusy(null);
    }
  };

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
      {problem && !busy && (
        <Problem wallet={problem.wallet} err={problem.err} others={installed.filter((w) => w.name !== problem.wallet).map((w) => w.name)} />
      )}
      <div className="rows">
        {installed.map((w) => (
          <div key={w.name}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: 'var(--text)' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="wlogo" src={w.icon || KNOWN_WALLETS.find((k) => sameWallet(k.name, w.name))?.logo} alt="" />
              {w.name}
              <span className="pill in" style={{ padding: '2px 8px', fontSize: 11 }}>
                Detected
              </span>
            </span>
            <button className="btn btn-dark btn-sm" disabled={!!busy || !client} onClick={() => connect(w)}>
              {busy === w.name ? (tryN ? 'Trying another way…' : 'Check your wallet') : 'Connect'}
            </button>
          </div>
        ))}
      </div>
      {busy && (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span>Approve the request in {busy}. Its window can open behind this one.</span>
          <button
            className="dim"
            style={{ textDecoration: 'underline', flex: 'none' }}
            onClick={() => {
              run.current++;
              setBusy(null);
            }}
          >
            Cancel
          </button>
        </p>
      )}
      {others.length > 0 && (
        <>
          <div className="dsec" style={{ margin: '18px 0 4px' }}>
            {installed.length ? 'Other wallets' : mobile ? 'Open Binwise in your wallet app' : 'Install a Solana wallet to continue'}
          </div>
          <div className="rows">
            {others.map((k) => {
              const app = mobile && !installed.length && k.browse ? k.browse(window.location.href, window.location.origin) : null;
              return (
                <div key={k.name}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: 'var(--soft)' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="wlogo" src={k.logo} alt="" />
                    {k.name}
                  </span>
                  <a className="btn btn-dark btn-sm" href={app ?? k.url} target={app ? undefined : '_blank'} rel="noreferrer">
                    {app ? 'Open app' : 'Install'}
                  </a>
                </div>
              );
            })}
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
