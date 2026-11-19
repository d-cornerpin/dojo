import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

// Toast notifications, auto-dismissed by level: info/success 10s, warning and error 15s. Only an action toast
// (`addActionToast`, needsAction) stays until acted on. `success` is an alias of `info`.

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

// Auto-dismiss timing per level (ms). A plain error needs nothing from the person, so it leaves too.
const AUTO_DISMISS_MS: Record<ToastLevel, number | null> = {
  info: 10000,
  success: 10000,
  warning: 15000,
  error: 15000,
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
