import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { NotADeposit, SOL_MINT, depositTransferLamports, parseDeposit } from './deposits';

const owner = Keypair.generate().publicKey;
const agent = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const agentUsdc = Keypair.generate().publicKey;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const tx = (instructions: object[], meta: object | null = { err: null, preTokenBalances: [], postTokenBalances: [] }) =>
  ({ meta, transaction: { message: { instructions, accountKeys: [{ pubkey: owner }, { pubkey: agentUsdc }] } } }) as unknown as ParsedTransactionWithMeta;
const sol = (source: string, lamports: number) => ({ program: 'system', parsed: { type: 'transfer', info: { source, destination: agent.toBase58(), lamports } } });

describe('parseDeposit', () => {
  it('counts SOL sent from the owner to the agent only', () => {
    expect(parseDeposit(tx([sol(owner.toBase58(), 2e9)]), owner.toBase58(), agent.toBase58())).toEqual({ [SOL_MINT]: 2 });
    expect(parseDeposit(tx([sol(stranger.toBase58(), 2e9)]), owner.toBase58(), agent.toBase58())).toEqual({});
  });
  it('ignores failed or unconfirmed transactions', () => {
    expect(parseDeposit(tx([sol(owner.toBase58(), 2e9)], { err: { InstructionError: [0, 'x'] } }), owner.toBase58(), agent.toBase58())).toEqual({});
    expect(parseDeposit(tx([sol(owner.toBase58(), 2e9)], null), owner.toBase58(), agent.toBase58())).toEqual({});
  });
  it('credits what actually arrived for tokens (transfer fees taken in transit)', () => {
    const ix = { program: 'spl-token-2022', parsed: { type: 'transferChecked', info: { authority: owner.toBase58(), destination: agentUsdc.toBase58(), mint: USDC, tokenAmount: { uiAmount: 100 } } } };
    const meta = {
      err: null,
      preTokenBalances: [{ accountIndex: 1, mint: USDC, owner: agent.toBase58(), uiTokenAmount: { uiAmount: 5 } }],
      postTokenBalances: [{ accountIndex: 1, mint: USDC, owner: agent.toBase58(), uiTokenAmount: { uiAmount: 104 } }],
    };
    expect(parseDeposit(tx([ix], meta), owner.toBase58(), agent.toBase58())).toEqual({ [USDC]: 99 });
  });
  it('a wallet created in Telegram (owner = agent) counts money from any other address, including plain token transfers', () => {
    const a = agent.toBase58();
    expect(parseDeposit(tx([sol(stranger.toBase58(), 1e9)]), a, a)).toEqual({ [SOL_MINT]: 1 });
    // The agent's own transfers are never deposits.
    expect(parseDeposit(tx([sol(a, 1e9)]), a, a)).toEqual({});
    const ix = { program: 'spl-token', parsed: { type: 'transfer', info: { authority: stranger.toBase58(), source: 'x', destination: agentUsdc.toBase58(), amount: '25000000' } } };
    const meta = {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 1, mint: USDC, owner: a, uiTokenAmount: { uiAmount: 25, decimals: 6 } }],
    };
    expect(parseDeposit(tx([ix], meta), a, a)).toEqual({ [USDC]: 25 });
    // A plain transfer doesn't count for website vaults (only the registered wallet, via transferChecked).
    expect(parseDeposit(tx([{ ...ix, parsed: { ...ix.parsed, info: { ...ix.parsed.info, authority: owner.toBase58() } } }], meta), owner.toBase58(), a)).toEqual({});
  });
});

describe('depositTransferLamports', () => {
  const [o, a] = [owner.toBase58(), agent.toBase58()];
  const transfer = (from = owner, to = agent, lamports = 2.5e9) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
  const build = (...ixs: TransactionInstruction[]) => new Transaction({ feePayer: owner, blockhash: stranger.toBase58(), lastValidBlockHeight: 1 }).add(...ixs);
  const lighthouse = new TransactionInstruction({ programId: new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'), keys: [], data: Buffer.from([1]) });

  it('passes the owner-to-vault transfer, with the priority fee and guard instructions wallets add', () => {
    expect(depositTransferLamports(build(transfer()), o, a)).toBe(2.5e9);
    expect(depositTransferLamports(build(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), transfer(), lighthouse), o, a)).toBe(2.5e9);
  });
  it('refuses a transfer anywhere else, from anyone else, or paid by another wallet', () => {
    expect(() => depositTransferLamports(build(transfer(owner, stranger)), o, a)).toThrow(NotADeposit);
    expect(() => depositTransferLamports(build(transfer(stranger)), o, a)).toThrow(NotADeposit);
    const tx = build(transfer());
    tx.feePayer = stranger;
    expect(() => depositTransferLamports(tx, o, a)).toThrow(NotADeposit);
  });
  it('refuses anything beside the one transfer', () => {
    expect(() => depositTransferLamports(build(transfer(), transfer()), o, a)).toThrow(NotADeposit);
    expect(() => depositTransferLamports(build(transfer(), transfer(owner, stranger, 1)), o, a)).toThrow(NotADeposit);
    expect(() => depositTransferLamports(build(SystemProgram.assign({ accountPubkey: owner, programId: stranger })), o, a)).toThrow(NotADeposit);
    const other = new TransactionInstruction({ programId: stranger, keys: [], data: Buffer.alloc(0) });
    expect(() => depositTransferLamports(build(transfer(), other), o, a)).toThrow(NotADeposit);
  });
});
