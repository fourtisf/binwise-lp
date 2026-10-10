import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

/**
 * Agent keypair custody (CLAUDE.md §3): secrets are sealed with AES-256-GCM
 * (authenticated encryption) using a 32-byte key from AGENT_KEY_ENCRYPTION_SECRET.
 * Stored format: version(1) | nonce(12) | tag(16) | ciphertext. Never plaintext in DB or logs.
 */

const VERSION = 1;

function key(secret = process.env.AGENT_KEY_ENCRYPTION_SECRET): Buffer {
  if (!secret) throw new Error('AGENT_KEY_ENCRYPTION_SECRET is not set');
  const k = Buffer.from(secret, 'base64');
  if (k.length !== 32) throw new Error('AGENT_KEY_ENCRYPTION_SECRET must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  return k;
}

export function sealSecret(plain: Uint8Array, secret?: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret), nonce);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, c.getAuthTag(), body]);
}

export function openSecret(sealed: Uint8Array, secret?: string): Buffer {
  const b = Buffer.from(sealed);
  if (b[0] !== VERSION) throw new Error('Unknown sealed secret version');
  const d = createDecipheriv('aes-256-gcm', key(secret), b.subarray(1, 13));
  d.setAuthTag(b.subarray(13, 29));
  return Buffer.concat([d.update(b.subarray(29)), d.final()]);
}

/** New agent keypair for a vault: public key + sealed secret, ready to store. */
export function createAgentKey(secret?: string): { pubkey: string; encSecret: Buffer } {
  const kp = Keypair.generate();
  const sealed = sealSecret(kp.secretKey, secret);
  kp.secretKey.fill(0);
  return { pubkey: kp.publicKey.toBase58(), encSecret: sealed };
}

export function loadAgentKey(encSecret: Uint8Array, secret?: string): Keypair {
  const raw = openSecret(encSecret, secret);
  try {
    return Keypair.fromSecretKey(new Uint8Array(raw));
  } finally {
    raw.fill(0);
  }
}
