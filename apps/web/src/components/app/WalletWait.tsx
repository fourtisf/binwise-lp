'use client';

import { useEffect, useRef, useState } from 'react';
import type { Wallet } from '@/lib/wallets';

const box = { marginTop: 12, padding: 14, borderRadius: 12, border: '1px solid var(--line)', background: 'rgba(255,255,255,.02)', fontSize: 12.5, lineHeight: 1.55 } as const;
const link = { fontSize: 12.5, color: 'var(--aqua)', textDecoration: 'underline' } as const;
const clock = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

/** Brings a panel that opens under the button into view: the drawer can end at the button. */
function useShown() {
  const ref = useRef<HTMLDivElement>(null);
  // A block, not an expression: newer Chrome returns a Promise from scrollIntoView, and React would call
  // whatever the effect returns as its cleanup ("n is not a function" when the panel closes).
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);
  return ref;
}

/** Seconds since mount, ticking. */
function useSeconds() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return secs;
}

/**
 * While a wallet is asked to approve: where to find its request. Extensions like Bitget Wallet can leave it
 * under their toolbar icon (the number on the icon) instead of opening a window, or open the window behind
 * the browser; the page can't bring it forward, so it says where to look.
 */
export function WalletWaiting({
  wallet,
  what,
  confirming,
  onStop,
}: {
  wallet: Wallet;
  what: string;
  /** Approved in the wallet: Solana is confirming the transfer, nothing more to do there */
  confirming?: boolean;
  onStop: () => void;
}) {
  const secs = useSeconds();
  const ref = useShown();
  const [phone, setPhone] = useState(false);
  useEffect(() => setPhone(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)), []);
  const icon = (size: number) =>
    // eslint-disable-next-line @next/next/no-img-element
    wallet.icon ? <img src={wallet.icon} alt="" style={{ width: size, height: size, borderRadius: 4, verticalAlign: size < 16 ? '-2px' : '-3px' }} /> : null;
  return (
    <div ref={ref} style={box} id="dWait" role="status">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 13.5 }}>
        <b style={{ fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {icon(16)}
          {confirming ? `Approved in ${wallet.name}` : `Approve in ${wallet.name}`}
        </b>
        <span className="pill watch live num">
          <span className="d" />
          {clock(secs)}
        </span>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        {what}
        {confirming ? '' : ' If it asks to connect to this site first, approve that too.'}
      </p>
      <p style={{ marginTop: 8, color: 'var(--soft)' }}>
        {confirming ? (
          'Solana usually confirms it in a few seconds, a minute or two when the network is busy. Keep this page open.'
        ) : phone ? (
          `Switch to ${wallet.name} if it didn't open by itself.`
        ) : (
          <>
            Don&apos;t see it? Click the {wallet.name} icon {icon(14)} in your browser&apos;s toolbar, top right next to the address bar: the request
            waits there (the number on the icon). Its window can also open behind this one.
          </>
        )}
      </p>
      {secs >= 60 && !confirming && (
        <p className="muted" style={{ marginTop: 8 }}>
          Over a minute: Solana may no longer take it. If the wallet says it failed, nothing was sent. Stop waiting and try again.
        </p>
      )}
      <p style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <button style={link} onClick={onStop}>
          Stop waiting
        </button>
      </p>
    </div>
  );
}
