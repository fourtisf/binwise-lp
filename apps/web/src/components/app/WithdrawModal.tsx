'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Withdrawable } from '@binwise/core';
import { ApiError } from '@/lib/api/client';
import { usd } from '@/lib/format';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { Tok } from '../Tokens';
import { hrefFor } from './pages';
import { shortWallet } from './Wallet';

const SOLSCAN = 'https://solscan.io';

/** Token amounts: more decimals for small ones (0.7490 SOL, 12.50 USDC, 1,250 BONK). */
const amount = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: n >= 1000 ? 0 : 2, maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 4 });
/** Rounded down to what the token can hold, so 25% / 50% / Max never ask for more than there is. */
const floorTo = (n: number, decimals: number) => {
  const k = 10 ** Math.min(decimals, 9);
  return Math.floor(n * k) / k;
};

/**
 * Withdraw from the vault to the owner's own wallet, the one they signed in with (the API sends nowhere
 * else). Same look as the prototype's Deposit modal: amount, token, 25% / 50% / Max. Only idle funds come
 * out: what sits in open positions needs closing first. SOL keeps a little back for the network fee.
 */
export function WithdrawModal() {
  const { layer, closeLayers } = useUi();
  const { client } = useAppData();
  const router = useRouter();
  const on = layer === 'withdraw';
  const [w, setW] = useState<Withdrawable | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [mint, setMint] = useState<string | null>(null);
  const [amt, setAmt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Sent: what, and its transaction */
  const [sent, setSent] = useState<{ text: string; signature?: string } | null>(null);
  const [tick, setTick] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Fresh numbers each time it opens (and after a failed try, which may have changed them).
  useEffect(() => {
    if (!on || !client) return;
    let live = true;
    setLoadErr(null);
    client
      .withdrawable()
      .then((x) => {
        if (!live) return;
        setW(x);
        setMint((m) => x.tokens.find((t) => t.mint === m && t.amount > 0)?.mint ?? x.tokens.find((t) => t.amount > 0)?.mint ?? null);
      })
      .catch((e) => live && setLoadErr(e instanceof ApiError ? e.message : 'Could not read your vault right now. Try again.'));
    return () => {
      live = false;
    };
  }, [on, client, tick]);

  // A new start each time it opens; Esc closes it.
  useEffect(() => {
    if (!on) return;
    setAmt('');
    setErr(null);
    setSent(null);
    const t = setTimeout(() => input.current?.focus(), 60);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeLayers();
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [on, closeLayers]);

  const tokens = w?.tokens.filter((t) => t.amount > 0) ?? [];
  const t = tokens.find((x) => x.mint === mint) ?? null;
  const a = Number(amt) || 0;
  const over = !!t && a > t.amount;
  const price = t && t.amount > 0 ? t.usd / t.amount : 0;
  const label = !t ? 'Nothing to withdraw' : over ? `Only ${amount(t.amount)} ${t.symbol} can come out` : !a ? 'Enter an amount' : `Withdraw ${amount(a)} ${t.symbol}`;

  const go = async () => {
    if (!client || !w || !t || !(a > 0) || over || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await client.withdraw(t.mint, t.symbol, a);
      setSent({ text: `Sent ${amount(a)} ${t.symbol} to your wallet ${shortWallet(w.to)}.`, signature: r.signature });
    } catch (e) {
      // The API says when nothing was sent; a request that never answered may still have gone through.
      setErr(
        e instanceof ApiError && !/^http_5/.test(e.code)
          ? e.message
          : "The request didn't finish. It may still have gone through: check Activity (or your wallet) before trying again.",
      );
      setTick((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const goPositions = () => {
    closeLayers();
    router.push(hrefFor('positions'));
  };

  return (
    <div className={`modal${on ? ' on' : ''}`} id="wModal" role="dialog" aria-modal="true" aria-labelledby="wTitle" aria-hidden={!on} style={{ maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto' }}>
      <div className="dh">
        <h3 id="wTitle" style={{ fontSize: 19, letterSpacing: '-.03em' }}>
          Withdraw to your wallet
        </h3>
        <button className="x" onClick={closeLayers} aria-label="Close">
          <Icon id="i-x" />
        </button>
      </div>

      {sent ? (
        <>
          <div className="verdict go" style={{ marginTop: 0 }} id="wSent">
            {sent.text}
            <div style={{ color: 'var(--soft)', fontWeight: 400, fontSize: 12.5, marginTop: 6 }}>
              It shows in your wallet in a few seconds. Activity lists it too.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            {sent.signature && (
              <a className="btn btn-dark" style={{ flex: 1 }} href={`${SOLSCAN}/tx/${sent.signature}`} target="_blank" rel="noreferrer">
                View on Solscan
                <Icon id="i-ext" />
              </a>
            )}
            <button className="btn btn-white" style={{ flex: 1 }} onClick={closeLayers}>
              Done
            </button>
          </div>
        </>
      ) : loadErr ? (
        <div className="verdict stop" style={{ marginTop: 0 }}>
          {loadErr}
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-dark btn-sm" onClick={() => setTick((n) => n + 1)}>
              Try again
            </button>
          </div>
        </div>
      ) : !w ? (
        <p className="muted" style={{ fontSize: 13.5 }}>
          Checking your vault…
        </p>
      ) : !tokens.length ? (
        <div className="verdict wt" style={{ marginTop: 0 }} id="wNothing">
          Nothing to withdraw right now.
          {w.openPositions > 0 && (
            <div style={{ color: 'var(--soft)', fontWeight: 400, fontSize: 13, marginTop: 6 }}>
              Your funds are in {w.openPositions} open position{w.openPositions > 1 ? 's' : ''}. Close {w.openPositions > 1 ? 'them' : 'it'} in Positions first; the funds then come back to the vault.
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-dark btn-sm" onClick={goPositions}>
                  Go to Positions
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="amt">
            <div className="top">
              <span>Amount</span>
              <span id="wAvail">
                Available {t ? `${amount(t.amount)} ${t.symbol}` : '—'}
              </span>
            </div>
            <div className="mid">
              <input
                id="wAmt"
                ref={input}
                inputMode="decimal"
                placeholder="0"
                value={amt}
                disabled={busy}
                onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))}
                aria-label="Amount to withdraw"
              />
              <div className="tsel" role="group" aria-label="Token">
                {tokens.map((x) => (
                  <button
                    key={x.mint}
                    aria-pressed={x.mint === mint}
                    disabled={busy}
                    onClick={() => {
                      setMint(x.mint);
                      setAmt('');
                    }}
                  >
                    <Tok t={x.token} />
                    {x.symbol}
                  </button>
                ))}
              </div>
            </div>
            <div className="quick">
              {(
                [
                  [0.25, '25%'],
                  [0.5, '50%'],
                  [1, 'Max'],
                ] as const
              ).map(([q, l]) => (
                <button key={l} disabled={!t || busy} onClick={() => t && setAmt(String(floorTo(t.amount * q, t.decimals)))}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="rows">
            <div>
              <span>Value</span>
              <b className="num" id="wVal">
                {price > 0 ? `≈ ${usd(a * price, 2)}` : '—'}
              </b>
            </div>
            <div>
              <span>To</span>
              <b className="num" title={w.to}>
                Your wallet {shortWallet(w.to)}
              </b>
            </div>
            {t?.symbol === 'SOL' && (
              <div>
                <span>Stays in the vault</span>
                <b className="num">{w.keptSol} SOL</b>
              </div>
            )}
          </div>
          <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 10 }}>
            Withdrawals only go to the wallet you signed in with. The vault pays the network fee
            {t?.symbol === 'SOL'
              ? w.openPositions
                ? `, and ${w.keptSol} SOL stays for fees while positions are open.`
                : `, and ${w.keptSol} SOL stays so Solana keeps the vault wallet open.`
              : '.'}
            {w.openPositions > 0 &&
              ` Funds in your ${w.openPositions} open position${w.openPositions > 1 ? 's' : ''} aren't included: close ${w.openPositions > 1 ? 'them' : 'it'} in Positions to take everything out.`}
          </p>
          {err && (
            <p className="down" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 10 }} id="wErr">
              {err}
            </p>
          )}
          <button className="btn btn-white" id="wGo" style={{ width: '100%', marginTop: 16 }} disabled={!t || !a || over || busy} onClick={go}>
            {busy ? 'Sending…' : label}
          </button>
        </>
      )}
    </div>
  );
}
