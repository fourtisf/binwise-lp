'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BRAND } from '@kovra/core/brand';
import type { PortfolioShare } from '@kovra/core';
import { SITE_URL, X_HANDLE } from '@/lib/site';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { Switch } from '../Switch';

/** Portfolio: the owner's switch for a public, read-only page of the vault, and its link. */
export function PublicShare({ share, onChange }: { share: PortfolioShare; onChange: (s: PortfolioShare) => void }) {
  const { client } = useAppData();
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const url = share.publicId ? `${SITE_URL.replace(/\/$/, '')}/p/${share.publicId}` : null;

  const set = async (enabled: boolean, showAmounts?: boolean) => {
    if (!client || busy) return;
    setBusy(true);
    try {
      const s = await client.setPublic(enabled, showAmounts);
      onChange(s);
      toast(showAmounts !== undefined ? (s.showAmounts ? 'Dollar amounts shown' : 'Dollar amounts hidden') : s.enabled ? 'Public page is on' : 'Public page is off');
    } catch {
      toast('Could not change the public page. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const copy = () =>
    url &&
    navigator.clipboard
      .writeText(url)
      .then(() => toast('Link copied'))
      .catch(() => toast(url));

  return (
    <div className="panel card" id="pfPublic" style={{ marginTop: 12 }}>
      <div className="ph" style={{ alignItems: 'center', marginBottom: share.enabled ? 16 : 0 }}>
        <div style={{ flex: '1 1 320px' }}>
          <h3>Public portfolio</h3>
          <p>
            Puts your vault on the <Link href="/app/public">Public</Link> list and gives it a read-only page anyone can open, under a made-up name: net vs
            hold, positions and the agent&apos;s moves. Never your wallet address or what else your wallet holds.
          </p>
        </div>
        <Switch label="Public page" checked={share.enabled} onChange={(v) => void set(v)} />
      </div>
      {share.enabled && url && (
        <>
          <div className="rows">
            <div>
              <span>
                Show dollar amounts<small className="rowhint">Off: percentages and counts only, the size stays private</small>
              </span>
              <Switch label="Show dollar amounts" checked={share.showAmounts} onChange={(v) => void set(true, v)} />
            </div>
          </div>
          <div className="pub-link">
            <code title={url}>{url.replace(/^https?:\/\//, '')}</code>
            <div>
              <button className="btn btn-dark btn-sm" onClick={() => void copy()}>
                <Icon id="i-copy" />
                Copy
              </button>
              <a className="btn btn-dark btn-sm" href={url} target="_blank" rel="noreferrer">
                <Icon id="i-ext" />
                Open
              </a>
              <a
                className="btn btn-white btn-sm"
                href={`https://x.com/intent/post?text=${encodeURIComponent(`My ${BRAND} vault, run by an autonomous LP agent on Meteora DLMM.\n\n${url}\n\n${X_HANDLE}`)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Icon id="i-xlogo" />
                Share on X
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
