import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as api from '../lib/api';

/* Presence (in the dojo vs out / iMessage) is shown + toggled in the composer's
   bottom-left, but the orb (sleepy when away) and the stage `is-out` styling
   also need it. This provider is the single source of truth both consume. */

export type PresenceStatus = 'in_dojo' | 'away';
interface PresenceState {
  status: PresenceStatus;
  imessageConfigured: boolean;
}
interface PresenceContextValue {
  presence: PresenceState | null;
  isAway: boolean;
  /** Flip in_dojo <-> away (optimistic, reverts on failure). */
  toggle: () => Promise<void>;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [presence, setPresence] = useState<PresenceState | null>(null);
  const presenceRef = useRef<PresenceState | null>(null);
  presenceRef.current = presence;

  useEffect(() => {
    let cancelled = false;
    api
      .request<PresenceState>('/system/presence')
      .then((res) => {
        if (!cancelled && res.ok) setPresence(res.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(async () => {
    const cur = presenceRef.current;
    if (!cur) return;
    const next: PresenceStatus = cur.status === 'in_dojo' ? 'away' : 'in_dojo';
    setPresence({ ...cur, status: next });
    const res = await api.request<PresenceState>('/system/presence', {
      method: 'POST',
      body: JSON.stringify({ status: next }),
    });
    if (!res.ok) setPresence(cur);
  }, []);

  const isAway = presence?.status === 'away';

  return (
    <PresenceContext.Provider value={{ presence, isAway, toggle }}>
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresence(): PresenceContextValue {
  return useContext(PresenceContext) ?? { presence: null, isAway: false, toggle: async () => {} };
}
