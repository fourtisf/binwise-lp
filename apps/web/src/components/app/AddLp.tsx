'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  binIdForPrice,
  binPrice,
  composition,
  customRangeError,
  openPosition,
  rangeFromPrices,
  type CustomRange,
  type LiquidityShape,
  type PoolDetail,
  type VaultBalance,
} from '@binwise/core';
import { ApiError } from '@/lib/api/client';
import { usd } from '@/lib/format';
import { BOT_URL } from '@/lib/site';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { SignInError, sendWithWallet, walletFor } from '@/lib/wallets';
import { Icon } from '../Sprite';
import { Tok } from '../Tokens';
import { LpRecommend, RecDot } from './LpRecommend';
import { LpShape } from './LpShape';
import { useSolanaWallets } from './Wallet';

/** Why Add LP can't put more into this pool (VaultBalance.pool.limit), in plain words. */
const LIMIT_TEXT: Record<NonNullable<VaultBalance['pool']>['limit'], string> = {
  balance: 'Limited by the idle funds in your vault.',
  pool: 'Limited by the pool: never more than 2% of its liquidity.',
  cap: 'Limited by your max per position (Strategy).',
  live: 'Limited by the live trading limits for now.',
  positions: 'Live vaults can hold a limited number of positions for now. Close one in Positions first.',
  held: 'You already have a position in this pool.',
};

const SHAPE_NAME: Record<LiquidityShape, string> = { spot: 'Spot', curve: 'Curve', bidask: 'Bid-Ask' };
const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** SOL the vault wallet keeps for network fees and rent (the agent's SOL_RESERVE). */
const VAULT_RESERVE_SOL = 0.25;
/** SOL left in the owner's wallet for the transfer's own fee. */
const WALLET_FEE_SOL = 0.005;

type Side = 'both' | 'x' | 'y';
/** One Jupiter swap the vault makes before adding liquidity */
type Swap = { from: string; fromMint: string; to: string; toMint: string; usd: number };
/** 'agent': the agent's own width; a number: ±% around the price; 'max': the widest one position holds. */
type RangeMode = 'agent' | number | 'max' | 'custom';
/** Bins each side the widest position holds (69 bins in all). */
const MAX_EACH_SIDE = 34;
const PRESET_PCTS = [1, 2, 5, 10, 25, 50];

/** Token amounts: more decimals for small ones (0.0421 SOL, 12.50 USDC, 1,250 BONK). */
const amount = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: n >= 1000 ? 0 : 2, maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 4 });
/** Prices from 0.00001234 to 152,310: enough significant digits to tell bins apart. */
const price = (n: number) => (n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Number(n.toPrecision(6))));
const pctFrom = (p: number, ref: number) => `${p >= ref ? '+' : '−'}${Math.abs((p / ref - 1) * 100).toFixed(1)}%`;
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const label = { display: 'block', fontSize: 12.5, color: 'var(--muted)', margin: '16px 0 7px' } as const;
const segFull = { display: 'flex', width: '100%' } as const;
const segBtn = { flex: 1, padding: '6px 4px' } as const;

/**
 * Add LP by hand, in the pool drawer: the vault's balance and limits, moving SOL in from the owner's own
 * wallet, the strategy shape, which token(s) to deposit, the price range, and the swaps the vault will
 * make first. With every option on "Agent", the agent decides all of it, as before.
 */
export function AddLp({ pool: x, active }: { pool: PoolDetail; active: boolean }) {
  const { client, me, overview, positions, deploy } = useAppData();
  const { toast } = useUi();
  const wallets = useSolanaWallets();
  const [amt, setAmt] = useState('');
  const [risk, setRisk] = useState(false);
  const [bal, setBal] = useState<VaultBalance | null>(null);
  const [balErr, setBalErr] = useState(false);
  const [shape, setShape] = useState<'agent' | LiquidityShape>('agent');
  const [side, setSide] = useState<Side>('both');
  const [mode, setMode] = useState<RangeMode>('agent');
  const [minS, setMinS] = useState('');
  const [maxS, setMaxS] = useState('');
  const [moveS, setMoveS] = useState('');
  /** SOL from the owner's wallet to pay for this LP with (empty vault): moved in, swapped, added in one go */
  const [payS, setPayS] = useState('');
  const [moving, setMoving] = useState(false);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // A new pool starts on the recommendation; the side is set once its Add LP data arrives.
  const hasLp = !!x.lp;
  useEffect(() => {
    setAmt('');
    setRisk(false);
    setBal(null);
    setBalErr(false);
    setShape('agent');
    setSide(x.lp?.side ?? 'both');
    setMode('agent');
    setMoveS('');
    setPayS('');
    setMoveErr(null);
    // Not on every refresh of the recommended side: that would undo the user's own choice mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x.id, hasLp]);

  // The vault's idle funds and the most Add LP puts into this pool: on open, every 20s, when positions change, after a move.
  useEffect(() => {
    if (!active || !client) return;
    let live = true;
    const load = () =>
      client
        .balance(x.id)
        .then((b) => {
          if (!live) return;
          setBal(b);
          setBalErr(false);
        })
        .catch(() => live && setBalErr(true));
    void load();
    const t = setInterval(load, 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [active, client, x.id, positions.length, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  const lp = x.lp;
  // The agent's own side here; null (a downtrend) leaves "Both tokens" as the starting point.
  const recSide: Side = lp?.side ?? 'both';
  const want = Number(amt) || 0;
  const lim = bal?.pool;
  const symA = x.tokenA.symbol;
  const symB = x.tokenB.symbol;

  // ---- range: bins below / above the price, from the side and the preset or the typed prices
  const range: CustomRange | null = useMemo(() => {
    if (!lp) return null;
    if (mode === 'agent' || mode === 'max') {
      const n = mode === 'max' ? MAX_EACH_SIDE : lp.binsEachSide;
      return side === 'both' ? { below: n, above: n } : side === 'x' ? { below: 0, above: 2 * n } : { below: 2 * n, above: 0 };
    }
    if (mode === 'custom') {
      const lo = Number(minS);
      const hi = Number(maxS);
      const okLo = side === 'x' || (lo > 0 && lo < lp.price);
      const okHi = side === 'y' || hi > lp.price;
      if (!okLo || !okHi) return null;
      const r = rangeFromPrices(lp.price, lp.binStep, side === 'x' ? lp.price : lo, side === 'y' ? lp.price : hi, side);
      return { below: r.below, above: r.above };
    }
    const r = rangeFromPrices(lp.price, lp.binStep, lp.price * (1 - mode / 100), lp.price * (1 + mode / 100), side);
    return { below: r.below, above: r.above };
  }, [lp, mode, side, minS, maxS]);
  const active0 = lp ? binIdForPrice(lp.price, lp.binStep) : 0;
  const rangeLo = lp && range ? binPrice(active0 - range.below, lp.binStep) : 0;
  const rangeHi = lp && range ? binPrice(active0 + range.above + 1, lp.binStep) : 0;
  const rangeErr = range ? customRangeError(range) : mode === 'custom' ? `Enter a min price below and a max price above the current ${price(lp?.price ?? 0)}.` : null;
  const maxPct = lp ? ((binPrice(MAX_EACH_SIDE, lp.binStep) - 1) * 100).toFixed(1) : '';
  // The range the shape picture draws: the chosen one, or the agent's width while a typed range is incomplete.
  const agentRange: CustomRange | null = !lp
    ? null
    : side === 'both'
      ? { below: lp.binsEachSide, above: lp.binsEachSide }
      : side === 'x'
        ? { below: 0, above: 2 * lp.binsEachSide }
        : { below: 2 * lp.binsEachSide, above: 0 };
  const drawn = lp && range && range.below + range.above + 1 <= 2 * lp.maxBins ? range : agentRange;
  // ±% presets that fit one position at this pool's bin step (narrow steps can't go wide), plus Max when few do.
  const presets: RangeMode[] = useMemo(() => {
    if (!lp) return [];
    // The side below the price needs more bins for the same % (−p% is further in bins than +p%).
    const fit = PRESET_PCTS.filter((p) => p < 100 && -Math.log(1 - p / 100) / Math.log(1 + lp.binStep / 10_000) < MAX_EACH_SIDE);
    return [...fit.slice(-3), ...(fit.length < 3 ? (['max'] as RangeMode[]) : [])];
  }, [lp]);

  const pickMode = (m: RangeMode) => {
    // Switching to Custom starts from the range on screen.
    if (m === 'custom' && lp && range) {
      setMinS(side === 'x' ? price(lp.price) : price(rangeLo));
      setMaxS(side === 'y' ? price(lp.price) : price(rangeHi));
    }
    setMode(m);
  };

  // Options are sent only when changed: with everything on "Agent", the agent picks (and may go one-sided in a trend).
  const custom = side !== recSide || mode !== 'agent';
  // What the agent itself would do here, and whether the form is on it.
  const recRange: CustomRange | null = !lp
    ? null
    : recSide === 'both'
      ? { below: lp.binsEachSide, above: lp.binsEachSide }
      : recSide === 'x'
        ? { below: 0, above: 2 * lp.binsEachSide }
        : { below: 2 * lp.binsEachSide, above: 0 };
  const onRec = !!lp && lp.side !== null && (shape === 'agent' || shape === lp.shape) && side === recSide && mode === 'agent';
  const recWidth = !lp
    ? ''
    : recSide === 'both'
      ? `±${((binPrice(lp.binsEachSide, lp.binStep) - 1) * 100).toFixed(1)}%`
      : recSide === 'x'
        ? `+${((binPrice(2 * lp.binsEachSide + 1, lp.binStep) - 1) * 100).toFixed(1)}%`
        : `−${((1 - binPrice(-2 * lp.binsEachSide, lp.binStep)) * 100).toFixed(1)}%`;
  const sideName = (k: Side) => (k === 'both' ? 'Both tokens' : k === 'x' ? `Only ${symA}` : `Only ${symB}`);
  /** Under each row of options: what the agent would pick here, ticked when chosen, else one click to use it. */
  const recHint = (text: string, on: boolean, pick: () => void) => (
    <p className="rechint" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 12.5, marginTop: 7, color: 'var(--muted)' }}>
      <RecDot />
      Recommended here: <b style={{ color: 'var(--text)', fontWeight: 500 }}>{text}</b>
      {on ? (
        <span className="up">✓</span>
      ) : (
        <button style={{ fontSize: 12.5, color: 'var(--aqua)', textDecoration: 'underline' }} onClick={pick}>
          Use it
        </button>
      )}
    </p>
  );
  const useRec = () => {
    setShape('agent');
    setSide(recSide);
    setMode('agent');
  };
  const opts = { ...(shape !== 'agent' ? { shape } : {}), ...(custom && range ? { range } : {}) };

  // ---- limits
  const blocked = !!lim && lim.maxUsd < lim.minUsd;
  const hardBlocked = !!lim && (lim.limit === 'held' || lim.limit === 'positions');
  const tooSmall = !!lim && want > 0 && want < lim.minUsd;
  const over = !!lim && !blocked && want > lim.maxUsd;

  // ---- swaps the vault makes first: what the range needs of each token, from what sits idle (largest first)
  const plannedUsd = want > 0 ? Math.min(want, lim?.maxUsd ?? want) : (lim?.maxUsd ?? 0);
  /** Share of the position's value in token A at today's price, for this shape and range. */
  const shareA = useMemo(() => {
    if (!lp || !range || rangeErr) return null;
    const c = composition(openPosition(1000, lp.price, lp.binStep, 0, shape === 'agent' ? lp.shape : shape, 'both', range), lp.price);
    return (c.x * lp.price) / (c.x * lp.price + c.y || 1);
  }, [lp, range, rangeErr, shape]);
  const mintA = x.tokenA.mint ?? symA;
  const mintB = x.tokenB.mint ?? symB;
  const swaps = useMemo(() => {
    if (shareA == null || !bal || plannedUsd < 1) return null;
    const need: Record<string, number> = { [mintA]: plannedUsd * shareA, [mintB]: plannedUsd * (1 - shareA) };
    const idle = Object.fromEntries(bal.assets.map((a) => [a.mint, a.usd]));
    const symbolOf = (m: string) => bal.assets.find((a) => a.mint === m)?.symbol ?? (m === mintA ? symA : m === mintB ? symB : m.slice(0, 4));
    const out: Swap[] = [];
    let short = 0;
    for (const [target, sym] of [
      [mintA, symA],
      [mintB, symB],
    ] as const) {
      let missing = need[target] - (idle[target] ?? 0);
      if (missing <= Math.max(1, need[target] * 0.02)) continue;
      const otherPool = target === mintA ? mintB : mintA;
      const sources = bal.assets.filter((a) => a.mint !== target && a.mint !== otherPool).sort((p, q) => q.usd - p.usd);
      for (const src of sources) {
        if (missing <= 1) break;
        const take = Math.min(idle[src.mint] ?? 0, missing);
        if (take < 1) continue;
        out.push({ from: src.symbol, fromMint: src.mint, to: sym, toMint: target, usd: take });
        idle[src.mint] = (idle[src.mint] ?? 0) - take;
        missing -= take;
      }
      // Then the other pool token, beyond what the position needs of it.
      const spare = (idle[otherPool] ?? 0) - need[otherPool];
      if (missing > 1 && spare > 1) {
        const take = Math.min(spare, missing);
        out.push({ from: symbolOf(otherPool), fromMint: otherPool, to: sym, toMint: target, usd: take });
        idle[otherPool] = (idle[otherPool] ?? 0) - take;
        missing -= take;
      }
      if (missing > 1) short += missing;
    }
    return { out, short };
  }, [shareA, bal, plannedUsd, mintA, mintB, symA, symB]);
  // An empty vault: what the SOL moved in becomes, for the amount typed (a pool token that is SOL needs no swap).
  const emptyVault = !!bal && bal.availableUsd < 1;
  const solSwaps: Swap[] =
    emptyVault && shareA != null && want > 0
      ? (
          [
            [mintA, symA, want * shareA],
            [mintB, symB, want * (1 - shareA)],
          ] as const
        )
          .filter(([m, , u]) => m !== SOL_MINT && u >= 1)
          .map(([m, sym, u]) => ({ from: 'SOL', fromMint: SOL_MINT, to: sym, toMint: m, usd: u }))
      : [];

  /** Logo and letter for a token in a swap row: the pool's own tokens, SOL, or an idle token by mint. */
  const tokenOf = (mint: string, symbol: string) =>
    mint === x.tokenA.mint
      ? x.tokenA
      : mint === x.tokenB.mint
        ? x.tokenB
        : mint === SOL_MINT
          ? { symbol: 'SOL', letter: 'S', color: '#1b1d27', logo: '/tokens/SOL.png', mint }
          : { symbol, letter: (symbol[0] ?? '?').toUpperCase(), color: '#2a2c38', mint };

  // ---- moving SOL in from the owner's own wallet
  const wallet = bal?.wallet;
  const movable = wallet ? Math.max(0, Math.floor((wallet.sol - WALLET_FEE_SOL) * 10_000) / 10_000) : 0;
  const reserveShort = bal?.vaultSol != null ? Math.max(0, VAULT_RESERVE_SOL - bal.vaultSol) : 0;
  // What the vault must hold for `want` here: idle funds, 2% kept for fees; limits that more funds can't raise
  // both have to allow it; limits that more funds can't raise (pool size, per-position cap, live) cap the target.
  const target = lim?.ceilingUsd != null ? Math.min(want, lim.ceilingUsd) : want;
  const neededIdle = target / 0.98;
  const neededUsd = want > 0 && bal ? Math.max(0, neededIdle - bal.availableUsd) : 0;
  const suggestSol = wallet && wallet.solPriceUsd > 0 && neededUsd > 0 ? Math.min(movable, Math.ceil((neededUsd / wallet.solPriceUsd + reserveShort) * 1000) / 1000) : 0;
  /** Sends `sol` from the owner's wallet to the vault and waits until the API has checked it on-chain. */
  const sendSol = async (sol: number, w: NonNullable<ReturnType<typeof walletFor>>): Promise<boolean> => {
    const { tx } = await client!.depositTx(sol);
    const signature = await sendWithWallet(w, me!.wallet, fromBase64(tx));
    // Solana confirms in a few seconds; the API checks the transfer on-chain before counting it.
    for (let i = 0; i < 15; i++) {
      try {
        await client!.depositLive(signature);
        return true;
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'tx_not_found') throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return false;
  };
  const walletError = (e: unknown, name: string) =>
    e instanceof SignInError
      ? e.kind === 'rejected'
        ? `Cancelled in ${name}. Nothing was sent.`
        : e.kind === 'pending'
          ? `${name} already has a request open. Finish or close it, then try again.`
          : e.message
      : e instanceof ApiError
        ? e.message
        : 'Something went wrong. Nothing was sent; try again.';
  /** The wallet to approve with, or why there is none. */
  const pickWallet = (sol: number) => {
    if (!(sol > 0) || sol > movable) return `Enter up to ${amount(movable)} SOL (a little stays for the network fee).`;
    return walletFor(wallets, me!.wallet) ?? 'No wallet found in this browser. Open this page where you signed in (Phantom, Solflare or Backpack).';
  };
  const move = async () => {
    const sol = Number(moveS);
    setMoveErr(null);
    if (!client || !me || !wallet) return;
    const w = pickWallet(sol);
    if (typeof w === 'string') return setMoveErr(w);
    setMoving(true);
    try {
      const recorded = await sendSol(sol, w);
      toast(recorded ? `Moved ${amount(sol)} SOL to your vault` : 'Sent. It shows in the vault once Solana confirms it.');
      setMoveS('');
      reload();
    } catch (e) {
      setMoveErr(walletError(e, w.name));
    } finally {
      setMoving(false);
    }
  };

  // ---- paying with SOL from the wallet (empty vault): move it in, then the agent swaps and adds LP
  // Also when the vault holds too little to add anything here.
  const payMode = (emptyVault || blocked) && !!wallet && movable > 0 && !hardBlocked;
  const solPrice = wallet?.solPriceUsd ?? 0;
  const paySol = Number(payS) || 0;
  // What reaches the vault after the fee reserve, and how much of it this pool may take (same limits as above).
  const payIdleUsd = (bal?.availableUsd ?? 0) + Math.max(0, paySol - reserveShort) * solPrice;
  const payLpUsd = lim ? Math.max(0, Math.min(payIdleUsd * 0.98, lim.ceilingUsd ?? Infinity)) : 0;
  const paySwaps: Swap[] =
    payMode && shareA != null && payLpUsd > 0
      ? (
          [
            [mintA, symA, payLpUsd * shareA],
            [mintB, symB, payLpUsd * (1 - shareA)],
          ] as const
        )
          .filter(([m, , u]) => m !== SOL_MINT && u >= 0.01)
          .map(([m, sym, u]) => ({ from: 'SOL', fromMint: SOL_MINT, to: sym, toMint: m, usd: u }))
      : [];
  const payTooSmall = paySol > 0 && !!lim && payLpUsd < lim.minUsd;
  const payAndAdd = async () => {
    setMoveErr(null);
    if (!client || !me || !wallet) return;
    const w = pickWallet(paySol);
    if (typeof w === 'string') return setMoveErr(w);
    setMoving(true);
    try {
      if (!(await sendSol(paySol, w))) {
        toast('Sent. Add LP once Solana confirms the transfer.');
        return reload();
      }
      // Size it from the vault as it is now that the SOL is in.
      const fresh = await client.balance(x.id);
      const size = Math.min(payLpUsd, fresh.pool?.maxUsd ?? 0);
      if (!fresh.pool || size < fresh.pool.minUsd) {
        setMoveErr(`Moved ${amount(paySol)} SOL to your vault, but this pool can't take enough of it right now. Try a smaller amount or another pool.`);
        return reload();
      }
      deploy(x.id, size, x.call !== 'in', opts);
      setPayS('');
      reload();
    } catch (e) {
      setMoveErr(walletError(e, w.name));
    } finally {
      setMoving(false);
    }
  };

  const disabled = payMode
    ? (x.call !== 'in' && !risk) || moving || !(paySol > 0) || payTooSmall || (custom && !!rangeErr)
    : (x.call !== 'in' && !risk) || blocked || tooSmall || (custom && !!rangeErr);

  return (
    <>
      <div className="dsec">Add LP by hand</div>
      {x.call !== 'in' && (
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
          The agent won&apos;t enter this pool by itself ({x.callLabel}). If you add LP here, it rebalances and claims fees, but won&apos;t close
          it on its trend rules: you close it yourself in Positions. The daily loss stop still applies.
        </p>
      )}
      <div className="rows">
        <div>
          <span>Vault balance</span>
          <b className="num" id="dBal">
            {bal ? usd(bal.availableUsd, 2) : balErr ? '—' : 'Checking…'}
          </b>
        </div>
        {lim && (
          <div>
            <span>Most you can add here</span>
            <b className="num" id="dMax">
              {usd(lim.maxUsd, 2)}
            </b>
          </div>
        )}
      </div>
      {bal && (
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
          {bal.assets.length ? bal.assets.map((a) => `${amount(a.amount)} ${a.symbol}`).join(' · ') : 'No idle funds'}
          {bal.reserveSol > 0 && ` · ${amount(bal.reserveSol)} SOL kept for network fees`}
          {bal.source === 'agent' && overview?.mode === 'live' && ' · as of the agent’s last check'}
          {lim && !blocked && (
            <>
              <br />
              {LIMIT_TEXT[lim.limit]}
            </>
          )}
        </p>
      )}
      {balErr && !bal && (
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
          Couldn&apos;t read the vault balance right now. The agent still checks it before adding.
        </p>
      )}
      {blocked && lim && bal && !payMode && (
        <div className="verdict wt" id="dBlocked">
          {hardBlocked ? (
            LIMIT_TEXT[lim.limit]
          ) : (
            <>
              {lim.limit === 'balance'
                ? `Not enough in your vault: Add LP needs at least ${usd(lim.minUsd)} idle.`
                : `You can add up to ${usd(lim.maxUsd, 2)} here now, below the ${usd(lim.minUsd)} minimum. ${LIMIT_TEXT[lim.limit]}`}{' '}
              {wallet && movable > 0 ? (
                'Move SOL from your wallet below.'
              ) : (
                <>
                  Deposit SOL or USDC to your vault in the{' '}
                  <a href={BOT_URL} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                    Telegram bot
                  </a>{' '}
                  (💳 Wallet).
                </>
              )}
            </>
          )}
        </div>
      )}

      {wallet && movable > 0 && !hardBlocked && !payMode && (
        <div id="dFund" style={{ marginTop: 14, padding: 14, borderRadius: 12, border: '1px solid var(--line)', background: 'rgba(255,255,255,.02)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13.5 }}>
            <b style={{ fontWeight: 500 }}>Use SOL from your wallet</b>
            <span className="muted num">
              {amount(wallet.sol)} SOL{wallet.solPriceUsd ? ` · ${usd(wallet.sol * wallet.solPriceUsd, 2)}` : ''}
            </span>
          </div>
          <div style={{ position: 'relative' }}>
            <input
              className="capin"
              inputMode="decimal"
              placeholder="SOL to move into the vault"
              aria-label="SOL to move into the vault"
              value={moveS}
              disabled={moving}
              style={{ paddingRight: 64 }}
              onChange={(e) => setMoveS(e.target.value.replace(/[^0-9.]/g, ''))}
            />
            <button className="btn btn-dark btn-sm" style={{ position: 'absolute', right: 6, top: 16, height: 26, padding: '0 10px', fontSize: 12.5 }} onClick={() => setMoveS(String(movable))}>
              Max
            </button>
          </div>
          {suggestSol > 0 && (
            <button className="muted" style={{ fontSize: 12.5, marginTop: 8, textDecoration: 'underline', textAlign: 'left' }} onClick={() => setMoveS(String(suggestSol))}>
              Move {amount(suggestSol)} SOL to add {usd(target)}
              {reserveShort > 0 ? ' (incl. the fee reserve)' : ''}
            </button>
          )}
          {lim?.ceilingUsd != null && want > lim.ceilingUsd && (
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 6 }}>
              This pool takes at most {usd(lim.ceilingUsd, 2)} from you (pool size, your max per position or the live limits), however much is in the vault.
            </p>
          )}
          <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 8 }}>
            You approve the transfer in your wallet. The vault keeps {VAULT_RESERVE_SOL} SOL for network fees{reserveShort > 0 ? ' (not there yet)' : ''}; the rest can go into LP.
          </p>
          {moveErr && (
            <p className="down" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
              {moveErr}
            </p>
          )}
          <button className="btn btn-dark btn-sm" style={{ width: '100%', marginTop: 10 }} disabled={moving || !(Number(moveS) > 0)} onClick={move}>
            {moving ? 'Approve in your wallet…' : `Move ${Number(moveS) > 0 ? amount(Number(moveS)) + ' ' : ''}SOL to the vault`}
          </button>
        </div>
      )}

      {lp && !hardBlocked && (
        <>
          {recRange && (
            <LpRecommend
              lp={lp}
              symA={symA}
              symB={symB}
              lo={price(binPrice(active0 - recRange.below, lp.binStep))}
              hi={price(binPrice(active0 + recRange.above + 1, lp.binStep))}
              width={recWidth}
              inUse={onRec}
              onUse={useRec}
            />
          )}

          <span style={label}>Strategy</span>
          <div className="seg" style={segFull} role="group" aria-label="Strategy shape">
            {(['agent', 'spot', 'curve', 'bidask'] as const).map((k) => (
              <button key={k} style={segBtn} aria-pressed={shape === k} onClick={() => setShape(k)}>
                {k === lp.shape && <RecDot />}
                {k === 'agent' ? 'Agent' : SHAPE_NAME[k]}
              </button>
            ))}
          </div>
          {recHint(SHAPE_NAME[lp.shape], shape === 'agent' || shape === lp.shape, () => setShape(lp.shape))}
          {drawn && (
            <LpShape
              shape={shape}
              agentShape={lp.shape}
              below={drawn.below}
              above={drawn.above}
              symA={symA}
              symB={symB}
              lo={price(binPrice(active0 - drawn.below, lp.binStep))}
              hi={price(binPrice(active0 + drawn.above + 1, lp.binStep))}
              now={price(lp.price)}
            />
          )}

          <span style={label}>Deposit</span>
          <div className="seg" style={segFull} role="group" aria-label="Tokens to deposit">
            {(
              [
                ['both', 'Both tokens'],
                ['x', `Only ${symA}`],
                ['y', `Only ${symB}`],
              ] as const
            ).map(([k, t]) => (
              <button key={k} style={segBtn} aria-pressed={side === k} onClick={() => setSide(k)}>
                {k === lp.side && <RecDot />}
                {t}
              </button>
            ))}
          </div>
          {lp.side === null ? (
            <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 7 }}>
              No recommendation: the pool is trending down, so the agent wouldn&apos;t add liquidity here now.
            </p>
          ) : (
            recHint(sideName(recSide), side === recSide, () => setSide(recSide))
          )}
          {side !== 'both' && (
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 6 }}>
              {side === 'x' ? `All ${symA}, in bins above the current price: it sells into ${symB} as price rises.` : `All ${symB}, in bins below the current price: it buys ${symA} as price falls.`}
            </p>
          )}

          <span style={label}>
            Price range <span className="dim">({symB} per {symA}, now {price(lp.price)})</span>
          </span>
          <div className="seg" style={segFull} role="group" aria-label="Price range">
            {(['agent', ...presets, 'custom'] as RangeMode[]).map((k) => (
              <button key={String(k)} style={segBtn} aria-pressed={mode === k} onClick={() => pickMode(k)}>
                {k === 'agent' && lp.side !== null && <RecDot />}
                {k === 'agent' ? 'Agent' : k === 'custom' ? 'Custom' : k === 'max' ? `Max ±${maxPct}%` : `±${k}%`}
              </button>
            ))}
          </div>
          {lp.side !== null && recHint(`Agent width, ${recWidth}`, mode === 'agent', () => setMode('agent'))}
          {mode === 'custom' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input
                className="capin"
                inputMode="decimal"
                aria-label="Min price"
                placeholder="Min price"
                value={side === 'x' ? price(lp.price) : minS}
                disabled={side === 'x'}
                onChange={(e) => setMinS(e.target.value.replace(/[^0-9.]/g, ''))}
              />
              <input
                className="capin"
                inputMode="decimal"
                aria-label="Max price"
                placeholder="Max price"
                value={side === 'y' ? price(lp.price) : maxS}
                disabled={side === 'y'}
                onChange={(e) => setMaxS(e.target.value.replace(/[^0-9.]/g, ''))}
              />
            </div>
          )}
          <p className={rangeErr ? 'down' : 'muted'} style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }} id="dRange">
            {rangeErr ? (
              `${rangeErr}${range && range.below + range.above + 1 > lp.maxBins ? ` Here that is about ±${maxPct}% around the price.` : ''}`
            ) : range ? (
              <>
                Min <b className="num">{price(rangeLo)}</b> ({pctFrom(rangeLo, lp.price)}) · Max <b className="num">{price(rangeHi)}</b> ({pctFrom(rangeHi, lp.price)}) ·{' '}
                {range.below + range.above + 1} bins
              </>
            ) : null}
          </p>
          {custom && (
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 4 }}>
              The range is set around the price when the agent opens it. If price leaves it, the agent moves it (only when the fees pay for the move)
              with the same width and shape.
            </p>
          )}
        </>
      )}

      {payMode && wallet ? (
        <>
          <span style={{ ...label, display: 'flex', justifyContent: 'space-between' }}>
            <span>Pay with SOL from your wallet</span>
            <span className="num">
              {amount(wallet.sol)} SOL{solPrice ? ` · ${usd(wallet.sol * solPrice, 2)}` : ''}
            </span>
          </span>
          <div style={{ position: 'relative' }}>
            <input
              className="capin"
              style={{ marginTop: 0, paddingRight: 64 }}
              inputMode="decimal"
              placeholder="SOL to use"
              aria-label="SOL to pay with"
              value={payS}
              disabled={moving}
              onChange={(e) => setPayS(e.target.value.replace(/[^0-9.]/g, ''))}
            />
            <button className="btn btn-dark btn-sm" style={{ position: 'absolute', right: 6, top: 6, height: 26, padding: '0 10px', fontSize: 12.5 }} onClick={() => setPayS(String(movable))}>
              Max
            </button>
          </div>
          {payTooSmall && lim && (
            <p className="down" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
              That adds about {usd(payLpUsd, 2)} of LP; the minimum is {usd(lim.minUsd)}.{reserveShort > 0 ? ` ${VAULT_RESERVE_SOL} SOL of it stays in the vault for network fees.` : ''}
            </p>
          )}
          {moveErr && (
            <p className="down" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
              {moveErr}
            </p>
          )}
        </>
      ) : (
        <>
        <span style={label}>Amount</span>
        <div style={{ position: 'relative' }}>
          <input
            className="capin"
            style={{ marginTop: 0, paddingRight: lim && !blocked ? 64 : undefined }}
            inputMode="decimal"
            placeholder="Amount in USD (empty: the agent sizes it)"
            aria-label="Amount in USD"
            value={amt}
            disabled={hardBlocked}
            onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))}
          />
          {lim && !blocked && (
            <button
              className="btn btn-dark btn-sm"
              style={{ position: 'absolute', right: 6, top: 6, height: 26, padding: '0 10px', fontSize: 12.5 }}
              onClick={() => setAmt(String(Math.floor(lim.maxUsd * 100) / 100))}
            >
              Max
            </button>
          )}
        </div>
        {tooSmall && lim && (
          <p className="down" style={{ fontSize: 12.5, marginTop: 8 }}>
            At least {usd(lim.minUsd)}.
          </p>
        )}
        {over && lim && (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            The agent adds at most {usd(lim.maxUsd, 2)} here; it sizes your amount down.
          </p>
        )}

        </>
      )}

      {lp && !hardBlocked && bal && (
        <>
          <span style={label}>Swap</span>
          <div id="dSwaps" style={{ padding: '10px 14px 12px', borderRadius: 11, background: 'rgba(255,255,255,.025)', border: '1px solid var(--line)' }}>
            {(() => {
              // From the vault's idle funds, or (empty vault) from the SOL the owner moves in.
              const rows = payMode ? paySwaps : emptyVault ? solSwaps : swaps && !blocked ? swaps.out : [];
              const holdBoth = !emptyVault && !!swaps && !blocked && swaps.out.length === 0;
              return (
                <>
                  {rows.map((r, i) => (
                    <div key={i} className="num" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '5px 0', fontSize: 13 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        <span className="toks">
                          <Tok t={tokenOf(r.fromMint, r.from)} />
                        </span>
                        {r.from}
                        <span className="dim">→</span>
                        <span className="toks">
                          <Tok t={tokenOf(r.toMint, r.to)} />
                        </span>
                        {r.to}
                      </span>
                      <b>≈ {usd(r.usd, 2)}</b>
                    </div>
                  ))}
                  {payMode &&
                    paySol > 0 &&
                    (() => {
                      // Where the SOL goes: into the LP, or kept in the vault (still the owner's).
                      const reserveSol = Math.min(paySol, reserveShort);
                      const capped = payLpUsd < payIdleUsd * 0.98 - 0.5;
                      const bufferUsd = capped ? 0 : payIdleUsd - payLpUsd;
                      const keptUsd = Math.max(0, paySol * solPrice - payLpUsd);
                      return (
                        <>
                          <div className="rows" style={{ marginTop: rows.length ? 6 : 0, fontSize: 13 }} id="dPayRows">
                            <div>
                              <span>You pay</span>
                              <b className="num">
                                {amount(paySol)} SOL · {usd(paySol * solPrice, 2)}
                              </b>
                            </div>
                            <div>
                              <span>Into the LP</span>
                              <b className="num up">≈ {usd(payLpUsd, 2)}</b>
                            </div>
                            <div>
                              <span>Stays in your vault</span>
                              <b className="num">≈ {usd(keptUsd, 2)}</b>
                            </div>
                          </div>
                          <p className="muted" style={{ fontSize: 12, lineHeight: 1.55, marginTop: 8 }}>
                            {reserveSol > 0 &&
                              `${amount(reserveSol)} SOL (≈ ${usd(reserveSol * solPrice, 2)}) is the vault's reserve: Solana needs it for the position's rent deposit and network fees. The rent comes back when the position closes, and the reserve stays in the vault, so later deposits go in fully. `}
                            {bufferUsd >= 0.5 && `${usd(bufferUsd, 2)} (2%) is a buffer for swap fees and price moves. `}
                            {capped && 'This pool takes no more from you (2% of its liquidity, your max per position or the live limits). '}
                            What stays in the vault is yours: withdraw it or use it for the next LP.
                          </p>
                        </>
                      );
                    })()}
                  <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: rows.length ? 6 : 2 }}>
                    {payMode
                      ? paySol > 0
                        ? `One click: you approve sending ${amount(paySol)} SOL to your vault in your wallet, then the vault swaps it through Jupiter (at most 0.5% slippage) and adds ≈ ${usd(payLpUsd, 2)} of LP. You don't need to hold ${symA} or ${symB}.`
                        : `Enter how much SOL to use. The vault swaps it into ${symA} and ${symB} through Jupiter and adds the LP, in one click. You don't need to hold either token.`
                      : holdBoth
                      ? `No swap needed: the vault already holds ${symA} and ${symB}.`
                      : emptyVault
                        ? want > 0
                          ? `Estimate for ${usd(want, 2)}. Move SOL into the vault above; when you add LP, the vault swaps it through Jupiter (at most 0.5% slippage). You don't need to hold ${symA} or ${symB}.`
                          : `You don't need to hold ${symA} or ${symB}. Move SOL into the vault above and enter an amount: the vault swaps the SOL into both through Jupiter when you add LP.`
                        : rows.length
                          ? `Through Jupiter, inside your vault, right before the LP opens (at most 0.5% slippage). You don't need to hold ${symA} or ${symB} yourself.`
                          : rangeErr
                            ? 'Pick a valid price range to see the swaps.'
                            : `The vault swaps its idle funds into ${symA} and ${symB} through Jupiter when you add LP.`}
                    {!emptyVault && swaps && swaps.short > 1 && ' Not enough idle funds for all of it: the agent sizes the position down.'}
                  </p>
                </>
              );
            })()}
          </div>
        </>
      )}

      {x.call !== 'in' && (
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12, fontSize: 12.5, lineHeight: 1.45, color: 'var(--muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={risk} onChange={(e) => setRisk(e.target.checked)} style={{ marginTop: 2, accentColor: '#4BE3CF' }} />
          <span>I add this against the agent&apos;s call, at my own risk. No strategy is guaranteed to profit.</span>
        </label>
      )}
      <button
        className="btn btn-white"
        style={{ width: '100%', marginTop: 12 }}
        disabled={disabled}
        onClick={() => (payMode ? payAndAdd() : deploy(x.id, Math.min(want, lim?.maxUsd ?? want), x.call !== 'in', opts))}
      >
        <Icon id="i-plus" />
        {payMode
          ? moving
            ? 'Approve in your wallet…'
            : `Swap & add LP${paySol > 0 ? ` with ${amount(paySol)} SOL` : ''}`
          : swaps && !blocked && swaps.out.length
            ? `Swap & add LP to ${x.pair}`
            : `Add LP to ${x.pair}`}
      </button>
    </>
  );
}
