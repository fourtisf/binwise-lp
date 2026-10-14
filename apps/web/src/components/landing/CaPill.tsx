'use client';

import { useState } from 'react';
import { TOKEN_CA } from '@/lib/site';

/**
 * The token's contract address with a copy button; "Coming soon" until there is one. In full by default, so it can
 * be checked; `short` (the nav) shows the first and last 4 characters, and Copy still copies the whole address.
 */
export function CaPill({ id = 'ca', className = '', short = false }: { id?: string; className?: string; short?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!TOKEN_CA)
    return (
      <div className={`ca-pill ${className}`} id={id}>
        <b>CA</b>
        <span className="ca-soon">Coming soon</span>
      </div>
    );
  const ca = TOKEN_CA;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ca);
    } catch {
      // Older browsers: select the address so it can be copied by hand.
      const el = document.getElementById(`${id}-addr`);
      if (el) {
        const r = document.createRange();
        r.selectNodeContents(el);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(r);
      }
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className={`ca-pill ${className}`} id={id}>
      <b>CA</b>
      <code id={`${id}-addr`} title={ca}>
        {short ? `${ca.slice(0, 4)}…${ca.slice(-4)}` : ca}
      </code>
      <button type="button" onClick={() => void copy()} aria-label="Copy the contract address">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
