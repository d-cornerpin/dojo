import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

// ════════════════════════════════════════
// Toast Notification System
// ════════════════════════════════════════
//
// Usage: const toast = useToast();
//   toast.info('Settings saved');          // 4s auto-dismiss
//   toast.success('Image generated');      // 3s auto-dismiss
//   toast.warning('Low memory');           // 8s auto-dismiss
//   toast.error('Connection failed');      // stays until dismissed
//
// Visual: glass-morphism toasts slide in from the top-right. Each
// level has a distinct left-border color matching the cp-* palette:
//   info    → cp-blue (#5B8DEF)
//   success → cp-teal (#00D4AA)
//   warning → cp-amber (#F5A623)
//   error   → cp-coral (#FF6B8A)

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
  timestamp: number;
}

// Auto-dismiss timing per level (ms). Errors stay until dismissed.
const AUTO_DISMISS_MS: Record<ToastLevel, number | null> = {
  info: 4000,
  success: 3000,
  warning: 8000,
  error: null, // manual dismiss only
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
  error:   { cssClass: 'glass-toast-error',   icon: '✕'  },
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
            className={`glass-toast ${style.cssClass} px-4 py-3 text-sm text-white animate-slide-in-right`}
          >
            <div className="flex items-start gap-2.5">
              <span className="text-sm shrink-0 mt-0.5 opacity-70">{style.icon}</span>
              <span className="flex-1 leading-relaxed">{t.message}</span>
              <button
                onClick={() => removeToast(t.id)}
                className="text-white/40 hover:text-white shrink-0 ml-1 text-lg leading-none"
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
