'use client';

import { useState } from 'react';
import { TOKEN_CA, TOKEN_TICKER } from '@/lib/site';

/** The token's contract address, in full so it can be checked, with a copy button. */
export function CaPill() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(TOKEN_CA);
    } catch {
      // Older browsers: select the address so it can be copied by hand.
      const r = document.createRange();
      const el = document.getElementById('ca-addr');
      if (el) {
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
    <div className="ca-pill" id="ca">
      <b>{TOKEN_TICKER}</b>
      <code id="ca-addr" title={`${TOKEN_TICKER} contract address`}>
        {TOKEN_CA}
      </code>
      <button type="button" onClick={() => void copy()} aria-label={`Copy the ${TOKEN_TICKER} contract address`}>
        {copied ? 'Copied' : 'Copy CA'}
      </button>
    </div>
  );
}
