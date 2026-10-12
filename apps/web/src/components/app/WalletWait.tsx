'use client';

import { useEffect, useRef, useState } from 'react';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import type { Wallet } from '@/lib/wallets';
import { shortWallet } from './Wallet';

const box = { marginTop: 12, padding: 14, borderRadius: 12, border: '1px solid var(--line)', background: 'rgba(255,255,255,.02)', fontSize: 12.5, lineHeight: 1.55 } as const;
const link = { fontSize: 12.5, color: 'var(--aqua)', textDecoration: 'underline' } as const;
const sol4 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const clock = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

/** Brings a panel that opens under the button into view: the drawer can end at the button. */
function useShown() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), []);
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
  onSendYourself,
}: {
  wallet: Wallet;
  what: string;
  /** Approved in the wallet: Solana is confirming the transfer, nothing more to do there */
  confirming?: boolean;
  onStop: () => void;
  onSendYourself?: () => void;
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
          Over a minute: Solana may no longer take this transfer. If the wallet says it failed, nothing was sent. Stop waiting and try again.
        </p>
      )}
      <p style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <button style={link} onClick={onStop}>
          Stop waiting
        </button>
        {/* Once approved the SOL is on its way: sending it by hand too would send it twice. */}
        {onSendYourself && !confirming && (
          <button style={link} onClick={onSendYourself}>
            Send the SOL yourself instead
          </button>
        )}
      </p>
    </div>
  );
}

/**
 * Sending SOL to the vault by hand, for when the wallet won't approve on this page (or from a phone app):
 * the vault address to send to from the signed-in wallet (only transfers from it count as a deposit). The
 * page then watches the vault wallet; once the SOL is there it records the deposit and calls `onArrived`.
 */
export function SendYourself({
  sol,
  vault,
  owner,
  then,
  onArrived,
  onClose,
}: {
  sol: number;
  vault: string;
  owner: string;
  /** What happens once it arrives, for the waiting line */
  then: string;
  onArrived: (received: number) => void;
  onClose: () => void;
}) {
  const { client } = useAppData();
  const { toast } = useUi();
  const secs = useSeconds();
  const ref = useShown();
  /** SOL that reached the vault since this opened */
  const [received, setReceived] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  // The latest callback, so a re-render while waiting doesn't restart the watch.
  const arrived = useRef(onArrived);
  arrived.current = onArrived;

  useEffect(() => {
    if (!client) return;
    let live = true;
    let busy = false;
    let base: number | null = null;
    const started = Date.now();
    const check = async () => {
      if (busy) return;
      busy = true;
      const b = await client.balance().catch(() => null);
      busy = false;
      if (!live) return;
      // Solana unreachable this time: read again on the next tick.
      if (b?.vaultSol != null) {
        if (base == null) base = b.vaultSol;
        const got = Math.max(0, b.vaultSol - base);
        setReceived(got);
        // A little under: the vault can pay a network fee meanwhile.
        if (got >= sol * 0.97) {
          live = false;
          clearInterval(t);
          // The agent records it too within a few minutes, so a failure here costs nothing.
          await client.depositScan().catch(() => null);
          arrived.current(got);
          return;
        }
      }
      if (Date.now() - started > 15 * 60_000) {
        live = false;
        clearInterval(t);
        setGaveUp(true);
      }
    };
    const t = setInterval(check, 4000);
    void check();
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [client, sol]);

  const copy = () =>
    navigator.clipboard
      .writeText(vault)
      .then(() => toast('Vault wallet address copied'))
      .catch(() => toast(vault));

  return (
    <div ref={ref} style={box} id="dManual">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 13.5 }}>
        <b style={{ fontWeight: 500 }}>Send it yourself</b>
        <button className="dim" style={{ fontSize: 12.5, textDecoration: 'underline' }} onClick={onClose}>
          Cancel
        </button>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        In your wallet <b className="num" style={{ color: 'var(--text)', fontWeight: 500 }}>{shortWallet(owner)}</b> (the one you signed in with), send{' '}
        <b className="num" style={{ color: 'var(--text)', fontWeight: 500 }}>{sol4(sol)} SOL</b> to your vault wallet:
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, padding: '9px 10px 9px 12px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
        <code className="num" style={{ flex: 1, minWidth: 0, wordBreak: 'break-all', fontSize: 12.5, color: 'var(--text)' }}>
          {vault}
        </code>
        <button className="btn btn-dark btn-sm" style={{ flex: 'none', height: 26, padding: '0 10px', fontSize: 12.5 }} onClick={copy}>
          Copy
        </button>
      </div>
      <p className="muted" style={{ marginTop: 8 }}>
        Only SOL from {shortWallet(owner)} counts as your deposit. Already approved it in the wallet? Don&apos;t send it again: it shows here once it lands.
      </p>
      <p style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: 'var(--soft)' }}>
        {gaveUp ? (
          <span className="muted">Nothing arrived in 15 minutes. If you send it later, it still lands in your vault: use it with Add LP then.</span>
        ) : (
          <>
            <span className="pill watch live num">
              <span className="d" />
              {clock(secs)}
            </span>
            {received > 0.0005 ? `Received ${sol4(received)} of ${sol4(sol)} SOL so far.` : `Waiting for ${sol4(sol)} SOL.`} {then}
          </>
        )}
      </p>
    </div>
  );
}
