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
  CustomRange,
  CycleState,
  Decision,
  LiquidityShape,
  Me,
  PoolRow,
  PositionChart,
  PositionTick,
  PositionView,
  Proposal,
  StrategySettings,
  StreamEvent,
  VaultMode,
  VaultOverview,
} from '@binwise/core';
import { ApiError, getClient, type BinwiseClient, type WalletAction } from './api/client';
import { usd } from './format';
import { LIVE_DEFAULT, WALLET_LOGIN } from './site';
import { useUi } from './ui';
import { PlanStopped, finishPendingPlans, runWalletPlan, walletErrorText, type PlanPhase } from './wallet-plan';
import { SignInError, findWalletFor, installedSolanaWallets, rememberWallet, type Wallet } from './wallets';

type TickFn = (t: PositionTick) => void;

/** Self-custody: an action being carried out in the owner's own wallet, for the progress card. */
export interface WalletTask {
  title: string;
  action: WalletAction;
  wallet: Wallet | null;
  /** find: looking for the signed-in wallet; pick: not found, the owner picks it; then the plan's own phases */
  /** error: `resume`, an Add LP that can finish from what its swaps brought into the wallet */
  phase: PlanPhase | { phase: 'find' } | { phase: 'pick'; wallets: Wallet[] } | { phase: 'error'; message: string; resume?: WalletAction };
}

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
  /** Manual mode: trades waiting for approval */
  proposals: Proposal[];
  approve: (p: Proposal) => void;
  reject: (p: Proposal) => void;
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
  claim: (p: PositionView) => void;
  close: (p: PositionView) => void;
  /** Add LP by hand (override: a pool the agent wouldn't enter; the owner accepted the risk) */
  deploy: (poolId: string, usd: number, override: boolean, opts?: { shape?: LiquidityShape; range?: CustomRange }) => void;
  /** Self-custody: funds and positions stay in the owner's own wallet, which approves every change */
  selfCustody: boolean;
  /** Self-custody: the action running in the owner's wallet, if any */
  walletTask: WalletTask | null;
  /** Self-custody: runs `action` in the owner's wallet (one approval); `wallet`: the one the owner picked. True once recorded. */
  inWallet: (action: WalletAction, title: string, wallet?: Wallet) => Promise<boolean>;
  /** Stops waiting for the wallet (before its approval), or hides the card (after) */
  stopWalletTask: () => void;
  /** A vault wallet from before self-custody, once empty: Binwise deletes its key; the vault then works from the owner's wallet */
  releaseCustody: () => void;
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
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [cycle, setCycle] = useState<CycleState | null>(null);
  const [cycleStart, setCycleStart] = useState(0);
  const [decisionText, setDecisionText] = useState('Waiting for cycle');
  const [draft, setDraft] = useState<StrategySettings | null>(null);
  const [generation, setGeneration] = useState(0);
  const [walletTask, setWalletTask] = useState<WalletTask | null>(null);
  /** Bumped by "Stop waiting": a wallet answer that comes later no longer updates the card. */
  const walletRun = useRef(0);
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
          // A request the agent couldn't carry out (Add LP, Claim, Close): say why now, not only in Activity.
          if (e.decision.type === 'skip' && e.decision.title.startsWith('Couldn')) toast(`${e.decision.title}: ${e.decision.reason}`, 9000);
          // Deploys, exits and rebalances change the position list.
          if (e.decision.type !== 'scan') void reloadPositions(c);
          break;
        case 'proposals':
          void c.proposals().then(setProposals).catch(() => {});
          break;
      }
    },
    [applyCycle, reloadPositions, toast],
  );

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const c = await getClient();
      if (cancelled) return;
      let vaultId = c.vaultId;
      if (c.kind === 'http') {
        const who = await c.me();
        if (cancelled) return;
        setMe(who);
        // Mainnet site: signed-out visitors see no simulated demo vault, only "Connect wallet" (and real pool data).
        vaultId = who?.vaults[0]?.id ?? (LIVE_DEFAULT ? '' : ((await c.demoVaultId()) ?? ''));
        if (!vaultId) {
          setOverview(null);
          setPositions([]);
          setDecisions([]);
          setPools(await c.pools().catch(() => [] as PoolRow[]));
          if (cancelled) return;
          setClient(c);
          setEmpty(true);
          setReady(true);
          return;
        }
        c.useVault(vaultId);
      }
      // Expose the client only once it points at the right vault.
      setClient(c);
      setEmpty(false);
      seriesRef.current.clear();
      off = c.subscribe((e) => onEvent(e, c));
      try {
        const [o, ps, ds, pl, cy, st, pr] = await Promise.all([
          c.overview(),
          c.positions(),
          c.decisions({ exclude: ['hold'] }),
          c.pools(),
          c.cycle(),
          c.strategy(),
          c.proposals().catch(() => [] as Proposal[]),
        ]);
        if (cancelled) return;
        ps.forEach((p) => seriesRef.current.set(p.id, structuredClone(p.chart)));
        setOverview(o);
        setPositions(ps);
        setDecisions(ds);
        setProposals(pr);
        setPools(pl);
        applyCycle(cy);
        if (o.status === 'paused') setDecisionText(o.pausedReason ?? 'Agent paused. Resume to continue.');
        setDraft(st);
        // Self-custody: record what an earlier visit approved in the wallet but didn't get to record.
        if (o.custody === 'wallet' && o.mode === 'live' && !o.readOnly)
          void finishPendingPlans(c).then((titles) => {
            if (cancelled || !titles.length) return;
            titles.forEach((t) => toast(`Recorded: ${t}`, 5000));
            void reloadPositions(c);
          });
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
  }, [onEvent, applyCycle, toast, generation, reloadPositions]);

  const inWallet = useCallback(
    async (action: WalletAction, title: string, picked?: Wallet): Promise<boolean> => {
      if (!client || !me) return false;
      const id = ++walletRun.current;
      const live = () => walletRun.current === id;
      const update = (t: Partial<WalletTask>) => live() && setWalletTask((prev) => (prev ? { ...prev, ...t } : prev));
      setWalletTask({ title, action, wallet: picked ?? null, phase: { phase: 'find' } });
      let name = picked?.name ?? 'your wallet';
      try {
        const all = installedSolanaWallets();
        const w = picked ?? (await findWalletFor(all, me.wallet));
        if (!live()) return false;
        if (!w) {
          update({
            phase: all.length
              ? { phase: 'pick', wallets: all }
              : { phase: 'error', message: 'No Solana wallet found in this browser. Open Binwise where your wallet is installed (Phantom, Solflare, Backpack, Bitget…).' },
          });
          return false;
        }
        if (picked) rememberWallet(picked.name, me.wallet);
        name = w.name;
        update({ wallet: w });
        const r = await runWalletPlan({ client, owner: me.wallet, wallet: w, action, stopped: () => !live(), onPhase: (p) => update({ phase: p }) });
        if (live()) setWalletTask(null);
        toast(r.title, 5000);
        void reloadPositions(client).catch(() => {});
        void client.overview().then(setOverview).catch(() => {});
        if (action.action === 'proposal') void client.proposals().then(setProposals).catch(() => {});
        return true;
      } catch (e) {
        if (e instanceof SignInError && e.kind === 'stopped') return false;
        const message = walletErrorText(e, name);
        // A wallet that failed by itself: maybe not the one signed in with, so offer the others.
        const others = e instanceof SignInError && e.kind === 'wallet' ? installedSolanaWallets() : [];
        const resume = e instanceof PlanStopped ? e.resume : undefined;
        if (live()) update({ phase: others.length > 1 ? { phase: 'pick', wallets: others } : { phase: 'error', message, resume } });
        // The card shows the error itself, except while it offers the other wallets or after "Stop waiting".
        if (others.length > 1 || !live()) toast(message, 9000);
        return false;
      }
    },
    [client, me, toast, reloadPositions],
  );

  const value = useMemo<AppData>(() => {
    const run = <T,>(p: Promise<T> | undefined, ok: (v: T) => void) => p?.then(ok).catch((e) => toast(errorText(e)));
    // Signed out (API mode): no vault of one's own yet, so every action asks to connect a wallet first.
    const canAct = !!overview && !overview.readOnly && (client?.kind !== 'http' || !!me);
    const guard = (fn: () => void) => {
      if (canAct) fn();
      else if (client?.kind === 'http' && !WALLET_LOGIN) toast('Manage your vault in the Binwise Telegram bot (Open Telegram bot, top right).');
      else if (client?.kind === 'http') openConnect();
      else toast('This vault is read-only.');
    };
    const selfCustody = overview?.mode === 'live' && overview.custody === 'wallet';
    return {
      client,
      me,
      ready,
      empty,
      overview,
      selfCustody,
      walletTask,
      inWallet,
      stopWalletTask: () => {
        walletRun.current++;
        setWalletTask(null);
      },
      releaseCustody: () =>
        guard(() =>
          run(client?.releaseCustody(), (o) => {
            setOverview(o);
            toast('Switched: your funds stay in your own wallet now', 5000);
          }),
        ),
      positions,
      decisions,
      proposals,
      approve: (p) => guard(() => selfCustody ? void inWallet({ action: 'proposal', proposalId: p.id }, p.title) : run(client?.approve(p.id), (list) => {
        setProposals(list);
        toast(`Approved: ${p.title}. The agent is on it.`);
      })),
      reject: (p) => guard(() => run(client?.reject(p.id), (list) => {
        setProposals(list);
        toast(`Rejected: ${p.title}`);
      })),
      pools,
      cycle,
      cycleStart,
      decisionText,
      draft,
      setDraft,
      guard,
      reload: () => {
        setClient(null);
        setReady(false);
        setOverview(null);
        setPositions([]);
        setDecisions([]);
        setProposals([]);
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
      claim: (p) =>
        guard(() =>
          selfCustody
            ? void inWallet({ action: 'claim', positionId: p.id }, `Claim fees from ${p.pair}`)
            : run(client?.claim(p.id), (r) => toast(r.queued ? `Claiming fees from ${p.pair}…` : `Claimed ${usd(r.amount ?? 0, 2)} from ${p.pair}`)),
        ),
      close: (p) =>
        guard(() =>
          selfCustody ? void inWallet({ action: 'close', positionId: p.id }, `Close ${p.pair}`) : run(client?.close(p.id), (r) => toast(r.queued ? `Closing ${p.pair}…` : `Closed ${p.pair}`)),
        ),
      deploy: (poolId, amount, override, opts) =>
        guard(() => run(client?.deploy(poolId, amount, override, opts), (r) => toast(`Adding ${amount > 0 ? usd(amount) + ' ' : ''}LP to ${r.pair}… The result shows in Activity.`))),
      series: (id) => seriesRef.current.get(id),
      onTick: (id, fn) => {
        const set = tickFns.current.get(id) ?? new Set<TickFn>();
        set.add(fn);
        tickFns.current.set(id, set);
        return () => set.delete(fn);
      },
    };
  }, [client, me, ready, empty, overview, positions, decisions, proposals, pools, cycle, cycleStart, decisionText, draft, toast, openConnect, openConfirmLive, walletTask, inWallet]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAppData must be used inside AppDataProvider');
  return c;
}
