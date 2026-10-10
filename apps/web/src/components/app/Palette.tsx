'use client';

import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon, type IconId } from '../Sprite';
import { PAGES } from './pages';

interface Cmd {
  group: string;
  label: string;
  icon: IconId;
  run: () => void;
  hint?: string;
}

/** ⌘K command menu: jump to pages, run actions, open a pool. */
export function Palette() {
  const { layer, closeLayers, openDeposit, openPool, openPalette, openConnect, toast } = useUi();
  const { overview, pools, togglePause, setMode, guard, client, me, reload } = useAppData();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const on = layer === 'palette';
  const paused = overview?.status === 'paused';
  const paper = (overview?.mode ?? 'paper') === 'paper';

  const items = useMemo(() => {
    const cmds: Cmd[] = [
      ...PAGES.map((p) => ({ group: 'Go to', label: p.title, icon: p.icon, run: () => router.push(p.href) })),
      { group: 'Actions', label: 'Deposit to vault', icon: 'i-plus', run: () => guard(openDeposit) },
      { group: 'Actions', label: paused ? 'Resume agent' : 'Pause agent', icon: paused ? 'i-play' : 'i-pause', run: togglePause },
      {
        group: 'Actions',
        label: paper ? 'Switch to live mode' : 'Switch to paper mode',
        icon: 'i-bolt',
        run: () => setMode(paper ? 'live' : 'paper'),
      },
      { group: 'Actions', label: 'Backtest report', icon: 'i-act', run: () => router.push('/app/report') },
      ...(client?.kind === 'http'
        ? [
            me
              ? {
                  group: 'Actions',
                  label: 'Sign out',
                  icon: 'i-exit' as IconId,
                  run: () =>
                    client.signOut().then(() => {
                      toast('Signed out');
                      reload();
                    }),
                }
              : { group: 'Actions', label: 'Connect wallet', icon: 'i-lock' as IconId, run: openConnect },
          ]
        : []),
      ...pools.map((x) => ({
        group: 'Pools',
        label: x.pair,
        icon: 'i-pools' as IconId,
        hint: `Score ${x.score}`,
        run: () => {
          router.push('/app/pools');
          openPool(x.id);
        },
      })),
    ];
    const s = q.toLowerCase().trim();
    return cmds.filter((c) => !s || c.label.toLowerCase().includes(s) || c.group.toLowerCase().includes(s));
  }, [q, pools, paused, paper, router, openDeposit, openPool, togglePause, setMode, guard, client, me, reload, toast, openConnect]);

  useEffect(() => {
    if (!on) return;
    setQ('');
    setSel(0);
    const t = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [on]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  }, [sel, items]);

  const runAt = (i: number) => {
    const c = items[i];
    if (!c) return;
    closeLayers();
    setTimeout(c.run, 10);
  };

  // Global keys: ⌘K / Ctrl+K toggles, Esc closes any layer, arrows + Enter drive the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (on) closeLayers();
        else openPalette();
        return;
      }
      if (e.key === 'Escape') closeLayers();
      if (!on) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => Math.min(items.length - 1, s + 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        runAt(sel);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  let group = '';
  return (
    <div className={`palette${on ? ' on' : ''}`} id="palette" role="dialog" aria-modal="true" aria-label="Command menu" aria-hidden={!on}>
      <div className="pin">
        <Icon id="i-search" />
        <input
          id="pInput"
          ref={input}
          placeholder="Search pools or type a command"
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
        />
        <span className="kbd">esc</span>
      </div>
      <div className="plist" id="pList" role="listbox" ref={list}>
        {items.length ? (
          items.map((c, i) => {
            const head = c.group !== group;
            group = c.group;
            return (
              <Fragment key={c.group + c.label}>
                {head && <div className="pgrp">{c.group}</div>}
                <button
                  className="pit"
                  role="option"
                  aria-selected={i === sel}
                  onClick={() => runAt(i)}
                  onMouseMove={() => i !== sel && setSel(i)}
                >
                  <Icon id={c.icon} />
                  {c.label}
                  {c.hint && <span className="hint">{c.hint}</span>}
                </button>
              </Fragment>
            );
          })
        ) : (
          <div className="pempty">No results. Try a token like JUP or a page like Pools.</div>
        )}
      </div>
      <div className="pfoot">
        <span>
          <span className="kbd">↑</span>
          <span className="kbd">↓</span>Navigate
        </span>
        <span>
          <span className="kbd">↵</span>Open
        </span>
      </div>
    </div>
  );
}
