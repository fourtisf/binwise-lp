'use client';

import { BRAND } from '@kovra/core/brand';
import { useAppData } from '@/lib/store';
import { WalletWaiting } from './WalletWait';

const link = { fontSize: 12.5, color: 'var(--accent-hi)', textDecoration: 'underline' } as const;

/**
 * Self-custody: the action running in the owner's own wallet (Add LP, close, claim, an approved proposal),
 * from finding the wallet to Solana confirming each step. One card for the whole app, bottom right.
 */
export function WalletTaskCard() {
  const { walletTask: t, inWallet, stopWalletTask, me } = useAppData();
  if (!t) return null;
  const p = t.phase;
  const steps = (n: number) => (n === 1 ? 'One transaction' : `${n} transactions`);
  return (
    <div className="wtask" role="dialog" aria-label={t.title}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
        <b style={{ fontWeight: 500, fontSize: 14 }}>{t.title}</b>
        {(p.phase === 'error' || p.phase === 'pick') && (
          <button className="muted" style={{ fontSize: 12.5 }} onClick={stopWalletTask} aria-label="Close">
            Close
          </button>
        )}
      </div>

      {(p.phase === 'find' || p.phase === 'prepare') && (
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 8 }}>
          {p.phase === 'find' ? 'Finding your wallet…' : 'Preparing the transactions for your wallet…'}{' '}
          <button style={link} onClick={stopWalletTask}>
            Cancel
          </button>
        </p>
      )}

      {p.phase === 'pick' && me && (
        <>
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 8 }}>
            Which wallet did you sign in with ({me.wallet.slice(0, 4)}…{me.wallet.slice(-4)})? {BRAND} remembers it.
          </p>
          <div className="seg" style={{ display: 'flex', flexWrap: 'wrap', width: '100%', marginTop: 8 }} role="group" aria-label="Wallet to approve in">
            {p.wallets.map((w) => (
              <button
                key={w.name}
                style={{ flex: 1, padding: '6px 8px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap' }}
                onClick={() => void inWallet(t.action, t.title, w)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {w.icon && <img src={w.icon} alt="" style={{ width: 16, height: 16, borderRadius: 4 }} />}
                {w.name}
              </button>
            ))}
          </div>
        </>
      )}

      {p.phase === 'approve' && t.wallet && (
        <WalletWaiting
          key="approve"
          wallet={t.wallet}
          what={
            p.signed
              ? `Approved ${p.signed} of ${p.steps}. ${t.wallet.name} asks once per transaction: approve the next one (${p.signed + 1} of ${p.steps}). Nothing is sent until all are approved.`
              : `${p.summary.join(' ')} ${steps(p.steps)}${p.steps > 1 ? ' (some wallets ask once for each)' : ''}. Nothing moves until you approve, and everything stays in your wallet.`
          }
          onStop={stopWalletTask}
        />
      )}

      {(p.phase === 'send' || p.phase === 'record') && t.wallet && (
        <WalletWaiting
          key="send"
          wallet={t.wallet}
          confirming
          what={p.phase === 'send' ? `Step ${p.step} of ${p.steps}: ${p.label}.` : 'Landed on Solana. Recording it…'}
          onStop={stopWalletTask}
        />
      )}

      {p.phase === 'error' && (
        <p className="down" style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 8, whiteSpace: 'pre-line' }}>
          {p.message}
        </p>
      )}
      {p.phase === 'error' && p.resume && (
        <button className="btn btn-white btn-sm" style={{ width: '100%', marginTop: 10 }} onClick={() => void inWallet(p.resume!, t.title, t.wallet ?? undefined)}>
          Finish the LP with the tokens in my wallet
        </button>
      )}
    </div>
  );
}
