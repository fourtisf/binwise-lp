'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  CycleState,
  Decision,
  PoolRow,
  PositionChart,
  PositionTick,
  PositionView,
  StrategySettings,
  StreamEvent,
  VaultMode,
  VaultOverview,
} from '@binwise/core';
import { ApiError, getClient, type BinwiseClient } from './api/client';
import { fmt, usd } from './format';
import { useUi } from './ui';

type TickFn = (t: PositionTick) => void;

interface AppData {
  client: BinwiseClient | null;
  overview: VaultOverview | null;
  positions: PositionView[];
  decisions: Decision[];
  pools: PoolRow[];
  cycle: CycleState | null;
  /** performance.now() when the current cycle started, in this browser. */
  cycleStart: number;
  /** Text in the "Decision" box under Agent reasoning. */
  decisionText: string;
  /** Strategy being edited on the Strategy page (unsaved changes survive navigation). */
  draft: StrategySettings | null;
  setDraft: (s: StrategySettings) => void;
  saveStrategy: () => void;
  togglePause: () => void;
  setMode: (m: VaultMode) => void;
  deposit: (token: string, amount: number) => Promise<boolean>;
  claim: (p: PositionView) => void;
  close: (p: PositionView) => void;
  /** Latest price series for a position, for charts that mount later. */
  series: (positionId: string) => PositionChart | undefined;
  onTick: (positionId: string, fn: TickFn) => () => void;
}

const Ctx = createContext<AppData | null>(null);

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** Loads the vault, keeps it live from the stream, and exposes the actions the app needs. */
export function AppDataProvider({ children }: { children: ReactNode }) {
  const { toast } = useUi();
  const [client, setClient] = useState<BinwiseClient | null>(null);
  const [overview, setOverview] = useState<VaultOverview | null>(null);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [cycle, setCycle] = useState<CycleState | null>(null);
  const [cycleStart, setCycleStart] = useState(0);
  const [decisionText, setDecisionText] = useState('Waiting for cycle');
  const [draft, setDraft] = useState<StrategySettings | null>(null);
  const seriesRef = useRef(new Map<string, PositionChart>());
  const tickFns = useRef(new Map<string, Set<TickFn>>());

  const applyCycle = useCallback((c: CycleState) => {
    setCycle(c);
    setCycleStart(performance.now() - c.elapsedMs);
    if (c.paused) setDecisionText('Agent paused. Resume to continue.');
    else if (c.step >= 4 && c.decision) setDecisionText(c.decision.text);
  }, []);

  const onEvent = useCallback(
    (e: StreamEvent) => {
      switch (e.type) {
        case 'tick': {
          const t = e.tick;
          const s = seriesRef.current.get(t.positionId);
          if (s) {
            s.history.push(t.price);
            s.history.shift();
            s.markers = s.markers.map((i) => i - 1).filter((i) => i >= 0);
            if (t.marker) s.markers.push(s.history.length - 1);
            s.lo = t.lo;
            s.hi = t.hi;
          }
          tickFns.current.get(t.positionId)?.forEach((fn) => fn(t));
          setPositions((ps) =>
            ps.map((p) =>
              p.id === t.positionId
                ? { ...p, inRange: t.inRange, fees: t.fees, netVsHold: t.netVsHold, rebalances: t.rebalances }
                : p,
            ),
          );
          break;
        }
        case 'vault':
          setOverview((o) => (o ? { ...o, ...e.vault } : o));
          break;
        case 'cycle':
          applyCycle(e.cycle);
          break;
        case 'decision':
          setDecisions((ds) => (ds.some((d) => d.id === e.decision.id) ? ds : [e.decision, ...ds].slice(0, 60)));
          break;
      }
    },
    [applyCycle],
  );

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    getClient().then(async (c) => {
      if (cancelled) return;
      setClient(c);
      off = c.subscribe(onEvent);
      try {
        const [o, ps, ds, pl, cy, st] = await Promise.all([
          c.overview(),
          c.positions(),
          c.decisions(),
          c.pools(),
          c.cycle(),
          c.strategy(),
        ]);
        if (cancelled) return;
        ps.forEach((p) => seriesRef.current.set(p.id, structuredClone(p.chart)));
        setOverview(o);
        setPositions(ps);
        setDecisions(ds);
        setPools(pl);
        applyCycle(cy);
        setDraft((d) => d ?? st);
      } catch (e) {
        toast(errorText(e));
      }
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [onEvent, applyCycle, toast]);

  const value = useMemo<AppData>(() => {
    const run = <T,>(p: Promise<T> | undefined, ok: (v: T) => void) =>
      p?.then(ok).catch((e) => toast(errorText(e)));
    return {
      client,
      overview,
      positions,
      decisions,
      pools,
      cycle,
      cycleStart,
      decisionText,
      draft,
      setDraft,
      saveStrategy: () =>
        draft &&
        run(client?.saveStrategy(draft), (s) => {
          setDraft(s);
          toast('Strategy saved');
          client?.pools().then(setPools);
        }),
      togglePause: () => {
        const paused = overview?.status === 'paused';
        run(paused ? client?.resume() : client?.pause(), (o) => {
          setOverview(o);
          toast(o.status === 'paused' ? 'Agent paused' : 'Agent resumed');
        });
      },
      setMode: (m) =>
        run(client?.setMode(m), (o) => {
          setOverview(o);
          toast(m === 'live' ? 'Live mode on. Real funds will be used.' : 'Paper mode on. Simulated funds only.');
        }),
      deposit: async (token, amount) => {
        if (!client) return false;
        try {
          setOverview(await client.deposit(token, amount));
          toast(`Deposited ${fmt(amount, 2)} ${token}`);
          return true;
        } catch (e) {
          toast(errorText(e));
          return false;
        }
      },
      claim: (p) => run(client?.claim(p.id), (r) => toast(`Claimed ${usd(r.amount, 2)} from ${p.pair}`)),
      close: (p) => run(client?.close(p.id), () => toast(`Closed ${p.pair}`)),
      series: (id) => seriesRef.current.get(id),
      onTick: (id, fn) => {
        const set = tickFns.current.get(id) ?? new Set<TickFn>();
        set.add(fn);
        tickFns.current.set(id, set);
        return () => set.delete(fn);
      },
    };
  }, [client, overview, positions, decisions, pools, cycle, cycleStart, decisionText, draft, toast]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAppData must be used inside AppDataProvider');
  return c;
}
