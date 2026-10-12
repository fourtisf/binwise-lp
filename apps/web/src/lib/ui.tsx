'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type Layer = 'drawer' | 'palette' | 'connect' | 'confirmLive' | null;

interface UiContext {
  layer: Layer;
  /** Pool shown in the score drawer. Kept after closing so the slide-out animates with content. */
  drawerPoolId: string | null;
  openPool: (id: string) => void;
  openPalette: () => void;
  /** Wallet picker for sign-in */
  openConnect: () => void;
  /** "Real funds will be used" confirmation before live mode */
  openConfirmLive: () => void;
  closeLayers: () => void;
  toastText: string;
  toastOn: boolean;
  /** A short notice; `ms`: how long it stays (longer for something to read, like why an action failed) */
  toast: (text: string, ms?: number) => void;
  /** Card to scroll to after navigating to Positions. */
  scrollTarget: React.MutableRefObject<string | null>;
}

const Ctx = createContext<UiContext | null>(null);

/** Overlay layers (drawer, wallet modals, ⌘K palette) and the toast, as in the prototype. */
export function UiProvider({ children }: { children: ReactNode }) {
  const [layer, setLayer] = useState<Layer>(null);
  const [drawerPoolId, setDrawerPoolId] = useState<string | null>(null);
  const [toastText, setToastText] = useState('');
  const [toastOn, setToastOn] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const scrollTarget = useRef<string | null>(null);

  const toast = useCallback((text: string, ms = 2000) => {
    setToastText(text);
    setToastOn(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastOn(false), ms);
  }, []);

  const value = useMemo<UiContext>(
    () => ({
      layer,
      drawerPoolId,
      openPool: (id) => {
        setDrawerPoolId(id);
        setLayer('drawer');
      },
      openPalette: () => setLayer('palette'),
      openConnect: () => setLayer('connect'),
      openConfirmLive: () => setLayer('confirmLive'),
      closeLayers: () => setLayer(null),
      toastText,
      toastOn,
      toast,
      scrollTarget,
    }),
    [layer, drawerPoolId, toastText, toastOn, toast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUi(): UiContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useUi must be used inside UiProvider');
  return c;
}
