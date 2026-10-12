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
import { LpShape } from './LpShape';
import { useSolanaWallets } from './Wallet';

/** Why Add LP can't put more into this pool (VaultBalance.pool.limit), in plain words. */
const LIMIT_TEXT: Record<NonNullable<VaultBalance['pool']>['limit'], string> = {
  balance: 'Limited by the idle funds in your vault.',
  strategy: 'Limited by your strategy: its max share of the vault per pool, and never more than 2% of the pool.',
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
  const [moving, setMoving] = useState(false);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setAmt('');
    setRisk(false);
    setBal(null);
    setBalErr(false);
    setShape('agent');
    setSide('both');
    setMode('agent');
    setMoveS('');
    setMoveErr(null);
  }, [x.id]);

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
  const custom = side !== 'both' || mode !== 'agent';
  const opts = { ...(shape !== 'agent' ? { shape } : {}), ...(custom && range ? { range } : {}) };

  // ---- limits
  const blocked = !!lim && lim.maxUsd < lim.minUsd;
  const hardBlocked = !!lim && (lim.limit === 'held' || lim.limit === 'positions');
  const tooSmall = !!lim && want > 0 && want < lim.minUsd;
  const over = !!lim && !blocked && want > lim.maxUsd;

  // ---- swaps the vault makes first: what the range needs of each token, from what sits idle (largest first)
  const plannedUsd = want > 0 ? Math.min(want, lim?.maxUsd ?? want) : (lim?.maxUsd ?? 0);
  const swaps = useMemo(() => {
    if (!lp || !range || rangeErr || !bal || plannedUsd < 1) return null;
    const pos = openPosition(1000, lp.price, lp.binStep, 0, shape === 'agent' ? lp.shape : shape, 'both', range);
    const c = composition(pos, lp.price);
    const shareA = (c.x * lp.price) / (c.x * lp.price + c.y || 1);
    const need: Record<string, number> = { [x.tokenA.mint ?? symA]: plannedUsd * shareA, [x.tokenB.mint ?? symB]: plannedUsd * (1 - shareA) };
    const idle = Object.fromEntries(bal.assets.map((a) => [a.mint, a.usd]));
    const symbolOf = (m: string) => bal.assets.find((a) => a.mint === m)?.symbol ?? (m === x.tokenA.mint ? symA : m === x.tokenB.mint ? symB : m.slice(0, 4));
    const out: { from: string; to: string; usd: number }[] = [];
    let short = 0;
    for (const [target, sym] of [
      [x.tokenA.mint ?? symA, symA],
      [x.tokenB.mint ?? symB, symB],
    ] as const) {
      let missing = need[target] - (idle[target] ?? 0);
      if (missing <= Math.max(1, need[target] * 0.02)) continue;
      const otherPool = target === (x.tokenA.mint ?? symA) ? (x.tokenB.mint ?? symB) : (x.tokenA.mint ?? symA);
      const sources = bal.assets.filter((a) => a.mint !== target && a.mint !== otherPool).sort((p, q) => q.usd - p.usd);
      for (const s of sources) {
        if (missing <= 1) break;
        const take = Math.min(idle[s.mint] ?? 0, missing);
        if (take < 1) continue;
        out.push({ from: s.symbol, to: sym, usd: take });
        idle[s.mint] = (idle[s.mint] ?? 0) - take;
        missing -= take;
      }
      // Then the other pool token, beyond what the position needs of it.
      const spare = (idle[otherPool] ?? 0) - need[otherPool];
      if (missing > 1 && spare > 1) {
        const take = Math.min(spare, missing);
        out.push({ from: symbolOf(otherPool), to: sym, usd: take });
        idle[otherPool] = (idle[otherPool] ?? 0) - take;
        missing -= take;
      }
      if (missing > 1) short += missing;
    }
    return { out, short };
  }, [lp, range, rangeErr, bal, plannedUsd, shape, x, symA, symB]);

  // ---- moving SOL in from the owner's own wallet
  const wallet = bal?.wallet;
  const movable = wallet ? Math.max(0, Math.floor((wallet.sol - WALLET_FEE_SOL) * 10_000) / 10_000) : 0;
  const reserveShort = bal?.vaultSol != null ? Math.max(0, VAULT_RESERVE_SOL - bal.vaultSol) : 0;
  // What the vault must hold for `want` here: idle funds (2% kept for fees) and the strategy's share per pool
  // both have to allow it; limits that more funds can't raise (pool size, per-position cap, live) cap the target.
  const target = lim?.ceilingUsd != null ? Math.min(want, lim.ceilingUsd) : want;
  const positionsUsd = positions.reduce((sum, p) => sum + p.value, 0);
  const neededIdle = lim ? Math.max(target / 0.98, target / (lim.allocPct / 100) - positionsUsd) : target / 0.98;
  const neededUsd = want > 0 && bal ? Math.max(0, neededIdle - bal.availableUsd) : 0;
  const suggestSol = wallet && wallet.solPriceUsd > 0 && neededUsd > 0 ? Math.min(movable, Math.ceil((neededUsd / wallet.solPriceUsd + reserveShort) * 1000) / 1000) : 0;
  const move = async () => {
    const sol = Number(moveS);
    setMoveErr(null);
    if (!client || !me || !wallet) return;
    if (!(sol > 0) || sol > movable) return setMoveErr(`Enter up to ${amount(movable)} SOL (a little stays for the network fee).`);
    const w = walletFor(wallets, me.wallet);
    if (!w) return setMoveErr('No wallet found in this browser. Open this page where you signed in (Phantom, Solflare or Backpack).');
    setMoving(true);
    try {
      const { tx } = await client.depositTx(sol);
      const signature = await sendWithWallet(w, me.wallet, fromBase64(tx));
      // Solana confirms in a few seconds; the API checks the transfer on-chain before counting it.
      let recorded = false;
      for (let i = 0; i < 15 && !recorded; i++) {
        try {
          await client.depositLive(signature);
          recorded = true;
        } catch (e) {
          if (!(e instanceof ApiError) || e.code !== 'tx_not_found') throw e;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      toast(recorded ? `Moved ${amount(sol)} SOL to your vault` : 'Sent. It shows in the vault once Solana confirms it.');
      setMoveS('');
      reload();
    } catch (e) {
      setMoveErr(
        e instanceof SignInError
          ? e.kind === 'rejected'
            ? `Cancelled in ${w.name}. Nothing was sent.`
            : e.kind === 'pending'
              ? `${w.name} already has a request open. Finish or close it, then try again.`
              : e.message
          : e instanceof ApiError
            ? e.message
            : 'Something went wrong. Nothing was sent; try again.',
      );
    } finally {
      setMoving(false);
    }
  };

  const disabled = (x.call !== 'in' && !risk) || blocked || tooSmall || (custom && !!rangeErr);

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
      {blocked && lim && bal && (
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

      {wallet && movable > 0 && !hardBlocked && (
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
          {lim && neededUsd > 0 && neededIdle > target / 0.98 + 0.5 && (
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 6 }}>
              Your strategy puts at most {lim.allocPct}% of the vault in one pool, so adding {usd(target)} needs about {usd(neededIdle + positionsUsd)} in the vault. You can raise
              the share in Strategy.
            </p>
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
          <span style={label}>Strategy</span>
          <div className="seg" style={segFull} role="group" aria-label="Strategy shape">
            {(['agent', 'spot', 'curve', 'bidask'] as const).map((k) => (
              <button key={k} style={segBtn} aria-pressed={shape === k} onClick={() => setShape(k)}>
                {k === 'agent' ? `Agent (${SHAPE_NAME[lp.shape]})` : SHAPE_NAME[k]}
              </button>
            ))}
          </div>
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
                {t}
              </button>
            ))}
          </div>
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
                {k === 'agent' ? 'Agent' : k === 'custom' ? 'Custom' : k === 'max' ? `Max ±${maxPct}%` : `±${k}%`}
              </button>
            ))}
          </div>
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

      {swaps && !blocked && (
        <div style={{ marginTop: 14, fontSize: 12.5, lineHeight: 1.6 }} id="dSwaps">
          <span className="muted">Swaps first (Jupiter, in the vault): </span>
          {swaps.out.length ? (
            swaps.out.map((s, i) => (
              <span key={i}>
                {i > 0 && ', '}
                <b className="num">≈ {usd(s.usd, 2)}</b> {s.from} → {s.to}
              </span>
            ))
          ) : (
            <span>none, the vault already holds both tokens.</span>
          )}
          {swaps.short > 1 && <span className="muted"> Not enough idle funds for all of it: the agent sizes the position down.</span>}
        </div>
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
        onClick={() => deploy(x.id, Math.min(want, lim?.maxUsd ?? want), x.call !== 'in', opts)}
      >
        <Icon id="i-plus" />
        Add LP to {x.pair}
      </button>
    </>
  );
}
