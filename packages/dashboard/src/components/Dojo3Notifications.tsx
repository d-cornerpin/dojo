import { useEffect, useRef } from 'react';
import type { WsEvent, ChatErrorEvent } from '@dojo/shared';
import { useToast } from '../hooks/useToast';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDojoOrb } from './orb/OrbProvider';

/*
 * The dojo3 notification surface: tiered glass cards that drop in UNDER the orb
 * and drive the orb's reaction, replacing the off-brand corner toasts inside
 * the stage. Consumes the shared toast queue (useToast), so every existing
 * toast.info/warning/error and chat:error still flows through here.
 *
 * Tiers (the toast system's own three levels):
 *   info / success -> teal  -> orb gives a quick pulse, card auto-fades
 *   warning        -> amber -> orb startles ("!" jolt), card auto-fades
 *   error          -> coral -> orb startles AND holds a red alert tint; the
 *                              card is pinned until dismissed OR the engine
 *                              signals recovery (AGENT_RECOVERED).
 */

export function Dojo3Notifications() {
  const { toasts, removeToast } = useToast();
  const { subscribe } = useWebSocket();
  const dojoOrb = useDojoOrb();

  // Orb reaction on each NEWLY-arrived toast.
  const seen = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const t of toasts) {
      if (seen.current.has(t.id)) continue;
      seen.current.add(t.id);
      if (t.level === 'error' || t.level === 'warning') dojoOrb.setEmotion('startled');
      else dojoOrb.pulse();
    }
    const present = new Set(toasts.map((t) => t.id));
    for (const id of [...seen.current]) if (!present.has(id)) seen.current.delete(id);
  }, [toasts, dojoOrb]);

  // Held red alert tint while any blocking (error) toast is active.
  const hasError = toasts.some((t) => t.level === 'error');
  useEffect(() => {
    dojoOrb.setAlert(hasError ? 1 : 0);
  }, [hasError, dojoOrb]);

  // The orb shows the notification icon INSIDE the glass (like the task glyphs):
  // exclamation for warnings/errors, a check for info/success, reflecting the
  // most important active notification.
  useEffect(() => {
    const glyph = toasts.some((t) => t.level === 'error' || t.level === 'warning')
      ? 'alert'
      : toasts.some((t) => t.level === 'info' || t.level === 'success')
        ? 'check'
        : null;
    dojoOrb.setNoteGlyph(glyph);
  }, [toasts, dojoOrb]);

  // Release the tint + glyph if this surface unmounts (e.g. to a full page).
  useEffect(() => () => { dojoOrb.setAlert(0); dojoOrb.setNoteGlyph(null); }, [dojoOrb]);

  // Engine recovery clears blocking errors automatically (the other half of
  // "both": dismiss OR recovery). The server emits chat:error with code
  // AGENT_RECOVERED / info severity when an agent recovers.
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;
  useEffect(() => {
    const unsub = subscribe('chat:error', (event: WsEvent) => {
      const e = event as ChatErrorEvent;
      if (e.code === 'AGENT_RECOVERED' || e.severity === 'info') {
        for (const t of toastsRef.current) if (t.level === 'error') removeToast(t.id);
      }
    });
    return unsub;
  }, [subscribe, removeToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="dojo3-notes" role="region" aria-label="Notifications">
      {toasts.map((t) => {
        const tier = t.level === 'success' ? 'info' : t.level;
        return (
          <div key={t.id} className={`dojo3-note dojo3-note--${tier}`} role={t.level === 'error' ? 'alert' : 'status'}>
            <span className="dojo3-note__dot" aria-hidden="true" />
            <span className="dojo3-note__msg">{t.message}</span>
            <button
              type="button"
              className="dojo3-note__x"
              onClick={() => removeToast(t.id)}
              aria-label="Dismiss notification"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
