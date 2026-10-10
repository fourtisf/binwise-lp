'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type Layer = 'drawer' | 'modal' | 'palette' | null;

interface UiContext {
  layer: Layer;
  /** Pool shown in the score drawer. Kept after closing so the slide-out animates with content. */
  drawerPoolId: string | null;
  openPool: (id: string) => void;
  openDeposit: () => void;
  openPalette: () => void;
  closeLayers: () => void;
  toastText: string;
  toastOn: boolean;
  toast: (text: string) => void;
  /** Card to scroll to after navigating to Positions. */
  scrollTarget: React.MutableRefObject<string | null>;
}

const Ctx = createContext<UiContext | null>(null);

/** Overlay layers (drawer, deposit modal, ⌘K palette) and the toast, as in the prototype. */
export function UiProvider({ children }: { children: ReactNode }) {
  const [layer, setLayer] = useState<Layer>(null);
  const [drawerPoolId, setDrawerPoolId] = useState<string | null>(null);
  const [toastText, setToastText] = useState('');
  const [toastOn, setToastOn] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const scrollTarget = useRef<string | null>(null);

  const toast = useCallback((text: string) => {
    setToastText(text);
    setToastOn(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastOn(false), 2000);
  }, []);

  const value = useMemo<UiContext>(
    () => ({
      layer,
      drawerPoolId,
      openPool: (id) => {
        setDrawerPoolId(id);
        setLayer('drawer');
      },
      openDeposit: () => setLayer('modal'),
      openPalette: () => setLayer('palette'),
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
