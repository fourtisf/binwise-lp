import type DLMMClass from '@meteora-ag/dlmm';
import type { LbPosition } from '@meteora-ag/dlmm';
import {
  ComputeBudgetProgram,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import { DEFAULT_COSTS, composition, openPosition, type CostModel, type CustomRange, type LiquidityShape, type LiquiditySide } from '@kovra/core';
import type { ActionResult, Executor, Holdings, MarkResult, OpenResult, PoolCtx, PositionRef } from './executor';
import { withRetry } from './http';
import type { JupiterClient, JupiterInstruction, JupiterQuote } from './jupiter';
import { MAX_SWAP_LOSS, SINGLE_TX_BINS, STRATEGY, markPosition, raw, setupRent, ui } from './live';
import { PROGRAM_IDS, PolicyViolation } from './programs';
import { priorityFeeMicroLamports } from './rpc';
import { DLMM, dlmmClass, sdk } from './sdk';

/**
 * Self-custody: Kovra holds no key. For each action it builds the transactions the owner's own wallet
 * signs (any Wallet Standard wallet), with the owner as fee payer and signer: Jupiter swaps, and Meteora
 * DLMM open / add / remove / claim. A new position's account is the only other signer; its key is made
 * here, signs that one transaction and is thrown away (the account never holds funds of its own).
 *
 * Everything is built at once so the wallet asks once, and as few transactions as Solana takes: a swap and
 * the position it pays for share one transaction when they fit (one approval even in wallets that ask once
 * per transaction, and nothing half done if it fails). A step that depends on an earlier one (liquidity
 * added from a swap's output) uses the swap's guaranteed minimum, so it never asks for more than the
 * wallet will hold; whatever a swap returns above its minimum stays in the owner's wallet.
 */

const SOL = NATIVE_MINT.toBase58();
/** Highest priority fee put on the owner's transactions, micro-lamports per compute unit (the agent's cap is higher). */
const WALLET_CU_PRICE_CAP = 500_000;
/** SOL a new position and its token accounts need besides bin arrays: position rent (refunded on close) plus fees. */
const OPEN_SOL_MARGIN = 0.02;
/** Accounts a swap's route may use when it shares a transaction with a new position (Jupiter's maxAccounts). */
const SHARED_SWAP_ACCOUNTS = 20;
/** Solana's compute limit for one transaction. */
const MAX_CU = 1_400_000;

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
  /**
   * The same transaction then opens a position from the swap's output: what that may also take from the
   * wallet (raw, by mint), and lamports for the position's rent and new bin arrays.
   */
  deposit?: Record<string, string>;
  rentLamports?: string;
}

export interface WalletPlanDeps {
  conn: Connection;
  /** swapInstructions: lets a swap share a transaction with the position it pays for */
  jupiter: Pick<JupiterClient, 'quote' | 'swap'> & Partial<Pick<JupiterClient, 'swapInstructions'>>;
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

/** A Jupiter quote that passed its checks, before any transaction is built from it. */
interface QuotedSwap {
  quote: JupiterQuote;
  check: SwapCheck;
  swap: SwapStep;
  label: string;
}

/**
 * Quotes a Jupiter swap for the owner (ExactIn, 0.5% slippage) and checks the quote: it matches the request
 * and its guaranteed minimum is within 3% of market value. `maxAccounts`: a route small enough to share a
 * transaction.
 */
async function quoteSwap(d: WalletPlanDeps, from: string, to: string, inUi: number, prices: Amounts, pool?: PoolCtx, maxAccounts?: number): Promise<QuotedSwap> {
  const [decIn, decOut] = await Promise.all([decimalsOf(d.conn, from, pool), decimalsOf(d.conn, to, pool)]);
  const amountRaw = raw(inUi, decIn).toString();
  if (amountRaw === '0') throw new Error('Swap amount is too small.');
  const quote: JupiterQuote = await d.jupiter.quote(from, to, amountRaw, 50, maxAccounts, d.legacyOnly).catch((e) => {
    // No route that small: any route, in a transaction of its own.
    if (!maxAccounts) throw e;
    return d.jupiter.quote(from, to, amountRaw, 50, undefined, d.legacyOnly);
  });
  if (quote.inputMint !== from || quote.outputMint !== to || quote.inAmount !== amountRaw || quote.swapMode !== 'ExactIn' || quote.slippageBps > 100)
    throw new PolicyViolation('The swap quote does not match the request.');
  const minOutUi = ui(quote.otherAmountThreshold, decOut);
  const inUsd = ui(amountRaw, decIn) * priced(prices, from);
  const outUsd = minOutUi * priced(prices, to);
  if (outUsd < inUsd * (1 - MAX_SWAP_LOSS))
    throw new Error(`Swapping would return about $${outUsd.toFixed(2)} for $${inUsd.toFixed(2)}, more than ${MAX_SWAP_LOSS * 100}% below market. Try a smaller amount or another pool.`);
  return {
    quote,
    check: { from, to, amountIn: amountRaw, minOut: quote.otherAmountThreshold },
    swap: { from, to, inUi: ui(amountRaw, decIn), minOutUi },
    label: `Swap ${symbolOf(d, from)} → ${symbolOf(d, to)}`,
  };
}

/**
 * The quoted swap as a transaction of its own, checked before the owner sees it: a simulation against the
 * owner's accounts shows only the input leaving (by at most its amount, plus fees) and at least the minimum
 * arriving. A bad route never reaches the wallet. `precheck` false when an earlier step must land first (the
 * tokens are still in a position): checked at send time only.
 */
async function swapTxStep(d: WalletPlanDeps, owner: PublicKey, q: QuotedSwap, precheck = true): Promise<WalletStep> {
  const { swapTransaction } = await d.jupiter.swap(q.quote, owner.toBase58(), 200_000, d.legacyOnly);
  if (precheck) await checkSwapEffects(d.conn, owner, VersionedTransaction.deserialize(fromBase64(swapTransaction)), q.check);
  return { label: q.label, tx: swapTransaction, kind: 'swap', check: q.check };
}

/** A checked Jupiter swap as its own step (see quoteSwap and swapTxStep). */
async function swapStep(
  d: WalletPlanDeps,
  owner: PublicKey,
  from: string,
  to: string,
  inUi: number,
  prices: Amounts,
  pool?: PoolCtx,
  precheck = true,
): Promise<{ step: WalletStep; swap: SwapStep }> {
  const q = await quoteSwap(d, from, to, inUi, prices, pool);
  return { step: await swapTxStep(d, owner, q, precheck), swap: q.swap };
}

/** Lamports a swap may use besides its input: network fee, priority fee, new token accounts. */
const SWAP_SOL_TOLERANCE = 10_000_000n;

/**
 * Simulates a swap for the owner and refuses it unless it only does what was asked: only `from` leaves the
 * wallet (at most its amount, plus fees) and at least the minimum of `to` arrives in the owner's own account
 * for it. Unsigned before the wallet sees it (`signed` false), or as signed right before it is sent.
 * A swap that also opens a position (`c.deposit`): the position's tokens may leave too, up to its amounts,
 * and its rent; what's left of `to` is at least the minimum less what went into the position.
 *
 * Only accounts the transaction itself uses can change, and Solana reports at most that many, so the check
 * watches the owner's token accounts among them, the owner's account for `to`, and the owner's SOL.
 * Returns the compute units the simulation used.
 */
export async function checkSwapEffects(conn: Connection, owner: PublicKey, tx: VersionedTransaction, c: SwapCheck, signed = false): Promise<{ unitsConsumed?: number }> {
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
  const deposit = (mint: string) => BigInt(c.deposit?.[mint] ?? '0');
  // Tokens (SOL apart): at most the swap's input and the position's share of each may leave.
  for (const [mint, dl] of delta) {
    if (mint === SOL || mint === c.to) continue;
    const may = (mint === c.from ? amountIn : 0n) + deposit(mint);
    if (-dl > may) throw new PolicyViolation(may ? 'The swap would take more than asked.' : `The swap would move another token (${mint.slice(0, 4)}…) out of your wallet.`);
  }
  // SOL, native and wrapped: the swap's input and the position's share, fees and rent.
  const solMay = (c.from === SOL ? amountIn : 0n) + deposit(SOL) + SWAP_SOL_TOLERANCE + BigInt(c.rentLamports ?? '0');
  if (solDelta < (c.to === SOL ? minOut : 0n) - solMay)
    throw new PolicyViolation(c.to === SOL ? "The swap's output wouldn't arrive in your wallet." : c.from === SOL ? 'The swap would take more than asked.' : 'The swap would spend too much SOL.');
  if (c.to !== SOL && (delta.get(c.to) ?? 0n) < minOut - deposit(c.to)) throw new PolicyViolation("The swap's output wouldn't arrive in your wallet.");
  return { unitsConsumed: r.value.unitsConsumed ?? undefined };
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

const jupiterIx = (i: JupiterInstruction) =>
  new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(i.data, 'base64'),
  });

/** The same DLMM or token-account instruction twice (a bin array or account both SDK transactions would create). */
const repeated = (a: TransactionInstruction, b: TransactionInstruction) =>
  [PROGRAM_IDS.DLMM, PROGRAM_IDS.ASSOCIATED_TOKEN].includes(a.programId.toBase58() as never) &&
  a.programId.equals(b.programId) &&
  a.data.equals(b.data) &&
  a.keys.length === b.keys.length &&
  a.keys.every((k, i) => k.pubkey.equals(b.keys[i].pubkey) && k.isWritable === b.keys[i].isWritable && k.isSigner === b.keys[i].isSigner);

/**
 * One transaction for what would otherwise take several: `swap` (a Jupiter swap that goes first, its output
 * feeding the rest) and the DLMM SDK's transactions `sdk`, in order. One approval even in wallets that ask
 * once per transaction, one network fee, and all or nothing: if any part fails, none of it happens.
 *
 * Null when it doesn't fit Solana's limits (1232 bytes; 1.4M compute units, measured by a simulation when
 * `precheck`) or can't be built or checked: the plan then uses a transaction per part, as before. With a
 * swap it carries the swap's check, widened by what the position takes (`deposit`, `rentLamports`), and
 * is simulated against it now when `precheck`; without a simulation only a `light` position shares a
 * transaction with a swap.
 */
async function oneTransaction(
  d: WalletPlanDeps,
  owner: PublicKey,
  o: {
    swap?: QuotedSwap;
    sdk: Transaction[];
    signers: Keypair[];
    label: string;
    kind: WalletStep['kind'];
    precheck: boolean;
    /** With a swap: shares a transaction with it even without a simulation */
    light?: boolean;
    /** With a swap: what the position takes, for its check */
    deposit?: Record<string, string>;
    rentLamports?: string;
  },
): Promise<WalletStep | null> {
  const skip = (why: string) => {
    console.warn(`[wallet-plan] not one transaction (${o.label}, ${o.sdk.length} SDK tx): ${why}`);
    return null;
  };
  if (o.swap && d.legacyOnly) return skip('the wallet signs legacy transactions only');
  if (o.swap && !d.jupiter.swapInstructions) return skip('no Jupiter swap instructions');
  if (o.swap && !o.precheck && !o.light) return skip('wide range, nothing to simulate yet');
  try {
    // The SDK's instructions without its compute budget (ours goes first), a repeated one once.
    const body: TransactionInstruction[] = [];
    for (const ix of o.sdk.flatMap((t) => t.instructions))
      if (!ix.programId.equals(ComputeBudgetProgram.programId) && !body.some((b) => repeated(b, ix))) body.push(ix);

    let swapIxs: TransactionInstruction[] = [];
    let tables: AddressLookupTableAccount[] = [];
    if (o.swap) {
      const j = await d.jupiter.swapInstructions!(o.swap.quote, owner.toBase58());
      if (j.otherInstructions?.length || j.tokenLedgerInstruction) return skip('Jupiter added other instructions');
      swapIxs = [...j.setupInstructions.map(jupiterIx), jupiterIx(j.swapInstruction), ...(j.cleanupInstruction ? [jupiterIx(j.cleanupInstruction)] : [])];
      const found = await Promise.all(j.addressLookupTableAddresses.map(async (a) => (await withRetry(() => d.conn.getAddressLookupTable(new PublicKey(a)), 3, 'getAddressLookupTable')).value));
      if (found.some((t) => !t)) return skip("a lookup table couldn't be read");
      tables = found as AddressLookupTableAccount[];
      // The swap closes the owner's wrapped-SOL account when done; the position may need it again (the SDK
      // only creates it when it didn't exist yet).
      const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
      const createsWsol = body.some((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.keys[1]?.pubkey.equals(wsol));
      if (j.cleanupInstruction && !createsWsol && body.some((ix) => ix.keys.some((k) => k.pubkey.equals(wsol))))
        body.unshift(createAssociatedTokenAccountIdempotentInstruction(owner, wsol, owner, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    }

    const writable = [...swapIxs, ...body].flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58()));
    const cuPrice = await priorityFeeMicroLamports(d.conn, [...new Set(writable)], WALLET_CU_PRICE_CAP);
    const { blockhash, lastValidBlockHeight } = await withRetry(() => d.conn.getLatestBlockhash('confirmed'), 3, 'getLatestBlockhash');
    let size = 0;
    const build = (units: number): Uint8Array | null => {
      const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }), ...swapIxs, ...body];
      let bytes: Uint8Array;
      if (o.swap) {
        const v = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables));
        if (o.signers.length) v.sign(o.signers);
        bytes = v.serialize();
      } else {
        // No lookup tables needed: a legacy transaction, like the SDK's own (any wallet signs it).
        const t = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(...ixs);
        if (o.signers.length) t.partialSign(...o.signers);
        bytes = t.serialize({ requireAllSignatures: false, verifySignatures: false });
      }
      size = bytes.length;
      return bytes.length <= PACKET_DATA_SIZE ? bytes : null;
    };

    let bytes = build(MAX_CU);
    if (!bytes) return skip(`${size} bytes, over Solana's ${PACKET_DATA_SIZE}`);
    const check: SwapCheck | undefined = o.swap ? { ...o.swap.check, deposit: o.deposit, rentLamports: o.rentLamports } : undefined;
    if (o.precheck) {
      // As the owner's wallet is now: it goes through, and (with a swap) moves only what the check allows.
      const tx = VersionedTransaction.deserialize(bytes);
      let units: number | undefined;
      if (check) units = (await checkSwapEffects(d.conn, owner, tx, check)).unitsConsumed;
      else {
        const r = await withRetry(() => d.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }), 2, 'simulateTransaction');
        if (r.value.err) return skip(`simulation failed: ${JSON.stringify(r.value.err)}`);
        units = r.value.unitsConsumed ?? undefined;
      }
      // What it used, with room for the price moving a few bins before it lands.
      if (units) bytes = build(Math.min(MAX_CU, Math.ceil(units * 1.2) + 50_000)) ?? bytes;
    }
    return { label: o.label, tx: toBase64(bytes), kind: o.kind, ...(check ? { check } : {}) };
  } catch (e) {
    // Too large, a route the check refuses, an RPC hiccup: the plan falls back to a transaction per part,
    // each checked on its own as before.
    return skip(e instanceof Error ? e.message.slice(0, 300) : String(e));
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
 * shape. Checks the wallet keeps enough SOL for the position's rent and fees. One transaction for all of it
 * when it fits (see oneTransaction), else a transaction per swap and for the position.
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

  // Swap the budget into the two tokens, counting each swap's guaranteed minimum. A route small enough to
  // share a transaction with the position when the wallet can sign one (versioned, with lookup tables).
  const together = !d.legacyOnly && !!d.jupiter.swapInstructions;
  const have: Amounts = { ...req.budget };
  const quoted: QuotedSwap[] = [];
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
      const q = await quoteSwap(d, src, target, inUi, prices, pool, together ? SHARED_SWAP_ACCOUNTS : undefined);
      quoted.push(q);
      have[src] -= q.swap.inUi;
      have[target] = (have[target] ?? 0) + q.swap.minOutUi;
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
  // The SDK's transactions for the position: one up to SINGLE_TX_BINS bins, else open, then add.
  const sdkSteps: { label: string; tx: Transaction; kind: 'open' | 'add' }[] = [];
  if (bins <= SINGLE_TX_BINS) {
    const t = await dlmm.initializePositionAndAddLiquidityByStrategy({ positionPubKey: positionKp.publicKey, totalXAmount: x, totalYAmount: y, strategy, user: owner, slippage: 1 });
    sdkSteps.push({ label: 'Open the position and add liquidity', tx: t, kind: 'open' });
  } else {
    const create = await dlmm.createEmptyPosition({ positionPubKey: positionKp.publicKey, minBinId, maxBinId, user: owner });
    sdkSteps.push({ label: 'Open the position', tx: create, kind: 'open' });
    const adds = await dlmm.addLiquidityByStrategyChunkable({ positionPubKey: positionKp.publicKey, totalXAmount: x, totalYAmount: y, strategy, user: owner, slippage: 1 });
    for (const [i, t] of adds.entries()) sdkSteps.push({ label: `Add liquidity (${i + 1} of ${adds.length})`, tx: t, kind: 'add' });
  }

  // A wider range may still fit one open-and-add instruction (the SDK's open, then add, is larger): it's
  // tried first, measured by a simulation, since a wide add can use a lot of compute.
  const wide =
    bins > SINGLE_TX_BINS && !req.incoming
      ? await dlmm.initializePositionAndAddLiquidityByStrategy({ positionPubKey: positionKp.publicKey, totalXAmount: x, totalYAmount: y, strategy, user: owner, slippage: 1 }).catch(() => null)
      : null;

  // As few transactions as fit: the swap and the position together, else the swap, then the position in one.
  // What the position may take (2% over its amounts: the SDK's own slippage allowance) and its rent, for the check.
  const deposit = { [pool.mintX]: x.muln(102).divn(100).addn(1).toString(), [pool.mintY]: y.muln(102).divn(100).addn(1).toString() };
  const rentLamports = String(Math.ceil((rent.sol + sdk().POSITION_FEE) * 1e9));
  const position = (txs: Transaction[], swap: QuotedSwap | undefined, precheck: boolean) =>
    oneTransaction(d, owner, {
      swap,
      sdk: txs,
      signers: [positionKp],
      label: swap ? `${swap.label} and open the position` : 'Open the position and add liquidity',
      kind: 'open',
      precheck,
      // Without a simulation to measure it, only a light position shares a transaction with a swap.
      light: bins <= SINGLE_TX_BINS,
      deposit,
      rentLamports,
    });
  let steps: WalletStep[] = [];
  let all: WalletStep | null = null;
  if (quoted.length <= 1) {
    if (wide) all = await position([wide], quoted[0], true);
    if (!all && quoted.length + sdkSteps.length > 1) all = await position(sdkSteps.map((s) => s.tx), quoted[0], !req.incoming);
  }
  if (all) steps = [all];
  else {
    for (const q of quoted) steps.push(await swapTxStep(d, owner, q, !req.incoming));
    // After a swap the position can't be simulated yet (its tokens arrive with the swap).
    const one = quoted.length && sdkSteps.length > 1 ? await position(sdkSteps.map((s) => s.tx), undefined, false) : null;
    if (one) steps.push(one);
    else for (const [i, s] of sdkSteps.entries()) steps.push({ label: s.label, tx: await forOwner(d, s.tx, owner, i === 0 ? [positionKp] : []), kind: s.kind });
  }
  return {
    steps,
    swaps: quoted.map((q) => q.swap),
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
  // Fees and farm rewards in one transaction when they fit.
  const one = txs.length > 1 ? await oneTransaction(d, owner, { sdk: txs, signers: [], label: 'Claim fees', kind: 'claim', precheck: true }) : null;
  const steps: WalletStep[] = one ? [one] : [];
  if (!one) for (const [i, t] of txs.entries()) steps.push({ label: txs.length > 1 ? `Claim fees (${i + 1} of ${txs.length})` : 'Claim fees', tx: await forOwner(d, t, owner), kind: 'claim' });
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
  const claims = await dlmm.claimAllRewardsByPosition({ owner, position: pos });
  const adds = await dlmm.addLiquidityByStrategyChunkable({
    positionPubKey: pos.publicKey,
    totalXAmount: fx,
    totalYAmount: fy,
    strategy: { minBinId: req.lowerBin, maxBinId: req.upperBin, strategyType: STRATEGY[req.shape] },
    user: owner,
    slippage: 1,
  });
  // Claim and add back in one transaction when they fit (one approval, and never claimed without the add).
  const one = await oneTransaction(d, owner, { sdk: [...claims, ...adds], signers: [], label: 'Claim the fees and add them back', kind: 'add', precheck: true });
  const steps: WalletStep[] = one ? [one] : [];
  if (!one) {
    for (const [i, t] of claims.entries()) steps.push({ label: `Claim fees${i ? ` (${i + 1})` : ''}`, tx: await forOwner(d, t, owner), kind: 'claim' });
    for (const [i, t] of adds.entries()) steps.push({ label: adds.length > 1 ? `Add the fees back (${i + 1} of ${adds.length})` : 'Add the fees back', tx: await forOwner(d, t, owner), kind: 'add' });
  }
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

  /** DLMM positions the owner's wallet holds, with amounts (raw), for adopting ones opened through Kovra. */
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
