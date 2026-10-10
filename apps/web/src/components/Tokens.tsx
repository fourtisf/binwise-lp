import type { TokenRef } from '@binwise/core';

export function Tok({ t }: { t: Pick<TokenRef, 'letter' | 'color'> }) {
  return (
    <span className="tok" style={{ background: t.color }}>
      {t.letter}
    </span>
  );
}

export function PairIcon({ a, b }: { a: Pick<TokenRef, 'letter' | 'color'>; b: Pick<TokenRef, 'letter' | 'color'> }) {
  return (
    <span className="toks">
      <Tok t={a} />
      <Tok t={b} />
    </span>
  );
}
