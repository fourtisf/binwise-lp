import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
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
  // Wide ranges: open the position, then add (both create the same bin array, like the SDK's own).
  createEmptyPosition: async (a: Record<string, unknown>) => {
    calls.push({ method: 'create', args: a });
    return sdkTx(a.user as PublicKey, a.positionPubKey as PublicKey).add(binArrayIx());
  },
  addLiquidityByStrategyChunkable: async (a: Record<string, unknown>) => {
    calls.push({ method: 'add', args: a });
    return [new Transaction().add(binArrayIx(), SystemProgram.transfer({ fromPubkey: a.user as PublicKey, toPubkey: fakeDlmm.pubkey, lamports: 7 }))];
  },
};
const binArray = Keypair.generate().publicKey;
const binArrayIx = () => new TransactionInstruction({ programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'), keys: [{ pubkey: binArray, isSigner: false, isWritable: true }], data: Buffer.from([35, 86, 19, 1]) });

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

const { planClaim, planClose, planCompound, planOpen, planRebalance, checkSwapEffects } = await import('./wallet-plan');

/** RPC stand-in: the owner's SOL, a blockhash, priority fees, and swap simulations that spend exactly the input. */
let walletLamports = 5e9;
/** Lamports a simulated swap takes: its input when that is SOL, else just the fee */
let simulatedSpend: (amountIn: bigint, fromSol: boolean) => bigint = (a, fromSol) => (fromSol ? a : 0n) + 5000n;
let lastSwapIn = 0n;
let lastSwapFromSol = false;
/** What a simulated swap delivers to the owner's account for the output token (raw); null: delivered elsewhere */
let lastSwapOut: bigint | null = 0n;
/** The owner's other token accounts (spam and empty ones too), none of them used by the swaps here */
let otherAccounts = 0;
/** Each swap transaction's quote, by its blockhash: what simulating it spends and delivers */
const swapsByHash = new Map<string, { in: bigint; fromSol: boolean; out: bigint }>();
/** Simulations asked for, and the accounts each wanted reported */
const simulated: string[][] = [];
/** An SPL token account holding `amount` (raw): the amount is the u64 at offset 64. */
const tokenAccount = (amount: bigint) => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b.toString('base64');
};
const conn = {
  rpcEndpoint: 'http://fake',
  getBalance: async () => walletLamports,
  getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
  getRecentPrioritizationFees: async () => [{ slot: 1, prioritizationFee: 50_000 }],
  getAccountInfo: async () => ({ owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }),
  getParsedTokenAccountsByOwner: async (_o: unknown, { programId }: { programId: PublicKey }) => ({
    value:
      programId.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
        ? Array.from({ length: otherAccounts }, () => ({
            pubkey: Keypair.generate().publicKey,
            account: { data: { parsed: { info: { mint: Keypair.generate().publicKey.toBase58(), tokenAmount: { amount: '0' } } } } },
          }))
        : [],
  }),
  getAddressLookupTable: async (key: PublicKey) => ({
    value: new AddressLookupTableAccount({ key, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: tableAddresses } }),
  }),
  // Like Solana: never more accounts reported than the transaction uses.
  simulateTransaction: async (tx: VersionedTransaction, o: { accounts?: { addresses: string[] } }) => {
    const addresses = o.accounts?.addresses ?? [];
    simulated.push(addresses);
    if (addresses.length > tx.message.staticAccountKeys.length + 1) throw new Error(`Too many accounts provided; max ${tx.message.staticAccountKeys.length}`);
    const s = swapsByHash.get(tx.message.recentBlockhash) ?? { in: lastSwapIn, fromSol: lastSwapFromSol, out: lastSwapOut };
    return {
      value: {
        err: null,
        logs: [],
        unitsConsumed: 300_000,
        accounts: addresses.map((a) =>
          a === owner.toBase58()
            ? { lamports: walletLamports - Number(simulatedSpend(s.in, s.fromSol)), data: ['', 'base64'] }
            : { lamports: 2_039_280, data: [tokenAccount(s.out ?? 0n), 'base64'] },
        ),
      },
    };
  },
};

/** Jupiter stand-in: fair quotes at `rate` (out per in, UI) with a 0.5% floor, and a swap tx paid by the user. */
const decimals: Record<string, number> = { [SOL]: 9, [CARDS]: 6, [USDC]: 6 };
let rate: Record<string, number> = {};
/** Jupiter's swap as instructions: a route of `routeAccounts` accounts, in its lookup table or not */
let routeAccounts = 10;
let routeInTable = true;
let tableAddresses: PublicKey[] = [];
let lastMaxAccounts: number | undefined;
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
const swapInstructions = async (_q: unknown, user: string) => {
  const route = Array.from({ length: routeAccounts }, () => Keypair.generate().publicKey);
  tableAddresses = routeInTable ? route : [];
  const meta = (pubkey: PublicKey | string, isSigner = false) => ({ pubkey: pubkey.toString(), isSigner, isWritable: true });
  return {
    computeBudgetInstructions: [],
    otherInstructions: [],
    setupInstructions: [{ programId: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', accounts: [meta(user, true), meta(wsolAta)], data: 'AQ==' }],
    swapInstruction: { programId: JUP, accounts: [meta(user, true), ...route.map((r) => meta(r))], data: Buffer.alloc(40).toString('base64') },
    // Unwraps SOL: closes the owner's wrapped-SOL account.
    cleanupInstruction: { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', accounts: [meta(wsolAta), meta(user, true)], data: 'CQ==' },
    addressLookupTableAddresses: [Keypair.generate().publicKey.toBase58()],
  };
};
const jupiter = {
  quote: async (inputMint: string, outputMint: string, amountRaw: string, _slippage?: number, maxAccounts?: number) => {
    lastMaxAccounts = maxAccounts;
    lastSwapIn = BigInt(amountRaw);
    lastSwapFromSol = inputMint === SOL;
    const outUi = (Number(amountRaw) / 10 ** decimals[inputMint]) * rate[`${inputMint}>${outputMint}`];
    const out = Math.floor(outUi * 10 ** decimals[outputMint]);
    lastSwapOut = BigInt(out);
    return { inputMint, outputMint, inAmount: amountRaw, outAmount: String(out), otherAmountThreshold: String(Math.floor(out * 0.995)), swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', routePlan: [] };
  },
  swap: async (q: { inputMint: string; inAmount: string; outAmount: string } | null, user: string) => {
    const blockhash = Keypair.generate().publicKey.toBase58();
    if (q) swapsByHash.set(blockhash, { in: BigInt(q.inAmount), fromSol: q.inputMint === SOL, out: BigInt(q.outAmount) });
    const msg = new TransactionMessage({ payerKey: new PublicKey(user), recentBlockhash: blockhash, instructions: [] }).compileToV0Message();
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
  rate = { [`${SOL}>${CARDS}`]: 1000, [`${SOL}>${USDC}`]: 150, [`${CARDS}>${USDC}`]: 0.15, [`${USDC}>${CARDS}`]: 1 / 0.15, [`${USDC}>${SOL}`]: 1 / 150 };
  otherAccounts = 0;
  simulated.length = 0;
  swapsByHash.clear();
  routeAccounts = 10;
  routeInTable = true;
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

describe('planOpen: as few transactions as fit (one approval even in wallets that ask once per transaction)', () => {
  const solPool = { ...pool, mintX: SOL, decimalsX: 9, usdX: 150, price: 150 };
  const dj = { ...d, jupiter: { ...jupiter, swapInstructions } as never };

  it('pays with SOL into a SOL pool: the swap and the position in one transaction, checked as a whole', async () => {
    // The SDK wraps SOL into the owner's wrapped-SOL account, which the swap's cleanup closes before.
    const init = fakeDlmm.initializePositionAndAddLiquidityByStrategy;
    fakeDlmm.initializePositionAndAddLiquidityByStrategy = async (a) =>
      (await init(a)).add(SystemProgram.transfer({ fromPubkey: a.user as PublicKey, toPubkey: wsolAta, lamports: 1 }));
    try {
      const p = await planOpen(dj, { owner: owner.toBase58(), pool: solPool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 5 });
      expect(lastMaxAccounts).toBe(20);
      expect(p.steps).toHaveLength(1);
      expect(p.steps[0]).toMatchObject({ label: 'Swap SOL → USDC and open the position', kind: 'open' });
      expect(p.swaps).toMatchObject([{ from: SOL, to: USDC, inUi: 0.5 }]);
      // Checked like the swap, plus what the position takes (2% over its amounts) and its rent.
      const x = Math.round(p.position.amountX * 1e9);
      const y = Math.round(p.position.amountY * 1e6);
      expect(p.steps[0].check).toMatchObject({ from: SOL, to: USDC, amountIn: '500000000', rentLamports: '57000000' });
      expect(Number(p.steps[0].check!.deposit![SOL])).toBe(Math.floor((x * 102) / 100) + 1);
      expect(Number(p.steps[0].check!.deposit![USDC])).toBe(Math.floor((y * 102) / 100) + 1);
      expect(simulated).toHaveLength(1);

      const tx = VersionedTransaction.deserialize(Buffer.from(p.steps[0].tx, 'base64'));
      expect(tx.version).toBe(0);
      expect(tx.message.addressTableLookups).toHaveLength(1);
      const keys = tx.message.staticAccountKeys;
      expect(keys[0].equals(owner)).toBe(true);
      // Signed by the new position; the owner's signature still to come.
      const signer = (k: string) => tx.signatures[keys.findIndex((x) => x.toBase58() === k)];
      expect(signer(p.position.address).some((b) => b !== 0)).toBe(true);
      expect(signer(owner.toBase58()).every((b) => b === 0)).toBe(true);
      // Compute: what the simulation used (300k) plus room; then the swap, its cleanup, the wrapped-SOL
      // account made again, and the SDK's instructions without its compute budget.
      const ixs = tx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex].toBase58(), data: Buffer.from(ix.data) }));
      expect(ixs[0].program).toBe('ComputeBudget111111111111111111111111111111');
      expect(ixs[0].data.readUInt32LE(1)).toBe(410_000);
      expect(ixs.map((i) => i.program).slice(2)).toEqual([
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        JUP,
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        '11111111111111111111111111111111',
        '11111111111111111111111111111111',
      ]);
    } finally {
      fakeDlmm.initializePositionAndAddLiquidityByStrategy = init;
    }
  });

  it("falls back to a transaction each when they don't fit together", async () => {
    routeAccounts = 40;
    routeInTable = false;
    const p = await planOpen(dj, { owner: owner.toBase58(), pool: solPool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 5 });
    expect(p.steps.map((s) => s.kind)).toEqual(['swap', 'open']);
    expect(p.steps[0].check).toMatchObject({ from: SOL, to: USDC, amountIn: '500000000' });
    expect(p.steps[0].check!.deposit).toBeUndefined();
  });

  it('falls back to a transaction each when Solana would refuse them together', async () => {
    // The simulation of the two together fails (here: once); the swap on its own is then checked as before.
    const spy = vi.spyOn(conn, 'simulateTransaction');
    spy.mockImplementationOnce(async () => ({ value: { err: { InstructionError: [3, { Custom: 1 }] }, logs: [], accounts: [], unitsConsumed: 0 } }) as never);
    const p = await planOpen(dj, { owner: owner.toBase58(), pool: solPool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 5 });
    spy.mockRestore();
    expect(p.steps.map((s) => s.kind)).toEqual(['swap', 'open']);
  });

  it('no route small enough to share a transaction: any route, on its own', async () => {
    // Asked with a cap on its accounts: no route; then without.
    const asked: (number | undefined)[] = [];
    const p = await planOpen(
      { ...dj, jupiter: { ...jupiter, swapInstructions, quote: async (...a: Parameters<typeof jupiter.quote>) => (asked.push(a[4]), a[4] ? Promise.reject(new Error('No routes found')) : jupiter.quote(...a)) } as never },
      { owner: owner.toBase58(), pool: solPool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 5 },
    );
    expect(asked).toEqual([20, undefined]);
    // The route that came back may not fit: the plan tries, and falls back if it doesn't.
    expect(p.swaps).toMatchObject([{ from: SOL, to: USDC }]);
  });

  it('a wallet that only signs legacy transactions: the swap stays on its own', async () => {
    const p = await planOpen({ ...dj, legacyOnly: true }, { owner: owner.toBase58(), pool: solPool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 5 });
    expect(lastMaxAccounts).toBeUndefined();
    expect(p.steps.map((s) => s.kind)).toEqual(['swap', 'open']);
  });

  it('a wide range from tokens already in the wallet: one open-and-add when it fits', async () => {
    // 41 bins: the SDK's single open-and-add is tried first, measured by a simulation.
    const p = await planOpen(d, { owner: owner.toBase58(), pool, budget: { [CARDS]: 500, [USDC]: 75 }, prices, shape: 'spot', side: 'both', binsEachSide: 20 });
    expect(p.swaps).toHaveLength(0);
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ label: 'Open the position and add liquidity', kind: 'open' });
    expect(p.steps[0].check).toBeUndefined();
    expect(calls.find((c) => c.method === 'init')!.args.strategy).toMatchObject({ minBinId: 980, maxBinId: 1020 });
    const tx = Transaction.from(Buffer.from(p.steps[0].tx, 'base64'));
    expect(tx.feePayer!.equals(owner)).toBe(true);
    const sigs = Object.fromEntries(tx.signatures.map((s) => [s.publicKey.toBase58(), s.signature != null]));
    expect(sigs[p.position.address]).toBe(true);
    expect(sigs[owner.toBase58()]).toBe(false);
    expect(tx.instructions.map((i) => i.programId.toBase58())).toEqual([
      'ComputeBudget111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
      '11111111111111111111111111111111',
    ]);
    expect(tx.instructions[0].data.readUInt32LE(1)).toBe(410_000);
  });

  it("a wide range whose single open-and-add Solana wouldn't take: open and add (the SDK's two) in one transaction", async () => {
    const spy = vi.spyOn(conn, 'simulateTransaction');
    spy.mockImplementationOnce(async () => ({ value: { err: { InstructionError: [2, 'ComputationalBudgetExceeded'] }, logs: [], accounts: [], unitsConsumed: 1_400_000 } }) as never);
    const p = await planOpen(d, { owner: owner.toBase58(), pool, budget: { [CARDS]: 500, [USDC]: 75 }, prices, shape: 'spot', side: 'both', binsEachSide: 20 }).finally(() => spy.mockRestore());
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ label: 'Open the position and add liquidity', kind: 'open' });
    const tx = Transaction.from(Buffer.from(p.steps[0].tx, 'base64'));
    expect(tx.instructions.map((i) => i.programId.toBase58())).toEqual([
      'ComputeBudget111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
      '11111111111111111111111111111111',
      'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // the bin array, once
      '11111111111111111111111111111111',
    ]);
  });

  it('a wide range after a swap: the swap, then open and add in one transaction', async () => {
    const p = await planOpen(dj, { owner: owner.toBase58(), pool: solPool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 20 });
    // Measured by a simulation, the three fit in one.
    expect(p.steps.map((s) => s.label)).toEqual(['Swap SOL → USDC and open the position']);
    // Without one (the tokens arrive with an earlier step), a wide position doesn't share with the swap.
    held = { x: 400_000_000, y: 0 };
    fillRatio = 150 / 1000;
    walletLamports = 0.09e9;
    const r = await planRebalance(dj, { owner: owner.toBase58(), pool: solPool, position: Keypair.generate().publicKey.toBase58(), prices, shape: 'spot', side: 'both', binsEachSide: 20 });
    expect(r.steps.map((s) => s.label)).toEqual(['Close the position', 'Swap SOL → USDC', 'Open the position and add liquidity']);
    expect(r.steps[2].check).toBeUndefined();
  });

  it('rebalances a narrow range with the swap and the new position in one transaction, checked when it is sent', async () => {
    held = { x: 400_000_000, y: 0 };
    fillRatio = 150 / 1000;
    walletLamports = 0.09e9;
    const r = await planRebalance(dj, { owner: owner.toBase58(), pool: solPool, position: Keypair.generate().publicKey.toBase58(), prices, shape: 'spot', side: 'both', binsEachSide: 10 });
    expect(r.steps.map((s) => s.label)).toEqual(['Close the position', 'Swap SOL → USDC and open the position']);
    expect(r.steps[1].check).toMatchObject({ from: SOL, to: USDC });
    // Its SOL only arrives with the close: nothing simulated now, the most compute allowed.
    expect(simulated).toHaveLength(0);
    const tx = VersionedTransaction.deserialize(Buffer.from(r.steps[1].tx, 'base64'));
    expect(Buffer.from(tx.message.compiledInstructions[0].data).readUInt32LE(1)).toBe(1_400_000);
  });
});

describe('checkSwapEffects', () => {
  it('refuses a swap paid by another wallet', async () => {
    const msg = new TransactionMessage({ payerKey: stranger, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message();
    const b64 = Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
    await expect(checkSwapEffects(conn as never, owner, VersionedTransaction.deserialize(Buffer.from(b64, 'base64')), { from: SOL, to: USDC, amountIn: '1', minOut: '1' })).rejects.toThrow(
      /not paid by your wallet/,
    );
  });

  it('watches only the accounts the swap uses, so a wallet full of token accounts can still swap', async () => {
    otherAccounts = 120;
    const p = await planOpen(d, { owner: owner.toBase58(), pool, budget: { [SOL]: 1 }, prices, shape: 'spot', side: 'both', binsEachSide: 10 });
    expect(p.swaps).toHaveLength(2);
    // The owner's account for the output, and the owner: none of the 120 others.
    expect(simulated.map((a) => a.length)).toEqual([2, 2]);
  });

  it("refuses a swap whose output wouldn't reach the owner's account for it (a new one included)", async () => {
    const swap = await jupiter.swap(null, owner.toBase58());
    lastSwapIn = 1_000_000n;
    lastSwapFromSol = true;
    lastSwapOut = null;
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    await expect(checkSwapEffects(conn as never, owner, tx, { from: SOL, to: USDC, amountIn: '1000000', minOut: '100' })).rejects.toThrow(/output wouldn't arrive/);
    lastSwapOut = 150n;
    await expect(checkSwapEffects(conn as never, owner, tx, { from: SOL, to: USDC, amountIn: '1000000', minOut: '100' })).resolves.toEqual({ unitsConsumed: 300_000 });
  });

  it('a swap that also opens a position: what the position takes may leave too, and no more', async () => {
    const swap = await jupiter.swap(null, owner.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    lastSwapIn = 1_000_000n;
    lastSwapFromSol = true;
    // 0.001 SOL in, and 3 SOL more into the position (plus the fee).
    simulatedSpend = (a) => a + 3_000_000_000n + 5000n;
    lastSwapOut = 40n; // 150 arrived, 110 of them went into the position
    const c = { from: SOL, to: USDC, amountIn: '1000000', minOut: '100' };
    await expect(checkSwapEffects(conn as never, owner, tx, c)).rejects.toThrow(/more than asked/);
    await expect(checkSwapEffects(conn as never, owner, tx, { ...c, deposit: { [SOL]: '2900000000', [USDC]: '110' } })).rejects.toThrow(/more than asked/);
    // Only 40 USDC left where at least 100 arrive and at most 50 may go into the position.
    await expect(checkSwapEffects(conn as never, owner, tx, { ...c, deposit: { [SOL]: '3000000000', [USDC]: '50' } })).rejects.toThrow(/output wouldn't arrive/);
    await expect(checkSwapEffects(conn as never, owner, tx, { ...c, deposit: { [SOL]: '3000000000', [USDC]: '110' } })).resolves.toEqual({ unitsConsumed: 300_000 });
    // The position's rent counts as SOL it may take.
    simulatedSpend = (a) => a + 3_057_000_000n;
    await expect(checkSwapEffects(conn as never, owner, tx, { ...c, deposit: { [SOL]: '3000000000', [USDC]: '110' } })).rejects.toThrow(/more than asked/);
    await expect(checkSwapEffects(conn as never, owner, tx, { ...c, deposit: { [SOL]: '3000000000', [USDC]: '110' }, rentLamports: '57000000' })).resolves.toBeDefined();
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
    // The CARDS are still in the position until the close lands: the swap is checked when it is sent, not now.
    expect(simulated).toHaveLength(0);
    expect(p.steps[1].check).toMatchObject({ from: CARDS, to: USDC, amountIn: '200799000' });
  });

  it('claims fees and farm rewards in one transaction', async () => {
    const claim = fakeDlmm.claimAllRewardsByPosition;
    fakeDlmm.claimAllRewardsByPosition = async (a) => [...(await claim(a)), ...(await claim(a))];
    const p = await planClaim(d, { owner: owner.toBase58(), pool, position: Keypair.generate().publicKey.toBase58() }).finally(() => (fakeDlmm.claimAllRewardsByPosition = claim));
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ label: 'Claim fees', kind: 'claim' });
    const tx = Transaction.from(Buffer.from(p.steps[0].tx, 'base64'));
    expect(tx.feePayer!.equals(owner)).toBe(true);
    // Both claims (the stand-in's identical transfers are both kept: only DLMM and token-account repeats are dropped).
    expect(tx.instructions.map((i) => i.programId.toBase58()).slice(2)).toEqual(['11111111111111111111111111111111', '11111111111111111111111111111111']);
  });

  it('compounds in one transaction: claim and add back together', async () => {
    const p = await planCompound(d, { owner: owner.toBase58(), pool, position: Keypair.generate().publicKey.toBase58(), lowerBin: 990, upperBin: 1010, shape: 'spot' });
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ label: 'Claim the fees and add them back', kind: 'add' });
    const tx = Transaction.from(Buffer.from(p.steps[0].tx, 'base64'));
    expect(tx.instructions.map((i) => i.programId.toBase58())).toEqual([
      'ComputeBudget111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
      '11111111111111111111111111111111',
      'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
      '11111111111111111111111111111111',
    ]);
    // The fees it adds back: what the position earned.
    expect(calls.find((c) => c.method === 'add')!.args).toMatchObject({ strategy: { minBinId: 990, maxBinId: 1010 } });
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

  it('counts the SOL coming back from the close when the new range needs SOL', async () => {
    // A SOL pool, all SOL after a rise (0.4 SOL); the wallet itself holds only enough for the new position's rent.
    const solPool = { ...pool, mintX: SOL, decimalsX: 9, usdX: 150, price: 150 };
    held = { x: 400_000_000, y: 0 };
    fillRatio = 150 / 1000; // USDC (6 decimals) per lamport-scaled SOL at 150
    walletLamports = 0.09e9;
    const p = await planRebalance(d, { owner: owner.toBase58(), pool: solPool, position: Keypair.generate().publicKey.toBase58(), prices, shape: 'spot', side: 'both', binsEachSide: 10 });
    expect(p.steps.map((s) => s.kind)).toEqual(['close', 'swap', 'open']);
    expect(p.open.swaps[0]).toMatchObject({ from: SOL, to: USDC });
    // The swap spends SOL that only arrives with the close: checked at send time.
    expect(simulated).toHaveLength(0);
  });

  it('rebalances a balanced position without swapping', async () => {
    const p = await planRebalance(d, { owner: owner.toBase58(), pool, position: Keypair.generate().publicKey.toBase58(), prices, shape: 'spot', side: 'both', binsEachSide: 10 });
    expect(p.steps.map((s) => s.kind)).toEqual(['close', 'open']);
  });
});
