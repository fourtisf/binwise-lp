import type { Redis } from 'ioredis';
import type { CycleState, StreamEvent } from '@binwise/core';

const PREFIX = 'binwise:events:';

/**
 * Fans agent events from Redis pub/sub out to WebSocket clients and keeps the
 * latest cycle state per vault for clients that connect mid-cycle.
 */
export class EventHub {
  private listeners = new Map<string, Set<(e: StreamEvent) => void>>();
  private lastCycle = new Map<string, { cycle: CycleState; at: number }>();

  constructor(private sub: Redis) {}

  async start() {
    await this.sub.psubscribe(`${PREFIX}*`);
    this.sub.on('pmessage', (_p, channel, raw) => {
      const vaultId = channel.slice(PREFIX.length);
      let e: StreamEvent;
      try {
        e = JSON.parse(raw) as StreamEvent;
      } catch {
        return;
      }
      if (e.type === 'cycle') this.lastCycle.set(vaultId, { cycle: e.cycle, at: Date.now() });
      this.listeners.get(vaultId)?.forEach((fn) => fn(e));
    });
  }

  on(vaultId: string, fn: (e: StreamEvent) => void): () => void {
    const set = this.listeners.get(vaultId) ?? new Set();
    set.add(fn);
    this.listeners.set(vaultId, set);
    return () => set.delete(fn);
  }

  cycle(vaultId: string, intervalMs: number, paused: boolean): CycleState {
    const c = this.lastCycle.get(vaultId);
    if (!c || paused) return { cycle: c?.cycle.cycle ?? 0, step: -1, paused, intervalMs, elapsedMs: 0, steps: c?.cycle.steps ?? [] };
    return { ...c.cycle, elapsedMs: c.cycle.elapsedMs + (Date.now() - c.at) };
  }

  async stop() {
    await this.sub.quit();
  }
}
