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

  /** Token metadata (logo, audit) for up to 100 mints per call. */
  async tokens(mints: string[]): Promise<JupiterToken[]> {
    const out: JupiterToken[] = [];
    for (let i = 0; i < mints.length; i += 100) {
      const query = mints.slice(i, i + 100).join(',');
      out.push(...(await fetchJson<JupiterToken[]>(`${this.baseUrl}/tokens/v2/search?query=${query}`, { headers: this.headers, minIntervalMs: this.spacing })));
    }
    return out;
  }

  quote(inputMint: string, outputMint: string, amountRaw: string, slippageBps = 50) {
    const q = new URLSearchParams({ inputMint, outputMint, amount: amountRaw, slippageBps: String(slippageBps), restrictIntermediateTokens: 'true' });
    return fetchJson<JupiterQuote>(`${this.baseUrl}/swap/v1/quote?${q}`, { headers: this.headers, minIntervalMs: this.spacing });
  }

  swap(quoteResponse: JupiterQuote, userPublicKey: string, maxPriorityLamports = 200_000) {
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
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: 'high', maxLamports: maxPriorityLamports } },
      },
    });
  }
}
