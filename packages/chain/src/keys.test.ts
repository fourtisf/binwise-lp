import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createAgentKey, exportAgentSecret, loadAgentKey, openSecret, sealSecret, walletAddress } from './keys';

const secret = randomBytes(32).toString('base64');

describe('agent key custody', () => {
  it('round-trips a keypair through sealed storage', () => {
    const { pubkey, encSecret } = createAgentKey(secret);
    expect(loadAgentKey(encSecret, secret).publicKey.toBase58()).toBe(pubkey);
  });
  it('never stores the secret in plaintext', () => {
    const plain = randomBytes(64);
    const sealed = sealSecret(plain, secret);
    expect(sealed.includes(plain.subarray(0, 16))).toBe(false);
  });
  it('rejects the wrong key and tampered data', () => {
    const sealed = sealSecret(Buffer.from('hello'), secret);
    expect(() => openSecret(sealed, randomBytes(32).toString('base64'))).toThrow();
    sealed[sealed.length - 1] ^= 1;
    expect(() => openSecret(sealed, secret)).toThrow();
  });
  it('requires a 32-byte key', () => {
    expect(() => sealSecret(Buffer.from('x'), Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('private key export', () => {
  it('gives the base58 key wallets import, only for the matching address', () => {
    const { pubkey, encSecret } = createAgentKey(secret);
    const exported = exportAgentSecret(encSecret, pubkey, secret);
    expect(Keypair.fromSecretKey(bs58.decode(exported)).publicKey.toBase58()).toBe(pubkey);
    expect(() => exportAgentSecret(encSecret, Keypair.generate().publicKey.toBase58(), secret)).toThrow(/doesn't match/);
  });
  it('accepts normal wallet addresses only', () => {
    const w = Keypair.generate().publicKey.toBase58();
    expect(walletAddress(` ${w} `)).toBe(w);
    expect(walletAddress('not an address')).toBeNull();
    // A program-derived address (off the curve) can't sign: funds sent there would be stuck.
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('x')], new PublicKey(w));
    expect(walletAddress(pda.toBase58())).toBeNull();
  });
});
