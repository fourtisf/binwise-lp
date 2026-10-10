'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { clamp, prefersReducedMotion } from '@/lib/format';

/** The tilted 3D product window that flattens as you scroll. */
export function Stage({ children }: { children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const win = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reduce = prefersReducedMotion();
    const on = () => {
      if (reduce || window.innerWidth <= 640 || !stage.current || !win.current) return;
      const r = stage.current.getBoundingClientRect();
      const t = clamp(1 - (r.top - window.innerHeight * 0.18) / (window.innerHeight * 0.55), 0, 1);
      win.current.style.setProperty('--tilt', (22 * (1 - t)).toFixed(2) + 'deg');
      win.current.style.setProperty('--sc', (0.94 + 0.06 * t).toFixed(3));
    };
    on();
    let rt: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(rt);
      rt = setTimeout(on, 150);
    };
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return (
    <div className="stage" id="stage" ref={stage}>
      <div className="window" id="window" ref={win}>
        {children}
      </div>
    </div>
  );
}
