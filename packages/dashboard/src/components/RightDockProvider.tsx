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
  | { kind: 'screenshot'; title?: string; url: string; sourceUrl: string }
  | { kind: 'panel'; title?: string; content: ReactNode };

export function isMediaDock(d: DockSpec | null): boolean {
  return d?.kind === 'canvas' || d?.kind === 'iframe' || d?.kind === 'screenshot';
}

export interface RightDockApi {
  dock: DockSpec | null;
  /** Desktop: dock width in px (side panel). */
  width: number;
  /** Mobile: dock height in px (top panel covering the upper part of the screen). */
  height: number;
  open: (spec: DockSpec) => void;
  close: () => void;
  setWidth: (w: number) => void;
  setHeight: (h: number) => void;
}

const RightDockContext = createContext<RightDockApi | null>(null);

const DEFAULT_WIDTH = 620;
const MIN_WIDTH = 340;
// Mobile: the canvas is a top panel. Default to half the viewport so the latest
// chat and the composer stay visible below it; drag its bottom edge to resize.
const DEFAULT_HEIGHT_RATIO = 0.5;
const MIN_HEIGHT = 180;
const initialHeight = (): number =>
  typeof window !== 'undefined' ? Math.round(window.innerHeight * DEFAULT_HEIGHT_RATIO) : 360;

const FALLBACK: RightDockApi = {
  dock: null,
  width: DEFAULT_WIDTH,
  height: 360,
  open: () => {},
  close: () => {},
  setWidth: () => {},
  setHeight: () => {},
};

export function RightDockProvider({ children }: { children: ReactNode }) {
  const [dock, setDock] = useState<DockSpec | null>(null);
  const [width, setWidthState] = useState(DEFAULT_WIDTH);
  const [height, setHeightState] = useState(initialHeight);

  const open = useCallback((spec: DockSpec) => setDock(spec), []);
  const close = useCallback(() => setDock(null), []);
  const setWidth = useCallback((w: number) => {
    const max = Math.max(MIN_WIDTH, window.innerWidth * 0.72);
    setWidthState(Math.min(Math.max(w, MIN_WIDTH), max));
  }, []);
  const setHeight = useCallback((h: number) => {
    // Leave ~130px at the bottom so the composer (and a sliver of chat) stay
    // reachable no matter how far the canvas is dragged down.
    const max = Math.max(MIN_HEIGHT + 80, window.innerHeight - 130);
    setHeightState(Math.min(Math.max(h, MIN_HEIGHT), max));
  }, []);

  const value = useMemo<RightDockApi>(
    () => ({ dock, width, height, open, close, setWidth, setHeight }),
    [dock, width, height, open, close, setWidth, setHeight],
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
