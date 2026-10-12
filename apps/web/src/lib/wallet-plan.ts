import { ApiError, type BinwiseClient, type WalletAction, type WalletTxStatus } from './api/client';
import { SignInError, signAllWithWallet, signsVersioned, type Wallet } from './wallets';

/** Where a plan is: being built, waiting for the wallet's approval, sending step `step` of `steps`, being recorded. */
export type PlanPhase =
  | { phase: 'prepare' }
  | { phase: 'approve'; steps: number; summary: string[] }
  | { phase: 'send'; step: number; steps: number; label: string }
  | { phase: 'record' };

/** Seconds between asks whether a sent transaction landed: about 90 seconds in all (a blockhash lives about a minute). */
const TX_WAITS_S = [1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 8, 10, 10, 10, 10, 10];
/** Seconds between asks to record the plan once all its transactions landed (Solana's reads can lag a little). */
const RECORD_WAITS_S = [0, 2, 3, 5, 8, 10];

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Carries out an action in the owner's own wallet (self-custody): Binwise builds the transactions, the
 * wallet signs them all in one approval, Binwise sends them one after the other (each once the one before
 * landed, since the next one uses what it produced), then records what Solana shows. Nothing moves
 * without the approval, and everything stays in the owner's wallet. Returns what was recorded.
 *
 * `stopped()` turning true before the approval cancels; after it, the plan finishes: stopping half way
 * would leave, say, a swap without its LP.
 */
export async function runWalletPlan(o: {
  client: BinwiseClient;
  owner: string;
  wallet: Wallet;
  action: WalletAction;
  onPhase: (p: PlanPhase) => void;
  stopped: () => boolean;
}): Promise<{ title: string }> {
  o.onPhase({ phase: 'prepare' });
  const plan = await o.client.walletPrepare(o.action, !signsVersioned(o.wallet));
  if (o.stopped()) throw new SignInError('stopped', 'Stopped waiting for the wallet.');
  o.onPhase({ phase: 'approve', steps: plan.steps.length, summary: plan.summary });
  const signed = await signAllWithWallet(
    o.wallet,
    o.owner,
    plan.steps.map((s) => fromBase64(s.tx)),
    o.stopped,
  );

  const sigs: string[] = [];
  /** Stopped at step `i`: what went through before it, and that everything is still in the owner's wallet. */
  const stoppedAt = (i: number, why: string) => {
    const doneLabels = plan.steps.slice(0, i).map((s) => s.label.toLowerCase());
    return new Error(
      i === 0
        ? `${why} Nothing changed: everything is still in your wallet.`
        : `${doneLabels.join(', ')}: done. ${plan.steps[i].label}: not done. ${why} What went through is in your wallet; try again from here.`,
    );
  };
  for (let i = 0; i < signed.length; i++) {
    o.onPhase({ phase: 'send', step: i + 1, steps: signed.length, label: plan.steps[i].label });
    let r: WalletTxStatus;
    try {
      r = await o.client.walletSend(toBase64(signed[i]));
    } catch (e) {
      throw stoppedAt(i, e instanceof ApiError ? e.message : 'Could not reach Binwise.');
    }
    const sig = r.signature!;
    sigs.push(sig);
    for (const s of TX_WAITS_S) {
      if (r.status !== 'pending') break;
      await sleep(s * 1000);
      r = await o.client.walletTx(sig).catch(() => r);
    }
    if (r.status === 'failed') throw stoppedAt(i, r.error ?? 'Solana refused it.');
    if (r.status === 'pending') throw stoppedAt(i, "Solana hasn't confirmed it after 90 seconds. If it lands, it shows here within a few minutes.");
  }

  o.onPhase({ phase: 'record' });
  for (const s of RECORD_WAITS_S) {
    await sleep(s * 1000);
    try {
      const d = await o.client.walletDone(plan.planId, sigs);
      return { title: d.title ?? 'Done' };
    } catch (e) {
      if (!(e instanceof ApiError) || (e.code !== 'not_yet' && e.code !== 'rate_limited')) throw e;
    }
  }
  // Landed, not readable yet: the app records it on its next load (finishPendingPlans).
  return { title: 'Done on Solana. It shows here in a minute.' };
}

/**
 * Records plans an earlier visit approved but didn't get to record (closed tab, lost connection). Returns
 * the titles of what it recorded now. Quiet: anything it can't record yet stays for the next time.
 */
export async function finishPendingPlans(client: BinwiseClient): Promise<string[]> {
  const pending = await client.walletPending().catch(() => []);
  const titles: string[] = [];
  for (const p of pending) {
    const d = await client.walletDone(p.planId, []).catch(() => null);
    if (d?.ok && d.title && !d.already) titles.push(d.title);
  }
  return titles;
}

/** Why an action in the wallet stopped, in plain words (`name`: the wallet's name). */
export function walletErrorText(e: unknown, name: string): string {
  if (e instanceof SignInError) {
    if (e.kind === 'rejected') return `Cancelled in ${name}. Nothing was sent.`;
    if (e.kind === 'pending') return `${name} already has a request open. Click the ${name} icon in your browser's toolbar, approve or reject it there, then try again.`;
    return e.message;
  }
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong. Nothing was sent; try again.';
}
