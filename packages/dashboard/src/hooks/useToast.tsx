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

export interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
  timestamp: number;
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
  removeToast: (id: number) => void;
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
    removeToast,
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

export const ToastContainer = () => {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-14 sm:top-4 right-2 sm:right-4 z-50 space-y-2 max-w-[calc(100vw-16px)] sm:max-w-sm">
      {toasts.map(t => {
        const style = LEVEL_STYLES[t.level];
        return (
          <div
            key={t.id}
            className={`glass-toast ${style.cssClass} px-4 py-3 text-sm text-ui animate-slide-in-right`}
          >
            <div className="flex items-start gap-2.5">
              <span className="text-sm shrink-0 mt-0.5 opacity-70">{style.icon}</span>
              <span className="flex-1 leading-relaxed">{t.message}</span>
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
