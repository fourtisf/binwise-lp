import {
  SolanaSignAndSendTransaction,
  SolanaSignIn,
  SolanaSignMessage,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignInFeature,
  type SolanaSignMessageFeature,
} from '@solana/wallet-standard-features';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { StandardConnect, type StandardConnectFeature } from '@wallet-standard/features';
import bs58 from 'bs58';
import { ApiError } from './api/client';
import { connectInjected, impostorOf, injectedFor, phantomDiagnostics, signMessageInjected } from './injected';

export type { Wallet };

const isSolana = (w: Wallet) => StandardConnect in w.features && w.chains.some((c) => c.startsWith('solana:'));

/**
 * Solana wallets installed in this browser, through Wallet Standard (Phantom, Backpack, Solflare,
 * MetaMask, Trust, Bitget… all register themselves). Calls `onChange` now and whenever a wallet loads.
 */
export function watchSolanaWallets(onChange: (wallets: Wallet[]) => void): () => void {
  const api = getWallets();
  const emit = () => onChange(api.get().filter(isSolana));
  emit();
  const offs = [api.on('register', emit), api.on('unregister', emit)];
  return () => offs.forEach((off) => off());
}

export interface SignInApi {
  /** Without a wallet: a nonce for the one-step Sign In With Solana request (`message` is null). */
  challenge(wallet?: string): Promise<{ message: string | null; nonce: string; domain: string; issuedAt: string; statement: string }>;
  verify(wallet: string, message: string, signatureB58: string): Promise<void>;
}

/**
 * Why sign-in stopped. `rejected`: the user said no in the wallet. `pending`: the wallet already has
 * a request open. `impostor`: another extension answers in place of the picked wallet. `binwise`:
 * our server failed. `wallet`: the wallet failed every way we asked (`tried` lists each answer).
 */
export class SignInError extends Error {
  constructor(
    /** account: the wallet is on another account than the one signed in */
    readonly kind: 'rejected' | 'pending' | 'impostor' | 'binwise' | 'wallet' | 'account',
    message: string,
    readonly tried: string[] = [],
    readonly code?: string,
  ) {
    super(message);
  }
}

const errCode = (e: unknown): string | undefined => {
  const x = e as { code?: unknown; error?: { code?: unknown }; cause?: { code?: unknown } } | null;
  const c = x?.code ?? x?.error?.code ?? x?.cause?.code;
  return c == null ? undefined : String(c);
};
const errText = (e: unknown) => (e as Error)?.message || (typeof e === 'string' ? e : '') || 'no details';
const describe = (e: unknown) => `${errText(e)}${errCode(e) ? ` (code ${errCode(e)})` : ''}`;

/** A wallet's answer: a refusal by the user, an open request, or a failure worth trying another way. */
function walletFailure(e: unknown): SignInError | null {
  const code = errCode(e);
  const m = errText(e);
  if (code === '4001' || /reject|cancel|denied|declined|(popup|window|plugin) (was )?closed/i.test(m)) return new SignInError('rejected', m, [], code);
  if (code === '-32002' || /already pending|pending request|request is already/i.test(m)) return new SignInError('pending', m, [], code);
  return null;
}

/** Our server's answer. A message it can't check, after a one-step sign-in, is worth another try. */
async function binwise<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError) throw new SignInError('binwise', e.message, [], e.code);
    throw new SignInError('binwise', `Could not reach Binwise (${errText(e)}). Check your connection and try again.`);
  }
}

const solanaAccount = (accounts: readonly WalletAccount[]) =>
  accounts.find((a) => a.chains.some((c) => c.startsWith('solana:')) && a.features.includes(SolanaSignMessage)) ??
  accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ??
  accounts[0];

/**
 * Signs in with one wallet, asking it one thing at a time (two requests at once make Phantom fail
 * with "Unexpected error"):
 *
 * 1. Sign In With Solana: connect and sign in one approval (Phantom, Backpack, Solflare…).
 * 2. Connect, then sign our message (every Wallet Standard wallet).
 * 3. The wallet's classic injected API (window.phantom.solana, …), what older sites use.
 *
 * The next way is tried only when the wallet failed by itself; a "no" from the user, an open request
 * or a Binwise error stops right there. Returns the signed-in address.
 */
export async function signInWithWallet(w: Wallet, api: SignInApi, onTry?: (n: number) => void): Promise<string> {
  const tried: string[] = [];
  let n = 0;
  const attempt = async (label: string, run: () => Promise<string>): Promise<string | null> => {
    onTry?.(n++);
    try {
      return await run();
    } catch (e) {
      if (e instanceof SignInError) {
        // A one-step message our server couldn't check (a wallet that builds it differently): try the classic message.
        if (e.kind === 'binwise' && (e.code === 'bad_nonce' || e.code === 'bad_signature') && label === 'One-step sign-in') {
          tried.push(`${label}: Binwise couldn't check the wallet's message (${e.message})`);
          return null;
        }
        throw e;
      }
      console.error(`[binwise] ${w.name}: ${label} failed`, e);
      const stop = walletFailure(e);
      if (stop) throw stop;
      tried.push(`${label}: ${describe(e)}`);
      return null;
    }
  };

  // 1. Sign In With Solana. The wallet shows our domain; only ask when it is this page's, or the wallet warns.
  if (SolanaSignIn in w.features) {
    // An API from before one-step sign-in wants the wallet first: skip to the next way.
    const c = await binwise(api.challenge()).catch((e) => {
      if (e instanceof SignInError && e.code === 'bad_wallet') return null;
      throw e;
    });
    const address =
      !!c &&
      c.domain === window.location.host &&
      (await attempt('One-step sign-in', async () => {
        const [out] = await (w.features as SolanaSignInFeature)[SolanaSignIn].signIn({
          domain: c.domain,
          statement: c.statement,
          uri: window.location.origin,
          version: '1',
          chainId: 'mainnet',
          nonce: c.nonce,
          issuedAt: c.issuedAt,
        });
        if (!out) throw new Error('The wallet returned nothing.');
        const signed = new TextDecoder().decode(out.signedMessage);
        await binwise(api.verify(out.account.address, signed, bs58.encode(out.signature)));
        return out.account.address;
      }));
    if (address) return address;
  }

  // 2. Connect, then sign our message.
  if (SolanaSignMessage in w.features) {
    const address = await attempt('Connect and sign', async () => {
      const accounts = w.accounts.length ? w.accounts : (await (w.features as StandardConnectFeature)[StandardConnect].connect()).accounts;
      const account = solanaAccount(accounts);
      if (!account) throw new Error('The wallet returned no Solana account.');
      const c = await binwise(api.challenge(account.address));
      const [out] = await (w.features as SolanaSignMessageFeature)[SolanaSignMessage].signMessage({ account, message: new TextEncoder().encode(c.message!) });
      if (!out) throw new Error('The wallet returned no signature.');
      await binwise(api.verify(account.address, c.message!, bs58.encode(out.signature)));
      return account.address;
    });
    if (address) return address;
  }

  // 3. The classic injected API, unless another extension sits in this wallet's slot (it would sign as itself).
  const p = injectedFor(w.name);
  const thief = p && /phantom/i.test(w.name) ? impostorOf(p) : null;
  if (thief) {
    console.error('[binwise] window.phantom.solana is not Phantom:', phantomDiagnostics());
    throw new SignInError('impostor', thief, tried);
  }
  if (p) {
    const address = await attempt('Classic connect', async () => {
      const address = await connectInjected(p);
      const c = await binwise(api.challenge(address));
      const signature = await signMessageInjected(p, new TextEncoder().encode(c.message!));
      await binwise(api.verify(address, c.message!, bs58.encode(signature)));
      return address;
    });
    if (address) return address;
  }

  console.error(`[binwise] ${w.name} failed every way:`, tried, '|', phantomDiagnostics());
  throw new SignInError('wallet', tried.length ? tried.join('\n') : `${w.name} can't sign in to websites.`, tried);
}

const REMEMBERED = 'binwise:wallet';
/** The wallet the user signed in with, so later approvals (moving SOL to the vault) go to the same one. */
export const rememberWallet = (name: string) => {
  try {
    localStorage.setItem(REMEMBERED, name);
  } catch {
    /* private mode: we'll ask the first wallet that has the account */
  }
};
const remembered = () => {
  try {
    return localStorage.getItem(REMEMBERED);
  } catch {
    return null;
  }
};

/** The wallet to ask for `owner`'s approval: the one used to sign in, else one already showing that account. */
export const walletFor = (wallets: Wallet[], owner: string) =>
  wallets.find((w) => w.name === remembered()) ?? wallets.find((w) => w.accounts.some((a) => a.address === owner)) ?? wallets[0] ?? null;

/**
 * Asks the wallet to sign and send `tx` (a serialized transaction) from `owner`, the signed-in address:
 * Wallet Standard first, then the wallet's classic API. Returns the signature (base58). A "no", an open
 * request or the wallet being on another account stops right there.
 */
export async function sendWithWallet(w: Wallet, owner: string, tx: Uint8Array): Promise<string> {
  const tried: string[] = [];
  const wrongAccount = () => new SignInError('account', `Switch ${w.name} to the account you signed in with (${owner.slice(0, 4)}…${owner.slice(-4)}), then try again.`);
  if (SolanaSignAndSendTransaction in w.features) {
    try {
      const accounts = w.accounts.some((a) => a.address === owner) ? w.accounts : (await (w.features as StandardConnectFeature)[StandardConnect].connect()).accounts;
      const account = accounts.find((a) => a.address === owner);
      if (!account) throw wrongAccount();
      const [out] = await (w.features as SolanaSignAndSendTransactionFeature)[SolanaSignAndSendTransaction].signAndSendTransaction({ account, chain: 'solana:mainnet', transaction: tx });
      if (!out) throw new Error('The wallet returned no signature.');
      return bs58.encode(out.signature);
    } catch (e) {
      if (e instanceof SignInError) throw e;
      console.error(`[binwise] ${w.name}: send failed`, e);
      const stop = walletFailure(e);
      if (stop) throw stop;
      tried.push(`Send: ${describe(e)}`);
    }
  }
  const p = injectedFor(w.name);
  if (p?.signAndSendTransaction && !(/phantom/i.test(w.name) && impostorOf(p))) {
    try {
      if ((await connectInjected(p)) !== owner) throw wrongAccount();
      const { Transaction } = await import('@solana/web3.js');
      const r = await p.signAndSendTransaction(Transaction.from(tx));
      return typeof r === 'string' ? r : r.signature;
    } catch (e) {
      if (e instanceof SignInError) throw e;
      console.error(`[binwise] ${w.name}: classic send failed`, e);
      const stop = walletFailure(e);
      if (stop) throw stop;
      tried.push(`Classic send: ${describe(e)}`);
    }
  }
  throw new SignInError('wallet', tried.length ? tried.join('\n') : `${w.name} can't send transactions from this page.`, tried);
}
