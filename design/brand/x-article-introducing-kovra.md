# X Article: "Judged by one number: introducing Kovra"

Cover: `kovra-x-article-cover.png` (5:2, 3000×1200). Paste the text below into X → Articles. Lines starting with `##` use
the "Heading" style in X's editor; `>` lines use the quote style. Claims match the code and the site's FAQ (October 2026);
re-check them before reusing this copy.

---

**Title:** Judged by one number: introducing Kovra

Most LP dashboards lead with APR. It's a big, flattering number, and it hides the only question that matters:

**Would you have done better just holding the tokens?**

Concentrated liquidity can earn fees all week and still leave you behind a wallet that did nothing. Price walks out of your range, impermanent loss eats the fees, and gas and swaps eat the rest. The APR still looks great.

Kovra keeps score differently. Every vault, every position and every chart is measured against one number: **net return vs simply holding the same tokens.** If it isn't beating holding, it isn't working, and you'll see it.

## What Kovra is

Kovra is an autonomous LP agent for Meteora DLMM pools on Solana. It watches the pools, scores them, works out where your liquidity should sit, re-centers it when that pays, and calls the exit when a trend breaks.

You stay in control. Your funds stay in your own wallet, and every move is a transaction you approve.

## How it works

1. **Connect.** Link Phantom, Backpack, Solflare or another Solana wallet, then pick a risk profile.
2. **Scan and score.** Every minute, Kovra scores each Meteora DLMM pool from 0 to 100 on fees per dollar of liquidity, volatility and trend. Tokens that fail the safety check (top-holder concentration, market cap, TVL) never make the list.
3. **Deploy and re-center.** The agent proposes the best pools for your profile and sizes each position to your limits. When price leaves your range, it only re-centers if the next 6 hours of fees are expected to beat 1.5× the cost of moving.
4. **Exit and withdraw.** When a pool's trend breaks your rules, the agent calls the exit. Your funds come back to your wallet whenever you ask.

## The rules it doesn't bend

- **Re-centers only when it pays.** Expected fees over the next 6 hours must beat 1.5× the gas, slippage and priority fees of the move. No churning for the sake of activity.
- **Exits on broken trends.** A 7-day trend below your threshold, or the hourly EMA20 crossing under the EMA50.
- **Daily loss stop.** If the vault drops past your daily limit, the agent asks you right away, in the app and on Telegram, to approve the exit.
- **Compounds when it's worth it.** Claimed fees go back to work when gas is under 1% of the claim.
- **Simulated before sent.** Every transaction is dry-run first. If the simulation fails, nothing is sent. A global kill switch sits above everything.

## Your keys stay yours

Kovra never holds your keys. Your funds and positions live in your own wallet. The agent finds the moves and proposes them; adding liquidity, re-centering, exiting and claiming are all transactions you approve.

If Kovra ever went offline, your funds would still be exactly where they are: in your wallet.

## Every move comes with a reason

The activity feed is the heart of Kovra. Every move is logged in plain language, including the pools it skipped and why. An example of what that looks like:

> Rebalanced PENGU / SOL. Price left the range by 2 bins. Fees over the next 6h ($4.20) beat the cost ($1.35) 3.1×.

No black box. If you'd have made a different call, you can see exactly why the agent made this one. Link Telegram and the same updates come to your phone.

## New: public portfolios

Proof beats promises. Kovra users can now switch on a public portfolio: a read-only page with net vs hold, open and closed positions and the agent's moves, plus a place on the **Public** list, ranked by net vs hold.

It's opt-in. You show under a made-up name, never your wallet address. Hide dollar amounts if you like, and switch it off anytime.

## What we won't promise

No strategy is guaranteed to profit, and Kovra isn't either. DeFi carries real risk, including the loss of funds. This is not financial advice.

What Kovra does promise is transparency: one honest scoreboard, a reason for every move, and your keys in your hands. Start small and judge it on real numbers.

## Get started

- **App:** kovra.live
- **X:** @kovrasol
- **Token:** CA coming soon. Only trust the address posted by @kovrasol.

APR is a promise. Net vs hold is a receipt.

---

## Post to share the article

APR is a promise. Net vs hold is a receipt.

We wrote down how Kovra works: the one number it answers to, the rules it doesn't bend, and why your keys never leave your wallet.

Read it below ↓
