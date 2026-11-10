import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

// Toast notifications, auto-dismissed by level: info/success 10s, warning 15s, error stays until
// dismissed. `success` is an alias of `info`; they differ only in the name read at the call site.

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

/** One action button on a decision toast. */
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
  message: string;
  actions: ToastAction[];
  dedupeKey: string;
  /** Card tone; defaults to 'warning' (amber, matching the Vitals pending tone). */
  level?: ToastLevel;
  /** Called when the person presses the card's X (an owner card tells the server). */
  onDismiss?: () => void;
  /** Does the person have to act? Default true: sticky, holds the orb's red alert until acted on.
   *  False: an informational card, leaves on its level's timer, never reddens the orb. */
  needsAction?: boolean;
}


export interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
  timestamp: number;
  // Interactive / persistent fields, all optional: plain toasts keep their shape and auto-dismiss.
  /** Bold headline shown above the message. Plain language, no jargon. */
  title?: string;
  /** Action buttons rendered under the message. When present the toast is a
   *  decision prompt (a generic Approve/Decline-style card for any feature that
   *  needs an explicit choice). */
  actions?: ToastAction[];
  /** Never auto-dismiss; stays until acted on or removed by key. */
  sticky?: boolean;
  /** Hold the orb's red alert tint while this toast is on screen; the orb surface reads it. */
  alertOrb?: boolean;
  /** Stable external id (e.g. healer:<id>): re-emit updates in place, a resolved frame removes by key. */
  dedupeKey?: string;
  /** Called when the person presses the X, not when a timer, a sweep or a key removes it. */
  onDismiss?: () => void;
}

// Auto-dismiss timing per level (ms). Errors are blocking: they stay until dismissed.
const AUTO_DISMISS_MS: Record<ToastLevel, number | null> = {
  info: 10000,
  success: 10000,
  warning: 15000,
  error: null, // blocking: stays until dismissed manually
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

  // A persistent decision toast (Approve / Decline): deduped on dedupeKey so a re-emit refreshes
  // the same card in place (same id + slot: no orb re-startle, no jump). Only a card the person
  // must act on (`needsAction`) stays sticky and red; an informational one leaves on its timer.
  const addActionToast = useCallback((opts: ActionToastOptions) => {
    const needsAction = opts.needsAction ?? true;
    const level = opts.level ?? ('warning' as ToastLevel);
    const fresh = ++toastIdCounter;
    setToasts(prev => {
      const fields = {
        message: opts.message,
        level,
        title: opts.title,
        actions: opts.actions,
        sticky: needsAction,
        alertOrb: needsAction,
        dedupeKey: opts.dedupeKey,
        onDismiss: opts.onDismiss,
      };
      const idx = prev.findIndex(t => t.dedupeKey === opts.dedupeKey);
      if (idx >= 0) {
        const next = [...prev];
        // A card that leaves by itself takes the fresh id, so the timer below runs from this showing.
        next[idx] = { ...next[idx], ...fields, ...(needsAction ? {} : { id: fresh }) };
        return next;
      }
      return [...prev, { id: fresh, timestamp: Date.now(), ...fields }];
    });
    const dismissMs = needsAction ? null : AUTO_DISMISS_MS[level];
    if (dismissMs !== null) setTimeout(() => removeToast(fresh), dismissMs);
  }, [removeToast]);

  const addToast = useCallback((message: string, level: ToastLevel) => {
    const id = ++toastIdCounter;
    setToasts(prev => {
      // Dedupe by message + level, and against a sticky card carrying the same words: an owner
      // card supersedes an agent's own copy, one card per incident.
      if (prev.some(t => t.message === message && (t.level === level || t.sticky))) return prev;
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

// Toast stack: render once at the app root, it draws every active toast from the context.

const LEVEL_STYLES: Record<ToastLevel, { cssClass: string; icon: string }> = {
  info:    { cssClass: 'glass-toast-info',    icon: 'ℹ️'  },
  success: { cssClass: 'glass-toast-success', icon: '✓'  },
  warning: { cssClass: 'glass-toast-warning', icon: '⚠'  },
  // Stop sign, not ✕: the ✕ glyph reads as the dismiss-button × in the same toast.
  error:   { cssClass: 'glass-toast-error',   icon: '🛑' },
};

// Button classes reused from the Healer vitals card so Approve / Decline match that surface exactly.
const ACTION_BTN_CLASS: Record<ToastAction['variant'], string> = {
  primary: 'px-3 py-1 text-xs rounded glass-btn-primary disabled:opacity-50',
  secondary:
    'px-3 py-1 text-xs rounded bg-ui/[0.08] text-ui/55 hover:text-ui/70 border border-ui/[0.10] hover:border-ui/[0.15] transition-colors disabled:opacity-50',
};

export const ToastContainer = () => {
  const { toasts, removeToast } = useToast();
  // Per-toast in-flight guard: an async action button can't double-fire, disabled while it runs.
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
                onClick={() => { t.onDismiss?.(); removeToast(t.id); }}
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
