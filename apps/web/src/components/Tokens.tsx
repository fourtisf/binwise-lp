'use client';

import { useEffect, useMemo, useState } from 'react';
import type { TokenRef } from '@kovra/core';

type TokLike = Pick<TokenRef, 'letter' | 'color'> & Partial<Pick<TokenRef, 'logo' | 'symbol' | 'mint'>>;

/**
 * Where to load a token's logo from, in order: its own URL; the same image through an image cache
 * (IPFS gateways and hotlink-protected hosts often fail in the browser; Jupiter's site does the same);
 * then DexScreener's copy by mint, which has most Solana tokens that trade.
 */
function logoSources(t: TokLike): string[] {
  const out: string[] = [];
  if (t.logo) {
    out.push(t.logo);
    if (/^https?:\/\//.test(t.logo)) out.push(`https://wsrv.nl/?url=${encodeURIComponent(t.logo)}&w=64&h=64&fit=cover`);
  }
  if (t.mint && !t.logo?.startsWith('/')) out.push(`https://dd.dexscreener.com/ds-data/tokens/solana/${t.mint}.png`);
  return out;
}

/** Token badge: the token's logo, or its letter on the token color if no logo source loads. */
export function Tok({ t }: { t: TokLike }) {
  const srcs = useMemo(() => logoSources(t), [t.logo, t.mint]); // eslint-disable-line react-hooks/exhaustive-deps
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [srcs]);
  const logo = srcs[i] ?? null;
  return (
    <span className={`tok${logo ? ' img' : ''}`} style={{ background: t.color }}>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={logo} src={logo} alt={t.symbol ?? ''} loading="lazy" decoding="async" onError={() => setI((n) => n + 1)} />
      ) : (
        t.letter
      )}
    </span>
  );
}

export function PairIcon({ a, b }: { a: TokLike; b: TokLike }) {
  return (
    <span className="toks">
      <Tok t={a} />
      <Tok t={b} />
    </span>
  );
}
