import { Connection, PublicKey, type Commitment, type ConnectionConfig, type VersionedTransaction } from '@solana/web3.js';
import { fetchJson, withRetry } from './http';

/** Longest one RPC request may take. Without it a stalled request would freeze the collector or agent forever. */
export const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 20_000);

export function makeConnection(url = process.env.RPC_URL, wsEndpoint = process.env.RPC_WS_URL || undefined, commitment: Commitment = 'confirmed') {
  if (!url) throw new Error('RPC_URL is not set');
  return new Connection(url, {
    commitment,
    wsEndpoint,
    fetch: ((input: string | URL, init?: RequestInit) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })) as unknown as ConnectionConfig['fetch'],
  });
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

/** Simulates and returns the accounts' state after the transaction (for balance checks). */
export async function simulateWithAccounts(conn: Connection, tx: VersionedTransaction, addresses: string[]) {
  const r = await withRetry(
    () => conn.simulateTransaction(tx, { sigVerify: true, commitment: 'processed', accounts: { encoding: 'base64', addresses } }),
    2,
    'simulateTransaction',
  );
  if (r.value.err) throw new SimulationFailed(`Simulation failed: ${JSON.stringify(r.value.err)}`, r.value.logs);
  return r.value.accounts ?? [];
}

export class TxFailed extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for a sent transaction. If the normal confirmation errors out (timeout, dropped
 * websocket, block-height expiry), asks the chain for the signature's real status instead of
 * guessing, so a transaction that did land is never treated as failed and sent again.
 */
export async function confirmOrCheck(conn: Connection, sig: string, blockhash: string, lastValidBlockHeight: number): Promise<string> {
  try {
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (res.value.err) throw new TxFailed(`Transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  } catch (e) {
    if (e instanceof TxFailed) throw e;
    for (let i = 0; i < 60; i++) {
      const st = (await withRetry(() => conn.getSignatureStatuses([sig], { searchTransactionHistory: true }), 3, 'getSignatureStatuses')).value[0];
      if (st?.err) throw new TxFailed(`Transaction ${sig} failed: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
      // Once the blockhash has expired the transaction can no longer land: safe to call it failed.
      if ((await withRetry(() => conn.getBlockHeight('confirmed'), 3, 'getBlockHeight')) > lastValidBlockHeight) {
        const last = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
        if (last && !last.err) return sig;
        throw new TxFailed(`Transaction ${sig} did not land before its blockhash expired.`);
      }
      await sleep(2000);
    }
    throw new Error(`Transaction ${sig} is still unconfirmed. Check it on an explorer before retrying.`);
  }
}

/** Sends a signed transaction (no preflight; we already simulated) and waits for confirmation. */
export async function sendAndConfirm(conn: Connection, tx: VersionedTransaction, lastValidBlockHeight: number): Promise<string> {
  const raw = tx.serialize();
  const sig = await withRetry(() => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 }), 2, 'sendRawTransaction');
  return confirmOrCheck(conn, sig, tx.message.recentBlockhash, lastValidBlockHeight);
}
