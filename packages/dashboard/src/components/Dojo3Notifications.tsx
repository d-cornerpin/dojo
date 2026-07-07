import { useCallback, useEffect, useRef, useState } from 'react';
import type { WsEvent, ChatErrorEvent } from '@dojo/shared';
import { useToast, type ToastAction } from '../hooks/useToast';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDojoOrb } from './orb/OrbProvider';

// Button classes reused from the Vitals card (HealerVitals.tsx) so a decision
// toast's Approve / Decline match the Healer surface's approve / deny exactly.
const ACTION_BTN_CLASS: Record<ToastAction['variant'], string> = {
  primary: 'px-3 py-1 text-xs rounded glass-btn-primary disabled:opacity-50',
  secondary:
    'px-3 py-1 text-xs rounded bg-ui/[0.08] text-ui/55 hover:text-ui/70 border border-ui/[0.10] hover:border-ui/[0.15] transition-colors disabled:opacity-50',
};

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
 *
 * A toast can also carry a headline + Approve/Decline buttons (a "decision toast",
 * flagged alertOrb): a generic capability any feature may post via useToast. Here
 * we render the buttons and let the alertOrb-based tint hold the orb red until the
 * last one is acted on. (The Healer's consent asks no longer use this lane; they
 * live in the Healer section of Vitals.)
 */

export function Dojo3Notifications() {
  const { toasts, removeToast } = useToast();
  const { subscribe } = useWebSocket();
  const dojoOrb = useDojoOrb();

  // Per-toast in-flight guard for decision-toast buttons (D-B step 4): stops a
  // double-fire and shows a disabled state while the approve/deny request runs.
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const runAction = useCallback(async (toastId: number, action: ToastAction) => {
    setBusy(prev => {
      if (prev[toastId]) return prev;
      return { ...prev, [toastId]: true };
    });
    try {
      await action.onClick();
    } finally {
      setBusy(prev => {
        const next = { ...prev };
        delete next[toastId];
        return next;
      });
    }
  }, []);

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

  // Held red alert tint while any blocking (error) toast OR any pending
  // decision toast (alertOrb) is active. `.some` naturally handles stacking: the
  // tint stays until none remain, and clears the instant the last one is acted
  // on or dismissed.
  const needsAlert = toasts.some((t) => t.level === 'error' || t.alertOrb);
  useEffect(() => {
    dojoOrb.setAlert(needsAlert ? 1 : 0);
  }, [needsAlert, dojoOrb]);

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
        const hasActions = !!t.actions && t.actions.length > 0;
        return (
          <div
            key={t.id}
            className={`dojo3-note dojo3-note--${tier}`}
            role={t.level === 'error' ? 'alert' : 'status'}
            // A decision toast is a multi-line card (headline + body + buttons),
            // so top-align the dot/x against the content column. The base
            // .dojo3-note rule wins over a Tailwind items-start on specificity,
            // so this one dynamic override goes inline.
            style={hasActions ? { alignItems: 'flex-start' } : undefined}
          >
            <span className="dojo3-note__dot" aria-hidden="true" style={hasActions ? { marginTop: '6px' } : undefined} />
            <div className="dojo3-note__msg">
              {t.title && <div className="font-semibold mb-0.5">{t.title}</div>}
              <span>{t.message}</span>
              {hasActions && (
                <div className="flex gap-2 mt-2">
                  {t.actions!.map((a, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => void runAction(t.id, a)}
                      disabled={!!busy[t.id]}
                      className={ACTION_BTN_CLASS[a.variant]}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
