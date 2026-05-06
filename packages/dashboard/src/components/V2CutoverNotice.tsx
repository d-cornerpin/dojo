// ════════════════════════════════════════
// V2CutoverNotice — one-time welcome banner
// ════════════════════════════════════════
//
// Shows once per installation when the user first lands on the dashboard
// after this version of the DOJO is installed. Tells them about the
// new architecture and offers a one-click "Reset all idle sessions"
// for a clean start (existing v1-era conversation history works on v2
// but the first few turns carry slightly more context than steady-state
// until stub-and-store kicks in).
//
// Trigger: server-side setting `v2_cutover_dismissed`. localStorage is a
// fast-path optimistic suppress so we don't flash the banner before the
// settings GET resolves. Once dismissed (explicit or via Reset), we
// persist to the server so other browsers / restarts also stay quiet.

import { useEffect, useState } from 'react';
import { resetIdleSessions, getSetting, setSetting } from '../lib/api';
import { useToast } from '../hooks/useToast';

const SEEN_KEY = 'dojo_v2_welcome_seen';
const SERVER_KEY = 'v2_cutover_dismissed';

export const V2CutoverNotice = () => {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Fast-path: localStorage already says we dismissed it here. Don't bother
    // the server.
    if (localStorage.getItem(SEEN_KEY) === '1') return;
    (async () => {
      try {
        const r = await getSetting(SERVER_KEY);
        if (cancelled) return;
        if (r.ok && r.data?.value === 'true') {
          // Server says dismissed — sync localStorage so we don't keep asking.
          localStorage.setItem(SEEN_KEY, '1');
          return;
        }
        setShow(true);
      } catch {
        // Network error fetching the setting — safer to show than to swallow.
        if (!cancelled) setShow(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const persistDismissed = () => {
    localStorage.setItem(SEEN_KEY, '1');
    // Best-effort: on failure the user just sees the banner again on a
    // different browser. Not worth blocking dismissal on.
    setSetting(SERVER_KEY, 'true').catch(() => { /* ignore */ });
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const r = await resetIdleSessions();
      if (r.ok) {
        const { reset, busy, errors } = r.data;
        const parts: string[] = [`${reset} agent${reset === 1 ? '' : 's'} reset`];
        if (busy > 0) parts.push(`${busy} ${busy === 1 ? 'was' : 'were'} busy`);
        if (errors > 0) parts.push(`${errors} failed`);
        toast.success(parts.join(', ') + '.');
      } else {
        toast.error(r.error || 'Could not reset sessions. Try again or check the Health page.');
      }
    } catch {
      toast.error('Network error while resetting sessions.');
    } finally {
      setResetting(false);
      handleDismiss();
    }
  };

  const handleDismiss = () => {
    persistDismissed();
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="fixed top-14 sm:top-4 left-1/2 -translate-x-1/2 z-[60] max-w-[calc(100vw-16px)] sm:max-w-xl w-full px-2">
      <div className="glass-toast glass-toast-info px-4 py-3 text-sm text-white animate-slide-in-right">
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2.5">
            <span className="text-base shrink-0 mt-0.5">🚀</span>
            <div className="flex-1 leading-relaxed space-y-1.5">
              <div className="font-semibold">DOJO v2 is live.</div>
              <div className="text-white/85">
                Agents have been upgraded — expect faster turns, true streaming, and rare-to-zero compaction.
                Sessions in progress will carry over with slightly more context for the first few turns.
              </div>
              <div className="text-white/70">
                If your agents aren't currently in the middle of a task, consider resetting their sessions for a clean start.
              </div>
            </div>
            <button
              onClick={handleDismiss}
              className="text-white/40 hover:text-white shrink-0 ml-1 text-lg leading-none"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
          <div className="flex gap-2 ml-7">
            <button
              onClick={handleReset}
              disabled={resetting}
              className="px-3 py-1.5 rounded bg-white/15 hover:bg-white/25 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium transition-colors"
            >
              {resetting ? 'Resetting…' : 'Reset all idle sessions'}
            </button>
            <button
              onClick={handleDismiss}
              className="px-3 py-1.5 rounded text-white/70 hover:text-white text-sm transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
