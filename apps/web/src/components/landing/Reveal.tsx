'use client';

import { useEffect } from 'react';
import { prefersReducedMotion } from '@/lib/format';

const TARGETS = '.kicker, .sec-h, .sec-p, .bento > *, .steps3 > *, .metrics > *, .plans > *, .faq, .final';

/**
 * Landing sections fade up as they scroll into view. Only what starts below the fold is hidden, and only
 * once this runs: without JavaScript, or with reduced motion, everything simply shows.
 */
export function Reveal() {
  useEffect(() => {
    if (prefersReducedMotion() || !('IntersectionObserver' in window)) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>(TARGETS)).filter((el) => el.getBoundingClientRect().top > window.innerHeight);
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add('in');
          io.unobserve(e.target);
        }),
      { rootMargin: '0px 0px -8% 0px' },
    );
    els.forEach((el) => {
      // Cards in one row arrive one after another.
      const i = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
      el.style.setProperty('--d', `${Math.min(i, 5) * 70}ms`);
      el.classList.add('rv');
      io.observe(el);
    });
    return () => io.disconnect();
  }, []);
  return null;
}
