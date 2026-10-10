import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

/**
 * Programs the agent may call (CLAUDE.md §3). IDs verified against the
 * @meteora-ag/dlmm SDK constants, @solana/spl-token, and Jupiter's docs.
 */
export const PROGRAM_IDS = {
  DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  SYSTEM: SystemProgram.programId.toBase58(),
  COMPUTE_BUDGET: ComputeBudgetProgram.programId.toBase58(),
  TOKEN: TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022: TOKEN_2022_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  /** Used by the DLMM SDK for Token-2022 transfers */
  MEMO: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
} as const;

export const ALLOWED_PROGRAMS = new Set<string>(Object.values(PROGRAM_IDS));

export class PolicyViolation extends Error {}

export interface TxPolicy {
  /** Accounts a top-level SOL transfer may go to (agent's own ATAs, Jito tip accounts, owner wallet on withdraw) */
  transferDestinations: Set<string>;
  /** Fresh accounts the transaction may create (e.g. the new position keypair) */
  newAccounts: Set<string>;
  /** Set only for withdrawals: top-level token transfers must land in these accounts */
  tokenDestinations?: Set<string>;
}

function checkInstruction(ix: TransactionInstruction, policy: TxPolicy) {
  const program = ix.programId.toBase58();
  if (!ALLOWED_PROGRAMS.has(program)) throw new PolicyViolation(`Program ${program} is not on the allowlist`);
  if (program === PROGRAM_IDS.SYSTEM) {
    const type = SystemInstruction.decodeInstructionType(ix);
    if (type === 'Transfer') {
      const { toPubkey } = SystemInstruction.decodeTransfer(ix);
      if (!policy.transferDestinations.has(toPubkey.toBase58()))
        throw new PolicyViolation(`SOL transfer to ${toPubkey.toBase58()} is not allowed`);
    } else if (type === 'Create') {
      const { newAccountPubkey } = SystemInstruction.decodeCreateAccount(ix);
      if (!policy.newAccounts.has(newAccountPubkey.toBase58())) throw new PolicyViolation('Unexpected account creation');
    } else throw new PolicyViolation(`System instruction ${type} is not allowed`);
  }
  if ((program === PROGRAM_IDS.TOKEN || program === PROGRAM_IDS.TOKEN_2022) && policy.tokenDestinations) {
    // Transfer = 3, TransferChecked = 12 (SPL Token instruction tags)
    const tag = ix.data[0];
    if (tag === 3 || tag === 12) {
      const dest = ix.keys[tag === 3 ? 1 : 2].pubkey.toBase58();
      if (!policy.tokenDestinations.has(dest)) throw new PolicyViolation(`Token transfer to ${dest} is not allowed`);
    }
  }
}

/** Throws PolicyViolation unless every top-level instruction passes the policy. */
export function assertTxAllowed(
  tx: Transaction | VersionedTransaction,
  policy: TxPolicy,
  lookupTables: AddressLookupTableAccount[] = [],
): void {
  const ixs =
    tx instanceof Transaction
      ? tx.instructions
      : TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: lookupTables }).instructions;
  ixs.forEach((ix) => checkInstruction(ix, policy));
}

/** Lookup table addresses a versioned transaction references. */
export const lookupTableKeys = (tx: VersionedTransaction): PublicKey[] =>
  tx.message.addressTableLookups.map((l) => l.accountKey);
