import { fetchJson } from './http';

/**
 * Jupiter API (https://api.jup.ag). x-api-key is optional; keyless is 0.5 rps.
 * Price v3 and Swap v1 (quote + swap) per jup-ag/docs openapi-spec/swap/v1/swap.yaml.
 */

export interface JupiterPrice {
  usdPrice: number;
  blockId: number;
  decimals: number;
  priceChange24h: number;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  contextSlot?: number;
}

export interface JupiterSwapResponse {
  /** base64 unsigned versioned transaction */
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

/** One instruction of /swap/v1/swap-instructions (data base64). */
export interface JupiterInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

/** /swap/v1/swap-instructions: the swap as instructions, to share a transaction with others. */
export interface JupiterSwapInstructions {
  computeBudgetInstructions: JupiterInstruction[];
  otherInstructions: JupiterInstruction[];
  setupInstructions: JupiterInstruction[];
  swapInstruction: JupiterInstruction;
  cleanupInstruction?: JupiterInstruction | null;
  tokenLedgerInstruction?: JupiterInstruction | null;
  addressLookupTableAddresses: string[];
}

/** Tokens API v2 (jup-ag/docs tokens/token-information.mdx); fields we use. */
export interface JupiterToken {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  isVerified?: boolean;
  holderCount?: number;
  mcap?: number;
  usdPrice?: number;
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; topHoldersPercentage?: number };
}

export class JupiterClient {
  constructor(
    readonly baseUrl = process.env.JUPITER_API_URL || 'https://api.jup.ag',
    readonly apiKey = process.env.JUPITER_API_KEY || '',
  ) {}

  private get headers() {
    return this.apiKey ? { 'x-api-key': this.apiKey } : undefined;
  }

  private get spacing() {
    return this.apiKey ? 1000 : 2000;
  }

  /** USD prices for up to 50 mints per call. Mints without a reliable price are omitted. */
  async prices(mints: string[]): Promise<Record<string, JupiterPrice>> {
    const out: Record<string, JupiterPrice> = {};
    for (let i = 0; i < mints.length; i += 50) {
      const ids = mints.slice(i, i + 50).join(',');
      Object.assign(
        out,
        await fetchJson<Record<string, JupiterPrice>>(`${this.baseUrl}/price/v3?ids=${ids}`, { headers: this.headers, minIntervalMs: this.spacing }),
      );
    }
    return out;
  }

  /** Token metadata (logo, audit, price) for up to 100 mints per call. `o`: a page can't wait 15s × 4 retries. */
  async tokens(mints: string[], o: { timeoutMs?: number; retries?: number } = {}): Promise<JupiterToken[]> {
    const out: JupiterToken[] = [];
    for (let i = 0; i < mints.length; i += 100) {
      const query = mints.slice(i, i + 100).join(',');
      out.push(...(await fetchJson<JupiterToken[]>(`${this.baseUrl}/tokens/v2/search?query=${query}`, { headers: this.headers, minIntervalMs: this.spacing, ...o })));
    }
    return out;
  }

  /** `asLegacyTransaction`: a route that fits a legacy transaction (wallets that can't sign versioned ones). */
  quote(inputMint: string, outputMint: string, amountRaw: string, slippageBps = 50, maxAccounts?: number, asLegacyTransaction = false) {
    const q = new URLSearchParams({ inputMint, outputMint, amount: amountRaw, slippageBps: String(slippageBps), restrictIntermediateTokens: 'true' });
    // Swap API v1 quote parameter: rough cap on accounts the route may use (default 64).
    if (maxAccounts) q.set('maxAccounts', String(maxAccounts));
    if (asLegacyTransaction) q.set('asLegacyTransaction', 'true');
    return fetchJson<JupiterQuote>(`${this.baseUrl}/swap/v1/quote?${q}`, { headers: this.headers, minIntervalMs: this.spacing });
  }

  swap(quoteResponse: JupiterQuote, userPublicKey: string, maxPriorityLamports = 200_000, asLegacyTransaction = false) {
    return fetchJson<JupiterSwapResponse>(`${this.baseUrl}/swap/v1/swap`, {
      method: 'POST',
      headers: this.headers,
      minIntervalMs: this.spacing,
      retries: 1,
      body: {
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        ...(asLegacyTransaction ? { asLegacyTransaction: true } : {}),
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: 'high', maxLamports: maxPriorityLamports } },
      },
    });
  }

  /** The quote's swap as instructions (versioned transactions only), for a transaction that also does other things. */
  swapInstructions(quoteResponse: JupiterQuote, userPublicKey: string) {
    return fetchJson<JupiterSwapInstructions>(`${this.baseUrl}/swap/v1/swap-instructions`, {
      method: 'POST',
      headers: this.headers,
      minIntervalMs: this.spacing,
      retries: 1,
      body: { quoteResponse, userPublicKey, wrapAndUnwrapSol: true },
    });
  }
}
