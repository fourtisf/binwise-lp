import { Connection, PublicKey, type Commitment, type VersionedTransaction } from '@solana/web3.js';
import { fetchJson, withRetry } from './http';

export function makeConnection(url = process.env.RPC_URL, wsEndpoint = process.env.RPC_WS_URL || undefined, commitment: Commitment = 'confirmed') {
  if (!url) throw new Error('RPC_URL is not set');
  return new Connection(url, { commitment, wsEndpoint });
}

/**
 * Compute-unit price (micro-lamports) for the given writable accounts.
 * Helius: getPriorityFeeEstimate with `recommended` (helius-labs/atlas-priority-fee-estimator).
 * Other RPCs: 75th percentile of getRecentPrioritizationFees.
 */
export async function priorityFeeMicroLamports(conn: Connection, accountKeys: string[], cap = 2_000_000): Promise<number> {
  const url = conn.rpcEndpoint;
  try {
    if (url.includes('helius')) {
      const r = await fetchJson<{ result?: { priorityFeeEstimate?: number } }>(url, {
        method: 'POST',
        body: { jsonrpc: '2.0', id: 1, method: 'getPriorityFeeEstimate', params: [{ accountKeys: accountKeys.slice(0, 500), options: { recommended: true } }] },
        retries: 2,
      });
      if (r.result?.priorityFeeEstimate != null) return Math.min(cap, Math.ceil(r.result.priorityFeeEstimate));
    }
    const fees = await withRetry(
      () => conn.getRecentPrioritizationFees({ lockedWritableAccounts: accountKeys.slice(0, 128).map((k) => new PublicKey(k)) }),
      2,
      'getRecentPrioritizationFees',
    );
    const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    const p75 = sorted.length ? sorted[Math.floor(sorted.length * 0.75)] : 10_000;
    return Math.min(cap, Math.max(10_000, p75));
  } catch {
    return 10_000;
  }
}

export class SimulationFailed extends Error {
  constructor(
    message: string,
    readonly logs: string[] | null,
  ) {
    super(message);
  }
}

/** Simulates first and aborts on any error (CLAUDE.md §3). Returns units consumed. */
export async function simulateOrThrow(conn: Connection, tx: VersionedTransaction): Promise<number | undefined> {
  const r = await withRetry(() => conn.simulateTransaction(tx, { sigVerify: true, commitment: 'processed' }), 2, 'simulateTransaction');
  if (r.value.err) throw new SimulationFailed(`Simulation failed: ${JSON.stringify(r.value.err)}`, r.value.logs);
  return r.value.unitsConsumed;
}

/** Sends a signed transaction (no preflight; we already simulated) and waits for confirmation. */
export async function sendAndConfirm(conn: Connection, tx: VersionedTransaction, lastValidBlockHeight: number): Promise<string> {
  const raw = tx.serialize();
  const sig = await withRetry(() => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 }), 2, 'sendRawTransaction');
  const res = await conn.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, 'confirmed');
  if (res.value.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}
