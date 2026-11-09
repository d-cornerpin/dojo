import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getCanvas, setCanvasStatus } from '../lib/api';
import { persistedToDockSpec } from './right-dock-canvas';
import { useActiveAgent } from './ActiveAgentProvider';
import { useToast } from '../hooks/useToast';
import { useWebSocket } from '../hooks/useWebSocket';

// Which docks collapse-to-handle + persist (canvas, iframe, screenshot); the rest just close.
function isCollapsibleDock(d: DockSpec | null): boolean {
  return d?.kind === 'canvas' || d?.kind === 'iframe' || d?.kind === 'screenshot';
}

declare global {
  interface Window {
    /** Open/close the right dock imperatively (agent bridge / console / tests). */
    dojoDock?: { open: (spec: DockSpec) => void; close: () => void };
  }
}

// The right dock: a side region that slides the dojo interface left and takes the freed space.
// It lives in the persistent shell so the dock survives panel navigation.
// Dock kinds: canvas (agent docs/HTML), iframe (a live site), screen, screenshot, panel (React, own chrome).
export type DockSpec =
  | { kind: 'canvas'; title?: string; html?: string; url?: string; path?: string }
  | { kind: 'iframe'; title?: string; url: string }
  | { kind: 'screenshot'; title?: string; url: string; sourceUrl: string }
  | { kind: 'screen'; title?: string }
  | { kind: 'panel'; title?: string; content: ReactNode };

// Media docks (everything but 'panel') get the resize grabber and the refresh/close header.
export function isMediaDock(d: DockSpec | null): boolean {
  return d?.kind === 'canvas' || d?.kind === 'iframe' || d?.kind === 'screenshot' || d?.kind === 'screen';
}

export interface RightDockApi {
  dock: DockSpec | null;
  collapsed: DockSpec | null;
  width: number;
  height: number;
  open: (spec: DockSpec) => void;
  /** User-initiated close: a canvas collapses to the edge handle; others close. */
  close: () => void;
  /** Re-open from the edge handle (restores the retained canvas). */
  reopen: () => void;
  collapseRemote: () => void;
  setWidth: (w: number) => void;
  setHeight: (h: number) => void;
}

const RightDockContext = createContext<RightDockApi | null>(null);

const DEFAULT_WIDTH = 620;
const MIN_WIDTH = 340;
// Mobile top panel: half the viewport default keeps the latest chat and the composer visible below.
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

  // The canvas is per-agent: the dock shows the viewed agent's slot; collapse/re-open record on it.
  const activeAgent = useActiveAgent();
  // Tolerate a tree with no ToastProvider above (a bare test mount) rather than throw here.
  let toastError: ((m: string) => void) | null = null;
  try { toastError = useToast().error; } catch { /* no ToastProvider above */ }
  let reconnectCount = 0;
  try { reconnectCount = useWebSocket().reconnectCount; } catch { /* no socket above (a bare mount) */ }
  const toastErrorRef = useRef(toastError);
  toastErrorRef.current = toastError;
  const agentIdRef = useRef(activeAgent.agentId);
  agentIdRef.current = activeAgent.agentId;

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

  // User closed the dock: a canvas (the persistent surface) collapses to the edge handle and the
  // server remembers it (collapsed status, content kept); transient docks just close.
  const close = useCallback(() => {
    const cur = dockRef.current;
    if (isCollapsibleDock(cur)) {
      setCollapsed(cur);
      const forAgent = agentIdRef.current;
      void setCanvasStatus(forAgent, 'collapsed').then((res) => {
        // The server still has it open: put the screen back so it tells the truth.
        if (res.ok || agentIdRef.current !== forAgent) return;
        setDock(cur);
        setCollapsed(null);
        toastErrorRef.current?.('Could not close the canvas. Please try again.');
      });
    }
    setDock(null);
  }, []);

  // Re-open from the edge handle: POST so the server persists open and broadcasts to other devices.
  const reopen = useCallback(() => {
    const c = collapsedRef.current;
    if (c) {
      setDock(c);
      setCollapsed(null);
      const forAgent = agentIdRef.current;
      void setCanvasStatus(forAgent, 'open').then((res) => {
        // The server still has it collapsed: back to the edge handle.
        if (res.ok || agentIdRef.current !== forAgent) return;
        setDock(null);
        setCollapsed(c);
        toastErrorRef.current?.('Could not re-open the canvas. Please try again.');
      });
    }
  }, []);

  // Another device closed the canvas (dock:collapse): mirror it locally, no re-POST (no echo loop).
  const collapseRemote = useCallback(() => {
    const cur = dockRef.current;
    if (isCollapsibleDock(cur)) setCollapsed(cur);
    setDock(null);
  }, []);

  // Restore the VIEWED agent's persisted canvas: what makes it survive a refresh, a server restart
  // and a move between devices. Re-runs when the viewed agent changes, so switching swaps to that
  // agent's canvas or clears the dock; a transient dock is not per-agent, so it is left alone. A
  // failed read says nothing about the agent being viewed and what is on screen belongs to the agent
  // before it: clear it, toast, open nothing. A reconnect (the "server is back" signal) asks again.
  const loadRef = useRef<(agentId: string, isCancelled: () => boolean) => void>(() => {});
  const failedLoadFor = useRef<string | null>(null);
  loadRef.current = (agentId, isCancelled) => {
    const failed = () => {
      if (isCancelled()) return;
      failedLoadFor.current = agentId;
      if (dockRef.current && !isCollapsibleDock(dockRef.current)) return;
      setDock(null);
      setCollapsed(null);
      toastErrorRef.current?.("Could not load this agent's canvas.");
    };
    getCanvas(agentId)
      .then((res) => {
        if (isCancelled()) return;
        if (dockRef.current && !isCollapsibleDock(dockRef.current)) return;
        if (!res.ok) { failed(); return; }
        failedLoadFor.current = null;
        const data = res.data;
        if (!data) { setDock(null); setCollapsed(null); return; }
        const spec = persistedToDockSpec(data.state);
        if (data.status === 'open') { setDock(spec); setCollapsed(null); }
        else { setCollapsed(spec); setDock(null); }
      })
      .catch(failed);
  };
  useEffect(() => {
    let cancelled = false;
    loadRef.current(activeAgent.agentId, () => cancelled);
    return () => { cancelled = true; };
  }, [activeAgent.agentId]);
  useEffect(() => {
    const id = failedLoadFor.current;
    if (!id || id !== agentIdRef.current) return;
    loadRef.current(id, () => agentIdRef.current !== id);
    // Only a reconnect re-asks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectCount]);

  const setWidth = useCallback((w: number) => {
    const max = Math.max(MIN_WIDTH, window.innerWidth * 0.72);
    setWidthState(Math.min(Math.max(w, MIN_WIDTH), max));
  }, []);
  const setHeight = useCallback((h: number) => {
    // Drag cap: keep 130px at the bottom so the composer (and a sliver of chat) stay reachable.
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
