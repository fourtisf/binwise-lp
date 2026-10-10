'use client';

import { useState } from 'react';
import type { TokenRef } from '@binwise/core';

type TokLike = Pick<TokenRef, 'letter' | 'color'> & Partial<Pick<TokenRef, 'logo' | 'symbol'>>;

/** Token badge: the token's logo, or its letter on the token color if there's no logo or it fails to load. */
export function Tok({ t }: { t: TokLike }) {
  const [broken, setBroken] = useState(false);
  const logo = t.logo && !broken ? t.logo : null;
  return (
    <span className={`tok${logo ? ' img' : ''}`} style={{ background: t.color }}>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt={t.symbol ?? ''} loading="lazy" decoding="async" onError={() => setBroken(true)} />
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
