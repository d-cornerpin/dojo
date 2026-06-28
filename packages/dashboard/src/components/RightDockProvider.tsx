import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getCanvas, setCanvasStatus, type CanvasPersisted } from '../lib/api';

// A persisted canvas only ever stores media kinds; map it back to a DockSpec.
function persistedToDockSpec(s: CanvasPersisted['state']): DockSpec {
  if (s.kind === 'iframe' && s.url) return { kind: 'iframe', title: s.title, url: s.url };
  if (s.kind === 'screenshot' && s.url && s.sourceUrl) return { kind: 'screenshot', title: s.title, url: s.url, sourceUrl: s.sourceUrl };
  return { kind: 'canvas', title: s.title, html: s.html, url: s.url, path: s.path };
}
// Which docks collapse-to-handle + persist (the canvas surface). Transient docks
// (live screen-share, ad-hoc panels) just close.
function isCollapsibleDock(d: DockSpec | null): boolean {
  return d?.kind === 'canvas' || d?.kind === 'iframe' || d?.kind === 'screenshot';
}

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
  | { kind: 'screen'; title?: string }
  | { kind: 'panel'; title?: string; content: ReactNode };

export function isMediaDock(d: DockSpec | null): boolean {
  return d?.kind === 'canvas' || d?.kind === 'iframe' || d?.kind === 'screenshot' || d?.kind === 'screen';
}

export interface RightDockApi {
  dock: DockSpec | null;
  /** The retained canvas when minimised to the edge handle (dock is null then). */
  collapsed: DockSpec | null;
  /** Desktop: dock width in px (side panel). */
  width: number;
  /** Mobile: dock height in px (top panel covering the upper part of the screen). */
  height: number;
  open: (spec: DockSpec) => void;
  /** User-initiated close: a canvas collapses to the edge handle; others close. */
  close: () => void;
  /** Re-open from the edge handle (restores the retained canvas). */
  reopen: () => void;
  /** Collapse driven by a remote dock:collapse event (another device closed it). */
  collapseRemote: () => void;
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
  collapsed: null,
  width: DEFAULT_WIDTH,
  height: 360,
  open: () => {},
  close: () => {},
  reopen: () => {},
  collapseRemote: () => {},
  setWidth: () => {},
  setHeight: () => {},
};

export function RightDockProvider({ children }: { children: ReactNode }) {
  const [dock, setDock] = useState<DockSpec | null>(null);
  // The retained canvas spec while minimised to the edge handle (dock === null).
  const [collapsed, setCollapsed] = useState<DockSpec | null>(null);
  const [width, setWidthState] = useState(DEFAULT_WIDTH);
  const [height, setHeightState] = useState(initialHeight);

  // Live mirrors so the stable callbacks below read current state without
  // re-creating themselves (and without side effects inside a state updater).
  const dockRef = useRef<DockSpec | null>(null);
  dockRef.current = dock;
  const collapsedRef = useRef<DockSpec | null>(null);
  collapsedRef.current = collapsed;

  const open = useCallback((spec: DockSpec) => {
    setDock(spec);
    setCollapsed(null);
  }, []);

  // User closed the dock. A canvas (the persistent surface) collapses to the
  // edge handle and the server remembers it (collapsed status, content kept);
  // transient docks (live screen-share, panels) just close.
  const close = useCallback(() => {
    const cur = dockRef.current;
    if (isCollapsibleDock(cur)) {
      setCollapsed(cur);
      void setCanvasStatus('collapsed');
    }
    setDock(null);
  }, []);

  // Re-open from the edge handle. POST so the server persists open + broadcasts
  // it to the user's other devices.
  const reopen = useCallback(() => {
    const c = collapsedRef.current;
    if (c) {
      setDock(c);
      setCollapsed(null);
      void setCanvasStatus('open');
    }
  }, []);

  // Another device closed the canvas (dock:collapse). Mirror it locally without
  // re-POSTing (no echo loop).
  const collapseRemote = useCallback(() => {
    const cur = dockRef.current;
    if (isCollapsibleDock(cur)) setCollapsed(cur);
    setDock(null);
  }, []);

  // Restore the persisted canvas on mount — this is what makes the canvas
  // survive a browser refresh, a server restart, and a move between devices.
  useEffect(() => {
    let cancelled = false;
    getCanvas()
      .then((res) => {
        if (cancelled || !res.ok || !res.data) return;
        const spec = persistedToDockSpec(res.data.state);
        if (res.data.status === 'open') { setDock(spec); setCollapsed(null); }
        else { setCollapsed(spec); setDock(null); }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

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
    () => ({ dock, collapsed, width, height, open, close, reopen, collapseRemote, setWidth, setHeight }),
    [dock, collapsed, width, height, open, close, reopen, collapseRemote, setWidth, setHeight],
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
