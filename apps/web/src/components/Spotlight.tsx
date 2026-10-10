'use client';

import { useEffect } from 'react';

/** Moves the hover glow on `.spot` cards to follow the pointer. */
export function Spotlight() {
  useEffect(() => {
    const on = (e: PointerEvent) => {
      const c = (e.target as Element | null)?.closest?.('.spot') as HTMLElement | null;
      if (!c) return;
      const r = c.getBoundingClientRect();
      c.style.setProperty('--mx', e.clientX - r.left + 'px');
      c.style.setProperty('--my', e.clientY - r.top + 'px');
    };
    document.addEventListener('pointermove', on, { passive: true });
    return () => document.removeEventListener('pointermove', on);
  }, []);
  return null;
}
