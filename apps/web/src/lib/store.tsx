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
  Me,
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
  /** Signed-in user (API mode only) */
  me: Me | null;
  /** True once we know which vault is shown */
  ready: boolean;
  /** No vault to show (API mode, signed out, no demo vault yet) */
  empty: boolean;
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
  setMode: (m: VaultMode, confirm?: boolean) => void;
  deposit: (token: string, amount: number) => Promise<boolean>;
  depositLive: (signature: string) => Promise<boolean>;
  claim: (p: PositionView) => void;
  close: (p: PositionView) => void;
  /** Re-reads who is signed in and which vault to show */
  reload: () => void;
  /** Runs `fn` only for a signed-in owner; otherwise asks to connect a wallet. */
  guard: (fn: () => void) => void;
  /** Latest price series for a position, for charts that mount later. */
  series: (positionId: string) => PositionChart | undefined;
  onTick: (positionId: string, fn: TickFn) => () => void;
}

const Ctx = createContext<AppData | null>(null);

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

/** Loads the vault, keeps it live from the stream, and exposes the actions the app needs. */
export function AppDataProvider({ children }: { children: ReactNode }) {
  const { toast, openConnect, openConfirmLive } = useUi();
  const [client, setClient] = useState<BinwiseClient | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [overview, setOverview] = useState<VaultOverview | null>(null);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [cycle, setCycle] = useState<CycleState | null>(null);
  const [cycleStart, setCycleStart] = useState(0);
  const [decisionText, setDecisionText] = useState('Waiting for cycle');
  const [draft, setDraft] = useState<StrategySettings | null>(null);
  const [generation, setGeneration] = useState(0);
  const seriesRef = useRef(new Map<string, PositionChart>());
  const tickFns = useRef(new Map<string, Set<TickFn>>());

  const applyCycle = useCallback((c: CycleState) => {
    setCycle(c);
    setCycleStart(performance.now() - c.elapsedMs);
    if (c.paused) setDecisionText('Agent paused. Resume to continue.');
    else if (c.step >= 4 && c.decision) setDecisionText(c.decision.text);
  }, []);

  const reloadPositions = useCallback(async (c: BinwiseClient) => {
    const ps = await c.positions();
    ps.forEach((p) => seriesRef.current.set(p.id, structuredClone(p.chart)));
    setPositions(ps);
  }, []);

  const onEvent = useCallback(
    (e: StreamEvent, c: BinwiseClient) => {
      switch (e.type) {
        case 'tick': {
          const t = e.tick;
          const s = seriesRef.current.get(t.positionId);
          if (!s) {
            // A position we don't know yet (just deployed): fetch the list again.
            void reloadPositions(c);
            break;
          }
          s.history.push(t.price);
          s.history.shift();
          s.markers = s.markers.map((i) => i - 1).filter((i) => i >= 0);
          if (t.marker) s.markers.push(s.history.length - 1);
          s.lo = t.lo;
          s.hi = t.hi;
          tickFns.current.get(t.positionId)?.forEach((fn) => fn(t));
          setPositions((ps) =>
            ps.map((p) =>
              p.id === t.positionId ? { ...p, inRange: t.inRange, fees: t.fees, netVsHold: t.netVsHold, rebalances: t.rebalances } : p,
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
          // Deploys, exits and rebalances change the position list.
          if (e.decision.type !== 'scan') void reloadPositions(c);
          break;
      }
    },
    [applyCycle, reloadPositions],
  );

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const c = await getClient();
      if (cancelled) return;
      setClient(c);
      let vaultId = c.vaultId;
      if (c.kind === 'http') {
        const who = await c.me();
        if (cancelled) return;
        setMe(who);
        vaultId = who?.vaults[0]?.id ?? (await c.demoVaultId()) ?? '';
        if (!vaultId) {
          setEmpty(true);
          setReady(true);
          return;
        }
        c.useVault(vaultId);
      }
      setEmpty(false);
      seriesRef.current.clear();
      off = c.subscribe((e) => onEvent(e, c));
      try {
        const [o, ps, ds, pl, cy, st] = await Promise.all([
          c.overview(),
          c.positions(),
          c.decisions({ exclude: ['hold'] }),
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
        if (o.status === 'paused') setDecisionText(o.pausedReason ?? 'Agent paused. Resume to continue.');
        setDraft(st);
      } catch (e) {
        toast(errorText(e));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, [onEvent, applyCycle, toast, generation]);

  const value = useMemo<AppData>(() => {
    const run = <T,>(p: Promise<T> | undefined, ok: (v: T) => void) => p?.then(ok).catch((e) => toast(errorText(e)));
    const canAct = !overview?.readOnly;
    const guard = (fn: () => void) => {
      if (canAct) fn();
      else if (client?.kind === 'http') openConnect();
      else toast('This vault is read-only.');
    };
    return {
      client,
      me,
      ready,
      empty,
      overview,
      positions,
      decisions,
      pools,
      cycle,
      cycleStart,
      decisionText,
      draft,
      setDraft,
      guard,
      reload: () => {
        setReady(false);
        setOverview(null);
        setPositions([]);
        setDecisions([]);
        setGeneration((g) => g + 1);
      },
      saveStrategy: () =>
        guard(
          () =>
            draft &&
            run(client?.saveStrategy(draft), (s) => {
              setDraft(s);
              toast('Strategy saved');
              client?.pools().then(setPools);
            }),
        ),
      togglePause: () =>
        guard(() => {
          const paused = overview?.status === 'paused';
          run(paused ? client?.resume() : client?.pause(), (o) => {
            setOverview(o);
            if (o.status === 'paused') setDecisionText(o.pausedReason ?? 'Agent paused. Resume to continue.');
            toast(o.status === 'paused' ? 'Agent paused' : 'Agent resumed');
          });
        }),
      setMode: (m, confirm) =>
        guard(() => {
          // Real API: going live needs an explicit confirmation first.
          if (m === 'live' && client?.kind === 'http' && !confirm && overview?.mode !== 'live') {
            openConfirmLive();
            return;
          }
          run(client?.setMode(m, confirm), (o) => {
            setOverview(o);
            toast(m === 'live' ? 'Live mode on. Real funds will be used.' : 'Paper mode on. Simulated funds only.');
          });
        }),
      deposit: async (token, amount) => {
        if (!canAct || !client) {
          guard(() => {});
          return false;
        }
        try {
          setOverview(await client.deposit(token, amount));
          toast(`Deposited ${fmt(amount, 2)} ${token}`);
          return true;
        } catch (e) {
          toast(errorText(e));
          return false;
        }
      },
      depositLive: async (signature) => {
        if (!client) return false;
        // The API verifies the transfer on-chain; give it a few tries while it confirms.
        for (let i = 0; i < 10; i++) {
          try {
            setOverview(await client.depositLive(signature));
            toast('Deposit received');
            return true;
          } catch (e) {
            if (!(e instanceof ApiError) || e.code !== 'tx_not_found') {
              toast(errorText(e));
              return false;
            }
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
        toast('Deposit sent. It will show up once it confirms.');
        return false;
      },
      claim: (p) =>
        guard(() =>
          run(client?.claim(p.id), (r) => toast(r.queued ? `Claiming fees from ${p.pair}…` : `Claimed ${usd(r.amount ?? 0, 2)} from ${p.pair}`)),
        ),
      close: (p) => guard(() => run(client?.close(p.id), (r) => toast(r.queued ? `Closing ${p.pair}…` : `Closed ${p.pair}`))),
      series: (id) => seriesRef.current.get(id),
      onTick: (id, fn) => {
        const set = tickFns.current.get(id) ?? new Set<TickFn>();
        set.add(fn);
        tickFns.current.set(id, set);
        return () => set.delete(fn);
      },
    };
  }, [client, me, ready, empty, overview, positions, decisions, pools, cycle, cycleStart, decisionText, draft, toast, openConnect, openConfirmLive]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAppData must be used inside AppDataProvider');
  return c;
}
