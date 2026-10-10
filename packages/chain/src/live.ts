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
import { DEFAULT_COSTS, type CostModel, type LiquidityShape } from '@binwise/core';
import { TX_COUNT, type ActionResult, type Executor, type Holdings, type MarkResult, type OpenRequest, type OpenResult, type PoolCtx, type PositionRef } from './executor';
import { JitoClient } from './jito';
import { JupiterClient } from './jupiter';
import { PolicyViolation, assertTxAllowed, lookupTableKeys, type TxPolicy } from './programs';
import { priorityFeeMicroLamports, sendAndConfirm, simulateOrThrow } from './rpc';
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
export class DuplicateAction extends Error {}

import { DLMM, sdk } from './sdk';
type DLMM = DLMMClass;

// StrategyType values from the SDK: Spot = 0, Curve = 1, BidAsk = 2.
const STRATEGY: Record<LiquidityShape, StrategyTypeEnum> = {
  spot: 0 as StrategyTypeEnum,
  curve: 1 as StrategyTypeEnum,
  bidask: 2 as StrategyTypeEnum,
};

/** SOL kept aside for fees and rent; never deployed. */
const SOL_RESERVE = 0.15;
/** DLMM: max bins one add-liquidity transaction handles (SDK MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX). */
const SINGLE_TX_BINS = 26;

const raw = (ui: number, decimals: number) => new BN(Math.floor(ui * 10 ** decimals).toString());
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

  async holdings(): Promise<Holdings> {
    const out: Holdings = {};
    const lamports = await withRetry(() => this.d.conn.getBalance(this.me), 3, 'getBalance');
    out[NATIVE_MINT.toBase58()] = Math.max(0, lamports / 1e9 - SOL_RESERVE);
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const r = await withRetry(() => this.d.conn.getParsedTokenAccountsByOwner(this.me, { programId }), 3, 'getParsedTokenAccountsByOwner');
      for (const a of r.value) {
        const info = a.account.data.parsed.info;
        out[info.mint] = (out[info.mint] ?? 0) + Number(info.tokenAmount.uiAmount ?? 0);
      }
    }
    return out;
  }

  private async lbPosition(dlmm: DLMM, address: string): Promise<LbPosition> {
    return withRetry(() => dlmm.getPosition(new PublicKey(address)), 3, 'getPosition');
  }

  async mark(p: PositionRef, pool: PoolCtx): Promise<MarkResult> {
    if (!p.address) throw new Error('Live position has no address');
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
  ): Promise<string> {
    assertTxAllowed(tx, policy, await this.lookupTables(tx));
    if (await this.d.killSwitch.isKilled()) throw new TradingHalted('Kill switch is on. Nothing was sent.');
    if (!(await this.d.idempotency.claim(key))) throw new DuplicateAction(`Action ${key} already ran.`);
    tx.sign([this.d.agent, ...signers]);
    await simulateOrThrow(this.d.conn, tx);
    if (this.d.jito) {
      // One-transaction bundle; the tip transfer is inside the transaction itself.
      await this.d.jito.sendBundle([Buffer.from(tx.serialize()).toString('base64')]);
      const signature = bs58.encode(tx.signatures[0]);
      const res = await this.d.conn.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, 'confirmed');
      if (res.value.err) throw new Error(`Bundle transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
      return signature;
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
      .sort((a, b) => (keep.includes(a) ? 1 : 0) - (keep.includes(b) ? 1 : 0) || have[b] * prices[b] - have[a] * prices[a]);
    for (const [i, m] of sources.entries()) {
      if (missing <= 1) break;
      const availUsd = have[m] * prices[m];
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
    const funding = [
      ...(await this.acquire(pool.mintX, req.valueUsd / 2, prices, `${req.key}:x`, [pool.mintY])),
      ...(await this.acquire(pool.mintY, req.valueUsd / 2, prices, `${req.key}:y`, [pool.mintX])),
    ];
    const dlmm = await DLMM.create(this.d.conn, new PublicKey(pool.address));
    const active = await dlmm.getActiveBin();
    const minBinId = active.binId - req.binsEachSide;
    const maxBinId = active.binId + req.binsEachSide;
    const strategy = { minBinId, maxBinId, strategyType: STRATEGY[req.shape] };
    const have = await this.holdings();

    // Balance X and Y for the strategy; scale down if Y is short.
    let x = raw(Math.min(have[pool.mintX] ?? 0, req.valueUsd / 2 / pool.usdX), pool.decimalsX);
    let y = sdk().autoFillYByStrategy(active.binId, pool.binStep, x, active.xAmount, active.yAmount, minBinId, maxBinId, strategy.strategyType);
    const yAvail = raw(have[pool.mintY] ?? 0, pool.decimalsY);
    if (y.gt(yAvail)) {
      x = x.mul(yAvail).div(y.isZero() ? new BN(1) : y);
      y = yAvail;
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

  async close(p: PositionRef, pool: PoolCtx, key: string): Promise<ActionResult> {
    if (!p.address) throw new Error('Live position has no address');
    const before = await this.holdings();
    const dlmm = await DLMM.create(this.d.conn, new PublicKey(pool.address));
    const pos = await this.lbPosition(dlmm, p.address);
    const feesUsd = ui(pos.positionData.feeX, pool.decimalsX) * pool.usdX + ui(pos.positionData.feeY, pool.decimalsY) * pool.usdY;
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
    const after = await this.holdings();
    return {
      amountX: (after[pool.mintX] ?? 0) - (before[pool.mintX] ?? 0),
      amountY: (after[pool.mintY] ?? 0) - (before[pool.mintY] ?? 0),
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
    const fx = pos.positionData.feeX;
    const fy = pos.positionData.feeY;
    const feesUsd = ui(fx, pool.decimalsX) * pool.usdX + ui(fy, pool.decimalsY) * pool.usdY;
    const sigs: string[] = [];
    for (const [i, t] of (await dlmm.claimSwapFee({ owner: this.me, position: pos })).entries()) sigs.push(await this.runLegacy(`${key}:claim:${i}`, t));
    const add = await dlmm.addLiquidityByStrategy({
      positionPubKey: pos.publicKey,
      totalXAmount: fx,
      totalYAmount: fy,
      strategy: { minBinId: p.lowerBin, maxBinId: p.upperBin, strategyType: STRATEGY[p.shape] },
      user: this.me,
      slippage: 1,
    });
    sigs.push(await this.runLegacy(`${key}:add`, add));
    return { amountX: 0, amountY: 0, feesUsd, costUsd: this.txCostUsd(sigs.length), txSigs: sigs, bins: null };
  }

  /** Jupiter swap: quote → swap tx → allowlist check → simulate → send. */
  async swap(fromMint: string, toMint: string, uiAmount: number, _usd: { from: number; to: number; poolTvlUsd?: number }, key: string): Promise<ActionResult> {
    const decimals = await this.decimals(fromMint);
    const amountRaw = raw(uiAmount, decimals).toString();
    if (amountRaw === '0') return { amountX: 0, amountY: 0, feesUsd: 0, costUsd: 0, txSigs: [] };
    const quote = await this.jupiter.quote(fromMint, toMint, amountRaw, 50);
    const { swapTransaction, lastValidBlockHeight } = await this.jupiter.swap(quote, this.me.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    const sig = await this.execute(`${key}:swap`, tx, lastValidBlockHeight, [], this.policy());
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
  async withdraw(mint: string, uiAmount: number, key: string): Promise<string> {
    const owner = this.d.ownerWallet;
    let ixs: TransactionInstruction[];
    let policyExtra: Partial<TxPolicy>;
    if (mint === NATIVE_MINT.toBase58()) {
      ixs = [SystemProgram.transfer({ fromPubkey: this.me, toPubkey: owner, lamports: Math.floor(uiAmount * 1e9) })];
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
      policyExtra = { tokenDestinations: new Set([to.toBase58()]) };
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
