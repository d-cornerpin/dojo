import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

declare global {
  interface Window {
    /** Open/close the right dock imperatively (agent bridge / console / tests). */
    dojoDock?: { open: (spec: DockSpec) => void; close: () => void };
  }
}

/*
 * The right dock: a side region that slides the whole dojo interface (orb,
 * chat, composer) to the left and takes the freed space on the right. Three
 * kinds:
 *   - 'canvas'  : working documents / HTML renders the agent produces
 *   - 'iframe'  : a live website the agent and user view together
 *   - 'panel'   : an arbitrary React panel (e.g. the technique builder form)
 * Canvas + iframe are "media": they get a resize grabber and a refresh/close
 * header. A 'panel' provides its own chrome.
 *
 * Lives in the persistent Dojo3Shell so the dock survives panel navigation.
 */
export type DockSpec =
  | { kind: 'canvas'; title?: string; html?: string; url?: string; path?: string }
  | { kind: 'iframe'; title?: string; url: string }
  | { kind: 'panel'; title?: string; content: ReactNode };

export function isMediaDock(d: DockSpec | null): boolean {
  return d?.kind === 'canvas' || d?.kind === 'iframe';
}

export interface RightDockApi {
  dock: DockSpec | null;
  width: number;
  open: (spec: DockSpec) => void;
  close: () => void;
  setWidth: (w: number) => void;
}

const RightDockContext = createContext<RightDockApi | null>(null);

const DEFAULT_WIDTH = 620;
const MIN_WIDTH = 340;

const FALLBACK: RightDockApi = {
  dock: null,
  width: DEFAULT_WIDTH,
  open: () => {},
  close: () => {},
  setWidth: () => {},
};

export function RightDockProvider({ children }: { children: ReactNode }) {
  const [dock, setDock] = useState<DockSpec | null>(null);
  const [width, setWidthState] = useState(DEFAULT_WIDTH);

  const open = useCallback((spec: DockSpec) => setDock(spec), []);
  const close = useCallback(() => setDock(null), []);
  const setWidth = useCallback((w: number) => {
    const max = Math.max(MIN_WIDTH, window.innerWidth * 0.72);
    setWidthState(Math.min(Math.max(w, MIN_WIDTH), max));
  }, []);

  const value = useMemo<RightDockApi>(
    () => ({ dock, width, open, close, setWidth }),
    [dock, width, open, close, setWidth],
  );

  useEffect(() => {
    window.dojoDock = { open, close };
    return () => { delete window.dojoDock; };
  }, [open, close]);

  return <RightDockContext.Provider value={value}>{children}</RightDockContext.Provider>;
}

export function useRightDock(): RightDockApi {
  return useContext(RightDockContext) ?? FALLBACK;
}
