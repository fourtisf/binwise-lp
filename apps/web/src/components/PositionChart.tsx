'use client';

import { useEffect, useRef } from 'react';
import type { LiquidityShape } from '@kovra/core';
import { LiveChart } from '@/lib/charts/LiveChart';
import { useAppData } from '@/lib/store';

/** Live chart for one vault position, fed by the stream. */
export function PositionChart({
  positionId,
  className,
  id,
  bins,
  compact,
  shape,
}: {
  positionId: string;
  className: string;
  id?: string;
  bins: number;
  compact?: boolean;
  shape: LiquidityShape;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { series, onTick } = useAppData();

  useEffect(() => {
    const s = series(positionId);
    if (!ref.current || !s) return;
    const chart = new LiveChart(ref.current, { bins, compact, shape });
    chart.load(s);
    const off = onTick(positionId, (t) => chart.push(t.price, t.lo, t.hi, t.marker));
    return () => {
      off();
      chart.destroy();
    };
    // series/onTick are stable lookups; re-create only when the position changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionId, bins, compact, shape, !!series(positionId)]);

  return <div className={className} id={id} ref={ref} />;
}
