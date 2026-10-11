import type { Transaction } from '@solana/web3.js';

/**
 * The wallets' own injected providers (window.phantom.solana, window.solflare, …): the classic API
 * most Solana sites use. A fallback for when a wallet rejects the Wallet Standard connect with a
 * generic "Unexpected error" (seen with Phantom next to other wallet extensions).
 */
export interface InjectedSolana {
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } } | void>;
  publicKey?: { toBase58(): string } | null;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array } | Uint8Array>;
  signAndSendTransaction?(tx: Transaction): Promise<{ signature: string } | string>;
}

type W = Record<string, unknown> & {
  phantom?: { solana?: InjectedSolana & { isPhantom?: boolean } };
  solflare?: InjectedSolana & { isSolflare?: boolean };
  backpack?: InjectedSolana;
  trustwallet?: { solana?: InjectedSolana };
  bitkeep?: { solana?: InjectedSolana };
  okxwallet?: { solana?: InjectedSolana };
};

export function injectedFor(walletName: string): InjectedSolana | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as W;
  const n = walletName.toLowerCase();
  if (n.includes('phantom')) return w.phantom?.solana?.isPhantom ? w.phantom.solana : null;
  if (n.includes('solflare')) return w.solflare?.isSolflare ? w.solflare : null;
  if (n.includes('backpack')) return w.backpack ?? null;
  if (n.includes('trust')) return w.trustwallet?.solana ?? null;
  if (n.includes('bitget')) return w.bitkeep?.solana ?? null;
  if (n.includes('okx')) return w.okxwallet?.solana ?? null;
  return null;
}

/** The injected wallet signed in through the fallback in this tab (used by Deposit). */
let active: { provider: InjectedSolana; address: string } | null = null;
export const activeInjected = () => active;

/** Connects through the injected provider and returns the wallet address. */
export async function connectInjected(p: InjectedSolana): Promise<string> {
  const r = await p.connect();
  const pk = (r && 'publicKey' in r ? r.publicKey : null) ?? p.publicKey;
  if (!pk) throw new Error('The wallet returned no account.');
  const address = pk.toBase58();
  active = { provider: p, address };
  return address;
}

export async function signMessageInjected(p: InjectedSolana, message: Uint8Array): Promise<Uint8Array> {
  const r = await p.signMessage(message, 'utf8');
  return r instanceof Uint8Array ? r : r.signature;
}

export async function sendInjected(p: InjectedSolana, tx: Transaction): Promise<string> {
  if (!p.signAndSendTransaction) throw new Error('This wallet cannot send the deposit from here. Reconnect it and try again.');
  const r = await p.signAndSendTransaction(tx);
  return typeof r === 'string' ? r : r.signature;
}
