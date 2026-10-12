import type DLMMClass from '@meteora-ag/dlmm';
import type { LbPosition, StrategyType as StrategyTypeEnum } from '@meteora-ag/dlmm';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';
import { DEFAULT_COSTS, composition, openPosition, sideOfRange, type CostModel, type LiquidityShape } from '@binwise/core';
import { TX_COUNT, type ActionResult, type Executor, type Holdings, type MarkResult, type OpenRequest, type OpenResult, type PoolCtx, type PositionRef } from './executor';
import { JitoClient } from './jito';
import { parseDeposit } from './deposits';
import { JupiterClient } from './jupiter';
import { PolicyViolation, assertTxAllowed, lookupTableKeys, type TxPolicy } from './programs';
import { confirmOrCheck, priorityFeeMicroLamports, sendAndConfirm, simulateOrThrow, simulateWithAccounts } from './rpc';
import { withRetry } from './http';

export interface KillSwitch {
  /** True when all trading must stop (global switch in Redis). */
  isKilled(): Promise<boolean>;
}

export interface IdempotencyGuard {
  /** Returns false if this key was already used: the action must not run again. */
  claim(key: string): Promise<boolean>;
}

export class TradingHalted extends Error {}
/** The open was skipped because one-off setup rent is too large for the position. */
export class SetupTooCostly extends Error {}
export class DuplicateAction extends Error {}

import { DLMM, sdk } from './sdk';
type DLMM = DLMMClass;

// StrategyType values from the SDK: Spot = 0, Curve = 1, BidAsk = 2.
const STRATEGY: Record<LiquidityShape, StrategyTypeEnum> = {
  spot: 0 as StrategyTypeEnum,
  curve: 1 as StrategyTypeEnum,
  bidask: 2 as StrategyTypeEnum,
};

/** SOL kept aside for fees and rent; never deployed. Covers a worst-case open (position + 2 bin arrays + bitmap + token accounts). */
export const SOL_RESERVE = 0.25;
/** Worst acceptable swap result vs. fair value (route fees + price impact + stale prices). */
const MAX_SWAP_LOSS = 0.03;
/** Lamports a swap may spend besides its input: network fee, tip, new token accounts. */
const SWAP_SOL_TOLERANCE = 10_000_000;
/** DLMM: max bins one add-liquidity transaction handles (SDK MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX). */
const SINGLE_TX_BINS = 26;

/** UI amount → raw base units, rounded down, exact for large integer parts (no float overflow into "1e+21"). */
const raw = (ui: number, decimals: number) => {
  if (!Number.isFinite(ui) || ui <= 0) return new BN(0);
  const whole = Math.trunc(ui);
  const frac = Math.floor((ui - whole) * 10 ** decimals);
  return new BN((BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac)).toString());
};
const ui = (r: BN | string, decimals: number) => Number(r.toString()) / 10 ** decimals;

export interface LiveExecutorDeps {
  conn: Connection;
  agent: Keypair;
  /** The vault owner's registered wallet: the only withdrawal destination */
  ownerWallet: PublicKey;
  killSwitch: KillSwitch;
  idempotency: IdempotencyGuard;
  jupiter?: JupiterClient;
  /** Set to send through Jito bundles with a tip */
  jito?: JitoClient | null;
  tipLamports?: number;
  costs?: CostModel;
}

/**
 * Live executor. Every transaction is: checked against the program allowlist,
 * gated by the kill switch, simulated (abort on failure), then sent and confirmed.
 * Only reachable when LIVE_TRADING_ENABLED=true and the vault opted in.
 */
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;
  private jupiter: JupiterClient;
  private costs: CostModel;

  constructor(private d: LiveExecutorDeps) {
    this.jupiter = d.jupiter ?? new JupiterClient();
    this.costs = d.costs ?? DEFAULT_COSTS;
  }

  private get me() {
    return this.d.agent.publicKey;
  }

  txCostUsd(n: number) {
    return (n * (this.costs.lamportsPerTx + (this.d.jito ? this.d.tipLamports ?? 10_000 : 0)) * this.costs.solUsd) / 1e9;
  }

  // ---------- reads ----------

  /** Spendable balances. With includeReserve, the SOL kept for fees and rent is counted too (vault value). */
  async holdings(opts: { includeReserve?: boolean } = {}): Promise<Holdings> {
    const out: Holdings = {};
    const lamports = await withRetry(() => this.d.conn.getBalance(this.me), 3, 'getBalance');
    out[NATIVE_MINT.toBase58()] = Math.max(0, lamports / 1e9 - (opts.includeReserve ? 0 : SOL_RESERVE));
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const r = await withRetry(() => this.d.conn.getParsedTokenAccountsByOwner(this.me, { programId }), 3, 'getParsedTokenAccountsByOwner');
      for (const a of r.value) {
        const info = a.account.data.parsed.info;
        out[info.mint] = (out[info.mint] ?? 0) + Number(info.tokenAmount.uiAmount ?? 0);
      }
    }
    return out;
  }

  /**
   * Every DLMM position the agent wallet owns on-chain, so the agent can adopt one it opened but
   * never recorded (e.g. the process stopped between sending and saving).
   */
  async listPositions(): Promise<{ address: string; pool: string; lowerBin: number; upperBin: number; amountX: string; amountY: string }[]> {
    const all = await withRetry(() => sdk().default.getAllLbPairPositionsByUser(this.d.conn, this.me), 2, 'getAllLbPairPositionsByUser');
    const out: { address: string; pool: string; lowerBin: number; upperBin: number; amountX: string; amountY: string }[] = [];
    for (const [pool, info] of all)
      for (const p of info.lbPairPositionsData)
        out.push({
          address: p.publicKey.toBase58(),
          pool,
          lowerBin: p.positionData.lowerBinId,
          upperBin: p.positionData.upperBinId,
          amountX: p.positionData.totalXAmount,
          amountY: p.positionData.totalYAmount,
        });
    return out;
  }

  /** Recent successful transactions touching the agent wallet (newest first), for spotting deposits. */
  async recentSignatures(limit = 20): Promise<string[]> {
    const r = await withRetry(() => this.d.conn.getSignaturesForAddress(this.me, { limit }), 2, 'getSignaturesForAddress');
    return r.filter((x) => !x.err).map((x) => x.signature);
  }

  /** Deposits from the owner in one transaction (see parseDeposit). */
  async depositIn(signature: string): Promise<Record<string, number>> {
    const tx = await withRetry(() => this.d.conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }), 2, 'getParsedTransaction');
    return tx ? parseDeposit(tx, this.d.ownerWallet.toBase58(), this.me.toBase58()) : {};
  }

  private async lbPosition(dlmm: DLMM, address: string): Promise<LbPosition> {
    return withRetry(() => dlmm.getPosition(new PublicKey(address)), 3, 'getPosition');
  }

  async mark(p: PositionRef, pool: PoolCtx): Promise<MarkResult> {
    if (!p.address) throw new Error('Live position has no address');
    // A position closed on-chain (e.g. by an action that stopped halfway) must not wedge every cycle.
    if (!(await withRetry(() => this.d.conn.getAccountInfo(new PublicKey(p.address!)), 3, 'getAccountInfo')))
      return { amountX: 0, amountY: 0, valueUsd: 0, feesUsd: 0, inRange: false, gone: true };
    const dlmm = await DLMM.create(this.d.conn, new PublicKey(pool.address));
    const [pos, active] = await Promise.all([this.lbPosition(dlmm, p.address), dlmm.getActiveBin()]);
    const d = pos.positionData;
    const x = ui(d.totalXAmount, pool.decimalsX);
    const y = ui(d.totalYAmount, pool.decimalsY);
    const fx = ui(d.feeX, pool.decimalsX);
    const fy = ui(d.feeY, pool.decimalsY);
    return {
      amountX: x,
      amountY: y,
      valueUsd: x * pool.usdX + y * pool.usdY,
      feesUsd: fx * pool.usdX + fy * pool.usdY,
      inRange: active.binId >= d.lowerBinId && active.binId <= d.upperBinId,
    };
  }

  // ---------- sending ----------

  private policy(extra: Partial<TxPolicy> = {}, newAccounts: PublicKey[] = []): TxPolicy {
    const own = [this.me, getAssociatedTokenAddressSync(NATIVE_MINT, this.me, true)];
    return {
      agent: this.me.toBase58(),
      ataOwners: new Set([this.me.toBase58(), ...(extra.ataOwners ?? [])]),
      transferDestinations: new Set([...own.map((k) => k.toBase58()), ...(extra.transferDestinations ?? [])]),
      newAccounts: new Set(newAccounts.map((k) => k.toBase58())),
      tokenDestinations: extra.tokenDestinations,
    };
  }

  private async lookupTables(tx: VersionedTransaction): Promise<AddressLookupTableAccount[]> {
    const keys = lookupTableKeys(tx);
    const res = await Promise.all(keys.map((k) => withRetry(() => this.d.conn.getAddressLookupTable(k), 2, 'getAddressLookupTable')));
    return res.map((r) => r.value).filter((v): v is AddressLookupTableAccount => !!v);
  }

  /** Rebuilds an SDK legacy transaction as v0 with our priority fee (and optional Jito tip). */
  private async compile(ixs: TransactionInstruction[], writable: string[]): Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number; tipAccount?: string }> {
    const cuPrice = await priorityFeeMicroLamports(this.d.conn, writable);
    // Drop the SDK's own compute-unit price; keep its unit limit if present.
    const body = ixs.filter((ix) => !(ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3));
    const out = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }), ...body];
    let tipAccount: string | undefined;
    if (this.d.jito) {
      const tip = await this.d.jito.tipInstruction(this.me, this.d.tipLamports ?? 10_000);
      out.push(tip.ix);
      tipAccount = tip.tipAccount;
    }
    const { blockhash, lastValidBlockHeight } = await withRetry(() => this.d.conn.getLatestBlockhash('confirmed'), 3, 'getLatestBlockhash');
    const msg = new TransactionMessage({ payerKey: this.me, recentBlockhash: blockhash, instructions: out }).compileToV0Message();
    return { tx: new VersionedTransaction(msg), lastValidBlockHeight, tipAccount };
  }

  /** Policy → kill switch → idempotency → simulate → send → confirm. */
  private async execute(
    key: string,
    tx: VersionedTransaction,
    lastValidBlockHeight: number,
    signers: Keypair[],
    policy: TxPolicy,
    /** Extra check on the signed transaction before sending (e.g. simulated balance changes) */
    check?: (tx: VersionedTransaction) => Promise<void>,
  ): Promise<string> {
    assertTxAllowed(tx, policy, await this.lookupTables(tx));
    if (await this.d.killSwitch.isKilled()) throw new TradingHalted('Kill switch is on. Nothing was sent.');
    if (!(await this.d.idempotency.claim(key))) throw new DuplicateAction(`Action ${key} already ran.`);
    tx.sign([this.d.agent, ...signers]);
    await simulateOrThrow(this.d.conn, tx);
    if (check) await check(tx);
    if (this.d.jito) {
      // One-transaction bundle; the tip transfer is inside the transaction itself.
      await this.d.jito.sendBundle([Buffer.from(tx.serialize()).toString('base64')]);
      return confirmOrCheck(this.d.conn, bs58.encode(tx.signatures[0]), tx.message.recentBlockhash, lastValidBlockHeight);
    }
    return sendAndConfirm(this.d.conn, tx, lastValidBlockHeight);
  }

  private async runLegacy(key: string, legacy: Transaction, signers: Keypair[] = [], extraPolicy: Partial<TxPolicy> = {}): Promise<string> {
    const writable = legacy.instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58()));
    const { tx, lastValidBlockHeight, tipAccount } = await this.compile(legacy.instructions, writable);
    const policy = this.policy(
      { ...extraPolicy, transferDestinations: new Set([...(extraPolicy.transferDestinations ?? []), ...(tipAccount ? [tipAccount] : [])]) },
      signers.map((s) => s.publicKey),
    );
    return this.execute(key, tx, lastValidBlockHeight, signers, policy);
  }

  // ---------- actions ----------

  /** USD prices for tokens outside the pool (set by the agent each cycle), used to fund swaps. */
  knownPrices: Record<string, number> = {};

  /** Swap from the vault's largest other holdings until it holds `usdNeeded` of `mint`. */
  private async acquire(mint: string, usdNeeded: number, prices: Record<string, number>, key: string, keep: string[]): Promise<string[]> {
    const sigs: string[] = [];
    const have = await this.holdings();
    let missing = usdNeeded - (have[mint] ?? 0) * (prices[mint] ?? 0);
    if (missing <= Math.max(1, usdNeeded * 0.02)) return sigs;
    const sources = Object.keys(have)
      .filter((m) => m !== mint && prices[m] && !keep.includes(m))
      .concat(keep.filter((m) => m !== mint && prices[m]))
      .sort((a, b) => (keep.includes(a) ? 1 : 0) - (keep.includes(b) ? 1 : 0) || (have[b] ?? 0) * prices[b] - (have[a] ?? 0) * prices[a]);
    for (const [i, m] of sources.entries()) {
      if (missing <= 1) break;
      const availUsd = (have[m] ?? 0) * prices[m];
      // Don't drain the other pool token below what the position needs from it.
      const spendable = keep.includes(m) ? Math.max(0, availUsd - usdNeeded) : availUsd;
      const takeUsd = Math.min(spendable, missing * 1.01);
      if (takeUsd < 1) continue;
      const r = await this.swap(m, mint, takeUsd / prices[m], { from: prices[m], to: prices[mint] }, `${key}:fund:${i}`);
      sigs.push(...r.txSigs);
      missing -= takeUsd;
    }
    return sigs;
  }

  async open(req: OpenRequest): Promise<OpenResult> {
    const { pool } = req;
    const prices = { ...this.knownPrices, [pool.mintX]: pool.usdX, [pool.mintY]: pool.usdY };
    const side = req.range ? sideOfRange(req.range) : (req.side ?? 'both');
    const dlmm = await DLMM.create(this.d.conn, new PublicKey(pool.address));
    // One-sided ranges cover the same 2n+1 bins, starting at the active bin and going up (X) or down (Y).
    // A range chosen by hand covers its own bins below and above the active bin.
    const count = req.range ? req.range.below + req.range.above + 1 : req.binsEachSide * 2 + 1;
    const rangeFor = (activeId: number) => {
      const minBinId = req.range ? activeId - req.range.below : side === 'both' ? activeId - req.binsEachSide : side === 'x' ? activeId : activeId - count + 1;
      return { minBinId, maxBinId: minBinId + count - 1 };
    };
    // How much of each token the range needs: half each when centred, but a lopsided range by hand needs more of one.
    const mix = req.range ? composition(openPosition(req.valueUsd / pool.usdY, pool.price, pool.binStep, 0, req.shape, side, req.range), pool.price) : null;
    const needX = mix ? mix.x * pool.usdX : req.valueUsd / 2;
    const needY = mix ? mix.y * pool.usdY : req.valueUsd / 2;

    // New bin arrays cost rent that is never refunded; skip ranges where that eats the position.
    // Checked before any funding swap, so a skipped open costs nothing.
    const r0 = rangeFor((await dlmm.getActiveBin()).binId);
    const { arrays, sol } = await this.setupRentSol(dlmm, r0.minBinId, r0.maxBinId);
    if (req.maxBinArrayCostPct != null) {
      const setupUsd = sol * (prices[NATIVE_MINT.toBase58()] ?? this.costs.solUsd);
      if (setupUsd > (req.valueUsd * req.maxBinArrayCostPct) / 100)
        throw new SetupTooCostly(
          `Opening here needs ${arrays} new bin array(s) costing $${setupUsd.toFixed(2)} in rent that is never refunded, more than ${req.maxBinArrayCostPct}% of the position.`,
        );
    }
    // The wallet must be able to pay the rent (position + bin arrays) and fees on top of the deposit.
    const needSol = sol + sdk().POSITION_FEE + 0.02;
    const nativeSol = (await withRetry(() => this.d.conn.getBalance(this.me), 3, 'getBalance')) / 1e9;
    if (nativeSol < needSol) throw new Error(`The vault wallet needs at least ${needSol.toFixed(3)} SOL for rent and fees; it has ${nativeSol.toFixed(3)}. Deposit a little SOL.`);

    const funding =
      side === 'both'
        ? [
            ...(await this.acquire(pool.mintX, needX, prices, `${req.key}:x`, [pool.mintY])),
            ...(await this.acquire(pool.mintY, needY, prices, `${req.key}:y`, [pool.mintX])),
          ]
        : side === 'x'
          ? await this.acquire(pool.mintX, req.valueUsd, prices, `${req.key}:x`, [])
          : await this.acquire(pool.mintY, req.valueUsd, prices, `${req.key}:y`, []);
    const have = await this.holdings();
    // Funding swaps may route through this pool and move its price: re-read it before building the deposit.
    await dlmm.refetchStates();
    const active = await dlmm.getActiveBin();
    const { minBinId, maxBinId } = rangeFor(active.binId);
    const strategy = { minBinId, maxBinId, strategyType: STRATEGY[req.shape], ...(side === 'x' ? { singleSidedX: true } : {}) };

    let x: BN;
    let y: BN;
    if (side === 'x') {
      x = raw(Math.min(have[pool.mintX] ?? 0, req.valueUsd / pool.usdX), pool.decimalsX);
      y = new BN(0);
    } else if (side === 'y') {
      x = new BN(0);
      y = raw(Math.min(have[pool.mintY] ?? 0, req.valueUsd / pool.usdY), pool.decimalsY);
    } else {
      // Balance X and Y for the strategy; scale down if Y is short.
      x = raw(Math.min(have[pool.mintX] ?? 0, needX / pool.usdX), pool.decimalsX);
      y = sdk().autoFillYByStrategy(active.binId, pool.binStep, x, active.xAmount, active.yAmount, minBinId, maxBinId, strategy.strategyType);
      const yAvail = raw(have[pool.mintY] ?? 0, pool.decimalsY);
      if (y.gt(yAvail)) {
        x = x.mul(yAvail).div(y.isZero() ? new BN(1) : y);
        y = yAvail;
      }
    }
    if (x.isZero() && y.isZero()) throw new Error('Not enough balance to open a position.');

    const positionKp = Keypair.generate();
    const sigs: string[] = [...funding];
    const bins = maxBinId - minBinId + 1;
    if (bins <= SINGLE_TX_BINS) {
      const t = await dlmm.initializePositionAndAddLiquidityByStrategy({ positionPubKey: positionKp.publicKey, totalXAmount: x, totalYAmount: y, strategy, user: this.me, slippage: 1 });
      sigs.push(await this.runLegacy(`${req.key}:open`, t, [positionKp]));
    } else {
      const create = await dlmm.createEmptyPosition({ positionPubKey: positionKp.publicKey, minBinId, maxBinId, user: this.me });
      sigs.push(await this.runLegacy(`${req.key}:create`, create, [positionKp]));
      const adds = await dlmm.addLiquidityByStrategyChunkable({ positionPubKey: positionKp.publicKey, totalXAmount: x, totalYAmount: y, strategy, user: this.me, slippage: 1 });
      for (const [i, t] of adds.entries()) sigs.push(await this.runLegacy(`${req.key}:add:${i}`, t));
    }
    return {
      address: positionKp.publicKey.toBase58(),
      lowerBin: minBinId,
      upperBin: maxBinId,
      bins: null,
      amountX: ui(x, pool.decimalsX),
      amountY: ui(y, pool.decimalsY),
      costUsd: this.txCostUsd(sigs.length),
      txSigs: sigs,
    };
  }

  /** Bin arrays the range needs that don't exist yet, and their rent (plus the bitmap extension if needed), in SOL. */
  private async setupRentSol(dlmm: DLMM, minBinId: number, maxBinId: number): Promise<{ arrays: number; sol: number }> {
    const m = sdk();
    const lo = m.binIdToBinArrayIndex(new BN(minBinId));
    const hi = m.binIdToBinArrayIndex(new BN(maxBinId));
    const keys: PublicKey[] = [];
    for (let i = lo.clone(); i.lte(hi); i = i.addn(1)) keys.push(m.deriveBinArray(dlmm.pubkey, i, dlmm.program.programId)[0]);
    const infos = await withRetry(() => this.d.conn.getMultipleAccountsInfo(keys), 2, 'getMultipleAccountsInfo');
    const arrays = infos.filter((a) => !a).length;
    const needsBitmap = (m.isOverflowDefaultBinArrayBitmap(lo) || m.isOverflowDefaultBinArrayBitmap(hi)) && !dlmm.binArrayBitmapExtension;
    return { arrays, sol: arrays * m.BIN_ARRAY_FEE + (needsBitmap ? m.BIN_ARRAY_BITMAP_FEE : 0) };
  }

  async close(p: PositionRef, pool: PoolCtx, key: string): Promise<ActionResult> {
    if (!p.address) throw new Error('Live position has no address');
    const before = await this.holdings();
    const dlmm = await DLMM.create(this.d.conn, new PublicKey(pool.address));
    const pos = await this.lbPosition(dlmm, p.address);
    const pd = pos.positionData;
    const feesUsd = ui(pd.feeXExcludeTransferFee, pool.decimalsX) * pool.usdX + ui(pd.feeYExcludeTransferFee, pool.decimalsY) * pool.usdY;
    const txs = await dlmm.removeLiquidity({
      user: this.me,
      position: pos.publicKey,
      fromBinId: pos.positionData.lowerBinId,
      toBinId: pos.positionData.upperBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });
    const sigs: string[] = [];
    for (const [i, t] of txs.entries()) sigs.push(await this.runLegacy(`${key}:close:${i}`, t));
    // What the position held (fees are reported separately, as in paper mode); the wallet's balance
    // change would also include the fees and the position rent refund.
    return {
      amountX: ui(pd.totalXAmountExcludeTransferFee, pool.decimalsX),
      amountY: ui(pd.totalYAmountExcludeTransferFee, pool.decimalsY),
      feesUsd,
      costUsd: this.txCostUsd(sigs.length),
      txSigs: sigs,
    };
  }

  async claim(p: PositionRef, pool: PoolCtx, key: string): Promise<ActionResult> {
    if (!p.address) throw new Error('Live position has no address');
    const dlmm = await DLMM.create(this.d.conn, new PublicKey(pool.address));
    const pos = await this.lbPosition(dlmm, p.address);
    const feesUsd = ui(pos.positionData.feeX, pool.decimalsX) * pool.usdX + ui(pos.positionData.feeY, pool.decimalsY) * pool.usdY;
    const txs = await dlmm.claimAllRewardsByPosition({ owner: this.me, position: pos });
    const sigs: string[] = [];
    for (const [i, t] of txs.entries()) sigs.push(await this.runLegacy(`${key}:claim:${i}`, t));
    return { amountX: 0, amountY: 0, feesUsd, costUsd: this.txCostUsd(sigs.length), txSigs: sigs };
  }

  /** Claim swap fees, then add the claimed amounts back into the same range. */
  async compound(p: PositionRef, pool: PoolCtx, key: string) {
    if (!p.address) throw new Error('Live position has no address');
    const dlmm = await DLMM.create(this.d.conn, new PublicKey(pool.address));
    const pos = await this.lbPosition(dlmm, p.address);
    // What actually arrives in the wallet (Token-2022 transfer fees excluded).
    const fx = pos.positionData.feeXExcludeTransferFee;
    const fy = pos.positionData.feeYExcludeTransferFee;
    const feesUsd = ui(fx, pool.decimalsX) * pool.usdX + ui(fy, pool.decimalsY) * pool.usdY;
    const sigs: string[] = [];
    // Claims swap fees and any farm rewards; only the swap fees (pool tokens) are added back.
    for (const [i, t] of (await dlmm.claimAllRewardsByPosition({ owner: this.me, position: pos })).entries()) sigs.push(await this.runLegacy(`${key}:claim:${i}`, t));
    // Chunked: a wide range doesn't fit one transaction. If the add fails, the fees stay as idle balance.
    const adds = await dlmm.addLiquidityByStrategyChunkable({
      positionPubKey: pos.publicKey,
      totalXAmount: fx,
      totalYAmount: fy,
      strategy: { minBinId: p.lowerBin, maxBinId: p.upperBin, strategyType: STRATEGY[p.shape] },
      user: this.me,
      slippage: 1,
    });
    for (const [i, t] of adds.entries()) sigs.push(await this.runLegacy(`${key}:add:${i}`, t));
    return { amountX: 0, amountY: 0, feesUsd, costUsd: this.txCostUsd(sigs.length), txSigs: sigs, bins: null };
  }

  /** The agent's token accounts and raw balances, for checking what a swap would move. */
  private async tokenAccounts(): Promise<{ address: string; mint: string; amount: bigint }[]> {
    const out: { address: string; mint: string; amount: bigint }[] = [];
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const r = await withRetry(() => this.d.conn.getParsedTokenAccountsByOwner(this.me, { programId }), 3, 'getParsedTokenAccountsByOwner');
      for (const a of r.value) out.push({ address: a.pubkey.toBase58(), mint: a.account.data.parsed.info.mint, amount: BigInt(a.account.data.parsed.info.tokenAmount.amount) });
    }
    return out;
  }

  /**
   * Jupiter swap: quote → checks → swap tx → allowlist check → simulate → balance check → send.
   * Jupiter builds this transaction remotely, so it is checked on what it would actually do to the
   * vault: only the input token may leave, by no more than the input amount, and at least the
   * quoted minimum must arrive in the agent's own account.
   */
  async swap(fromMint: string, toMint: string, uiAmount: number, usd: { from: number; to: number; poolTvlUsd?: number }, key: string): Promise<ActionResult> {
    const decimals = await this.decimals(fromMint);
    const amountRaw = raw(uiAmount, decimals).toString();
    if (amountRaw === '0') return { amountX: 0, amountY: 0, feesUsd: 0, costUsd: 0, txSigs: [] };
    // With Jito the tip transfer is appended to Jupiter's transaction; fewer route accounts leave room for it.
    const quote = await this.jupiter.quote(fromMint, toMint, amountRaw, 50, this.d.jito ? 54 : undefined);
    if (quote.inputMint !== fromMint || quote.outputMint !== toMint || quote.inAmount !== amountRaw || quote.swapMode !== 'ExactIn' || quote.slippageBps > 100)
      throw new PolicyViolation('The swap quote does not match the request.');
    const outDecimals = await this.decimals(toMint);
    const minOut = BigInt(quote.otherAmountThreshold);
    // Price sanity against market prices: refuse fills far below fair value (thin or falling pools).
    if (usd.from > 0 && usd.to > 0) {
      const inUsd = ui(amountRaw, decimals) * usd.from;
      const outUsd = ui(quote.otherAmountThreshold, outDecimals) * usd.to;
      if (outUsd < inUsd * (1 - MAX_SWAP_LOSS))
        throw new Error(`Swap would return about $${outUsd.toFixed(2)} for $${inUsd.toFixed(2)}, more than ${MAX_SWAP_LOSS * 100}% below market. Not swapping.`);
    }

    const { swapTransaction, lastValidBlockHeight } = await this.jupiter.swap(quote, this.me.toBase58());
    let tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    let extra: Partial<TxPolicy> = {};
    if (this.d.jito) {
      // Jito only lands bundles that pay a tip, so add the tip transfer to Jupiter's transaction.
      const alts = await this.lookupTables(tx);
      const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: alts });
      const tip = await this.d.jito.tipInstruction(this.me, this.d.tipLamports ?? 10_000);
      msg.instructions.push(tip.ix);
      tx = new VersionedTransaction(msg.compileToV0Message(alts));
      extra = { transferDestinations: new Set([tip.tipAccount]) };
    }

    const SOL = NATIVE_MINT.toBase58();
    const before = await this.tokenAccounts();
    const lamportsBefore = BigInt(await withRetry(() => this.d.conn.getBalance(this.me), 3, 'getBalance'));
    const watch = [...before];
    if (toMint !== SOL) {
      const mintInfo = await withRetry(() => this.d.conn.getAccountInfo(new PublicKey(toMint)), 2, 'getAccountInfo');
      const ata = getAssociatedTokenAddressSync(new PublicKey(toMint), this.me, true, mintInfo?.owner ?? TOKEN_PROGRAM_ID).toBase58();
      if (!watch.some((a) => a.address === ata)) watch.push({ address: ata, mint: toMint, amount: 0n });
    }
    const check = async (signed: VersionedTransaction) => {
      const post = await simulateWithAccounts(this.d.conn, signed, [...watch.map((a) => a.address), this.me.toBase58()]);
      const delta = new Map<string, bigint>();
      watch.forEach((a, i) => {
        const acc = post[i];
        const buf = acc ? Buffer.from(acc.data[0], 'base64') : null;
        // SPL token account layout (Token and Token-2022 base): amount is the u64 at offset 64.
        const after = buf && buf.length >= 72 ? buf.readBigUInt64LE(64) : 0n;
        delta.set(a.mint, (delta.get(a.mint) ?? 0n) + after - a.amount);
      });
      const lamportsAfter = BigInt(post[watch.length]?.lamports ?? 0);
      const solDelta = lamportsAfter - lamportsBefore + (delta.get(SOL) ?? 0n); // native + wrapped
      const tol = BigInt(SWAP_SOL_TOLERANCE);
      for (const [mint, d] of delta) if (d < 0n && mint !== fromMint && mint !== SOL) throw new PolicyViolation(`Swap would move another token (${mint}) out of the vault.`);
      if (fromMint === SOL ? -solDelta > BigInt(amountRaw) + tol : -(delta.get(fromMint) ?? 0n) > BigInt(amountRaw))
        throw new PolicyViolation('Swap would take more than the requested amount.');
      if (fromMint !== SOL && -solDelta > tol) throw new PolicyViolation('Swap would spend too much SOL.');
      if (toMint === SOL ? solDelta < minOut - tol : (delta.get(toMint) ?? 0n) < minOut)
        throw new PolicyViolation("Swap output wouldn't arrive in the vault wallet.");
    };
    const sig = await this.execute(`${key}:swap`, tx, lastValidBlockHeight, [], this.policy(extra), check);
    return { amountX: 0, amountY: 0, feesUsd: 0, costUsd: this.txCostUsd(TX_COUNT.swap), txSigs: [sig] };
  }

  private async decimals(mint: string): Promise<number> {
    if (mint === NATIVE_MINT.toBase58()) return 9;
    const info = await withRetry(() => this.d.conn.getParsedAccountInfo(new PublicKey(mint)), 2, 'getParsedAccountInfo');
    const data = info.value?.data;
    if (data && 'parsed' in data) return data.parsed.info.decimals as number;
    throw new Error(`Could not read decimals for ${mint}`);
  }

  /**
   * Withdraw to the owner's registered wallet, and nowhere else (CLAUDE.md §3).
   * SOL is sent as native SOL; tokens go to the owner's associated token account.
   */
  /** Native SOL that can be withdrawn: all of it when nothing is deployed, otherwise above the reserve. */
  async withdrawableSol(nothingDeployed: boolean): Promise<number> {
    const lamports = await withRetry(() => this.d.conn.getBalance(this.me), 3, 'getBalance');
    return Math.max(0, lamports / 1e9 - (nothingDeployed ? 0.001 : SOL_RESERVE));
  }

  async withdraw(mint: string, uiAmount: number, key: string): Promise<string> {
    const owner = this.d.ownerWallet;
    let ixs: TransactionInstruction[];
    let policyExtra: Partial<TxPolicy>;
    if (mint === NATIVE_MINT.toBase58()) {
      ixs = [
        // A plain transfer uses ~450 compute units. Without a limit the priority fee is paid on 200,000, which on a
        // busy network can eat into the 0.001 SOL a full withdrawal leaves and break the vault's rent minimum.
        ComputeBudgetProgram.setComputeUnitLimit({ units: 3_000 }),
        SystemProgram.transfer({ fromPubkey: this.me, toPubkey: owner, lamports: Math.floor(uiAmount * 1e9) }),
      ];
      policyExtra = { transferDestinations: new Set([owner.toBase58()]) };
    } else {
      const mintPk = new PublicKey(mint);
      const info = await withRetry(() => this.d.conn.getAccountInfo(mintPk), 2, 'getAccountInfo');
      const programId = info?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const decimals = await this.decimals(mint);
      const from = getAssociatedTokenAddressSync(mintPk, this.me, true, programId);
      const to = getAssociatedTokenAddressSync(mintPk, owner, true, programId);
      ixs = [
        createAssociatedTokenAccountIdempotentInstruction(this.me, to, owner, mintPk, programId),
        createTransferCheckedInstruction(from, mintPk, to, this.me, BigInt(raw(uiAmount, decimals).toString()), decimals, [], programId),
      ];
      policyExtra = { tokenDestinations: new Set([to.toBase58()]), ataOwners: new Set([owner.toBase58()]) };
    }
    const legacy = new Transaction().add(...ixs);
    try {
      return await this.runLegacy(`${key}:withdraw`, legacy, [], policyExtra);
    } catch (e) {
      if (e instanceof PolicyViolation) throw new PolicyViolation(`Withdrawal blocked: ${e.message}`);
      throw e;
    }
  }
}

/**
 * Every token a wallet holds (SPL and Token-2022), with its decimals: UI amounts, SOL and wrapped SOL
 * together under the SOL mint (always listed, even at 0). For display only.
 */
export async function walletTokens(conn: Connection, owner: string): Promise<{ mint: string; amount: number; decimals: number }[]> {
  const pk = new PublicKey(owner);
  const [lamports, ...lists] = await Promise.all([
    withRetry(() => conn.getBalance(pk), 2, 'getBalance'),
    ...[TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) => withRetry(() => conn.getParsedTokenAccountsByOwner(pk, { programId }), 2, 'getParsedTokenAccountsByOwner')),
  ]);
  const out = new Map<string, { amount: number; decimals: number }>([[NATIVE_MINT.toBase58(), { amount: (lamports as number) / 1e9, decimals: 9 }]]);
  for (const list of lists as Awaited<ReturnType<Connection['getParsedTokenAccountsByOwner']>>[])
    for (const a of list.value) {
      const info = a.account.data.parsed?.info;
      const amt = Number(info?.tokenAmount?.uiAmount ?? 0);
      if (!info?.mint || !(amt > 0)) continue;
      const prev = out.get(info.mint);
      out.set(info.mint, { amount: (prev?.amount ?? 0) + amt, decimals: Number(info.tokenAmount?.decimals ?? prev?.decimals ?? 0) });
    }
  return [...out].map(([mint, t]) => ({ mint, ...t }));
}

/** Everything a wallet holds, by mint (UI amounts; SOL and wrapped SOL together). For display only. */
export async function walletBalances(conn: Connection, owner: string): Promise<Record<string, number>> {
  return Object.fromEntries((await walletTokens(conn, owner)).map((t) => [t.mint, t.amount]));
}
