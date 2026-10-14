# X Article: "Judged by one number: introducing Kovra" (long version)

Cover: `kovra-x-article-cover.png` (5:2, 3000×1200). Paste the text below into X → Articles.
- Lines starting with `##` use the "Heading" style in X's editor and `###` the "Subheading" style (delete the `#` marks).
- Lines starting with `>` use the quote style.
- Numbered and bulleted lines use the list buttons.

Claims match the code (`packages/core/src/rules.ts`, `scoring.ts`, `apps/agent/src/agent.ts`) and the site's FAQ as of
October 2026. Re-check them before reusing this copy. The worked example uses made-up numbers and says so.

---

**Title:** Judged by one number: introducing Kovra

Most LP dashboards open with APR. It's a big, flattering number, and it hides the only question that matters:

**Would you have done better just holding the tokens?**

Concentrated liquidity can earn fees all week and still leave you behind a wallet that did nothing. Price walks out of your range. Impermanent loss quietly eats the fees. Gas, swaps and slippage eat the rest. And the APR still looks great.

Kovra keeps score differently. Every vault, every position and every chart is measured against one number: **net return vs simply holding the same tokens.** If it isn't beating holding, it isn't working, and you'll see it, in plain numbers, without digging.

This article is the long version: what Kovra is, how the agent thinks, the rules it won't break, what stays in your hands, and the risks we won't pretend away.

## The number LP dashboards don't show you

When you provide liquidity, you give up something: the simple option of holding your two tokens and doing nothing. That option is the real benchmark. Not zero. Not a bank rate. Holding.

APR measures fees against what you put in. It says nothing about what happened to the tokens themselves while they were in the pool. As price moves, a liquidity position sells the token that's rising and buys the token that's falling. That drift is impermanent loss, and APR ignores it completely.

Here is an illustrative example. The numbers are made up to show the math, not a Kovra result.

- You add $3,000 to a SOL / USDC pool: 10 SOL at $150 and 1,500 USDC.
- A week later SOL is at $120. Had you simply held, you'd have 10 SOL + 1,500 USDC = **$2,700**.
- Your LP position, which bought SOL on the way down, is worth $2,640. It also earned **$70** in fees.
- Fees as APR: $70 on $3,000 in a week is about **121% a year.** Looks incredible.
- Net vs hold: ($2,640 + $70) ÷ $2,700 − 1 = **+0.4%.** You barely beat doing nothing.

Now say the week earned $40 in fees instead. APR still reads about 69%, a number most people would happily screenshot. Net vs hold: ($2,640 + $40) ÷ $2,700 − 1 = **−0.7%.** You'd have been better off holding.

Same pool, same week, same "great APR". One result is a win, the other a loss. Only net vs hold tells you which one you got.

That's why it's the headline on every Kovra screen:

> net vs hold = (position value + fees) ÷ value of simply holding − 1

## A 60-second primer on Meteora DLMM

Kovra works on Meteora DLMM pools on Solana. DLMM (Dynamic Liquidity Market Maker) splits liquidity into price **bins**. Only the bin the price is sitting in, the **active bin**, trades at any moment. You choose which bins your liquidity covers, and in what shape.

That's what makes DLMM powerful:

- **Concentrated:** liquidity close to the price earns far more fees per dollar than liquidity spread thin.
- **Dynamic fees:** fees rise when the market gets volatile, which is exactly when LPs carry the most risk.
- **Shapes:** you can spread liquidity evenly (Spot), stack it near the price (Curve), or weight it toward the edges (Bid-Ask).

And it's also what makes DLMM demanding:

- When price leaves your bins, you earn **nothing** until it comes back or you move.
- Moving costs gas, swaps and slippage. Move too often and the costs eat the fees.
- Sit in a pool while a token trends down, and your position keeps converting into the falling token.

Doing it well means watching pools every minute, doing the cost math before every move, and leaving a pool without hesitation when the trend turns. That's a full-time job. Kovra is built to do that job.

## What Kovra is

Kovra is an autonomous LP agent for Meteora DLMM on Solana. It scans the pools, scores them, works out where your liquidity should sit, re-centers it when that pays, compounds fees when it's worth the gas, and calls the exit when a trend breaks.

You stay in control. Your funds stay in your own wallet, and every move it makes is a transaction you approve.

## How Kovra thinks: one cycle, every minute

Every minute, the agent runs the same five steps for your vault. You can watch them happen live in the app.

### 1. Scan

Kovra reads every Meteora DLMM pool it tracks: liquidity, volume, fees, price history. Pools that don't clear your filters are out before scoring starts: minimum liquidity, your minimum market cap, and a token safety check on top-holder concentration. Small, thin or concentrated tokens never make the list.

### 2. Score

Every remaining pool gets a score from 0 to 100. The biggest input is **volume per dollar of liquidity**, because that's what actually pays LPs. The base fee adds to it. Volatility counts against it. The 7-day trend pushes it up or down, and token holder quality counts too.

A pool needs **62 or more** before the agent will deploy into it. And the score isn't a black box: open any pool in the Pools tab and you see the breakdown, component by component, with the agent's reason in plain words.

### 3. Check positions

For every open position: is it still in range? How far has price moved? What has it earned, what would moving cost, and how is it doing against holding?

### 4. Decide

The agent picks one of a few clear actions: deploy into a new pool, re-center a position, exit, compound fees, or hold. Holding is a decision too, and often the right one.

### 5. Execute

The transaction is built and simulated first. If the simulation fails, nothing is sent. Then it goes to your wallet for approval.

## Where the liquidity goes

Picking a good pool is half the job. The other half is how much goes in, in what shape, and how wide.

- **Size.** Never more than your idle balance, never more than your "max per pool" share of the vault, and never more than 2% of the pool's liquidity, so you're never the whale stuck at the exit.
- **Shape.** Curve for stable pairs, where price barely moves. Spot for a balanced profile. Bid-Ask for volatile pools (or the aggressive profile), where price swings across the range.
- **Width.** The range scales with volatility: calmer pools get tighter ranges that earn more per dollar, wilder pools get wider ones that stay in range longer. A conservative profile runs wider than an aggressive one.
- **Direction.** When a pool is ranging, liquidity goes on both sides of the price. When the token is trending up, liquidity goes one-sided, holding the token, so you keep the upside and sell into strength. When it's trending down, there's no new liquidity at all.

## Re-centering only when it pays

The most expensive habit in LP is chasing price. Every move costs gas, swap fees and slippage, and if price comes back an hour later you've paid twice for nothing.

So Kovra moves only when three things are true:

1. **Price has really left.** When a position first drops out of range, the agent waits one more tick, because price often snaps back.
2. **It hasn't just moved.** After a re-center, the position cools down for 30 minutes.
3. **The math works.** The fees expected over the next 6 hours must beat **1.5×** the total cost of the move: gas, slippage and priority fees.

Each of those becomes a sentence in your activity feed:

> Just left the range. Waiting one more tick, since price often snaps back.

> Expected fees over 6h don't cover 1.5× the move cost. Holding.

Most of the time, the right move is no move. Kovra is built to know the difference.

## Knowing when to leave

Fees can't save you from a token in freefall. Kovra exits a pool when any of these is true:

- **The 7-day trend breaks your limit.** You set the threshold in Strategy, for example −12%.
- **The hourly trend turns.** EMA20 crosses below EMA50 on the 1-hour chart.
- **It's losing to holding.** Net vs hold stays below −3% for 24 hours.
- **The pool stops being good.** Its score stays under 45 for three scans in a row.

On top of that sits your **daily loss stop.** If the vault drops past your daily limit, the agent asks you right away, in the app and on Telegram, to approve the exit.

## Compounding, without burning gas

Claimed fees can go back into the same bins, but only when it's worth it. Kovra compounds when gas is **under 1% of the claim.** Below that, it waits until there's enough to make the transaction pay.

## Safety rails

An agent that touches real money needs guardrails that don't depend on it being right:

- **Simulated before sent.** Every transaction is dry-run first. If it would fail, nothing is sent.
- **A short list of actions.** The agent can add and remove liquidity on Meteora DLMM, claim fees, and swap through Jupiter to rebalance. Nothing else.
- **Never twice.** Every decision carries its own key, so the same action can't be sent twice.
- **Kill switch.** One switch stops every transaction across the system, checked before each one.
- **Your approval.** Nothing leaves your wallet without your signature.

## Your keys stay yours

Kovra never holds your keys. Your funds and positions live in your own wallet: Phantom, Backpack, Solflare and other Solana wallets work.

The agent finds the moves and proposes them. Adding liquidity, re-centering, exiting and claiming are all transactions you approve in your wallet. Withdraw whenever you like: it's your wallet.

If Kovra ever went offline, or worse, your funds would still be exactly where they are: in your wallet.

## Every move comes with a reason

The activity feed is the heart of Kovra. Every move is logged in plain language, including the pools it skipped and why. A re-center looks like this (an example):

> Rebalanced PENGU / SOL. Price left the range by 2 bins. Fees over the next 6h ($4.20) beat the cost ($1.35) 3.1×.

An exit looks like this:

> Closed WIF / SOL. 7-day trend −14.6% broke your −12% exit rule.

No black box. If you'd have made a different call, you can see exactly why the agent made this one. Link Telegram and the deploys, re-centers and exits come straight to your phone.

## You set the limits, the agent works inside them

The Strategy page is where you draw the lines:

- **Risk profile:** conservative, balanced or aggressive.
- **Max per pool:** how much of the vault one pool can hold.
- **Minimum market cap:** smaller tokens are never farmed.
- **Trend exit:** the 7-day drop that sends the agent for the exit.
- **Daily loss stop:** the one-day drop that stops everything.
- **Toggles:** auto-compound, rebalance only when profitable, the holder safety check, pausing on volatility spikes, and Telegram alerts.

## Proof, in public

Promises are cheap. Results are better, and results you can check are best.

Kovra users can now switch on a **public portfolio**: a read-only page with net vs hold, open and closed positions, the 30-day chart against holding, and the agent's moves with their reasons. Every public portfolio also gets a place on the **Public** tab, ranked by net vs hold, and anyone can open it without connecting a wallet.

It's opt-in, and privacy comes first:

- You show under a made-up name, never your wallet address.
- No transaction links that could lead back to your wallet.
- Hide dollar amounts if you like: percentages stay, sizes don't.
- Switch it off anytime.

## Who Kovra is for

- You LP on Meteora, or want to, and don't want to watch charts all day.
- You care whether you actually beat holding, not just how big the APR looks.
- You want to keep your own keys and approve what happens to your money.
- You'd rather read why a move happened than trust a black box.

And who it isn't for: anyone looking for guaranteed returns. That doesn't exist, here or anywhere.

## The risks, plainly

No strategy is guaranteed to profit, and Kovra isn't either. Here is what can go wrong:

- **Market risk.** Tokens can drop fast. Exit rules limit how long you sit in a falling pool; they can't stop the drop itself.
- **Impermanent loss.** Fees don't always cover it. That's exactly why we measure against holding.
- **Token risk.** Safety checks reduce the odds of a bad token; they can't rule it out.
- **Smart contract and network risk.** Kovra runs on Solana, Meteora and Jupiter. Bugs, outages or congestion there affect every user of those protocols.
- **Execution costs.** Gas, slippage and priority fees are real, even with the cost rules.
- **The agent can be wrong.** Rules are rules. Markets don't always follow them.

DeFi carries real risk, including the loss of funds. Start small, judge it on real numbers, and never put in more than you can afford to lose. Nothing here is financial advice.

## FAQ

**Does Kovra hold my funds?**
No. Your funds and positions stay in your own wallet, and Kovra never holds your keys. Every move is a transaction you approve.

**Which pools does it use?**
Meteora DLMM pools on Solana that pass your filters: minimum liquidity, minimum market cap and the holder safety check. You can see every pool it tracks, and its score, in the Pools tab.

**What happens in a crash?**
Your trend exit and daily loss stop take over. When a pool's trend breaks your limit, or the vault drops past your daily stop, the agent asks you right away, in the app and on Telegram, to approve the exit.

**Why net vs hold instead of APR?**
Because APR can look great while you lose to simply holding. Net vs hold includes fees, price moves and costs, so it answers the question you actually care about.

**Can I withdraw anytime?**
Yes. It's your wallet.

**Is there a token?**
CA coming soon. Only trust the address posted by @kovrasol.

## Get started

- **App:** kovra.live
- **X:** @kovrasol
- **Token:** CA coming soon. Only from @kovrasol.

Connect a wallet, set your limits, and watch the agent work, with a reason for every move and one honest number at the top.

APR is a promise. Net vs hold is a receipt.

---

## Post to share the article

APR is a promise. Net vs hold is a receipt.

We wrote down everything about how Kovra works: the one number it answers to, how it scores Meteora pools, when it moves (and when it doesn't), when it leaves, and why your keys never leave your wallet.

Read it below ↓
