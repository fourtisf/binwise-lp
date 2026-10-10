import type { ParsedTransactionWithMeta } from '@solana/web3.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * What a confirmed transaction deposited from the owner's wallet into the agent wallet, by mint
 * (UI amounts). Only plain SOL transfers owner → agent and SPL transferChecked signed by the owner
 * into the agent's own token account count; token amounts are what actually arrived (Token-2022
 * transfer fees are taken in transit). Empty when nothing qualifies.
 */
export function parseDeposit(tx: ParsedTransactionWithMeta, owner: string, agent: string): Record<string, number> {
  const meta = tx.meta;
  const credited: Record<string, number> = {};
  if (!meta || meta.err) return credited;
  for (const ix of tx.transaction.message.instructions) {
    if (!('parsed' in ix)) continue;
    const info = ix.parsed?.info;
    if (ix.program === 'system' && ix.parsed?.type === 'transfer' && info.source === owner && info.destination === agent)
      credited[SOL_MINT] = (credited[SOL_MINT] ?? 0) + info.lamports / 1e9;
    if ((ix.program === 'spl-token' || ix.program === 'spl-token-2022') && ix.parsed?.type === 'transferChecked' && info.authority === owner) {
      const post = meta.postTokenBalances?.find((b) => b.mint === info.mint && b.owner === agent);
      const destKey = post ? tx.transaction.message.accountKeys[post.accountIndex]?.pubkey.toBase58() : null;
      if (post && destKey === info.destination) {
        const pre = meta.preTokenBalances?.find((b) => b.accountIndex === post.accountIndex)?.uiTokenAmount.uiAmount ?? 0;
        const received = Math.min(Number(info.tokenAmount.uiAmount), (post.uiTokenAmount.uiAmount ?? 0) - pre);
        if (received > 0) credited[info.mint] = (credited[info.mint] ?? 0) + received;
      }
    }
  }
  return credited;
}
