'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Portfolio } from '@binwise/core';
import { Icon } from '@/components/Sprite';
import { PairIcon, Tok } from '@/components/Tokens';
import { fmt, pct, usd } from '@/lib/format';
import { BOT_URL } from '@/lib/site';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { shortWallet } from '@/components/app/Wallet';

const SOLSCAN = 'https://solscan.io';
/** Token amounts: more decimals for small ones (0.0421 SOL, 12.50 USDC, 1,250 BONK). */
const amount = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: n >= 1000 ? 0 : 2, maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 4 });
const day = (ts: number) =>
  new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(new Date(ts).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
/** How long a position was open: 45m, 6h, 3d. */
const held = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`);
const signed = (n: number) => (n >= 0 ? '+' : '−') + usd(Math.abs(n), 2);

/** A Solana address: short form, Copy and a Solscan link. */
function Address({ address, onCopy }: { address: string; onCopy: () => void }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <b className="num" title={address}>
        {shortWallet(address)}
      </b>
      <button className="muted" style={{ fontSize: 12.5, fontWeight: 500 }} onClick={onCopy}>
        Copy address
      </button>
      <a className="muted" style={{ fontSize: 12.5, fontWeight: 500 }} href={`${SOLSCAN}/account/${address}`} target="_blank" rel="noreferrer">
        Solscan
      </a>
    </span>
  );
}

/** The owner's portfolio: holdings, net vs hold since the start, fees, closed positions, money in and out. */
export default function PortfolioPage() {
  const { client, me, ready, overview } = useAppData();
  const { openConnect, toast, scrollTarget } = useUi();
  const router = useRouter();
  const [p, setP] = useState<Portfolio | null>(null);
  const [failed, setFailed] = useState(false);
  const api = client?.kind === 'http';

  // On open, then every 30s (the agent revalues the vault every minute).
  useEffect(() => {
    if (!api || !client || !me || !overview?.id) return;
    let live = true;
    const load = () =>
      client
        .portfolio()
        .then((x) => {
          if (!live) return;
          setP(x);
          setFailed(false);
        })
        .catch(() => live && setFailed(true));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [api, client, me, overview?.id]);

  if (ready && (!api || !me))
    return (
      <div className="page on" id="p-portfolio">
        <div className="panel card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <h3 style={{ fontSize: 19 }}>Connect a wallet to see your portfolio</h3>
          <p className="muted" style={{ margin: '8px auto 20px', maxWidth: '44ch' }}>
            Your vault&apos;s holdings, how it did against simply holding, fees earned and every closed position.
          </p>
          {api && (
            <button className="btn btn-white" onClick={openConnect}>
              Connect wallet
            </button>
          )}
        </div>
      </div>
    );

  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => toast(`${what} copied`))
      .catch(() => toast(text));
  const linkTelegram = () => {
    // Open the tab on the click itself (a popup opened after the request would be blocked), then point it at the link.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    client
      ?.telegramLink()
      .then((l) => {
        if (!l.url) tab?.close();
        else if (tab) tab.location.href = l.url;
        else window.open(l.url, '_blank', 'noopener');
        toast(l.url ? 'Open Telegram and press Start to link your vault.' : `Send /start ${l.code} to the Binwise bot.`);
      })
      .catch(() => {
        tab?.close();
        toast('Could not create a Telegram link. Try again.');
      });
  };

  const vsHoldUsd = p ? p.value - p.holdValue : 0;
  const total = p ? p.holdings.reduce((s, h) => s + h.value, 0) : 0;
  const openCount = p ? p.holdings.filter((h) => h.kind === 'position').length : 0;

  return (
    <div className="page on" id="p-portfolio">
      <div className="panel card">
        <div className="ph" style={{ marginBottom: 0, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
            <span className="avatar" style={{ width: 44, height: 44 }}></span>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ fontSize: 17, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="num">{me ? shortWallet(me.wallet) : '—'}</span>
                {me && (
                  <button className="muted" style={{ fontSize: 12.5, fontWeight: 500 }} onClick={() => copy(me.wallet, 'Wallet address')} aria-label="Copy wallet address">
                    Copy
                  </button>
                )}
              </h3>
              <p>
                {p ? `${p.name} · ${p.mode === 'live' ? 'Mainnet, real funds' : 'Paper, simulated funds'} · since ${day(p.since)}` : 'Loading…'}
              </p>
              {p?.vaultWallet && (
                <p id="pfVaultWallet">
                  Vault wallet <Address address={p.vaultWallet} onCopy={() => copy(p.vaultWallet!, 'Vault wallet address')} />
                </p>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {me && (
              <a className="btn btn-dark btn-sm" href={`${SOLSCAN}/account/${me.wallet}`} target="_blank" rel="noreferrer">
                Wallet on Solscan
                <Icon id="i-ext" />
              </a>
            )}
            {p &&
              (p.telegramLinked ? (
                <a className="btn btn-dark btn-sm" href={BOT_URL} target="_blank" rel="noreferrer">
                  <Icon id="i-send" />
                  Telegram linked
                </a>
              ) : (
                <button className="btn btn-dark btn-sm" onClick={linkTelegram}>
                  <Icon id="i-send" />
                  Link Telegram
                </button>
              ))}
          </div>
        </div>
      </div>

      {p && p.ownWallet.length > 0 && me && (
        <div className="panel card" id="pfOwn" style={{ marginTop: 12 }}>
          <div className="ph">
            <div>
              <h3>In your wallet, not in the vault</h3>
              <p>The agent only uses what is in your vault wallet.</p>
            </div>
            <Address address={me.wallet} onCopy={() => copy(me.wallet, 'Wallet address')} />
          </div>
          <div className="rows">
            {p.ownWallet.map((w) => (
              <div key={w.token.mint ?? w.token.symbol}>
                <span className="pairname" style={{ color: 'var(--text)' }}>
                  <Tok t={w.token} />
                  {w.token.symbol}
                </span>
                <b className="num">
                  {amount(w.amount)} {w.token.symbol}
                  <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                    {usd(w.value, 2)}
                  </span>
                </b>
              </div>
            ))}
          </div>
          {p.vaultWallet && (
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.6, marginTop: 14 }}>
              To let the agent use it, send SOL or USDC from this wallet to your vault wallet{' '}
              <Address address={p.vaultWallet} onCopy={() => copy(p.vaultWallet!, 'Vault wallet address')} />.
              <br />
              Keep about 0.25 SOL in the vault for network fees. The agent picks up the transfer within a few minutes, or use 💳 Wallet in the{' '}
              <a href={BOT_URL} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                Telegram bot
              </a>
              .
            </p>
          )}
        </div>
      )}

      {failed && !p && (
        <p className="muted" style={{ padding: '14px 2px 0', fontSize: 13.5 }}>
          Couldn&apos;t load your portfolio right now. Trying again in a moment.
        </p>
      )}

      <div className="kpis" style={{ marginTop: 12 }}>
        <div className="kpi card">
          <small>Portfolio value</small>
          <div className="v num" id="pfValue">
            {p ? usd(p.value, 2) : '—'}
          </div>
          <div className="s">
            {p
              ? p.pendingUsd >= 0.5
                ? `${usd(p.pendingUsd, 2)} just arrived; the agent records it as a deposit within minutes`
                : `${p.holdings.filter((h) => h.kind === 'token').length} token${p.holdings.filter((h) => h.kind === 'token').length === 1 ? '' : 's'} idle · ${openCount} position${openCount === 1 ? '' : 's'}`
              : ' '}
          </div>
        </div>
        <div className="kpi card">
          <small>Net vs hold, since start</small>
          <div className={`v num ${p?.netVsHold == null ? '' : p.netVsHold >= 0 ? 'up' : 'down'}`} id="pfNet">
            {p?.netVsHold != null ? pct(p.netVsHold, 1) : '—'}
          </div>
          <div className="s">
            {p?.netVsHold != null ? (
              <>
                <b className={`num ${vsHoldUsd >= 0 ? 'up' : 'down'}`}>{signed(vsHoldUsd)}</b> vs holding
              </>
            ) : p ? (
              'Starts with your first recorded deposit'
            ) : (
              ' '
            )}
          </div>
        </div>
        <div className="kpi card">
          <small>Fees earned, all time</small>
          <div className="v num up">{p ? usd(p.fees, 2) : '—'}</div>
          <div className="s">{p ? `${usd(p.costs, 2)} paid in network costs` : ' '}</div>
        </div>
        <div className="kpi card">
          <small>If you had held</small>
          <div className="v num">{p ? usd(p.holdValue, 2) : '—'}</div>
          <div className="s">Same deposits, today&apos;s prices</div>
        </div>
      </div>

      <div className="g2">
        <div className="panel card">
          <div className="ph">
            <div>
              <h3>Holdings</h3>
              <p>What your vault holds now</p>
            </div>
          </div>
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="r">Value</th>
                  <th className="r">Share</th>
                  <th className="r">Amount</th>
                </tr>
              </thead>
              <tbody id="pfHoldings">
                {p && p.holdings.length ? (
                  p.holdings.map((h) =>
                    h.kind === 'token' ? (
                      <tr key={`t-${h.token.mint ?? h.token.symbol}`} style={{ cursor: 'default' }}>
                        <td>
                          <span className="pairname">
                            <Tok t={h.token} />
                            {h.token.symbol}
                            <span className="dim" style={{ fontWeight: 400, fontSize: 12.5 }}>
                              idle
                            </span>
                          </span>
                        </td>
                        <td className="r num">{usd(h.value, 2)}</td>
                        <td className="r num muted">{total > 0 ? `${fmt((h.value / total) * 100, 1)}%` : '—'}</td>
                        <td className="r num">
                          {amount(h.amount)} {h.token.symbol}
                          {h.reserve ? (
                            <div className="dim" style={{ fontSize: 11.5 }}>
                              {amount(h.reserve)} kept for fees
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ) : (
                      <tr
                        key={`p-${h.positionId}`}
                        onClick={() => {
                          scrollTarget.current = h.positionId;
                          router.push('/app/positions');
                        }}
                      >
                        <td>
                          <span className="pairname">
                            <PairIcon a={h.tokenA} b={h.tokenB} />
                            {h.pair}
                            <span className={`pill ${h.inRange ? 'in' : 'out'}`} style={{ padding: '2px 8px', fontSize: 11 }}>
                              {h.inRange ? 'In range' : 'Out of range'}
                            </span>
                          </span>
                        </td>
                        <td className="r num">{usd(h.value, 2)}</td>
                        <td className="r num muted">{total > 0 ? `${fmt((h.value / total) * 100, 1)}%` : '—'}</td>
                        <td className="r muted">{h.manual ? 'LP, by hand' : 'LP position'}</td>
                      </tr>
                    ),
                  )
                ) : (
                  <tr style={{ cursor: 'default' }}>
                    <td colSpan={4} className="muted" style={{ whiteSpace: 'normal', padding: '24px 16px' }}>
                      {p
                        ? p.vaultWallet
                          ? 'Nothing in the vault wallet yet. Send SOL or USDC to it (address above, or 💳 Wallet in the Telegram bot).'
                          : 'Nothing in the vault yet. Deposit SOL or USDC in the Telegram bot (💳 Wallet).'
                        : 'Loading…'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel card">
          <div className="ph">
            <div>
              <h3>Track record</h3>
              <p>Since the vault started</p>
            </div>
          </div>
          <div className="rows">
            <div>
              <span>Open positions</span>
              <b className="num">{p ? openCount : '—'}</b>
            </div>
            <div>
              <span>Closed positions</span>
              <b className="num">{p ? p.closedCount : '—'}</b>
            </div>
            <div>
              <span>Beat holding</span>
              <b className="num">{p ? (p.closedCount ? `${p.beatHold} of ${p.closedCount}` : '—') : '—'}</b>
            </div>
            <div>
              <span>Fees earned</span>
              <b className="num up">{p ? usd(p.fees, 2) : '—'}</b>
            </div>
            <div>
              <span>Network costs</span>
              <b className="num">{p ? usd(p.costs, 2) : '—'}</b>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 14 }}>
            Net vs hold compares your vault with simply holding the same deposits at today&apos;s prices, after impermanent loss and costs. No
            strategy is guaranteed to profit.
          </p>
        </div>
      </div>

      <div className="panel card" style={{ marginTop: 12 }}>
        <div className="ph">
          <div>
            <h3>Closed positions</h3>
            <p>Every position the vault has closed, latest first</p>
          </div>
        </div>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Pool</th>
                <th className="r">Net vs hold</th>
                <th className="r">Entry</th>
                <th className="r">Exit</th>
                <th className="r">Fees</th>
                <th className="r">Held</th>
                <th className="r">Closed</th>
              </tr>
            </thead>
            <tbody id="pfClosed">
              {p && p.closed.length ? (
                p.closed.map((c) => (
                  <tr key={c.id} style={{ cursor: 'default' }}>
                    <td>
                      <span className="pairname">
                        <PairIcon a={c.tokenA} b={c.tokenB} />
                        {c.pair}
                        {c.manual && (
                          <span className="dim" style={{ fontWeight: 400, fontSize: 12.5 }}>
                            by hand
                          </span>
                        )}
                      </span>
                    </td>
                    <td className={`r num ${c.netVsHold >= 0 ? 'up' : 'down'}`}>{pct(c.netVsHold, 1)}</td>
                    <td className="r num">{usd(c.entryValue, 2)}</td>
                    <td className="r num">{usd(c.exitValue, 2)}</td>
                    <td className="r num up">{usd(c.fees, 2)}</td>
                    <td className="r num muted">{held(c.closedAt - c.openedAt)}</td>
                    <td className="r muted">{day(c.closedAt)}</td>
                  </tr>
                ))
              ) : (
                <tr style={{ cursor: 'default' }}>
                  <td colSpan={7} className="muted" style={{ whiteSpace: 'normal', padding: '24px 16px' }}>
                    {p ? 'No closed positions yet.' : 'Loading…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel card" style={{ marginTop: 12 }}>
        <div className="ph">
          <div>
            <h3>Money in and out</h3>
            <p>Deposits and withdrawals, in dollars at the time</p>
          </div>
        </div>
        <div className="tbl">
          <table>
            <tbody id="pfFlows">
              {p && p.flows.length ? (
                p.flows.map((f) => (
                  <tr key={`${f.ts}-${f.title}`} style={{ cursor: 'default' }}>
                    <td className="muted" style={{ width: 1 }}>
                      {day(f.ts)}
                    </td>
                    <td>
                      {f.title}
                      {f.txSig && p.mode === 'live' && (
                        <a className="dim" href={`${SOLSCAN}/tx/${f.txSig}`} target="_blank" rel="noreferrer" style={{ marginLeft: 8, fontSize: 12.5 }}>
                          View tx
                        </a>
                      )}
                    </td>
                    <td className={`r num ${f.usd >= 0 ? 'up' : 'down'}`}>{signed(f.usd)}</td>
                  </tr>
                ))
              ) : (
                <tr style={{ cursor: 'default' }}>
                  <td className="muted" style={{ whiteSpace: 'normal', padding: '24px 16px' }}>
                    {p ? 'No deposits yet. Deposit SOL or USDC to your vault in the Telegram bot (💳 Wallet).' : 'Loading…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
