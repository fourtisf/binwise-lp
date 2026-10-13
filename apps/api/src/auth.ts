import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import bs58 from 'bs58';
import { BRAND } from '@binwise/core';

/**
 * Sign-In With Solana: the wallet signs a one-time message; we verify the
 * ed25519 signature and issue an HMAC-signed session cookie.
 */

export const SESSION_COOKIE = 'bw_session';
export const SESSION_DAYS = 14;

export const newNonce = () => randomBytes(16).toString('hex');

/** The statement shown by wallets that use the standard Sign In With Solana flow. */
export const SIGN_IN_STATEMENT = `Sign in to ${BRAND}. This does not send a transaction or cost anything.`;

export const signInMessage = (wallet: string, nonce: string, issuedAt: string, domain: string) =>
  `${domain} wants you to sign in to ${BRAND} with your Solana wallet.\n\nWallet: ${wallet}\nNonce: ${nonce}\nIssued at: ${issuedAt}\n\nThis does not send a transaction or cost anything.`;

/** True when `signature` (base58) is `wallet`'s ed25519 signature over `message`. */
export function verifyWalletSignature(wallet: string, message: string, signatureB58: string): boolean {
  try {
    const pub = bs58.decode(wallet);
    const sig = bs58.decode(signatureB58);
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub).toString('base64url') }, format: 'jwk' });
    return verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (at least 32 characters)');
  return s;
}

export function makeSession(userId: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ uid: userId, exp: now + SESSION_DAYS * 86_400_000 })).toString('base64url');
  const mac = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function readSession(token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', secret()).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { uid: string; exp: number };
    return exp > now ? uid : null;
  } catch {
    return null;
  }
}
