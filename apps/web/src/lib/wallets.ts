import {
  SolanaSignAndSendTransaction,
  SolanaSignIn,
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignInFeature,
  type SolanaSignMessageFeature,
  type SolanaSignTransactionFeature,
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

/** Solana wallets installed in this browser right now. */
export const installedSolanaWallets = (): Wallet[] => getWallets().get().filter(isSolana);

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
    /**
     * account: the wallet is on another account than the one signed in. expired: approved too late, Solana no
     * longer takes the transaction. stopped: the page stopped waiting, so nothing more goes to the wallet.
     */
    readonly kind: 'rejected' | 'pending' | 'impostor' | 'binwise' | 'wallet' | 'account' | 'expired' | 'stopped',
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
/** The wallet `address` signed in with, so later approvals (moving SOL to the vault) go to the same one. */
export const rememberWallet = (name: string, address: string) => {
  try {
    localStorage.setItem(`${REMEMBERED}:${address}`, name);
  } catch {
    /* private mode: findWalletFor asks the wallets again next time */
  }
};
const remembered = (address: string) => {
  try {
    return localStorage.getItem(`${REMEMBERED}:${address}`);
  } catch {
    return null;
  }
};

/** The wallet holding `owner` when that's known without asking: remembered, showing the account, or the only one. */
const knownWalletFor = (wallets: Wallet[], owner: string) =>
  wallets.find((w) => w.name === remembered(owner)) ?? wallets.find((w) => w.accounts.some((a) => a.address === owner)) ?? (wallets.length === 1 ? wallets[0] : null);

/** A wallet's answer to a silent request; one that never answers counts as no. */
const quietly = <T,>(p: Promise<T>): Promise<T> => Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('no answer')), 2500))]);

/**
 * The wallet `owner` signed in with, found without bothering the user: remembered from sign-in, already
 * showing the account, or else every installed wallet asked silently whether this site is connected to
 * that account. First the classic `connect({ onlyIfTrusted })` (Phantom, Bitget, Solflare, Trust, OKX…),
 * then Wallet Standard's silent connect; both answer without a popup, and only for a site the wallet
 * already trusts. Remembers what it finds. Null if no wallet claims the account.
 */
export async function findWalletFor(wallets: Wallet[], owner: string): Promise<Wallet | null> {
  const known = knownWalletFor(wallets, owner);
  if (known) return known;
  const classic = async (w: Wallet) => {
    const p = injectedFor(w.name);
    if (!p || (/phantom/i.test(w.name) && impostorOf(p))) return false;
    const r = await quietly(p.connect({ onlyIfTrusted: true }));
    return ((r && 'publicKey' in r ? r.publicKey : null) ?? p.publicKey)?.toBase58() === owner;
  };
  const standard = async (w: Wallet) => (await quietly((w.features as StandardConnectFeature)[StandardConnect].connect({ silent: true }))).accounts.some((a) => a.address === owner);
  for (const ask of [classic, standard]) {
    // One silent request per wallet, all at once; the first wallet (in install order) that claims the account wins.
    const yes = await Promise.all(wallets.map((w) => ask(w).catch(() => false)));
    const w = wallets[yes.indexOf(true)];
    if (w) {
      rememberWallet(w.name, owner);
      return w;
    }
  }
  return null;
}

/** Broadcasts a transaction the wallet signed but didn't send (base64 → Binwise → Solana); returns its signature. */
export type Relay = (signed: Uint8Array) => Promise<string>;

/** A wallet or Solana saying the transaction's blockhash is unknown or expired. */
const isExpired = (e: unknown) => /blockhash ?not ?found|block height exceeded|transaction (has )?expired/i.test(describe(e));
/** A blockhash lives about a minute; younger than this, "blockhash not found" is a wallet's lagging node, worth another way. */
const EXPIRES_AFTER_MS = 45_000;

/** The account's Solana mainnet chain as the wallet names it ('solana:mainnet' in the standard). */
const mainnetOf = (a: WalletAccount) =>
  a.chains.find((c) => c === 'solana:mainnet') ?? a.chains.find((c) => c.startsWith('solana:') && !/devnet|testnet|localnet/.test(c)) ?? 'solana:mainnet';

/**
 * Asks the wallet to sign and send `tx` (a serialized transaction) from `owner`, the signed-in address,
 * one way at a time, each only when the one before failed by itself:
 *
 * 1. Sign and send through Wallet Standard.
 * 2. Sign only, and `relay` sends it: Phantom's own sending can fail with "Unexpected error" (-32603).
 * 3. and 4. The same two through the wallet's classic API.
 *
 * Each API connects first (it must show the signed-in account); if that fails, its two ways are skipped.
 * Wallet Standard connects silently first, so a wallet that already trusts this site asks only once.
 * Returns the signature (base58). A "no", an open request, the wallet being on another account, an
 * approval that came too late (expired) or a Binwise error (the relay refusing) stops right there; so
 * does `stopped()` turning true (the page stopped waiting) before the next request.
 */
export async function sendWithWallet(w: Wallet, owner: string, tx: Uint8Array, relay?: Relay, stopped?: () => boolean): Promise<string> {
  const tried: string[] = [];
  const built = Date.now();
  const wrongAccount = () => new SignInError('account', `Switch ${w.name} to the account you signed in with (${owner.slice(0, 4)}…${owner.slice(-4)}), then try again.`);
  const attempt = async <T,>(label: string, run: () => Promise<T>): Promise<T | null> => {
    if (stopped?.()) throw new SignInError('stopped', 'Stopped waiting for the wallet.', tried);
    try {
      return await run();
    } catch (e) {
      if (e instanceof SignInError) throw e;
      console.error(`[binwise] ${w.name}: ${label} failed`, e);
      const stop = walletFailure(e);
      if (stop) throw stop;
      // Approved too late: the same transaction can't go through another way, Solana no longer takes it.
      if (isExpired(e) && Date.now() - built > EXPIRES_AFTER_MS) throw new SignInError('expired', 'You approved after about a minute, so Solana no longer takes this transfer. Nothing was sent: try again and approve right away.');
      tried.push(`${label}: ${describe(e)}`);
      return null;
    }
  };
  const relayed = (signed: Uint8Array) => binwise(relay!(signed));

  const send = SolanaSignAndSendTransaction in w.features;
  const signOnly = !!relay && SolanaSignTransaction in w.features;
  // Called on the feature object: a wallet's connect can rely on `this`.
  const connector = (w.features as StandardConnectFeature)[StandardConnect];
  const account =
    send || signOnly
      ? await attempt('Connect', async () => {
          const mine = (accounts: readonly WalletAccount[]) => accounts.find((a) => a.address === owner);
          // Already connected on this page, or without a popup (a site the wallet trusts), else the wallet asks.
          // A silent connect that fails or never answers just means "not trusted yet" (Phantom answers 4001).
          const found =
            mine(w.accounts) ??
            mine(await quietly(connector.connect({ silent: true })).then((r) => r.accounts, () => [])) ??
            mine((await connector.connect()).accounts);
          if (!found) throw wrongAccount();
          return found;
        })
      : null;
  if (account && send) {
    const sig = await attempt('Send', async () => {
      const [out] = await (w.features as SolanaSignAndSendTransactionFeature)[SolanaSignAndSendTransaction].signAndSendTransaction({ account, chain: mainnetOf(account), transaction: tx });
      if (!out) throw new Error('The wallet returned no signature.');
      return bs58.encode(out.signature);
    });
    if (sig) return sig;
  }
  if (account && signOnly) {
    const sig = await attempt('Sign', async () => {
      const [out] = await (w.features as SolanaSignTransactionFeature)[SolanaSignTransaction].signTransaction({ account, chain: mainnetOf(account), transaction: tx });
      if (!out) throw new Error('The wallet returned no signed transaction.');
      return relayed(out.signedTransaction);
    });
    if (sig) return sig;
  }

  const injected = injectedFor(w.name);
  const p = injected && !(/phantom/i.test(w.name) && impostorOf(injected)) ? injected : null;
  // Classic transactions go in as @solana/web3.js objects, a fresh one per request.
  const Tx =
    p && (p.signAndSendTransaction || (relay && p.signTransaction))
      ? await attempt('Classic connect', async () => {
          if ((await connectInjected(p)) !== owner) throw wrongAccount();
          return (await import('@solana/web3.js')).Transaction;
        })
      : null;
  if (Tx && p?.signAndSendTransaction) {
    const sig = await attempt('Classic send', async () => {
      const r = await p.signAndSendTransaction!(Tx.from(tx));
      return typeof r === 'string' ? r : r.signature;
    });
    if (sig) return sig;
  }
  if (Tx && relay && p?.signTransaction) {
    const sig = await attempt('Classic sign', async () => relayed((await p.signTransaction!(Tx.from(tx))).serialize()));
    if (sig) return sig;
  }
  console.error(`[binwise] ${w.name} could not send:`, tried, '|', phantomDiagnostics());
  // Phantom's catch-all: an outdated app, Testnet mode, or another wallet extension in the way.
  const internal = tried.some((t) => /-32603|unexpected error/i.test(t));
  const help = internal
    ? `${w.name} hit an internal error. Update ${w.name}, check Testnet mode is off (Settings → Developer Settings) and turn off other wallet extensions, then try again.\n`
    : '';
  throw new SignInError('wallet', tried.length ? help + tried.join('\n') : `${w.name} can't send transactions from this page.`, tried);
}

/**
 * Whether the wallet signs versioned (v0) transactions, which Jupiter's swaps use. If not, Binwise builds
 * legacy ones. Only Wallet Standard says so; a wallet reached only through its classic API gets legacy ones.
 */
export function signsVersioned(w: Wallet): boolean {
  const f = (w.features as Partial<SolanaSignTransactionFeature>)[SolanaSignTransaction];
  return !!f && f.supportedTransactionVersions.includes(0);
}

/**
 * Asks the wallet to sign every transaction of a plan (serialized, in order) in one approval, without
 * sending them: Binwise sends them one after the other, each once the one before landed. Tries:
 *
 * 1. Wallet Standard signTransaction with all of them in one request (one approval in Phantom, Solflare,
 *    Backpack and most others).
 * 2. The classic signAllTransactions (one approval).
 * 3. The classic signTransaction, one approval per transaction.
 *
 * Returns the signed transactions, in the same order. Stops like sendWithWallet: a "no", an open request,
 * another account, or `stopped()` turning true.
 */
export async function signAllWithWallet(w: Wallet, owner: string, txs: Uint8Array[], stopped?: () => boolean): Promise<Uint8Array[]> {
  const tried: string[] = [];
  const wrongAccount = () => new SignInError('account', `Switch ${w.name} to the account you signed in with (${owner.slice(0, 4)}…${owner.slice(-4)}), then try again.`);
  const attempt = async <T,>(label: string, run: () => Promise<T>): Promise<T | null> => {
    if (stopped?.()) throw new SignInError('stopped', 'Stopped waiting for the wallet.', tried);
    try {
      return await run();
    } catch (e) {
      if (e instanceof SignInError) throw e;
      console.error(`[binwise] ${w.name}: ${label} failed`, e);
      const stop = walletFailure(e);
      if (stop) throw stop;
      tried.push(`${label}: ${describe(e)}`);
      return null;
    }
  };
  const all = <T,>(out: readonly T[]) => {
    if (out.length !== txs.length) throw new Error(`The wallet returned ${out.length} of ${txs.length} transactions.`);
    return out;
  };

  if (SolanaSignTransaction in w.features) {
    const connector = (w.features as StandardConnectFeature)[StandardConnect];
    const account = await attempt('Connect', async () => {
      const mine = (accounts: readonly WalletAccount[]) => accounts.find((a) => a.address === owner);
      const found =
        mine(w.accounts) ??
        mine(await quietly(connector.connect({ silent: true })).then((r) => r.accounts, () => [])) ??
        mine((await connector.connect()).accounts);
      if (!found) throw wrongAccount();
      return found;
    });
    if (account) {
      const signed = await attempt('Sign', async () => {
        const out = await (w.features as SolanaSignTransactionFeature)[SolanaSignTransaction].signTransaction(
          ...txs.map((transaction) => ({ account, chain: mainnetOf(account), transaction })),
        );
        return all(out).map((o) => o.signedTransaction);
      });
      if (signed) return signed;
    }
  }

  const injected = injectedFor(w.name);
  const p = injected && !(/phantom/i.test(w.name) && impostorOf(injected)) ? injected : null;
  const web3 =
    p && (p.signAllTransactions || p.signTransaction)
      ? await attempt('Classic connect', async () => {
          if ((await connectInjected(p)) !== owner) throw wrongAccount();
          return import('@solana/web3.js');
        })
      : null;
  if (web3 && p) {
    // A fresh @solana/web3.js object per request, legacy or versioned as built.
    const objects = () =>
      txs.map((t) => {
        const v = web3.VersionedTransaction.deserialize(t);
        return v.version === 'legacy' ? web3.Transaction.from(t) : v;
      });
    // The position's own signature is already on it: serialize without asking for every signature again.
    const bytes = (t: { serialize(opts?: object): Uint8Array }) => Uint8Array.from(t.serialize({ requireAllSignatures: false, verifySignatures: false }));
    if (p.signAllTransactions) {
      const signed = await attempt('Classic sign all', async () => all(await p.signAllTransactions!(objects())).map(bytes));
      if (signed) return signed;
    }
    if (p.signTransaction) {
      const signed = await attempt('Classic sign', async () => {
        const out: Uint8Array[] = [];
        for (const t of objects()) {
          if (stopped?.()) throw new SignInError('stopped', 'Stopped waiting for the wallet.', tried);
          out.push(bytes(await p.signTransaction!(t)));
        }
        return out;
      });
      if (signed) return signed;
    }
  }
  console.error(`[binwise] ${w.name} could not sign:`, tried, '|', phantomDiagnostics());
  throw new SignInError('wallet', tried.length ? tried.join('\n') : `${w.name} can't sign transactions from this page.`, tried);
}
