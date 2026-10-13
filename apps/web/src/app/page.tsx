import Link from 'next/link';
import { BRAND } from '@kovra/core/brand';
import { BinRing } from '@/components/landing/BinRing';
import { CaPill } from '@/components/landing/CaPill';
import { Bento } from '@/components/landing/Sections';
import { Faq } from '@/components/landing/Faq';
import { HeroWindow } from '@/components/landing/HeroWindow';
import { Nav } from '@/components/landing/Nav';
import { Reveal } from '@/components/landing/Reveal';
import { Logo } from '@/components/Logo';
import { Icon } from '@/components/Sprite';
import { LIVE_DEFAULT, WALLET_LOGIN, X_HANDLE, X_URL } from '@/lib/site';

const Check = () => <Icon id="i-check" />;

export default function Landing() {
  return (
    <div id="landing">
      <div className="topglow"></div>
      <Nav />
      <Reveal />

      <section className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <div className="hero-top">
              <a href="#how" className="announce">
                <b>New</b>{LIVE_DEFAULT ? 'Live on Solana mainnet' : 'Paper mode is open to everyone'}
                <Icon id="i-chev" />
              </a>
              {/* The project token's contract address: "Coming soon" until it exists. */}
              <CaPill />
            </div>
            <h1>Liquidity that manages itself.</h1>
            <p className="lead">
              {BRAND} is an autonomous LP agent for Solana. It finds the pools that pay, keeps your liquidity in range, and
              steps aside before a downtrend eats the yield.
            </p>
            <div className="ctas">
              <Link className="btn btn-white" href="/app">
                {LIVE_DEFAULT ? 'Launch app' : 'Start in paper mode'}
              </Link>
              <a href="#live" className="btn btn-dark">
                See how it decides
              </a>
            </div>
            <p className="hero-note">
              {LIVE_DEFAULT
                ? 'Real funds on mainnet. Start small: your funds stay in your own wallet, and you approve every move.'
                : 'No deposit needed to try. With real funds, everything stays in your own wallet.'}
            </p>
            <div className="hero-links">
              <a className="x-pill" href={X_URL} target="_blank" rel="noreferrer" aria-label={`${BRAND} on X (${X_HANDLE})`}>
                <Icon id="i-xlogo" />
                {X_HANDLE}
              </a>
            </div>
          </div>
          <BinRing />
        </div>
      </section>

      <section className="sec" id="live">
        <div className="wrap">
          <div className="sec-head">
            <span className="kicker">
              <i></i>Live demo
            </span>
            <h2 className="sec-h">Watch the agent work.</h2>
            <p className="sec-p">The public demo vault on live prices: every tick, every decision and the reason behind it, as it happens.</p>
          </div>
          <div className="window">
            <HeroWindow />
          </div>
        </div>
        <div className="wrap logos">
          <p>Built on the infrastructure Solana runs on</p>
          <div>
            <span>
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path d="M3 15l4-10h2l-4 10zM8 15l4-10h2l-4 10zM13 15l3-7.5h2L15 15z" />
              </svg>
              Meteora
            </span>
            <span>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="10" cy="10" r="7" />
                <path d="M5 12c3-1 7-1 10 0M5.5 8c3-1 6-1 9 0" />
              </svg>
              Jupiter
            </span>
            <span>
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 2l2.4 5.6L18 10l-5.6 2.4L10 18l-2.4-5.6L2 10l5.6-2.4z" />
              </svg>
              Jito
            </span>
            <span>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="10" cy="10" r="3" />
                <path d="M10 2v3M10 15v3M2 10h3M15 10h3M4.3 4.3l2.1 2.1M13.6 13.6l2.1 2.1M4.3 15.7l2.1-2.1M13.6 6.4l2.1-2.1" />
              </svg>
              Helius
            </span>
          </div>
        </div>
      </section>

      <section className="sec" id="product">
        <div className="wrap">
          <div className="sec-head">
            <span className="kicker">
              <i></i>Product
            </span>
            <h2 className="sec-h">
              An agent you can actually read. <span className="g">Every move comes with a reason.</span>
            </h2>
          </div>
          <Bento />
        </div>
      </section>

      <section className="sec" id="how">
        <div className="wrap">
          <div className="sec-head">
            <span className="kicker">
              <i></i>How it works
            </span>
            <h2 className="sec-h">From wallet to working agent in three steps.</h2>
          </div>
          <div className="steps3">
            <div className="st card spot">
              <span className="n">01</span>
              <h3>{WALLET_LOGIN ? 'Connect a wallet' : 'Open the Telegram bot'}</h3>
              <p>
                {WALLET_LOGIN
                  ? `Phantom, Backpack, Solflare or any Solana wallet. ${LIVE_DEFAULT ? 'You sign one message: no transaction, no cost.' : 'Paper mode needs no deposit at all.'}`
                  : 'Create or import a Solana wallet in the chat and deposit SOL. No app to install.'}
              </p>
            </div>
            <div className="st card spot">
              <span className="n">02</span>
              <h3>Pick a risk profile</h3>
              <p>Conservative, balanced or aggressive. Fine-tune the limits if you want.</p>
            </div>
            <div className="st card spot">
              <span className="n">03</span>
              <h3>Let it work</h3>
              <p>
                {LIVE_DEFAULT
                  ? 'Watch every decision live. The agent finds the moves; you approve each one in your wallet, so nothing moves without you.'
                  : 'Watch every decision live. Go live with real funds only when the numbers convince you.'}
              </p>
            </div>
          </div>
          <div className="metrics">
            <div>
              <b className="num">+6.8%</b>
              <span>Net return vs holding</span>
            </div>
            <div>
              <b className="num">93%</b>
              <span>Time in range</span>
            </div>
            <div>
              <b className="num">1.4</b>
              <span>Rebalances per day</span>
            </div>
            <div>
              <b className="num">0</b>
              <span>Downtrend tokens held</span>
            </div>
          </div>
          <p className="mnote">Example figures from a simulated 30-day {LIVE_DEFAULT ? '' : 'paper '}run. Past results don&apos;t guarantee future returns.</p>
        </div>
      </section>

      <section className="sec" id="pricing">
        <div className="wrap">
          <div className="sec-head">
            <span className="kicker">
              <i></i>Pricing
            </span>
            <h2 className="sec-h">We earn only when you beat holding.</h2>
            <p className="sec-p">
              No subscription for the agent. A share of the profit above what holding would have made, and nothing in a losing
              month.
            </p>
          </div>
          <div className={`plans${LIVE_DEFAULT ? ' two' : ''}`} style={{ textAlign: 'left' }}>
            {/* Mainnet site: no paper vaults, so no Paper plan. */}
            {!LIVE_DEFAULT && (
              <div className="plan card spot">
                <h3>Paper</h3>
                <div className="price">
                  <b>$0</b>
                  <span>forever</span>
                </div>
                <p>Try the full agent on live prices with simulated funds.</p>
                <ul>
                  <li>
                    <Check />
                    Full agent and reasoning log
                  </li>
                  <li>
                    <Check />
                    All risk profiles
                  </li>
                  <li>
                    <Check />
                    Unlimited simulated vaults
                  </li>
                </ul>
                <Link className="btn btn-dark" href="/app">
                  Start free
                </Link>
              </div>
            )}
            <div className="plan card spot hl">
              <span className="pill watch tag">Most popular</span>
              <h3>Pro</h3>
              <div className="price">
                <b>10%</b>
                <span>of profit above hold</span>
              </div>
              <p>Live vaults with real funds, up to $50K.</p>
              <ul>
                <li>
                  <Check />
                  {LIVE_DEFAULT ? 'Full agent and reasoning log, all risk profiles' : 'Everything in Paper'}
                </li>
                <li>
                  <Check />
                  Live vaults, withdrawals only to your wallet
                </li>
                <li>
                  <Check />
                  Telegram alerts
                </li>
                <li>
                  <Check />
                  Priority execution via Jito
                </li>
              </ul>
              <Link className="btn btn-white" href="/app">
                Go Pro
              </Link>
            </div>
            <div className="plan card spot">
              <h3>Fund</h3>
              <div className="price">
                <b>Custom</b>
              </div>
              <p>For DAOs, funds and teams running larger vaults.</p>
              <ul>
                <li>
                  <Check />
                  Vaults above $50K
                </li>
                <li>
                  <Check />
                  Multiple vaults and members
                </li>
                <li>
                  <Check />
                  API and custom strategies
                </li>
              </ul>
              <button className="btn btn-dark">Talk to us</button>
            </div>
          </div>
        </div>
      </section>

      <section className="sec" id="faq">
        <div className="wrap faq-grid">
          <div className="faq-head">
            <span className="kicker">
              <i></i>FAQ
            </span>
            <h2 className="sec-h">Questions, answered.</h2>
            <p className="sec-p">
              Anything else? Ask us on{' '}
              <a href={X_URL} target="_blank" rel="noreferrer">
                X
              </a>
              .
            </p>
          </div>
          <Faq />
        </div>
      </section>

      <div className="wrap">
        <div className="final">
          <div className="final-ring" aria-hidden="true"></div>
          <h2>Put your liquidity to work.</h2>
          <p>
            {!WALLET_LOGIN
              ? 'Open the Telegram bot, deposit a small amount, and watch every decision here.'
              : LIVE_DEFAULT
                ? 'Connect your wallet, add a small LP from it, and watch every decision.'
                : 'Start in paper mode today. Go live when the numbers convince you.'}
          </p>
          <div className="ctas">
            <Link className="btn btn-white" href="/app">
              {LIVE_DEFAULT ? 'Launch app' : 'Start in paper mode'}
            </Link>
            <a href="#pricing" className="btn btn-dark">
              View pricing
            </a>
          </div>
        </div>
      </div>

      <footer>
        <div className="wrap">
          <div className="fgrid">
            <div>
              <Logo />
              <p>The autonomous LP agent for Solana.</p>
            </div>
            <div>
              <h4>Product</h4>
              <a href="#product">Agent</a>
              <a href="#pricing">Pricing</a>
              <a href="#how">How it works</a>
            </div>
            <div>
              <h4>Resources</h4>
              <a href="#faq">FAQ</a>
              <a href="#">Docs</a>
              <a href="#">Risk disclosure</a>
            </div>
            <div>
              <h4>Community</h4>
              <a href={X_URL} target="_blank" rel="noreferrer">
                X {X_HANDLE}
              </a>
            </div>
          </div>
          <div className="fbot">
            <span>© 2026 {BRAND}. DeFi carries risk, including total loss of funds. Not financial advice.</span>
            <span className="status">
              <i></i>All systems normal
            </span>
          </div>
          <div className="fmark" aria-hidden="true">
            {BRAND}
          </div>
        </div>
      </footer>
    </div>
  );
}
