import { DuplicateAction, SOL_MINT, walletAddress, type KillSwitch } from '@kovra/chain';
import { shrinkDeposits, type PrismaClient, type Vault } from '@kovra/db';
import type { ManualResult } from './agent';

/**
 * Wallet actions for the Telegram bot: withdrawals, and which vaults are "bot wallets".
 * A bot wallet is a vault created in Telegram: it has no separate owner wallet, so its own agent
 * wallet is the user's registered wallet, and withdrawals go to an address the user types.
 */

/** The parts of the live executor a withdrawal needs (tests swap in a fake). */
export interface WithdrawChain {
  holdings(): Promise<Record<string, number>>;
  withdrawableSol(nothingDeployed: boolean): Promise<number>;
  withdraw(mint: string, uiAmount: number, key: string): Promise<string>;
}

export interface WithdrawDeps {
  db: PrismaClient;
  killSwitch: KillSwitch;
  /** A live executor for this vault that sends withdrawals to `to`. */
  chainFor: (vault: Vault, to: string) => Promise<WithdrawChain>;
  now?: () => number;
}

export interface WithdrawRequest {
  id: string;
  mint: string;
  /** Share of the idle balance, 1–100 */
  pct: number;
  /** Destination (bot wallets only; website vaults always withdraw to their registered wallet) */
  to?: string;
}

export const isBotWallet = (user: { wallet: string }, vault: { agentPubkey: string | null }) => !!vault.agentPubkey && user.wallet === vault.agentPubkey;

const amountText = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 4 });
export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Sends idle funds out of a live vault. Returns null when this exact request already ran. */
export async function runWithdraw(d: WithdrawDeps, vault: Vault, req: WithdrawRequest): Promise<ManualResult | null> {
  const { db } = d;
  const now = (d.now ?? Date.now)();
  if (vault.mode !== 'live' || !vault.encSecret) throw new Error('This vault uses simulated money (Paper), so there is nothing to withdraw on-chain.');
  if (await d.killSwitch.isKilled()) throw new Error('Trading is halted right now. Nothing was sent; try again later.');
  const user = await db.user.findUniqueOrThrow({ where: { id: vault.userId } });
  // Website vaults: only ever to the registered wallet, whatever the request says.
  const to = isBotWallet(user, vault) ? walletAddress(req.to ?? '') : user.wallet;
  if (!to || to === vault.agentPubkey) throw new Error('That is not a wallet address funds can be sent to.');
  const chain = await d.chainFor(vault, to);
  const open = await db.position.count({ where: { vaultId: vault.id, status: 'open' } });
  const have = req.mint === SOL_MINT ? await chain.withdrawableSol(open === 0) : ((await chain.holdings())[req.mint] ?? 0);
  const pct = Math.min(100, Math.max(1, Math.round(req.pct)));
  const amount = pct === 100 ? have : (have * pct) / 100;
  if (!(amount > 0))
    throw new Error(open ? 'Nothing idle to withdraw: the funds are in positions. Close them first (💼 Positions → Close).' : 'Nothing to withdraw.');
  let sig: string;
  try {
    sig = await chain.withdraw(req.mint, amount, `withdraw:${req.id}`);
  } catch (e) {
    if (e instanceof DuplicateAction) return null;
    throw e;
  }
  const token = await db.token.findUnique({ where: { mint: req.mint } });
  const symbol = req.mint === SOL_MINT ? 'SOL' : (token?.symbol ?? shortAddress(req.mint));
  const flowUsd = amount * (token?.priceUsd ?? 0);
  const fresh = await db.vault.findUniqueOrThrow({ where: { id: vault.id } });
  await db.vault.update({ where: { id: vault.id }, data: { deposits: await shrinkDeposits(db, fresh.deposits as Record<string, number>, flowUsd) } });
  const title = `Withdrew ${amountText(amount)} ${symbol}`;
  await db.decision.create({
    data: { vaultId: vault.id, ts: new Date(now), type: 'exit', title, reason: `Sent to ${shortAddress(to)} (requested from Telegram).`, inputs: { flowUsd: -flowUsd, manual: true }, txSig: sig },
  });
  return { title, text: `Sent to ${to}\nhttps://solscan.io/tx/${sig}` };
}
