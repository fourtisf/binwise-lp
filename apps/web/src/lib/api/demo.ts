import type { DemoEvent, DemoPair } from '@binwise/core';
import { getClient } from './client';

export interface DemoSource {
  pairs: DemoPair[];
  /** Pair for the small chart in the "Stays in range" card */
  bentoId: string;
  subscribe: (pairId: string, fn: (e: DemoEvent) => void) => () => void;
}

let source: Promise<DemoSource> | null = null;

/**
 * Landing page window: the public demo vault's live positions when the API has them,
 * otherwise the in-browser simulation (same look, clearly a demo).
 */
export function getDemoSource(): Promise<DemoSource> {
  source ??= (async () => {
    const client = await getClient();
    const pairs = await client.demoPairs();
    if (client.kind === 'http' && pairs.length) return { pairs, bentoId: pairs[0].id, subscribe: client.demo };
    const { startDemo } = await import('@binwise/mock');
    const { MOCK_DEMO_PAIRS } = await import('./mock');
    return { pairs: MOCK_DEMO_PAIRS, bentoId: 'bento', subscribe: (id, fn) => startDemo(id, fn) };
  })();
  return source;
}
