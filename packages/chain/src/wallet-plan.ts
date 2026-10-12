import type DLMMClass from '@meteora-ag/dlmm';
import type { LbPosition } from '@meteora-ag/dlmm';
import { ComputeBudgetProgram, Keypair, PublicKey, VersionedTransaction, type Connection, type Transaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import { DEFAULT_COSTS, composition, openPosition, type CostModel, type CustomRange, type LiquidityShape, type LiquiditySide } from '@binwise/core';
import type { ActionResult, Executor, Holdings, MarkResult, OpenResult, PoolCtx, PositionRef } from './executor';
import { withRetry } from './http';
import type { JupiterClient, JupiterQuote } from './jupiter';
import { MAX_SWAP_LOSS, SINGLE_TX_BINS, STRATEGY, markPosition, raw, setupRent, ui } from './live';
import { PolicyViolation } from './programs';
import { priorityFeeMicroLamports } from './rpc';
import { DLMM, dlmmClass, sdk } from './sdk';

/**
 * Self-custody: Binwise holds no key. For each action it builds the transactions the owner's own wallet
 * signs (any Wallet Standard wallet), with the owner as fee payer and signer: Jupiter swaps, and Meteora
 * DLMM open / add / remove / claim. A new position's account is the only other signer; its key is made
 * here, signs that one transaction and is thrown away (the account never holds funds of its own).
 *
 * Everything is built at once so the wallet asks once. A step that depends on an earlier one (liquidity
 * added from a swap's output) uses the swap's guaranteed minimum, so it never asks for more than the
 * wallet will hold; whatever a swap returns above its minimum stays in the owner's wallet.
 */

const SOL = NATIVE_MINT.toBase58();
/** Highest priority fee put on the owner's transactions, micro-lamports per compute unit (the agent's cap is higher). */
const WALLET_CU_PRICE_CAP = 500_000;
/** SOL a new position and its token accounts need besides bin arrays: position rent (refunded on close) plus fees. */
const OPEN_SOL_MARGIN = 0.02;

export class NeedsOwnerApproval extends Error {}

/** One transaction for the owner's wallet to sign, base64 (other required signers already signed). */
export interface WalletStep {
  label: string;
  tx: string;
  /** 'swap' steps can be checked before signing; later steps rely on them */
  kind: 'swap' | 'open' | 'add' | 'close' | 'claim';
  /** A swap: what it may take and must deliver, checked again right before it is sent (raw amounts) */
  check?: SwapCheck;
}

/** What a swap may take from the owner's wallet and the least it must deliver there (raw amounts). */
export interface SwapCheck {
  from: string;
  to: string;
  amountIn: string;
  minOut: string;
}

export interface WalletPlanDeps {
  conn: Connection;
  jupiter: Pick<JupiterClient, 'quote' | 'swap'>;
  /** The wallet signs legacy transactions only (no lookup tables): ask Jupiter for legacy routes */
  legacyOnly?: boolean;
  /** Token symbols by mint, for the step labels the owner sees */
  symbols?: Record<string, string>;
}

const symbolOf = (d: WalletPlanDeps, mint: string) => (mint === SOL ? 'SOL' : (d.symbols?.[mint] ?? `${mint.slice(0, 4)}…`));

/** UI amounts by mint */
export type Amounts = Record<string, number>;

export interface SwapStep {
  from: string;
  to: string;
  inUi: number;
  /** Guaranteed minimum out (the quote's slippage floor) */
  minOutUi: number;
}

export interface OpenPlan {
  steps: WalletStep[];
  swaps: SwapStep[];
  /** The position this plan opens */
  position: { address: string; lowerBin: number; upperBin: number; amountX: number; amountY: number };
  /** SOL the wallet needs on top of what is put in: position rent (refunded on close), new bin arrays (not refunded), fees */
  rentSol: number;
  /** New bin arrays the range needs (their rent is never refunded) */
  newBinArrays: number;
}

export interface OpenWalletRequest {
  owner: string;
  pool: PoolCtx;
  /** What the plan may spend from the wallet (e.g. { SOL: 1 }), UI amounts */
  budget: Amounts;
  /** USD price of every budget token and both pool tokens */
  prices: Amounts;
  shape: LiquidityShape;
  side: LiquiditySide;
  binsEachSide: number;
  range?: CustomRange;
  /**
   * What earlier steps of the same plan bring into the wallet before this one runs (a rebalance's close):
   * counted as there, and the swaps are checked when they are sent instead of now.
   */
  incoming?: Amounts;
}

const fromBase64 = (b64: string) => Buffer.from(b64, 'base64');
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** USD prices must be known for every token the plan touches. */
function priced(prices: Amounts, mint: string): number {
  const p = prices[mint];
  if (!(p > 0)) throw new Error(`No price for ${mint.slice(0, 4)}…: can't size this safely.`);
  return p;
}

/**
 * Readies one of the DLMM SDK's legacy transactions for the owner: our priority fee (capped) instead of
 * the SDK's, the owner as fee payer, a fresh blockhash, and signed by `signers` (a new position account).
 */
async function forOwner(d: WalletPlanDeps, tx: Transaction, owner: PublicKey, signers: Keypair[] = []): Promise<string> {
  const writable = tx.instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58()));
  const cuPrice = await priorityFeeMicroLamports(d.conn, writable, WALLET_CU_PRICE_CAP);
  const body = tx.instructions.filter((ix) => !(ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3));
  tx.instructions = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }), ...body];
  const { blockhash, lastValidBlockHeight } = await withRetry(() => d.conn.getLatestBlockhash('confirmed'), 3, 'getLatestBlockhash');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = owner;
  if (signers.length) tx.partialSign(...signers);
  return toBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

async function decimalsOf(conn: Connection, mint: string, pool?: PoolCtx): Promise<number> {
  if (mint === SOL) return 9;
  if (pool && mint === pool.mintX) return pool.decimalsX;
  if (pool && mint === pool.mintY) return pool.decimalsY;
  const info = await withRetry(() => conn.getParsedAccountInfo(new PublicKey(mint)), 2, 'getParsedAccountInfo');
  const data = info.value?.data;
  const dec = data && 'parsed' in data ? Number(data.parsed?.info?.decimals) : NaN;
  if (!Number.isFinite(dec)) throw new Error(`Couldn't read the decimals of ${mint.slice(0, 4)}….`);
  return dec;
}

/** The owner's token accounts by mint (raw amounts), for checking what a transaction would move. */
async function ownerTokenAccounts(conn: Connection, owner: PublicKey) {
  const out: { address: string; mint: string; amount: bigint }[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const r = await withRetry(() => conn.getParsedTokenAccountsByOwner(owner, { programId }), 3, 'getParsedTokenAccountsByOwner');
    for (const a of r.value) out.push({ address: a.pubkey.toBase58(), mint: a.account.data.parsed.info.mint, amount: BigInt(a.account.data.parsed.info.tokenAmount.amount) });
  }
  return out;
}

/**
 * Builds a Jupiter swap for the owner (ExactIn, 0.5% slippage) and checks it before the owner sees it:
 * the quote matches the request, the guaranteed minimum is within 3% of market value, and a simulation
 * against the owner's accounts shows only the input leaving (by at most its amount, plus fees) and at
 * least the minimum arriving. A bad route never reaches the wallet.
 */
async function swapStep(
  d: WalletPlanDeps,
  owner: PublicKey,
  from: string,
  to: string,
  inUi: number,
  prices: Amounts,
  pool?: PoolCtx,
  /** False when an earlier step must land first (the tokens are still in a position): checked at send time only */
  precheck = true,
): Promise<{ step: WalletStep; swap: SwapStep }> {
  const [decIn, decOut] = await Promise.all([decimalsOf(d.conn, from, pool), decimalsOf(d.conn, to, pool)]);
  const amountRaw = raw(inUi, decIn).toString();
  if (amountRaw === '0') throw new Error('Swap amount is too small.');
  const quote: JupiterQuote = await d.jupiter.quote(from, to, amountRaw, 50, undefined, d.legacyOnly);
  if (quote.inputMint !== from || quote.outputMint !== to || quote.inAmount !== amountRaw || quote.swapMode !== 'ExactIn' || quote.slippageBps > 100)
    throw new PolicyViolation('The swap quote does not match the request.');
  const minOutUi = ui(quote.otherAmountThreshold, decOut);
  const inUsd = ui(amountRaw, decIn) * priced(prices, from);
  const outUsd = minOutUi * priced(prices, to);
  if (outUsd < inUsd * (1 - MAX_SWAP_LOSS))
    throw new Error(`Swapping would return about $${outUsd.toFixed(2)} for $${inUsd.toFixed(2)}, more than ${MAX_SWAP_LOSS * 100}% below market. Try a smaller amount or another pool.`);
  const { swapTransaction } = await d.jupiter.swap(quote, owner.toBase58(), 200_000, d.legacyOnly);
  const check: SwapCheck = { from, to, amountIn: amountRaw, minOut: quote.otherAmountThreshold };
  if (precheck) await checkSwapEffects(d.conn, owner, VersionedTransaction.deserialize(fromBase64(swapTransaction)), check);
  return { step: { label: `Swap ${symbolOf(d, from)} → ${symbolOf(d, to)}`, tx: swapTransaction, kind: 'swap', check }, swap: { from, to, inUi: ui(amountRaw, decIn), minOutUi } };
}

/** Lamports a swap may use besides its input: network fee, priority fee, new token accounts. */
const SWAP_SOL_TOLERANCE = 10_000_000n;

/**
 * Simulates a swap for the owner and refuses it unless it only does what was asked: only `from` leaves the
 * wallet (at most its amount, plus fees) and at least the minimum of `to` arrives in the owner's own account
 * for it. Unsigned before the wallet sees it (`signed` false), or as signed right before it is sent.
 *
 * Only accounts the transaction itself uses can change, and Solana reports at most that many, so the check
 * watches the owner's token accounts among them, the owner's account for `to`, and the owner's SOL.
 */
export async function checkSwapEffects(conn: Connection, owner: PublicKey, tx: VersionedTransaction, c: SwapCheck, signed = false) {
  if (!tx.message.staticAccountKeys[0]?.equals(owner)) throw new PolicyViolation('The swap is not paid by your wallet.');
  const tables = await Promise.all(
    tx.message.addressTableLookups.map(async (l) => {
      const t = (await withRetry(() => conn.getAddressLookupTable(l.accountKey), 3, 'getAddressLookupTable')).value;
      if (!t) throw new Error("Couldn't read the swap's route right now. Nothing was sent; try again.");
      return t;
    }),
  );
  const inTx = new Set(tx.message.getAccountKeys({ addressLookupTableAccounts: tables }).keySegments().flat().map((k) => k.toBase58()));
  const watch = (await ownerTokenAccounts(conn, owner)).filter((a) => inTx.has(a.address));
  if (c.to !== SOL) {
    // Where the output must land: the owner's associated account for it (made by the swap if new).
    const mintInfo = await withRetry(() => conn.getAccountInfo(new PublicKey(c.to)), 2, 'getAccountInfo');
    const ata = getAssociatedTokenAddressSync(new PublicKey(c.to), owner, true, mintInfo?.owner ?? TOKEN_PROGRAM_ID).toBase58();
    if (!watch.some((a) => a.address === ata)) watch.push({ address: ata, mint: c.to, amount: 0n });
  }
  const lamportsBefore = BigInt(await withRetry(() => conn.getBalance(owner), 3, 'getBalance'));
  const r = await withRetry(
    () =>
      conn.simulateTransaction(tx, {
        sigVerify: signed,
        // A signed transaction keeps its blockhash (Solana can't verify signatures on a replaced one).
        replaceRecentBlockhash: !signed,
        commitment: 'processed',
        accounts: { encoding: 'base64', addresses: [...watch.map((a) => a.address), owner.toBase58()] },
      }),
    2,
    'simulateTransaction',
  );
  if (r.value.err) throw new SwapRefused(r.value.err, r.value.logs);
  const post = r.value.accounts ?? [];
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
  const amountIn = BigInt(c.amountIn);
  const minOut = BigInt(c.minOut);
  for (const [mint, dl] of delta) if (dl < 0n && mint !== c.from && mint !== SOL) throw new PolicyViolation(`The swap would move another token (${mint.slice(0, 4)}…) out of your wallet.`);
  if (c.from === SOL ? -solDelta > amountIn + SWAP_SOL_TOLERANCE : -(delta.get(c.from) ?? 0n) > amountIn) throw new PolicyViolation('The swap would take more than asked.');
  if (c.from !== SOL && -solDelta > SWAP_SOL_TOLERANCE) throw new PolicyViolation('The swap would spend too much SOL.');
  if (c.to === SOL ? solDelta < minOut - SWAP_SOL_TOLERANCE : (delta.get(c.to) ?? 0n) < minOut) throw new PolicyViolation("The swap's output wouldn't arrive in your wallet.");
}

/** Solana would refuse the swap (not a policy problem): its error and logs, for a plain answer. */
export class SwapRefused extends Error {
  constructor(
    readonly err: unknown,
    readonly logs: string[] | null | undefined,
  ) {
    super(`The swap wouldn't go through right now (${JSON.stringify(err)}). Nothing was sent; try again.`);
  }
}

/** The position's bins for the request, around the active bin. */
function rangeAround(activeId: number, r: Pick<OpenWalletRequest, 'side' | 'binsEachSide' | 'range'>) {
  const count = r.range ? r.range.below + r.range.above + 1 : r.binsEachSide * 2 + 1;
  const minBinId = r.range ? activeId - r.range.below : r.side === 'both' ? activeId - r.binsEachSide : r.side === 'x' ? activeId : activeId - count + 1;
  return { minBinId, maxBinId: minBinId + count - 1 };
}

/**
 * Opens a position in the owner's wallet from a budget: swaps what the range needs from the budget
 * (other tokens first, then the other pool token beyond its own share), then adds both tokens with the
 * shape. Checks the wallet keeps enough SOL for the position's rent and fees.
 */
export async function planOpen(d: WalletPlanDeps, req: OpenWalletRequest): Promise<OpenPlan> {
  const { pool, prices } = req;
  const owner = new PublicKey(req.owner);
  const dlmm: DLMMClass = await DLMM.create(d.conn, new PublicKey(pool.address));
  const active = await dlmm.getActiveBin();
  const { minBinId, maxBinId } = rangeAround(active.binId, req);
  const rent = await setupRent(d.conn, dlmm, minBinId, maxBinId);
  const rentSol = rent.sol + sdk().POSITION_FEE + OPEN_SOL_MARGIN;

  const usd = (m: string) => priced(prices, m);
  const valueUsd = Object.entries(req.budget).reduce((s, [m, a]) => s + a * usd(m), 0);
  if (!(valueUsd > 0)) throw new Error('Nothing to add.');
  // The wallet pays the budget and, on top, the rent and fees (counting what earlier steps bring in).
  const nativeSol = (await withRetry(() => d.conn.getBalance(owner), 3, 'getBalance')) / 1e9 + (req.incoming?.[SOL] ?? 0);
  const solSpent = req.budget[SOL] ?? 0;
  if (nativeSol < solSpent + rentSol)
    throw new Error(`Your wallet needs about ${(solSpent + rentSol).toFixed(3)} SOL for this: ${solSpent ? `${Number(solSpent.toFixed(4))} SOL into the LP and ` : ''}${rentSol.toFixed(3)} SOL for the position's rent and fees (the rent comes back when it closes). It has ${nativeSol.toFixed(3)}.`);

  // What the range needs of each token, in USD.
  const mix = req.range ? composition(openPosition(valueUsd / pool.usdY, pool.price, pool.binStep, 0, req.shape, req.side, req.range), pool.price) : null;
  const needUsd: Amounts = {
    [pool.mintX]: req.side === 'y' ? 0 : req.side === 'x' ? valueUsd : mix ? mix.x * pool.usdX : valueUsd / 2,
    [pool.mintY]: req.side === 'x' ? 0 : req.side === 'y' ? valueUsd : mix ? mix.y * pool.usdY : valueUsd / 2,
  };

  // Swap the budget into the two tokens, counting each swap's guaranteed minimum.
  const have: Amounts = { ...req.budget };
  const steps: WalletStep[] = [];
  const swaps: SwapStep[] = [];
  for (const target of [pool.mintX, pool.mintY]) {
    let missing = needUsd[target] - (have[target] ?? 0) * usd(target);
    if (missing <= Math.max(0.5, needUsd[target] * 0.01)) continue;
    const other = target === pool.mintX ? pool.mintY : pool.mintX;
    const sources = Object.keys(have)
      .filter((m) => m !== target && (have[m] ?? 0) > 0)
      .sort((a, b) => (a === other ? 1 : 0) - (b === other ? 1 : 0) || have[b] * usd(b) - have[a] * usd(a));
    for (const src of sources) {
      if (missing <= 0.5) break;
      // The other pool token keeps what its own side needs.
      const spendableUsd = have[src] * usd(src) - (src === other ? needUsd[other] : 0);
      const takeUsd = Math.min(spendableUsd, missing);
      if (takeUsd < 0.5) continue;
      const inUi = Math.min(have[src], takeUsd / usd(src));
      const s = await swapStep(d, owner, src, target, inUi, prices, pool, !req.incoming);
      steps.push(s.step);
      swaps.push(s.swap);
      have[src] -= s.swap.inUi;
      have[target] = (have[target] ?? 0) + s.swap.minOutUi;
      missing -= takeUsd;
    }
  }

  // Amounts to add, never more than the wallet will hold (swaps at their minimum).
  const strategy = { minBinId, maxBinId, strategyType: STRATEGY[req.shape], ...(req.side === 'x' ? { singleSidedX: true } : {}) };
  let x: BN;
  let y: BN;
  if (req.side === 'x') {
    x = raw(Math.min(have[pool.mintX] ?? 0, needUsd[pool.mintX] / pool.usdX), pool.decimalsX);
    y = new BN(0);
  } else if (req.side === 'y') {
    x = new BN(0);
    y = raw(Math.min(have[pool.mintY] ?? 0, needUsd[pool.mintY] / pool.usdY), pool.decimalsY);
  } else {
    x = raw(Math.min(have[pool.mintX] ?? 0, needUsd[pool.mintX] / pool.usdX), pool.decimalsX);
    y = sdk().autoFillYByStrategy(active.binId, pool.binStep, x, active.xAmount, active.yAmount, minBinId, maxBinId, strategy.strategyType);
    const yAvail = raw(have[pool.mintY] ?? 0, pool.decimalsY);
    if (y.gt(yAvail)) {
      x = x.mul(yAvail).div(y.isZero() ? new BN(1) : y);
      y = yAvail;
    }
  }
  if (x.isZero() && y.isZero()) throw new Error('Not enough to open a position.');

  const positionKp = Keypair.generate();
  const bins = maxBinId - minBinId + 1;
  if (bins <= SINGLE_TX_BINS) {
    const t = await dlmm.initializePositionAndAddLiquidityByStrategy({ positionPubKey: positionKp.publicKey, totalXAmount: x, totalYAmount: y, strategy, user: owner, slippage: 1 });
    steps.push({ label: 'Open the position and add liquidity', tx: await forOwner(d, t, owner, [positionKp]), kind: 'open' });
  } else {
    const create = await dlmm.createEmptyPosition({ positionPubKey: positionKp.publicKey, minBinId, maxBinId, user: owner });
    steps.push({ label: 'Open the position', tx: await forOwner(d, create, owner, [positionKp]), kind: 'open' });
    const adds = await dlmm.addLiquidityByStrategyChunkable({ positionPubKey: positionKp.publicKey, totalXAmount: x, totalYAmount: y, strategy, user: owner, slippage: 1 });
    for (const [i, t] of adds.entries()) steps.push({ label: `Add liquidity (${i + 1} of ${adds.length})`, tx: await forOwner(d, t, owner), kind: 'add' });
  }
  return {
    steps,
    swaps,
    position: { address: positionKp.publicKey.toBase58(), lowerBin: minBinId, upperBin: maxBinId, amountX: ui(x, pool.decimalsX), amountY: ui(y, pool.decimalsY) },
    rentSol,
    newBinArrays: rent.arrays,
  };
}

/** A position in the owner's wallet, read from chain; refuses one the owner doesn't own. */
async function ownedPosition(d: WalletPlanDeps, pool: PoolCtx, owner: PublicKey, address: string): Promise<{ dlmm: DLMMClass; pos: LbPosition }> {
  const dlmm: DLMMClass = await DLMM.create(d.conn, new PublicKey(pool.address));
  const pos = await withRetry(() => dlmm.getPosition(new PublicKey(address)), 3, 'getPosition');
  if (!pos.positionData.owner.equals(owner)) throw new PolicyViolation('That position belongs to another wallet.');
  return { dlmm, pos };
}

export interface ClosePlan {
  steps: WalletStep[];
  swaps: SwapStep[];
  /** What comes back to the wallet (position amounts and unclaimed fees, transfer fees excluded), UI amounts */
  out: Amounts;
  feesUsd: number;
}

/**
 * Removes all liquidity, claims the fees and closes the position (its rent comes back to the owner).
 * `stepAside`: then swaps what came back of the risky token into the quote token (an exit).
 */
export async function planClose(
  d: WalletPlanDeps,
  req: { owner: string; pool: PoolCtx; position: string; prices: Amounts; stepAside?: { risky: string; quote: string } },
): Promise<ClosePlan> {
  const owner = new PublicKey(req.owner);
  const { pool } = req;
  const { dlmm, pos } = await ownedPosition(d, pool, owner, req.position);
  const pd = pos.positionData;
  const txs = await dlmm.removeLiquidity({ user: owner, position: pos.publicKey, fromBinId: pd.lowerBinId, toBinId: pd.upperBinId, bps: new BN(10_000), shouldClaimAndClose: true });
  const steps: WalletStep[] = [];
  for (const [i, t] of txs.entries()) steps.push({ label: txs.length > 1 ? `Close the position (${i + 1} of ${txs.length})` : 'Close the position', tx: await forOwner(d, t, owner), kind: 'close' });
  const fx = ui(pd.feeXExcludeTransferFee, pool.decimalsX);
  const fy = ui(pd.feeYExcludeTransferFee, pool.decimalsY);
  const out: Amounts = {
    [pool.mintX]: ui(pd.totalXAmountExcludeTransferFee, pool.decimalsX) + fx,
    [pool.mintY]: ui(pd.totalYAmountExcludeTransferFee, pool.decimalsY) + fy,
  };
  const swaps: SwapStep[] = [];
  const risky = req.stepAside?.risky;
  if (risky && req.stepAside && (out[risky] ?? 0) > 0) {
    // A hair less than came back, so rounding never asks for more than the wallet holds.
    // Its tokens are still in the position until the close lands: checked when it is sent.
    const s = await swapStep(d, owner, risky, req.stepAside.quote, out[risky] * 0.999, req.prices, pool, false);
    steps.push(s.step);
    swaps.push(s.swap);
  }
  return { steps, swaps, out, feesUsd: fx * pool.usdX + fy * pool.usdY };
}

/** Claims the position's swap fees (and any farm rewards) into the owner's wallet. */
export async function planClaim(d: WalletPlanDeps, req: { owner: string; pool: PoolCtx; position: string }): Promise<{ steps: WalletStep[]; feesUsd: number }> {
  const owner = new PublicKey(req.owner);
  const { pool } = req;
  const { dlmm, pos } = await ownedPosition(d, pool, owner, req.position);
  const txs = await dlmm.claimAllRewardsByPosition({ owner, position: pos });
  const steps: WalletStep[] = [];
  for (const [i, t] of txs.entries()) steps.push({ label: txs.length > 1 ? `Claim fees (${i + 1} of ${txs.length})` : 'Claim fees', tx: await forOwner(d, t, owner), kind: 'claim' });
  const feesUsd = ui(pos.positionData.feeX, pool.decimalsX) * pool.usdX + ui(pos.positionData.feeY, pool.decimalsY) * pool.usdY;
  return { steps, feesUsd };
}

/** Claims the swap fees and adds them back into the same range. */
export async function planCompound(
  d: WalletPlanDeps,
  req: { owner: string; pool: PoolCtx; position: string; lowerBin: number; upperBin: number; shape: LiquidityShape },
): Promise<{ steps: WalletStep[]; feesUsd: number }> {
  const owner = new PublicKey(req.owner);
  const { pool } = req;
  const { dlmm, pos } = await ownedPosition(d, pool, owner, req.position);
  const fx = pos.positionData.feeXExcludeTransferFee;
  const fy = pos.positionData.feeYExcludeTransferFee;
  const steps: WalletStep[] = [];
  for (const [i, t] of (await dlmm.claimAllRewardsByPosition({ owner, position: pos })).entries()) steps.push({ label: `Claim fees${i ? ` (${i + 1})` : ''}`, tx: await forOwner(d, t, owner), kind: 'claim' });
  const adds = await dlmm.addLiquidityByStrategyChunkable({
    positionPubKey: pos.publicKey,
    totalXAmount: fx,
    totalYAmount: fy,
    strategy: { minBinId: req.lowerBin, maxBinId: req.upperBin, strategyType: STRATEGY[req.shape] },
    user: owner,
    slippage: 1,
  });
  for (const [i, t] of adds.entries()) steps.push({ label: adds.length > 1 ? `Add the fees back (${i + 1} of ${adds.length})` : 'Add the fees back', tx: await forOwner(d, t, owner), kind: 'add' });
  return { steps, feesUsd: ui(fx, pool.decimalsX) * pool.usdX + ui(fy, pool.decimalsY) * pool.usdY };
}

/**
 * Moves a position to a new range around the price: close it, then open a new one from exactly what came
 * back (a hair less, for rounding), swapping between the two tokens as the new range needs.
 */
export async function planRebalance(
  d: WalletPlanDeps,
  req: { owner: string; pool: PoolCtx; position: string; prices: Amounts; shape: LiquidityShape; side: LiquiditySide; binsEachSide: number; range?: CustomRange },
): Promise<{ close: ClosePlan; open: OpenPlan; steps: WalletStep[] }> {
  const close = await planClose(d, req);
  const budget = Object.fromEntries(Object.entries(close.out).map(([m, a]) => [m, a * 0.999]).filter(([, a]) => (a as number) > 0));
  const open = await planOpen(d, { owner: req.owner, pool: req.pool, budget, prices: req.prices, shape: req.shape, side: req.side, binsEachSide: req.binsEachSide, range: req.range, incoming: close.out });
  return { close, open, steps: [...close.steps, ...open.steps] };
}

/**
 * The agent's view of a self-custody vault: it reads positions in the owner's wallet but never signs.
 * Holdings are empty on purpose: the rest of the owner's wallet is theirs, not the agent's to deploy.
 * Every action becomes a proposal the owner approves in their wallet.
 */
export class WalletReader implements Executor {
  readonly mode = 'live' as const;
  constructor(private readonly d: { conn: Connection; owner: string; costs?: CostModel }) {}

  async holdings(): Promise<Holdings> {
    return {};
  }

  mark(p: PositionRef, pool: PoolCtx): Promise<MarkResult> {
    return markPosition(this.d.conn, p, pool);
  }

  /** DLMM positions the owner's wallet holds, with amounts (raw), for adopting ones opened through Binwise. */
  async listPositions() {
    const all = await withRetry(() => dlmmClass().getAllLbPairPositionsByUser(this.d.conn, new PublicKey(this.d.owner)), 2, 'getAllLbPairPositionsByUser');
    const out: { address: string; pool: string; lowerBin: number; upperBin: number; amountX: string; amountY: string }[] = [];
    for (const [pool, info] of all)
      for (const p of info.lbPairPositionsData)
        out.push({ address: p.publicKey.toBase58(), pool, lowerBin: p.positionData.lowerBinId, upperBin: p.positionData.upperBinId, amountX: p.positionData.totalXAmount, amountY: p.positionData.totalYAmount });
    return out;
  }

  txCostUsd(n: number): number {
    const c = this.d.costs ?? DEFAULT_COSTS;
    return (n * c.lamportsPerTx * c.solUsd) / 1e9;
  }

  private refuse(): never {
    throw new NeedsOwnerApproval("This vault's funds are in the owner's wallet: the owner approves every transaction.");
  }
  open(): Promise<OpenResult> {
    return this.refuse();
  }
  close(): Promise<ActionResult> {
    return this.refuse();
  }
  claim(): Promise<ActionResult> {
    return this.refuse();
  }
  compound(): Promise<ActionResult & { bins: number[] | null }> {
    return this.refuse();
  }
  swap(): Promise<ActionResult> {
    return this.refuse();
  }
}

/** A position as the chain has it now, for recording what an approved plan did; null when the account is gone. */
export async function readWalletPosition(
  conn: Connection,
  pool: PoolCtx,
  address: string,
): Promise<{ owner: string; lowerBin: number; upperBin: number; amountX: number; amountY: number; feesUsd: number } | null> {
  if (!(await withRetry(() => conn.getAccountInfo(new PublicKey(address)), 3, 'getAccountInfo'))) return null;
  const dlmm: DLMMClass = await DLMM.create(conn, new PublicKey(pool.address));
  const d = (await withRetry(() => dlmm.getPosition(new PublicKey(address)), 3, 'getPosition')).positionData;
  return {
    owner: d.owner.toBase58(),
    lowerBin: d.lowerBinId,
    upperBin: d.upperBinId,
    amountX: ui(d.totalXAmount, pool.decimalsX),
    amountY: ui(d.totalYAmount, pool.decimalsY),
    feesUsd: ui(d.feeX, pool.decimalsX) * pool.usdX + ui(d.feeY, pool.decimalsY) * pool.usdY,
  };
}
