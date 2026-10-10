import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PROGRAM_IDS, PolicyViolation, assertTxAllowed, type TxPolicy } from './programs';

const agent = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const policy = (p: Partial<TxPolicy> = {}): TxPolicy => ({ transferDestinations: new Set([agent.toBase58()]), newAccounts: new Set(), ...p });
const tx = (...ixs: TransactionInstruction[]) => new Transaction().add(...ixs);

describe('transaction policy', () => {
  it('allows compute budget and DLMM instructions', () => {
    const dlmm = new TransactionInstruction({ programId: new PublicKey(PROGRAM_IDS.DLMM), keys: [], data: Buffer.alloc(8) });
    expect(() => assertTxAllowed(tx(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), dlmm), policy())).not.toThrow();
  });
  it('blocks programs that are not on the allowlist', () => {
    const evil = new TransactionInstruction({ programId: stranger, keys: [], data: Buffer.alloc(1) });
    expect(() => assertTxAllowed(tx(evil), policy())).toThrow(PolicyViolation);
  });
  it('blocks SOL transfers to anyone but allowed accounts', () => {
    expect(() => assertTxAllowed(tx(SystemProgram.transfer({ fromPubkey: agent, toPubkey: stranger, lamports: 1 })), policy())).toThrow(/not allowed/);
    expect(() => assertTxAllowed(tx(SystemProgram.transfer({ fromPubkey: agent, toPubkey: agent, lamports: 1 })), policy())).not.toThrow();
  });
  it('only lets withdrawals reach the owner', () => {
    const mint = Keypair.generate().publicKey;
    const from = getAssociatedTokenAddressSync(mint, agent);
    const ownerAta = getAssociatedTokenAddressSync(mint, owner);
    const strangerAta = getAssociatedTokenAddressSync(mint, stranger);
    const p = policy({ tokenDestinations: new Set([ownerAta.toBase58()]) });
    expect(() => assertTxAllowed(tx(createTransferCheckedInstruction(from, mint, ownerAta, agent, 1n, 6)), p)).not.toThrow();
    expect(() => assertTxAllowed(tx(createTransferCheckedInstruction(from, mint, strangerAta, agent, 1n, 6)), p)).toThrow(PolicyViolation);
  });
  it('checks versioned transactions too', () => {
    const msg = new TransactionMessage({
      payerKey: agent,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: agent, toPubkey: stranger, lamports: 5 })],
    }).compileToV0Message();
    expect(() => assertTxAllowed(new VersionedTransaction(msg), policy())).toThrow(PolicyViolation);
  });
  it('blocks unexpected account creation', () => {
    const ix = SystemProgram.createAccount({ fromPubkey: agent, newAccountPubkey: stranger, lamports: 1, space: 0, programId: SystemProgram.programId });
    expect(() => assertTxAllowed(tx(ix), policy())).toThrow(/Unexpected/);
    expect(() => assertTxAllowed(tx(ix), policy({ newAccounts: new Set([stranger.toBase58()]) }))).not.toThrow();
  });
});
