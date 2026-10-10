import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createAgentKey, loadAgentKey, openSecret, sealSecret } from './keys';

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
