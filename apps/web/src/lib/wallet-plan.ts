import { BRAND } from '@kovra/core/brand';
import { ApiError, type KovraClient, type WalletAction, type WalletTxStatus } from './api/client';
import { SignInError, signAllWithWallet, signsVersioned, type Wallet } from './wallets';

/** Where a plan is: being built, waiting for the wallet's approval, sending step `step` of `steps`, being recorded. */
export type PlanPhase =
  | { phase: 'prepare' }
  /** signed: how many the wallet signed so far (wallets that ask once per transaction) */
  | { phase: 'approve'; steps: number; summary: string[]; signed?: number }
  | { phase: 'send'; step: number; steps: number; label: string }
  | { phase: 'record' };

/** Seconds between asks whether a sent transaction landed: about 90 seconds in all (a blockhash lives about a minute). */
const TX_WAITS_S = [1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 8, 10, 10, 10, 10, 10];
/** Seconds between asks to record the plan once all its transactions landed (Solana's reads can lag a little). */
const RECORD_WAITS_S = [0, 2, 3, 5, 8, 10];

const SOL = 'So11111111111111111111111111111111111111112';

/**
 * A plan that stopped part way. `resume`: an Add LP whose swaps went through but whose position didn't open:
 * the same Add LP from what the swaps brought into the wallet (nothing to swap again).
 */
export class PlanStopped extends Error {
  constructor(
    message: string,
    readonly resume?: WalletAction,
  ) {
    super(message);
  }
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Carries out an action in the owner's own wallet (self-custody): Kovra builds the transactions, the
 * wallet signs them all in one approval, Kovra sends them one after the other (each once the one before
 * landed, since the next one uses what it produced), then records what Solana shows. Nothing moves
 * without the approval, and everything stays in the owner's wallet. Returns what was recorded.
 *
 * `stopped()` turning true before the approval cancels; after it, the plan finishes: stopping half way
 * would leave, say, a swap without its LP.
 */
export async function runWalletPlan(o: {
  client: KovraClient;
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
  let signed: Uint8Array[];
  try {
    signed = await signAllWithWallet(
      o.wallet,
      o.owner,
      plan.steps.map((s) => fromBase64(s.tx)),
      o.stopped,
      (n, total) => n < total && o.onPhase({ phase: 'approve', steps: total, summary: plan.summary, signed: n }),
    );
  } catch (e) {
    // Nothing signed reaches Solana without this page: the plan is dead, so another can be prepared right away.
    void o.client.walletCancel(plan.planId).catch(() => {});
    throw e;
  }

  const sigs: string[] = [];
  /**
   * Stopped at step `i`: what went through before it, and that everything is still in the owner's wallet.
   * `surely`: step `i` certainly didn't land (Solana refused it), so an Add LP stopped after its swaps can finish
   * from what they brought in.
   */
  const stoppedAt = (i: number, why: string, surely = false) => {
    const done = plan.steps.slice(0, i).map((s) => s.label.toLowerCase()).join(', ');
    const doneLabels = done.charAt(0).toUpperCase() + done.slice(1);
    const resume = surely && i > 0 ? resumeAfterSwaps(o.action, plan, i) : undefined;
    // Nothing more of this plan can land: another Add LP into this pool can be prepared at once.
    if (resume) void o.client.walletCancel(plan.planId).catch(() => {});
    return new PlanStopped(
      i === 0
        ? `${why} Nothing changed: everything is still in your wallet.`
        : `${doneLabels}: done. ${plan.steps[i].label}: not done. ${why} ${resume ? 'The swapped tokens are in your wallet: finish the LP with them below.' : 'What went through is in your wallet; try again from here.'}`,
      resume,
    );
  };
  for (let i = 0; i < signed.length; i++) {
    o.onPhase({ phase: 'send', step: i + 1, steps: signed.length, label: plan.steps[i].label });
    let r: WalletTxStatus;
    try {
      r = await o.client.walletSend(toBase64(signed[i]), plan.planId, i);
    } catch (e) {
      // The first step refused before it was sent (Solana's simulation, a checked swap, a switch): nothing of the plan can land.
      if (i === 0 && e instanceof ApiError && ['sim_failed', 'swap_refused', 'unsigned', 'bad_tx', 'kill_switch', 'live_disabled'].includes(e.code))
        void o.client.walletCancel(plan.planId).catch(() => {});
      // Refused by Solana's simulation or the swap check: it surely didn't go out.
      throw stoppedAt(i, e instanceof ApiError ? e.message : `Could not reach ${BRAND}.`, e instanceof ApiError && ['sim_failed', 'swap_refused'].includes(e.code));
    }
    const sig = r.signature!;
    sigs.push(sig);
    for (const s of TX_WAITS_S) {
      if (r.status !== 'pending') break;
      await sleep(s * 1000);
      r = await o.client.walletTx(sig).catch(() => r);
    }
    if (r.status === 'failed') throw stoppedAt(i, r.error ?? 'Solana refused it.', true);
    if (r.status === 'pending') throw stoppedAt(i, "Solana hasn't confirmed it after 90 seconds. If it lands, it shows here within a few minutes.");
  }

  o.onPhase({ phase: 'record' });
  for (const s of RECORD_WAITS_S) {
    await sleep(s * 1000);
    try {
      const d = await o.client.walletDone(plan.planId, sigs);
      return { title: d.title ?? 'Done' };
    } catch (e) {
      // Not on Solana yet, or the agent is busy with this vault for a moment: ask again.
      if (!(e instanceof ApiError) || !['not_yet', 'rate_limited', 'vault_busy'].includes(e.code)) throw e;
    }
  }
  // Landed, not readable yet: the app records it on its next load (finishPendingPlans).
  return { title: 'Done on Solana. It shows here in a minute.' };
}

/**
 * The same Add LP, from what an Add LP stopped at step `i` brought into the wallet: only when every step before
 * it was a swap (no position opened yet). What it spends: its budget, minus the swaps' inputs, plus their
 * guaranteed outputs (a little more usually arrives and stays in the wallet).
 */
function resumeAfterSwaps(action: WalletAction, plan: Awaited<ReturnType<KovraClient['walletPrepare']>>, i: number): WalletAction | undefined {
  if (action.action !== 'open' || !plan.budget || !plan.swaps || !plan.steps.slice(0, i).every((s) => s.kind === 'swap')) return undefined;
  const hold: Record<string, number> = { [SOL]: plan.budget.sol, ...plan.budget.use };
  for (const sw of plan.swaps.slice(0, i)) {
    hold[sw.from] = (hold[sw.from] ?? 0) - sw.inUi;
    hold[sw.to] = (hold[sw.to] ?? 0) + sw.minOutUi;
  }
  const use = Object.fromEntries(Object.entries(hold).filter(([m, a]) => m !== SOL && a > 0));
  const sol = Math.max(0, Math.floor((hold[SOL] ?? 0) * 1e9) / 1e9);
  return { ...action, sol, use };
}

/**
 * Records plans an earlier visit approved but didn't get to record (closed tab, lost connection). Returns
 * the titles of what it recorded now. Quiet: anything it can't record yet stays for the next time.
 */
export async function finishPendingPlans(client: KovraClient): Promise<string[]> {
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
