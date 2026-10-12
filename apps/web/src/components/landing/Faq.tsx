'use client';

import { useState } from 'react';
import { LIVE_DEFAULT } from '@/lib/site';

const FAQ: [string, string][] = [
  [
    'Does Binwise hold my funds?',
    'No. In live mode each vault is a wallet only you can withdraw from. The agent can add or remove liquidity and swap to rebalance, but it can never send funds anywhere except back to you.',
  ],
  [
    'Is profit guaranteed?',
    `No. No strategy is. Binwise is built to beat holding the same tokens by picking high-fee pools, avoiding downtrends and not over-trading. ${
      LIVE_DEFAULT
        ? 'Every number is shown against holding, so you can start small and judge it on real results.'
        : 'That is why paper mode exists: you see the real numbers before risking anything.'
    }`,
  ],
  [
    'What happens in a crash?',
    'Your downtrend rule and daily loss stop take over. The agent exits pools whose trend breaks your limit, and pauses everything if the vault drops past your daily stop.',
  ],
  [
    'Which pools does it farm?',
    'Meteora DLMM pools on Solana that pass your filters: minimum liquidity, minimum market cap and a holder safety check. You can see every pool it tracks and why in the Pools tab.',
  ],
  [
    'How is the fee charged?',
    "Pro takes 10% of profit above what holding would have earned, settled monthly. If the vault doesn't beat holding that month, you pay nothing.",
  ],
];

export function Faq() {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <div className="faq" style={{ textAlign: 'left' }} id="faqList">
      {FAQ.map(([q, a], i) => (
        // `open` is a custom attribute here, matching the prototype's CSS ([open]).
        <div className="q" key={q} {...(open.has(i) ? { open: true } : {})}>
          <button aria-expanded={open.has(i)} onClick={() => toggle(i)}>
            {q}
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          <div className="a">
            <div>
              <p>{a}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
