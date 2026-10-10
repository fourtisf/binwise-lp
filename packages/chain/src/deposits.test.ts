import { describe, expect, it } from 'vitest';
import { Keypair, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { SOL_MINT, parseDeposit } from './deposits';

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
});
