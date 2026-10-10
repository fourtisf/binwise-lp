'use client';

import { useEffect, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { fmt, usd } from '@/lib/format';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { Tok } from '../Tokens';

/** SOL left in the wallet on a live "Max" so the transfer's network fee can still be paid. */
const SOL_FEE_RESERVE = 0.01;
const PROFILE_NAME = { conservative: 'Conservative', balanced: 'Balanced', aggressive: 'Aggressive' } as const;

export function DepositModal() {
  const { layer, closeLayers, toast } = useUi();
  const { overview, draft, deposit, depositLive, me } = useAppData();
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const live = overview?.mode === 'live';
  const [tok, setTok] = useState('SOL');
  const [amt, setAmt] = useState('10');
  const [busy, setBusy] = useState(false);
  /** Live deposits need an explicit "I understand the risk" every time the modal opens. */
  const [agree, setAgree] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const on = layer === 'modal';

  useEffect(() => {
    if (!on) return;
    setAgree(false);
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [on]);

  const assets = overview?.depositAssets ?? [];
  const asset = assets.find((a) => a.symbol === tok);
  const bal = asset?.balance ?? 0;
  const a = parseFloat(amt) || 0;
  const over = a > bal;
  const walletMismatch = live && (!publicKey || publicKey.toBase58() !== me?.wallet);
  const label = walletMismatch
    ? 'Connect your signed-in wallet'
    : over
      ? `Not enough ${tok}`
      : !a
        ? 'Enter an amount'
        : `Deposit ${fmt(a, a % 1 ? 2 : 0)} ${tok}`;

  return (
    <div className={`modal${on ? ' on' : ''}`} id="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle" aria-hidden={!on}>
      <div className="dh">
        <h3 id="mTitle" style={{ fontSize: 19, letterSpacing: '-.03em' }}>
          Deposit to vault
        </h3>
        <button className="x" onClick={closeLayers} aria-label="Close">
          <Icon id="i-x" />
        </button>
      </div>
      <div className="amt">
        <div className="top">
          <span>Amount</span>
          <span id="mBal">
            Balance {fmt(bal, 2)} {tok}
          </span>
        </div>
        <div className="mid">
          <input id="mAmt" ref={input} inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Amount" />
          <div className="tsel" id="mTok">
            {assets.map((x) => (
              <button
                key={x.symbol}
                aria-pressed={x.symbol === tok}
                onClick={() => {
                  setTok(x.symbol);
                  setAmt(x.symbol === 'SOL' ? '10' : '1000');
                }}
              >
                <Tok t={x} />
                {x.symbol}
              </button>
            ))}
          </div>
        </div>
        <div className="quick">
          {[
            ['.25', '25%'],
            ['.5', '50%'],
            ['1', 'Max'],
          ].map(([q, l]) => (
            <button
              key={q}
              onClick={() => {
                // Round down to the shown precision so "Max" never exceeds the balance.
                const max = live && tok === 'SOL' ? Math.max(0, bal - SOL_FEE_RESERVE) : bal;
                setAmt(String(Math.floor(Math.min(bal * +q, max) * 100) / 100));
              }}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="rows">
        <div>
          <span>Value</span>
          <b className="num" id="mVal">
            {usd(a * (asset?.priceUsd ?? 0), 2)}
          </b>
        </div>
        <div>
          <span>Strategy</span>
          <b id="mStrat">{PROFILE_NAME[draft?.profile ?? 'balanced']}</b>
        </div>
        <div>
          <span>Mode</span>
          <b id="mMode2">{overview?.mode === 'live' ? 'Live, real funds' : 'Paper, simulated funds'}</b>
        </div>
      </div>
      {live && (
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 14, fontSize: 12.5, lineHeight: 1.45, color: 'var(--muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 2, accentColor: '#4BE3CF' }} />
          <span>
            I understand this sends real funds on Solana mainnet to my vault&apos;s agent wallet, which Binwise operates. Liquidity
            positions can lose value and no strategy is guaranteed to profit. Withdrawals only go back to this wallet.
          </span>
        </label>
      )}
      <button
        className="btn btn-white"
        id="mGo"
        style={{ width: '100%', marginTop: 16 }}
        disabled={!a || over || busy || walletMismatch || (live && !agree)}
        onClick={async () => {
          setBusy(true);
          try {
            if (!live) {
              if (await deposit(tok, a)) closeLayers();
              return;
            }
            // Live: your wallet sends the transfer to the vault wallet; the API verifies it on-chain.
            if (!publicKey || !me || publicKey.toBase58() !== me.wallet || !overview?.depositAddress || !asset?.mint) return;
            const to = new PublicKey(overview.depositAddress);
            const tx = new Transaction();
            if (asset.symbol === 'SOL') tx.add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: to, lamports: Math.floor(a * 1e9) }));
            else {
              const mint = new PublicKey(asset.mint);
              const info = await connection.getAccountInfo(mint);
              if (!info) throw new Error(`Couldn't load the ${asset.symbol} token from Solana. Try again.`);
              const programId = info.owner;
              const from = getAssociatedTokenAddressSync(mint, publicKey, false, programId);
              const dest = getAssociatedTokenAddressSync(mint, to, true, programId);
              const decimals = asset.decimals ?? 6;
              tx.add(
                createAssociatedTokenAccountIdempotentInstruction(publicKey, dest, to, mint, programId),
                createTransferCheckedInstruction(from, mint, dest, publicKey, BigInt(Math.floor(a * 10 ** decimals)), decimals, [], programId),
              );
            }
            const sig = await sendTransaction(tx, connection);
            closeLayers();
            await depositLive(sig);
          } catch (e) {
            console.error(e);
            const msg = e instanceof Error ? e.message : '';
            toast(/reject|cancel|denied/i.test(msg) ? 'Deposit cancelled' : msg || 'Deposit failed. Try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {label}
      </button>
    </div>
  );
}
