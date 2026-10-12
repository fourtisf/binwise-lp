import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';

/** Self-custody plans without the network: the DLMM SDK, Jupiter and the RPC are stand-ins that record what they're asked. */

const SOL = 'So11111111111111111111111111111111111111112';
const CARDS = Keypair.generate().publicKey.toBase58();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const owner = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;

/** Calls the fake DLMM received, for assertions */
const calls: { method: string; args: Record<string, unknown> }[] = [];
let positionOwner = owner;
/** What the position holds (raw): CARDS and USDC both have 6 decimals */
let held = { x: 200_000_000, y: 30_000_000 };
/** Y (raw) the strategy pairs with one raw unit of X: price x 10^(decY - decX) */
let fillRatio = 0.15;

/** A transaction the SDK would return: one instruction from the user, plus the new position as a signer when opening. */
const sdkTx = (user: PublicKey, position?: PublicKey) => {
  const t = new Transaction();
  if (position) t.add(SystemProgram.createAccount({ fromPubkey: user, newAccountPubkey: position, lamports: 1, space: 0, programId: SystemProgram.programId }));
  else t.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: user, lamports: 0 }));
  return t;
};

const fakeDlmm = {
  pubkey: new PublicKey(Keypair.generate().publicKey),
  getActiveBin: async () => ({ binId: 1000, xAmount: new BN(0), yAmount: new BN(0) }),
  initializePositionAndAddLiquidityByStrategy: async (a: Record<string, unknown>) => {
    calls.push({ method: 'init', args: a });
    return sdkTx(a.user as PublicKey, a.positionPubKey as PublicKey);
  },
  getPosition: async (address: PublicKey) => ({
    publicKey: address,
    positionData: {
      owner: positionOwner,
      lowerBinId: 990,
      upperBinId: 1010,
      totalXAmountExcludeTransferFee: new BN(held.x),
      totalYAmountExcludeTransferFee: new BN(held.y),
      feeXExcludeTransferFee: new BN(1_000_000),
      feeYExcludeTransferFee: new BN(500_000),
      feeX: new BN(1_000_000),
      feeY: new BN(500_000),
    },
  }),
  removeLiquidity: async (a: Record<string, unknown>) => {
    calls.push({ method: 'remove', args: a });
    return [sdkTx(a.user as PublicKey)];
  },
  claimAllRewardsByPosition: async (a: Record<string, unknown>) => {
    calls.push({ method: 'claim', args: a });
    return [sdkTx(a.owner as PublicKey)];
  },
};

vi.mock('./sdk', () => ({
  DLMM: { create: async () => fakeDlmm },
  dlmmClass: () => ({ getAllLbPairPositionsByUser: async () => new Map() }),
  sdk: () => ({
    POSITION_FEE: 0.057,
    // Spot centred on the price: as much Y as X is worth.
    autoFillYByStrategy: (_a: number, _s: number, x: BN) => new BN(Math.floor(x.toNumber() * fillRatio)),
  }),
}));
vi.mock('./live', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./live')>()),
  setupRent: async () => ({ arrays: 0, sol: 0 }),
}));

const { planClose, planOpen, planRebalance, checkSwapEffects } = await import('./wallet-plan');

/** RPC stand-in: the owner's SOL, a blockhash, priority fees, and swap simulations that spend exactly the input. */
let walletLamports = 5e9;
/** Lamports a simulated swap takes: its input when that is SOL, else just the fee */
let simulatedSpend: (amountIn: bigint, fromSol: boolean) => bigint = (a, fromSol) => (fromSol ? a : 0n) + 5000n;
let lastSwapIn = 0n;
let lastSwapFromSol = false;
const conn = {
  rpcEndpoint: 'http://fake',
  getBalance: async () => walletLamports,
  getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
  getRecentPrioritizationFees: async () => [{ slot: 1, prioritizationFee: 50_000 }],
  getParsedTokenAccountsByOwner: async () => ({ value: [] }),
  simulateTransaction: async () => ({ value: { err: null, logs: [], accounts: [{ lamports: walletLamports - Number(simulatedSpend(lastSwapIn, lastSwapFromSol)), data: ['', 'base64'] }] } }),
};

/** Jupiter stand-in: fair quotes at `rate` (out per in, UI) with a 0.5% floor, and a swap tx paid by the user. */
const decimals: Record<string, number> = { [SOL]: 9, [CARDS]: 6, [USDC]: 6 };
let rate: Record<string, number> = {};
const jupiter = {
  quote: async (inputMint: string, outputMint: string, amountRaw: string) => {
    lastSwapIn = BigInt(amountRaw);
    lastSwapFromSol = inputMint === SOL;
    const outUi = (Number(amountRaw) / 10 ** decimals[inputMint]) * rate[`${inputMint}>${outputMint}`];
    const out = Math.floor(outUi * 10 ** decimals[outputMint]);
    return { inputMint, outputMint, inAmount: amountRaw, outAmount: String(out), otherAmountThreshold: String(Math.floor(out * 0.995)), swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', routePlan: [] };
  },
  swap: async (_q: unknown, user: string) => {
    const msg = new TransactionMessage({ payerKey: new PublicKey(user), recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message();
    return { swapTransaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64'), lastValidBlockHeight: 100 };
  },
};

const prices = { [SOL]: 150, [CARDS]: 0.15, [USDC]: 1 };
const pool = { address: fakeDlmm.pubkey.toBase58(), binStep: 20, mintX: CARDS, mintY: USDC, decimalsX: 6, decimalsY: 6, price: 0.15, usdX: 0.15, usdY: 1, tvlUsd: 3e7, baseFeePct: 0.2, volume24hUsd: 4e7 };
const d = { conn: conn as never, jupiter: jupiter as never, symbols: { [CARDS]: 'CARDS', [USDC]: 'USDC' } };

beforeEach(() => {
  calls.length = 0;
  walletLamports = 5e9;
  positionOwner = owner;
  held = { x: 200_000_000, y: 30_000_000 };
  fillRatio = 0.15;
  simulatedSpend = (a, fromSol) => (fromSol ? a : 0n) + 5000n;
  rate = { [`${SOL}>${CARDS}`]: 1000, [`${SOL}>${USDC}`]: 150, [`${CARDS}>${USDC}`]: 0.15, [`${USDC}>${CARDS}`]: 1 / 0.15 };
});

describe('planOpen (self-custody)', () => {
  it('pays with SOL: two swaps, then liquidity from no more than their guaranteed minimum, in one approval', async () => {
    const p = await planOpen(d, { owner: owner.toBase58(), pool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 10 });
    expect(p.steps.map((s) => s.label)).toEqual(['Swap SOL → CARDS', 'Swap SOL → USDC', 'Open the position and add liquidity']);
    expect(p.swaps.map((s) => s.inUi)).toEqual([0.5, 0.5]);
    // 0.5 SOL = $75 each side; the floor is 0.5% under fair value.
    expect(p.swaps[0].minOutUi).toBeCloseTo(497.5, 3);
    const init = calls.find((c) => c.method === 'init')!.args;
    expect((init.totalXAmount as BN).toNumber()).toBeLessThanOrEqual(497_500_000);
    expect((init.totalYAmount as BN).toNumber()).toBeLessThanOrEqual(74_625_000);
    expect((init.user as PublicKey).equals(owner)).toBe(true);
    // Bins around the active bin, and the position account is the one the plan reports.
    expect(init.strategy).toMatchObject({ minBinId: 990, maxBinId: 1010 });
    expect((init.positionPubKey as PublicKey).toBase58()).toBe(p.position.address);

    // The open transaction: paid by the owner, already signed by the new position, the owner's signature still to come.
    const open = Transaction.from(Buffer.from(p.steps[2].tx, 'base64'));
    expect(open.feePayer!.equals(owner)).toBe(true);
    const sigs = Object.fromEntries(open.signatures.map((s) => [s.publicKey.toBase58(), s.signature != null]));
    expect(sigs[p.position.address]).toBe(true);
    expect(sigs[owner.toBase58()]).toBe(false);
    // Our priority fee replaces any of the SDK's, first in the transaction.
    expect(open.instructions[0].programId.toBase58()).toBe('ComputeBudget111111111111111111111111111111');
  });

  it('a pool with SOL in it: only the other side is swapped', async () => {
    const solPool = { ...pool, mintX: SOL, decimalsX: 9, usdX: 150, price: 150 };
    const p = await planOpen(d, { owner: owner.toBase58(), pool: solPool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 5 });
    expect(p.steps.map((s) => s.kind)).toEqual(['swap', 'open']);
    expect(p.swaps).toMatchObject([{ from: SOL, to: USDC, inUi: 0.5 }]);
    // 0.5 SOL stays SOL; both sides scale down to the swap's guaranteed USDC (0.5% under fair).
    expect(p.position.amountX).toBeCloseTo(0.4975, 6);
    expect(p.position.amountY).toBeCloseTo(74.625, 6);
  });

  it('refuses when the wallet would not keep SOL for the rent and fees', async () => {
    walletLamports = 1.03e9;
    await expect(planOpen(d, { owner: owner.toBase58(), pool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 10 })).rejects.toThrow(/needs about 1\.077 SOL/);
  });

  it('refuses a swap far below market and one that would take more than asked', async () => {
    rate[`${SOL}>${CARDS}`] = 900; // 10% under fair value
    await expect(planOpen(d, { owner: owner.toBase58(), pool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 10 })).rejects.toThrow(/below market/);
    rate[`${SOL}>${CARDS}`] = 1000;
    simulatedSpend = (a) => a * 2n;
    await expect(planOpen(d, { owner: owner.toBase58(), pool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 10 })).rejects.toThrow(/more than asked/);
  });
});

describe('checkSwapEffects', () => {
  it('refuses a swap paid by another wallet', async () => {
    const msg = new TransactionMessage({ payerKey: stranger, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message();
    const b64 = Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
    await expect(checkSwapEffects(conn as never, owner, b64, SOL, USDC, 1n, 1n)).rejects.toThrow(/not paid by your wallet/);
  });
});

describe('planClose / planRebalance (self-custody)', () => {
  it('closes with fees claimed, and steps aside into the quote token on an exit', async () => {
    const p = await planClose(d, { owner: owner.toBase58(), pool, position: Keypair.generate().publicKey.toBase58(), prices, stepAside: { risky: CARDS, quote: USDC } });
    expect(calls[0]).toMatchObject({ method: 'remove', args: { fromBinId: 990, toBinId: 1010, shouldClaimAndClose: true } });
    expect((calls[0].args.user as PublicKey).equals(owner)).toBe(true);
    // 200 CARDS + 1 in fees, 30 USDC + 0.5.
    expect(p.out).toEqual({ [CARDS]: 201, [USDC]: 30.5 });
    expect(p.steps.map((s) => s.label)).toEqual(['Close the position', 'Swap CARDS → USDC']);
    expect(p.swaps[0].inUi).toBeCloseTo(200.799, 3);
  });

  it("refuses a position the owner doesn't own", async () => {
    positionOwner = stranger;
    await expect(planClose(d, { owner: owner.toBase58(), pool, position: Keypair.generate().publicKey.toBase58(), prices })).rejects.toThrow(/another wallet/);
  });

  it('rebalances from exactly what the close returns: close, a swap for the side the new range lacks, open', async () => {
    // Price fell through the range: the position is all USDC now ($60 + $0.50 fees, plus 1 CARDS of fees).
    held = { x: 0, y: 60_000_000 };
    const p = await planRebalance(d, { owner: owner.toBase58(), pool, position: Keypair.generate().publicKey.toBase58(), prices, shape: 'spot', side: 'both', binsEachSide: 10 });
    expect(p.steps.map((s) => s.kind)).toEqual(['close', 'swap', 'open']);
    // About half the value goes into CARDS, from USDC only (nothing else of the wallet is touched).
    expect(p.open.swaps).toHaveLength(1);
    expect(p.open.swaps[0]).toMatchObject({ from: USDC, to: CARDS });
    expect(p.open.swaps[0].inUi).toBeGreaterThan(29);
    expect(p.open.swaps[0].inUi).toBeLessThan(31);
    // Never more than came back.
    expect(p.open.position.amountX * 0.15 + p.open.position.amountY).toBeLessThanOrEqual(60.65);
  });

  it('rebalances a balanced position without swapping', async () => {
    const p = await planRebalance(d, { owner: owner.toBase58(), pool, position: Keypair.generate().publicKey.toBase58(), prices, shape: 'spot', side: 'both', binsEachSide: 10 });
    expect(p.steps.map((s) => s.kind)).toEqual(['close', 'open']);
  });
});
