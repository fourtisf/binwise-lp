import { ComputeBudgetProgram, SystemInstruction, SystemProgram, type ParsedTransactionWithMeta, type Transaction } from '@solana/web3.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * What a confirmed transaction deposited from the owner's wallet into the agent wallet, by mint
 * (UI amounts). Only plain SOL transfers owner → agent and SPL transfers signed by the owner into the
 * agent's own token account count; token amounts are what actually arrived (Token-2022 transfer fees
 * are taken in transit). Empty when nothing qualifies.
 *
 * A wallet created in Telegram has no separate owner wallet (owner = agent): there, money sent from
 * any other address counts (an exchange, a friend, the user's own Phantom).
 */
export function parseDeposit(tx: ParsedTransactionWithMeta, owner: string, agent: string): Record<string, number> {
  const meta = tx.meta;
  const credited: Record<string, number> = {};
  if (!meta || meta.err) return credited;
  const anySource = owner === agent;
  const fromOwner = (a: unknown) => typeof a === 'string' && (anySource ? a !== agent : a === owner);
  for (const ix of tx.transaction.message.instructions) {
    if (!('parsed' in ix)) continue;
    const type = ix.parsed?.type;
    const info = ix.parsed?.info;
    if (ix.program === 'system' && type === 'transfer' && fromOwner(info.source) && info.destination === agent)
      credited[SOL_MINT] = (credited[SOL_MINT] ?? 0) + info.lamports / 1e9;
    const spl = ix.program === 'spl-token' || ix.program === 'spl-token-2022';
    // Exchanges often send with plain `transfer`; only accepted where any sender counts.
    if (spl && (type === 'transferChecked' || (anySource && type === 'transfer')) && fromOwner(info.authority ?? info.multisigAuthority)) {
      const post = meta.postTokenBalances?.find((b) => b.owner === agent && tx.transaction.message.accountKeys[b.accountIndex]?.pubkey.toBase58() === info.destination);
      if (!post || (info.mint && info.mint !== post.mint)) continue;
      const sent = type === 'transferChecked' ? Number(info.tokenAmount.uiAmount) : Number(info.amount) / 10 ** post.uiTokenAmount.decimals;
      const pre = meta.preTokenBalances?.find((b) => b.accountIndex === post.accountIndex)?.uiTokenAmount.uiAmount ?? 0;
      const received = Math.min(sent, (post.uiTokenAmount.uiAmount ?? 0) - pre);
      if (received > 0) credited[post.mint] = (credited[post.mint] ?? 0) + received;
    }
  }
  return credited;
}

/** Instructions a wallet may add to a transfer it signs: priority fees and Lighthouse's balance guards. */
const WALLET_ADDED = new Set([ComputeBudgetProgram.programId.toBase58(), 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95']);

export class NotADeposit extends Error {}

/**
 * Lamports a transfer signed by the owner's wallet moves into the agent wallet, before Binwise broadcasts
 * it on the wallet's behalf. Only one plain SOL transfer from the owner (also the fee payer) to the agent
 * passes, beside what wallets add on their own; anything else throws NotADeposit.
 */
export function depositTransferLamports(tx: Transaction, owner: string, agent: string): number {
  if (tx.feePayer?.toBase58() !== owner) throw new NotADeposit('The network fee is not paid by your wallet.');
  const own = tx.instructions.filter((ix) => !WALLET_ADDED.has(ix.programId.toBase58()));
  if (own.length !== 1 || !own[0].programId.equals(SystemProgram.programId) || SystemInstruction.decodeInstructionType(own[0]) !== 'Transfer')
    throw new NotADeposit('Only a SOL transfer to the vault can be sent.');
  const { fromPubkey, toPubkey, lamports } = SystemInstruction.decodeTransfer(own[0]);
  if (fromPubkey.toBase58() !== owner || toPubkey.toBase58() !== agent) throw new NotADeposit('Only a transfer from your wallet to this vault can be sent.');
  return Number(lamports);
}
