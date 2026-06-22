import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import { DojoOrb } from './orb/DojoOrb';
import { useDojoOrb } from './orb/OrbProvider';
import { useOrbActivity } from './orb/useOrbActivity';
import { useActiveAgent } from './ActiveAgentProvider';
import { agentHue } from '../lib/agent-hue';
import { useTechniqueSession } from './TechniqueSessionProvider';
import { useRightDock, isMediaDock } from './RightDockProvider';
import { RightDock } from './RightDock';
import { Dojo3Notifications } from './Dojo3Notifications';
import { usePresence } from './PresenceProvider';

interface Dojo3StageProps {
  children: ReactNode;
  composer: ReactNode;
  agentName: string;
  isWorking: boolean;
  wordyMode: boolean;
  onToggleWordyMode: () => void;
  onNewSession: () => void | Promise<void>;
  panel?: {
    title?: string;
    meta?: string;
    content: ReactNode;
  } | null;
}

// The nine controls render as a wrapping cluster of labeled glass pills that
// blooms from beneath the orb (the tab-pill aesthetic the pages already use).
// Order is the reading order; each pill staggers in left-to-right (see render).
const fanItems = [
  { panel: 'agents', label: 'Agents', path: '/agents' },
  { panel: 'vault', label: 'Vault', path: '/memory' },
  { panel: 'techniques', label: 'Techniques', path: '/techniques' },
  { panel: 'tracker', label: 'Tracker', path: '/tracker' },
  { panel: 'ledger', label: 'Ledger', path: '/costs' },
  { panel: 'vitals', label: 'Vitals', path: '/health' },
  { panel: 'settings', label: 'Settings', path: '/settings' },
  { panel: 'trace', label: 'Wordy', path: null, trace: true },
  { panel: 'reset', label: 'Reset', path: null, destructive: true },
] as const;

export function Dojo3Stage({
  children,
  composer,
  agentName,
  isWorking,
  wordyMode,
  onToggleWordyMode,
  onNewSession,
  panel,
}: Dojo3StageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const stageRef = useRef<HTMLDivElement>(null);
  const fanRef = useRef<HTMLElement>(null);
  const dojoOrb = useDojoOrb();
  const activeAgent = useActiveAgent();
  const isPrimary = activeAgent.isPrimary;
  const techSession = useTechniqueSession();
  const { dock, width: dockWidth, height: dockHeight, open: openDock, setWidth: setDockWidth, setHeight: setDockHeight } = useRightDock();
  const { subscribe } = useWebSocket();
  const [resizing, setResizing] = useState(false);

  // The agent opens a canvas/iframe in the dock by emitting `dock:open`.
  useEffect(() => {
    const unsub = subscribe('dock:open', (e) => {
      if (e.type !== 'dock:open') return;
      const d = e.data;
      if (d.kind === 'iframe' && d.url) openDock({ kind: 'iframe', title: d.title, url: d.url });
      else if (d.kind === 'screenshot' && d.url && d.sourceUrl) openDock({ kind: 'screenshot', title: d.title, url: d.url, sourceUrl: d.sourceUrl });
      else if (d.kind === 'canvas') openDock({ kind: 'canvas', title: d.title, html: d.html, url: d.url, path: d.path });
      else if (d.kind === 'screen') openDock({ kind: 'screen', title: d.title });
    });
    return unsub;
  }, [subscribe, openDock]);

  // Drag the grabber between the chat and a media dock to resize (the chat
  // grows/shrinks inversely). Transition is disabled while dragging.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    setResizing(true);
    // Capture the pointer ON THE GRABBER so move/up keep firing even when the
    // cursor passes over the dock's iframe (an iframe swallows page-level
    // pointer events, which previously lost the pointerup and left the drag
    // stuck "following" the mouse after release). Listeners live on the
    // grabber element, not window, so capture routes every event to them.
    const el = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    try { el.setPointerCapture(pointerId); } catch { /* not fatal */ }
    const onMove = (ev: PointerEvent) => setDockWidth(window.innerWidth - ev.clientX);
    const onUp = () => {
      setResizing(false);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      try { el.releasePointerCapture(pointerId); } catch { /* already released */ }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  // Mobile vertical resize: the canvas is a top panel and its bottom edge is the
  // grabber. clientY (distance from the top of the screen) IS the panel height.
  const startResizeV = (e: React.PointerEvent) => {
    e.preventDefault();
    setResizing(true);
    const el = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    try { el.setPointerCapture(pointerId); } catch { /* not fatal */ }
    const onMove = (ev: PointerEvent) => setDockHeight(ev.clientY);
    const onUp = () => {
      setResizing(false);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      try { el.releasePointerCapture(pointerId); } catch { /* already released */ }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  // Keep the orb centred in the (now narrower) main area when the dock opens,
  // closes, or is resized.
  useEffect(() => {
    const id = requestAnimationFrame(() => dojoOrb.resize());
    return () => cancelAnimationFrame(id);
  }, [dock, dockWidth, dockHeight, dojoOrb]);

  /* Drive the orb's task glyph (image/audio/song/video/compaction/dreamer/
     healer) from real engine work, and react to errors. */
  useOrbActivity();
  const [fanOpen, setFanOpen] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  /* Presence (in the dojo / out) now lives in the composer's bottom-left, but
     the stage still needs it for the orb (sleepy when away) + `is-out` styling. */
  const { isAway } = usePresence();

  /* Orb STATE (idle/thinking/listening/speaking) is owned by the composer,
     which has both the agent's working flag AND the live voice state — so a
     voice session can drive listening/speaking without fighting this effect.
     The stage still owns the presence emotion (sleepy when "out"). */
  useEffect(() => {
    dojoOrb.setEmotion(isAway ? 'sleepy' : null);
  }, [isAway, dojoOrb]);

  /* Per-agent hue: the orb takes on the active agent's colour — the same hue as
     that agent's avatar box. The primary keeps the dojo's signature champagne
     (null = no shift); a selected sub-agent uses its chosen colour, falling back
     to a stable derived hue if none was picked. */
  useEffect(() => {
    dojoOrb.setHue(isPrimary ? null : (activeAgent.activeHue ?? agentHue(activeAgent.agentId)));
  }, [activeAgent.agentId, activeAgent.activeHue, isPrimary, dojoOrb]);

  useEffect(() => {
    if (!fanOpen) setResetArmed(false);
  }, [fanOpen]);

  /* Esc steps back up: close the panel (back to chat) or close the fan. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (panel) { setFanOpen(false); navigate('/'); }
      else if (fanOpen) { setFanOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, fanOpen, navigate]);

  /* Click-away closes the front layer (throughout the dojo): an open fan
     folds back into the orb unless you click a lens or the orb; an open
     panel closes only when you click OUTSIDE it (the blurred chat showing
     around its edges) or on the orb/composer/close — a touch anywhere inside
     the panel keeps it open, so scrolling by pressing on empty space / the gaps
     between cards never dismisses it. */
  useEffect(() => {
    if (!fanOpen && !panel) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // A modal / overlay (Recruit Agent, New Contact, confirms, image
      // lightbox, ...) is the FRONT layer and owns its own dismissal. They
      // render inside the panel DOM, so without this guard a tap on a modal's
      // padding / labels / gaps (anything not in KEEP) matched .dojo3-panel and
      // closed the whole panel back to the chat. Universal across every panel:
      //   - any glass-modal* present anywhere -> suppress entirely (covers the
      //     modal box AND a tap on its backdrop), and
      //   - a tap landing inside ANY full-screen fixed overlay (`.fixed.inset-0`,
      //     e.g. the attachment lightbox / popovers) -> suppress for that tap.
      if (
        document.querySelector('.glass-modal-backdrop, .glass-modal, .glass-modal-bg') ||
        t.closest('.fixed.inset-0')
      ) return;
      if (fanOpen) {
        if (!t.closest('.dojo3-orb-fan') && !t.closest('.dojo3-orb-hit')) {
          setFanOpen(false);
          setResetArmed(false);
        }
        return;
      }
      if (panel) {
        const onChrome = t.closest(
          '.dojo3-orb-hit, .dojo3-panel__close, .composer, .voice-capsule, .dojo3-wordmark',
        );
        // Inside the panel (content OR its padding/gaps) -> keep open. Only a
        // press on the area OUTSIDE the panel dismisses it.
        if (!onChrome && !t.closest('.dojo3-panel')) {
          setFanOpen(false);
          navigate('/');
        }
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [fanOpen, panel, navigate]);

  const handleOrbClick = () => {
    if (panel) {
      navigate('/');
      setFanOpen(false);
      return;
    }
    setFanOpen((open) => !open);
  };

  const handleFanClick = async (item: typeof fanItems[number]) => {
    if (item.panel === 'reset') {
      if (!resetArmed) {
        setResetArmed(true);
        window.setTimeout(() => setResetArmed(false), 3000);
        return;
      }
      setFanOpen(false);
      setResetArmed(false);
      await onNewSession();
      return;
    }
    if (item.panel === 'trace') {
      onToggleWordyMode();
      setFanOpen(false);
      return;
    }
    setFanOpen(false);
    if (item.path && location.pathname !== item.path) navigate(item.path);
  };

  const orbState = isWorking ? 'thinking' : isAway ? 'sleepy' : 'idle';

  // Wordmark: always the ACTIVE agent's name (the primary's own name by
  // default; falls back to "DOJO" only until the name loads). On the primary
  // it toggles presence; while another agent is active, clicking it returns
  // to the primary (dojo master).
  // While building/editing a technique the stage is the trainer conversation:
  // the wordmark shows the trainer and returns to the Dojo (exits the builder)
  // on click — mirroring the "Back to <primary>" affordance for agents.
  const inTechSession = techSession.active;
  const wordmarkText = inTechSession
    ? (techSession.trainerName || 'Trainer')
    : (activeAgent.agentName || 'DOJO');
  const wordmarkIsAgent = inTechSession || !isPrimary;
  /* The primary wordmark is now just the name (presence moved to the composer);
     only a sub-agent / trainer wordmark is an action ("Back to the Dojo"). */
  const wordmarkStateLabel = wordmarkIsAgent
    ? `Back to ${activeAgent.primaryName || 'the Dojo'}`
    : '';
  const handleWordmarkClick = () => {
    if (inTechSession) { navigate('/'); }
    else if (!isPrimary) { activeAgent.selectAgent(null); }
  };

  const closePanel = () => {
    setFanOpen(false);
    navigate('/');
  };

  return (
    <div
      className={`dojo3-stage ${fanOpen ? 'fan-open' : ''} ${panel ? 'panel-open' : ''} ${isAway ? 'is-out' : ''} ${dock ? 'dock-open' : ''} ${resizing ? 'is-resizing' : ''}`}
      data-orb-state={orbState}
      style={{ '--dock-w': dock ? `${dockWidth}px` : '0px', '--dock-h': dock ? `${dockHeight}px` : '0px' } as CSSProperties}
    >
      <div ref={stageRef} className="dojo3-stage__main">
      <div className="dojo3-backdrop" aria-hidden="true" />
      <DojoOrb stageRef={stageRef} />
      <button
        type="button"
        className={`dojo3-wordmark ${wordmarkIsAgent ? 'is-agent' : ''}`}
        onClick={handleWordmarkClick}
        aria-label={wordmarkIsAgent ? `Talking to ${wordmarkText}, click to return to ${activeAgent.primaryName || 'the Dojo'}` : wordmarkText}
        disabled={!wordmarkIsAgent}
      >
        <span className="dojo3-wordmark__text">{wordmarkText}</span>
        <span className="dojo3-wordmark__dot" />
        <span className="dojo3-wordmark__state">{wordmarkStateLabel}</span>
      </button>

      {/* tiered notification cards that drop in under the orb + drive its
          reaction (pulse / startle / held-red); consume the shared toast queue */}
      <Dojo3Notifications />

      <button
        type="button"
        className="dojo3-orb-hit"
        onClick={handleOrbClick}
        aria-label="Dojo menu"
        aria-expanded={fanOpen}
      />

      <nav ref={fanRef} className="dojo3-orb-fan" aria-label="Dojo controls" aria-hidden={!fanOpen}>
        {fanItems.map((item, i) => {
          const isReset = 'destructive' in item && item.destructive;
          const isTrace = 'trace' in item && item.trace;
          const armed = isReset && resetArmed;
          const traceOn = isTrace && wordyMode;
          const onRoute = item.path != null && location.pathname === item.path;
          const label = armed ? 'Confirm' : item.label;
          /* the first item that isn't a page (Trace) starts the chat-function
             group; a subtle divider sets Trace + Reset apart from the pages */
          const startsChatFns = item.path == null && fanItems[i - 1]?.path != null;
          /* stagger from the centre outward so the labels appear in step with
             the rail's center-out reveal */
          const center = (fanItems.length - 1) / 2;
          const delay = Math.round(Math.abs(i - center) * 34 + 60);
          return (
            <button
              key={item.panel}
              type="button"
              className={`dojo3-fan-btn ${isReset ? 'dojo3-fan-btn--reset' : ''} ${isTrace ? 'dojo3-fan-btn--trace' : ''} ${startsChatFns ? 'dojo3-fan-btn--sep' : ''} ${armed ? 'is-confirm' : ''} ${onRoute ? 'is-active' : ''}`}
              style={{ '--d': `${delay}ms` } as CSSProperties}
              aria-current={onRoute ? 'page' : undefined}
              aria-pressed={isTrace ? traceOn : undefined}
              onClick={() => { void handleFanClick(item); }}
            >
              {label}
              {isTrace && traceOn && <span className="dojo3-fan-btn__dot" aria-hidden="true" />}
            </button>
          );
        })}
      </nav>

      <main className="dojo3-chat" aria-label={`Conversation with ${agentName || 'the Dojo'}`}>
        {children}
      </main>

      {panel && (
        <section className="dojo3-panel" aria-label={panel.title ?? 'Panel'}>
          {panel.title && (
            <header className="dojo3-panel__head">
              <div>
                <h2 className="dojo3-panel__title">{panel.title}</h2>
                {panel.meta && <p className="dojo3-panel__meta">{panel.meta}</p>}
              </div>
              <button type="button" className="dojo3-panel__close" onClick={closePanel} aria-label="Close panel">
                ×
              </button>
            </header>
          )}
          <div className={`dojo3-panel__body ${panel.title ? '' : 'dojo3-pbody'}`}>
            {panel.content}
          </div>
        </section>
      )}

      {/* self-headered panels: close floats at the panel's top-right,
          outside the scroll container so it stays put */}
      {panel && !panel.title && (
        <button
          type="button"
          className="dojo3-panel__close dojo3-panel__close--float"
          onClick={closePanel}
          aria-label="Close panel"
        >
          ×
        </button>
      )}

      <div className="dojo3-haze dojo3-haze--top" aria-hidden="true">
        <i /><i /><i /><i /><i />
      </div>
      <div className="dojo3-haze dojo3-haze--bottom" aria-hidden="true">
        <i /><i /><i /><i /><i />
      </div>

      <div className="dojo3-composer-scrim" aria-hidden="true" />
      {composer}
      </div>

      {dock && isMediaDock(dock) && (
        <div
          className="dojo3-dock-resizer"
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize dock"
        />
      )}
      <aside className="dojo3-dock" aria-hidden={!dock}>
        {dock && <RightDock dock={dock} />}
        {dock && isMediaDock(dock) && (
          <div
            className="dojo3-dock-resizer--bottom"
            onPointerDown={startResizeV}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize canvas"
          />
        )}
      </aside>
    </div>
  );
}
