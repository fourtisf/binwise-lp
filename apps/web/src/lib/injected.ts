/**
 * The wallets' own injected providers (window.phantom.solana, window.solflare, …): the classic API
 * most Solana sites use. The last way sign-in tries, after the Wallet Standard ones.
 */
export interface InjectedSolana {
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } } | void>;
  publicKey?: { toBase58(): string } | null;
  /** Bitget: the connected address (its connect() returns nothing; @solana/wallet-adapter-bitkeep reads this) */
  getAccount?(): Promise<string>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array } | Uint8Array>;
  /** Takes a @solana/web3.js Transaction */
  signAndSendTransaction?(tx: unknown): Promise<{ signature: string } | string>;
  /** Same, signed but not sent */
  signTransaction?(tx: unknown): Promise<{ serialize(opts?: object): Uint8Array }>;
  /** Several at once, one approval */
  signAllTransactions?(txs: unknown[]): Promise<{ serialize(opts?: object): Uint8Array }[]>;
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

/** Connects through the injected provider and returns the wallet address. */
export async function connectInjected(p: InjectedSolana): Promise<string> {
  const r = await p.connect();
  const pk = (r && 'publicKey' in r ? r.publicKey : null) ?? p.publicKey;
  const address = pk?.toBase58() ?? (await p.getAccount?.());
  if (!address) throw new Error('The wallet returned no account.');
  return address;
}

export async function signMessageInjected(p: InjectedSolana, message: Uint8Array): Promise<Uint8Array> {
  const r = await p.signMessage(message, 'utf8');
  return r instanceof Uint8Array ? r : r.signature;
}

/**
 * Which extension really answers as `window.phantom.solana`. Bitget, Trust, OKX and others can take
 * over Phantom's slot ("use as default" settings); requests then reach the wrong wallet and fail.
 */
export function impostorOf(p: object | null | undefined): string | null {
  const f = (p ?? {}) as Record<string, unknown>;
  if (f.isBitKeep || f.isBitget || f.isBitgetWallet) return 'Bitget Wallet';
  if (f.isTrust || f.isTrustWallet) return 'Trust Wallet';
  if (f.isOkxWallet || f.isOKExWallet) return 'OKX Wallet';
  if (f.isCoinbaseWallet) return 'Coinbase Wallet';
  if (f.isMetaMask) return 'MetaMask';
  if (f.isSolflare) return 'Solflare';
  if (f.isBackpack) return 'Backpack';
  return null;
}

/** What answers as Phantom on this page, for the console. */
export function phantomDiagnostics(): string {
  if (typeof window === 'undefined') return '';
  const w = window as unknown as { phantom?: { solana?: object }; solana?: object };
  const p = w.phantom?.solana;
  const parts = [
    p ? `window.phantom.solana from ${impostorOf(p) ?? 'Phantom'}` : 'no window.phantom.solana',
    w.solana ? `window.solana from ${impostorOf(w.solana) ?? 'Phantom'}` : 'no window.solana',
  ];
  return parts.join(', ');
}
