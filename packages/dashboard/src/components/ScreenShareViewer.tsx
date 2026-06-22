import { useEffect, useRef, useState, useCallback } from 'react';
import RFB from '@novnc/novnc/core/rfb.js';
import { useRightDock } from './RightDockProvider';

// Live view of the agent's Mac screen in the right dock. Connects to the JWT-
// gated VNC bridge (/api/screen/vnc) and renders with noVNC. View-only by
// default; "Take control" enables mouse/keyboard. The user enters the VNC
// password set on the Mac (the second factor); the dojo stores nothing.
//
// Zoom + pan: noVNC always runs scaleViewport (so it owns the scale and input
// mapping stays correct). We size the noVNC target to framebuffer × zoom inside
// our own scroll wrapper — noVNC fits the desktop into that at the zoom scale,
// and the wrapper scrolls to pan. No fighting noVNC's viewport math.

type ViewerStatus = 'connecting' | 'credential' | 'connected' | 'disconnected' | 'error';

const CONNECT_TIMEOUT_MS = 20_000;
const ZOOM_STEP = 1.5;
const ZOOM_MAX = 16;

export function ScreenShareViewer() {
  const { close } = useRightDock();
  const outerRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const connectedRef = useRef(false);
  const submittedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<ViewerStatus>('connecting');
  const [controlling, setControlling] = useState(false);
  const [needsUsername, setNeedsUsername] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(1); // 1 = fit; >1 = zoomed in
  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const armTimer = (msg: string) => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      setError(msg);
      setStatus('error');
      try { rfbRef.current?.disconnect(); } catch { /* ignore */ }
    }, CONNECT_TIMEOUT_MS);
  };

  // Size the noVNC target to framebuffer × zoom (fit when zoom <= 1). noVNC fits
  // the desktop into that, so its scale = fitScale × zoom and input stays correct.
  const applyZoom = useCallback((mult: number) => {
    const rfb = rfbRef.current;
    const outer = outerRef.current;
    const screen = screenRef.current;
    if (!rfb || !outer || !screen) return;
    rfb.scaleViewport = true;

    if (mult <= 1) {
      screen.style.width = '100%';
      screen.style.height = '100%';
      return;
    }
    const d = (rfb as unknown as { _display?: { width: number; height: number } })._display;
    const fbW = d?.width ?? 0;
    const fbH = d?.height ?? 0;
    const ow = outer.clientWidth;
    const oh = outer.clientHeight;
    if (!fbW || !fbH || !ow || !oh) { screen.style.width = '100%'; screen.style.height = '100%'; return; }
    const fitScale = Math.min(ow / fbW, oh / fbH);
    screen.style.width = `${Math.round(fbW * fitScale * mult)}px`;
    screen.style.height = `${Math.round(fbH * fitScale * mult)}px`;
  }, []);

  useEffect(() => {
    const el = screenRef.current;
    const outer = outerRef.current;
    if (!el || !outer) return;
    connectedRef.current = false;
    submittedRef.current = false;
    setError(''); setControlling(false); setStatus('connecting');

    const token = localStorage.getItem('dojo_token') ?? '';
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/api/screen/vnc?token=${encodeURIComponent(token)}`;

    let rfb: RFB;
    try {
      rfb = new RFB(el, url, {});
    } catch {
      setError('Could not start the screen viewer.');
      setStatus('error');
      return;
    }
    rfb.viewOnly = true;
    rfb.scaleViewport = true;
    rfb.background = '#0b0b0f';

    armTimer('Could not reach the screen-sharing service. Is Screen Sharing enabled on the Mac?');

    rfb.addEventListener('connect', () => {
      clearTimer();
      connectedRef.current = true;
      setStatus('connected');
      setError('');
    });
    rfb.addEventListener('disconnect', (ev: Event) => {
      clearTimer();
      if (connectedRef.current) {
        setStatus('disconnected');
      } else {
        setStatus('error');
        const clean = (ev as CustomEvent).detail?.clean;
        setError((prev) => prev || (clean ? 'Disconnected.' : 'Connection closed before it could log in.'));
      }
    });
    rfb.addEventListener('credentialsrequired', (ev: Event) => {
      clearTimer();
      const types = (ev as CustomEvent).detail?.types;
      setNeedsUsername(Array.isArray(types) ? types.includes('username') : true);
      if (submittedRef.current) {
        setError('Incorrect password. Try again.');
        submittedRef.current = false;
      }
      setStatus('credential');
    });
    rfb.addEventListener('securityfailure', (ev: Event) => {
      clearTimer();
      const reason = (ev as CustomEvent).detail?.reason;
      setError(reason || 'Login failed. Check the VNC password.');
      setStatus('error');
    });

    rfbRef.current = rfb;

    // Reapply zoom on wrapper resize (the fit scale depends on the dock size).
    const ro = new ResizeObserver(() => {
      if (connectedRef.current && zoomRef.current > 1) applyZoom(zoomRef.current);
    });
    ro.observe(outer);

    return () => {
      clearTimer();
      ro.disconnect();
      try { rfb.disconnect(); } catch { /* ignore */ }
      rfbRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(() => {
    if (status === 'connected') applyZoom(zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, status]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const rfb = rfbRef.current;
    if (!rfb || !password || (needsUsername && !username)) return;
    submittedRef.current = true;
    setError('');
    setStatus('connecting');
    armTimer('Timed out connecting. Check the VNC password, or that Screen Sharing is on.');
    rfb.sendCredentials(needsUsername ? { username, password } : { password });
  };

  const toggleControl = () => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    const next = !controlling;
    rfb.viewOnly = !next;
    setControlling(next);
    if (next) { try { rfb.focus(); } catch { /* ignore */ } }
  };

  const cancel = () => {
    clearTimer();
    try { rfbRef.current?.disconnect(); } catch { /* ignore */ }
    close();
  };

  const reconnect = () => {
    clearTimer();
    try { rfbRef.current?.disconnect(); } catch { /* ignore */ }
    setPassword('');
    setZoom(1);
    setAttempt((a) => a + 1);
  };

  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, z <= 1 ? ZOOM_STEP : z * ZOOM_STEP));
  const zoomOut = () => setZoom((z) => Math.max(1, z / ZOOM_STEP));
  const zoomFit = () => setZoom(1);

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.25)',
    color: 'inherit', marginBottom: 8,
  };

  const showCancel = status === 'connecting' || status === 'credential';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="tech__head" style={{ padding: '6px 10px', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {status === 'connected' && <span className="pill pill--ok"><i className="dot" />Connected</span>}
        {status === 'connecting' && <span className="text-xs text-ui/55">Connecting...</span>}
        {status === 'credential' && <span className="text-xs text-ui/55">VNC password required</span>}
        {status === 'disconnected' && <span className="text-xs text-ui/55">Disconnected</span>}
        {status === 'error' && <span className="text-xs" style={{ color: '#e88' }}>{error || 'Connection error'}</span>}

        {status === 'connected' && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button type="button" className="btn btn--sm" onClick={zoomOut} disabled={zoom <= 1} title="Zoom out">−</button>
            <button type="button" className={`btn btn--sm${zoom <= 1 ? ' btn--primary' : ''}`} onClick={zoomFit} title="Fit to window">
              {zoom > 1 ? `${zoom.toFixed(1)}×` : 'Fit'}
            </button>
            <button type="button" className="btn btn--sm" onClick={zoomIn} disabled={zoom >= ZOOM_MAX} title="Zoom in">+</button>
          </div>
        )}

        <span className="toolbar__spacer" />
        {status === 'connected' && (
          <>
            <button
              type="button"
              className={`btn btn--sm${controlling ? ' btn--primary' : ''}`}
              onClick={toggleControl}
              title={controlling ? 'Stop sending mouse/keyboard' : 'Send mouse/keyboard to this Mac'}
            >
              {controlling ? 'Release control' : 'Take control'}
            </button>
            <button type="button" className="btn btn--sm" onClick={cancel} title="End the screen share and close">
              Disconnect
            </button>
          </>
        )}
        {(status === 'error' || status === 'disconnected') && (
          <button type="button" className="btn btn--sm" onClick={reconnect}>Reconnect</button>
        )}
        {showCancel && (
          <button type="button" className="btn btn--sm" onClick={cancel}>Cancel</button>
        )}
      </div>

      {status === 'credential' && (
        <form onSubmit={submit} className="glass-nested rounded-xl p-3" style={{ margin: 10 }}>
          <p className="text-xs text-ui/55" style={{ marginBottom: 8 }}>
            Enter the screen-sharing (VNC) password set on this Mac to start the screen share.
          </p>
          {error && <p className="text-xs" style={{ color: '#e88', marginBottom: 8 }}>{error}</p>}
          {needsUsername && (
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus placeholder="Username" autoComplete="off" style={inputStyle} />
          )}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!needsUsername} placeholder="VNC password" style={inputStyle} />
          <button type="submit" className="btn btn--primary btn--sm">Connect</button>
        </form>
      )}

      {status === 'error' && (
        <div className="glass-nested rounded-xl p-3" style={{ margin: 10 }}>
          <p className="text-xs" style={{ color: '#e88' }}>{error || 'Connection error.'}</p>
        </div>
      )}

      <div ref={outerRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', background: '#0b0b0f' }}>
        <div ref={screenRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
