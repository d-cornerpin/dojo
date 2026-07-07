import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

// ════════════════════════════════════════
// Toast Notification System
// ════════════════════════════════════════
//
// Usage: const toast = useToast();
//   toast.info('Settings saved');          // 10s auto-dismiss, green
//   toast.success('Image generated');      // 10s auto-dismiss, green (alias of info)
//   toast.warning('Low memory');           // 15s auto-dismiss, orange
//   toast.error('Connection failed');      // permanent — must be dismissed, red
//
// Three-tier classification (per user spec, 2026-05-05):
//   INFO  — green  — successful events / harmless notifications  — 10s
//   WARN  — orange — non-blocking errors or alerts              — 15s
//   ERROR — red    — blocking errors requiring user interaction — permanent
//
// `info` and `success` both render as INFO (green / 10s). Kept as separate
// methods for caller ergonomics (toast.success reads naturally) but identical
// in behavior. Choose by what reads best at the call site.
//
// Visual: glass-morphism toasts slide in from the top-right with a
// left-border color matching the level:
//   info / success → cp-teal  (green)
//   warning        → cp-amber (orange)
//   error          → cp-coral (red)

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

/** One action button on a decision toast (D-B step 4). */
export interface ToastAction {
  label: string;
  /** May be async; the rendering surface disables the buttons while it runs. */
  onClick: () => void | Promise<void>;
  variant: 'primary' | 'secondary';
}

/** Options for a persistent decision toast (Approve / Decline style). */
export interface ActionToastOptions {
  /** Bold headline, plain language (no jargon, no tool names). */
  title: string;
  /** Short body line under the headline. */
  message: string;
  actions: ToastAction[];
  /** Stable external id (e.g. `healer:<proposalId>`). */
  dedupeKey: string;
  /** Card tone; defaults to 'warning' (amber, matching the Vitals pending tone). */
  level?: ToastLevel;
}

export interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
  timestamp: number;
  // ── D-B step 4: interactive / persistent toast fields. All optional so
  // every existing toast.info/success/warning/error keeps its exact shape and
  // behavior (no title, no actions, normal auto-dismiss). ──
  /** Bold headline shown above the message. Plain language, no jargon. */
  title?: string;
  /** Action buttons rendered under the message. When present the toast is a
   *  decision prompt (a generic Approve/Decline-style card for any feature that
   *  needs an explicit choice). */
  actions?: ToastAction[];
  /** Never auto-dismiss; stays until acted on or removed by key. */
  sticky?: boolean;
  /** Hold the orb's red alert tint while this toast is on screen. The orb
   *  surface reads it and keeps setAlert(1) until no such toast remains. */
  alertOrb?: boolean;
  /** Stable external id (e.g. a Healer proposal id) so a re-emit updates the
   *  same toast in place and a later resolved frame can dismiss it by key. */
  dedupeKey?: string;
}

// Auto-dismiss timing per level (ms). Errors stay until dismissed.
// Per user spec (2026-05-05): INFO 10s, WARN 15s, ERROR permanent.
const AUTO_DISMISS_MS: Record<ToastLevel, number | null> = {
  info: 10000,
  success: 10000,
  warning: 15000,
  error: null, // manual dismiss only — blocking, requires user interaction
};

interface ToastContextValue {
  toasts: Toast[];
  addToast: (message: string, level: ToastLevel) => void;
  /** Post a persistent decision toast (Approve / Decline style). Dedupes on
   *  dedupeKey: a re-emit for the same key refreshes the toast in place. */
  addActionToast: (opts: ActionToastOptions) => void;
  removeToast: (id: number) => void;
  /** Remove whatever toast currently carries this dedupeKey (no-op if none). */
  removeToastByKey: (dedupeKey: string) => void;
  info: (message: string) => void;
  success: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastIdCounter = 0;

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const removeToastByKey = useCallback((dedupeKey: string) => {
    setToasts(prev => prev.filter(t => t.dedupeKey !== dedupeKey));
  }, []);

  // A persistent decision toast (Approve / Decline). Never auto-dismisses
  // (sticky) and holds the orb's red alert tint (alertOrb) until it is acted on
  // or removed by key. Deduped on dedupeKey so a re-emit for the same proposal
  // refreshes content in place instead of stacking a duplicate, keeping the
  // same id + slot so the orb doesn't re-startle and the card doesn't jump.
  const addActionToast = useCallback((opts: ActionToastOptions) => {
    setToasts(prev => {
      const fields = {
        message: opts.message,
        level: opts.level ?? ('warning' as ToastLevel),
        title: opts.title,
        actions: opts.actions,
        sticky: true,
        alertOrb: true,
        dedupeKey: opts.dedupeKey,
      };
      const idx = prev.findIndex(t => t.dedupeKey === opts.dedupeKey);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...fields };
        return next;
      }
      return [...prev, { id: ++toastIdCounter, timestamp: Date.now(), ...fields }];
    });
  }, []);

  const addToast = useCallback((message: string, level: ToastLevel) => {
    const id = ++toastIdCounter;
    setToasts(prev => {
      // Deduplicate: if the same message + level is already showing, don't add again
      if (prev.some(t => t.message === message && t.level === level)) return prev;
      return [...prev, { id, message, level, timestamp: Date.now() }];
    });

    const dismissMs = AUTO_DISMISS_MS[level];
    if (dismissMs !== null) {
      setTimeout(() => removeToast(id), dismissMs);
    }
  }, [removeToast]);

  const value: ToastContextValue = {
    toasts,
    addToast,
    addActionToast,
    removeToast,
    removeToastByKey,
    info: useCallback((msg: string) => addToast(msg, 'info'), [addToast]),
    success: useCallback((msg: string) => addToast(msg, 'success'), [addToast]),
    warning: useCallback((msg: string) => addToast(msg, 'warning'), [addToast]),
    error: useCallback((msg: string) => addToast(msg, 'error'), [addToast]),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
};

// ── Toast Display Component ──
// Render this once at the app root level. It reads from the context
// and renders the stack of active toasts.

const LEVEL_STYLES: Record<ToastLevel, { cssClass: string; icon: string }> = {
  info:    { cssClass: 'glass-toast-info',    icon: 'ℹ️'  },
  success: { cssClass: 'glass-toast-success', icon: '✓'  },
  warning: { cssClass: 'glass-toast-warning', icon: '⚠'  },
  // Stop sign instead of ✕ — the ✕ glyph collided visually with the
  // dismiss-button × in the same toast. (Reported by user, 2026-05-05.)
  error:   { cssClass: 'glass-toast-error',   icon: '🛑' },
};

// Button classes reused from the Vitals card (HealerVitals.tsx) so the toast's
// Approve / Decline match the Healer surface's approve / deny exactly.
const ACTION_BTN_CLASS: Record<ToastAction['variant'], string> = {
  primary: 'px-3 py-1 text-xs rounded glass-btn-primary disabled:opacity-50',
  secondary:
    'px-3 py-1 text-xs rounded bg-ui/[0.08] text-ui/55 hover:text-ui/70 border border-ui/[0.10] hover:border-ui/[0.15] transition-colors disabled:opacity-50',
};

export const ToastContainer = () => {
  const { toasts, removeToast } = useToast();
  // Per-toast in-flight guard so an async action button can't double-fire and
  // shows a disabled state while its request runs.
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  const runAction = useCallback(async (toastId: number, action: ToastAction) => {
    setBusy(prev => {
      if (prev[toastId]) return prev; // already running, ignore the re-click
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

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-14 sm:top-4 right-2 sm:right-4 z-50 space-y-2 max-w-[calc(100vw-16px)] sm:max-w-sm">
      {toasts.map(t => {
        const style = LEVEL_STYLES[t.level];
        const hasActions = !!t.actions && t.actions.length > 0;
        return (
          <div
            key={t.id}
            className={`glass-toast ${style.cssClass} px-4 py-3 text-sm text-ui animate-slide-in-right`}
          >
            <div className="flex items-start gap-2.5">
              <span className="text-sm shrink-0 mt-0.5 opacity-70">{style.icon}</span>
              <div className="flex-1 min-w-0">
                {t.title && <div className="font-medium leading-snug mb-0.5">{t.title}</div>}
                <span className="leading-relaxed">{t.message}</span>
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
                onClick={() => removeToast(t.id)}
                className="text-ui/40 hover:text-ui shrink-0 ml-1 text-lg leading-none"
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
