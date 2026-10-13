'use client';

import { useState } from 'react';
import { BRAND } from '@binwise/core/brand';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';

/**
 * A live vault whose wallet Binwise still holds the key of (from before self-custody): it takes no new money.
 * The owner withdraws to their own wallet, then switches; Binwise deletes the key and the vault works from
 * the owner's wallet from then on.
 */
export function CustodyNotice() {
  const { overview: o, releaseCustody } = useAppData();
  const { openWithdraw } = useUi();
  const [asking, setAsking] = useState(false);
  if (!o || o.mode !== 'live' || o.custody !== 'agent' || o.readOnly) return null;
  return (
    <div className="panel card" id="custodyNotice" style={{ marginBottom: 12 }}>
      <div className="ph" style={{ marginBottom: 0 }}>
        <div>
          <h3>{BRAND} no longer keeps funds for you</h3>
          <p style={{ maxWidth: 640, lineHeight: 1.55 }}>
            Your money now stays in your own wallet, and you approve every change there. This vault&apos;s wallet is from before: it takes no new money.
            Open positions are still looked after until you close them. Withdraw what&apos;s in it to your wallet, then switch.
          </p>
        </div>
      </div>
      {asking ? (
        <div style={{ marginTop: 12 }}>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>
            {BRAND} deletes this vault&apos;s key for good. It only works once the vault wallet is empty (no positions, nothing but dust), so nothing can be
            lost.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button
              className="btn btn-white btn-sm"
              onClick={() => {
                setAsking(false);
                releaseCustody();
              }}
            >
              Yes, switch to my own wallet
            </button>
            <button className="btn btn-dark btn-sm" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="btn btn-white btn-sm" onClick={openWithdraw}>
            <Icon id="i-down" />
            Withdraw to my wallet
          </button>
          <button className="btn btn-dark btn-sm" onClick={() => setAsking(true)}>
            Switch to my own wallet
          </button>
        </div>
      )}
    </div>
  );
}
