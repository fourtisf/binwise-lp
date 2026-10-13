'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { BRAND } from '@binwise/core/brand';
import { BOT_URL } from '@/lib/site';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { shortWallet } from './Wallet';

/** The avatar in the top bar: who is signed in, and a menu (portfolio, copy address, Solscan, Telegram, sign out). */
export function AccountMenu() {
  const { me, client, overview, reload } = useAppData();
  const { toast, openWithdraw } = useUi();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Closes on a click outside or Esc (focus goes back to the avatar).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The built-in simulation has no account.
  if (!me || client?.kind !== 'http') return <span className="avatar" title="Demo"></span>;

  const close = () => setOpen(false);
  const copy = () => {
    close();
    navigator.clipboard
      .writeText(me.wallet)
      .then(() => toast('Wallet address copied'))
      .catch(() => toast(me.wallet));
  };
  const linkTelegram = () => {
    close();
    // Open the tab on the click itself (a popup opened after the request would be blocked), then point it at the link.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    client
      .telegramLink()
      .then((l) => {
        if (!l.url) tab?.close();
        else if (tab) tab.location.href = l.url;
        else window.open(l.url, '_blank', 'noopener');
        toast(l.url ? 'Open Telegram and press Start to link your vault.' : `Send /start ${l.code} to the ${BRAND} bot.`);
      })
      .catch(() => {
        tab?.close();
        toast('Could not create a Telegram link. Try again.');
      });
  };
  const signOut = () => {
    close();
    client
      .signOut()
      .then(() => {
        toast('Signed out');
        reload();
      })
      .catch(() => toast('Could not sign out. Try again.'));
  };

  return (
    <div className="acct" ref={box}>
      <button
        ref={button}
        className="avatar"
        title={shortWallet(me.wallet)}
        aria-label={`Account ${shortWallet(me.wallet)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      ></button>
      <div className={`acct-menu${open ? ' on' : ''}`} role="menu" aria-label="Account" aria-hidden={!open} id="acctMenu">
        <div className="acct-head">
          <span className="avatar"></span>
          <div>
            <b className="num">{shortWallet(me.wallet)}</b>
            <small>
              {overview?.name ?? 'Main vault'} · {overview?.mode === 'live' ? 'Mainnet' : 'Paper'}
            </small>
          </div>
        </div>
        <Link role="menuitem" tabIndex={open ? 0 : -1} href="/app/portfolio" onClick={close}>
          <Icon id="i-wallet" />
          Portfolio
        </Link>
        {overview?.mode === 'live' && overview.custody !== 'wallet' && !overview.readOnly && (
          <button
            role="menuitem"
            tabIndex={open ? 0 : -1}
            onClick={() => {
              close();
              openWithdraw();
            }}
          >
            <Icon id="i-down" />
            Withdraw to wallet
          </button>
        )}
        <button role="menuitem" tabIndex={open ? 0 : -1} onClick={copy}>
          <Icon id="i-copy" />
          Copy wallet address
        </button>
        <a role="menuitem" tabIndex={open ? 0 : -1} href={`https://solscan.io/account/${me.wallet}`} target="_blank" rel="noreferrer" onClick={close}>
          <Icon id="i-ext" />
          View on Solscan
        </a>
        {BOT_URL &&
          (me.telegramLinked ? (
            <a role="menuitem" tabIndex={open ? 0 : -1} href={BOT_URL} target="_blank" rel="noreferrer" onClick={close}>
              <Icon id="i-send" />
              Open Telegram bot
              <span className="pill in">Linked</span>
            </a>
          ) : (
            <button role="menuitem" tabIndex={open ? 0 : -1} onClick={linkTelegram}>
              <Icon id="i-send" />
              Link Telegram
            </button>
          ))}
        <div className="acct-sep"></div>
        <button role="menuitem" tabIndex={open ? 0 : -1} onClick={signOut}>
          <Icon id="i-exit" />
          Sign out
        </button>
      </div>
    </div>
  );
}
