import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { fetchJson } from './http';

/**
 * Jito block engine JSON-RPC (jito-labs/jito-docs lowlatencytxnsend).
 * Bundles: max 5 txs, base64, min tip 1000 lamports, tip = SOL transfer to a tip account
 * inside the same transaction. Default rate limit 1 req/s per IP per region.
 */
export const MIN_TIP_LAMPORTS = 1000;

export class JitoClient {
  private tipAccounts: string[] = [];

  constructor(readonly baseUrl = process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf') {}

  private rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    return fetchJson<{ result: T; error?: { message: string } }>(`${this.baseUrl}${path}`, {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method, params },
      minIntervalMs: 1100,
      retries: 2,
    }).then((r) => {
      if (r.error) throw new Error(`Jito ${method}: ${r.error.message}`);
      return r.result;
    });
  }

  async getTipAccounts(): Promise<string[]> {
    if (!this.tipAccounts.length) this.tipAccounts = await this.rpc<string[]>('/api/v1/getTipAccounts', 'getTipAccounts', []);
    return this.tipAccounts;
  }

  /** SOL transfer to a random tip account; add it to the same transaction as the work. */
  async tipInstruction(payer: PublicKey, lamports: number): Promise<{ ix: TransactionInstruction; tipAccount: string }> {
    const accounts = await this.getTipAccounts();
    const tipAccount = accounts[Math.floor(Math.random() * accounts.length)];
    return {
      tipAccount,
      ix: SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(tipAccount), lamports: Math.max(MIN_TIP_LAMPORTS, lamports) }),
    };
  }

  /** Sends base64-encoded signed transactions as one atomic bundle. Returns the bundle id. */
  sendBundle(base64Txs: string[]): Promise<string> {
    if (base64Txs.length > 5) throw new Error('A Jito bundle holds at most 5 transactions');
    return this.rpc<string>('/api/v1/bundles', 'sendBundle', [base64Txs, { encoding: 'base64' }]);
  }

  getBundleStatuses(ids: string[]) {
    return this.rpc<{ value: { bundle_id: string; transactions: string[]; slot: number; confirmation_status: string; err: unknown }[] }>(
      '/api/v1/getBundleStatuses',
      'getBundleStatuses',
      [ids],
    );
  }
}
