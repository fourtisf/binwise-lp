'use client';

import { useEffect, useRef, useState } from 'react';
import { fmt, usd } from '@/lib/format';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { Tok } from '../Tokens';

const PROFILE_NAME = { conservative: 'Conservative', balanced: 'Balanced', aggressive: 'Aggressive' } as const;

export function DepositModal() {
  const { layer, closeLayers } = useUi();
  const { overview, draft, deposit } = useAppData();
  const [tok, setTok] = useState('SOL');
  const [amt, setAmt] = useState('10');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const on = layer === 'modal';

  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [on]);

  const assets = overview?.depositAssets ?? [];
  const asset = assets.find((a) => a.symbol === tok);
  const bal = asset?.balance ?? 0;
  const a = parseFloat(amt) || 0;
  const over = a > bal;
  const label = over ? `Not enough ${tok}` : !a ? 'Enter an amount' : `Deposit ${fmt(a, a % 1 ? 2 : 0)} ${tok}`;

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
            <button key={q} onClick={() => setAmt(String(+(bal * +q).toFixed(2)))}>
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
      <button
        className="btn btn-white"
        id="mGo"
        style={{ width: '100%', marginTop: 16 }}
        disabled={!a || over || busy}
        onClick={async () => {
          setBusy(true);
          if (await deposit(tok, a)) closeLayers();
          setBusy(false);
        }}
      >
        {label}
      </button>
    </div>
  );
}
