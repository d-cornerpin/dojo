import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { resolveAgentHue } from '../lib/agent-hue';
import {
  agentParamOf,
  isRestorable,
  readRememberedAgent,
  rememberAgent,
  restoreCandidate,
  withAgentParam,
} from '../lib/active-agent-memory';

// The dojo3 stage always has ONE active agent, the "dojo master" by default: chat, composer,
// orb, wordmark and placeholder follow it. It lives in the persistent Dojo3Shell, so panel
// navigation never loses the choice, and reloads survive via `localStorage` (per-browser, see
// lib/active-agent-memory.ts) and `?agent=<id>`; the URL wins a tie. Restored ids are verified.
interface SelectedAgent { id: string; name: string; hue?: number }

export interface ActiveAgentApi {
  agentId: string;
  agentName: string;
  primaryName: string;
  primaryId: string | null;
  isPrimary: boolean;
  activeHue: number | null;
  selectAgent: (agent: SelectedAgent | null) => void;
}

const ActiveAgentContext = createContext<ActiveAgentApi | null>(null);

const FALLBACK: ActiveAgentApi = {
  agentId: 'primary',
  agentName: '',
  primaryName: '',
  primaryId: null,
  isPrimary: true,
  activeHue: null,
  selectAgent: () => {},
};

export function ActiveAgentProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [primaryName, setPrimaryName] = useState<string>('');
  /* Nothing may be written before the primary is known: a premature write erases a restored choice. */
  const [primaryKnown, setPrimaryKnown] = useState(false);
  // Restored SYNCHRONOUSLY in the initialiser, so the first paint is the right agent, not a DOJO flash.
  const [selected, setSelected] = useState<SelectedAgent | null>(
    () => restoreCandidate(window.location.search, readRememberedAgent()),
  );
  const verifying = useRef<string | null>(null);
  // A failed read is re-asked on the real signal (socket reconnect): no clock, no count.
  const { reconnectCount } = useWebSocket();
  const failedVerify = useRef<string | null>(null);
  const primaryKnownRef = useRef(false);
  /** The last agent id THIS provider wrote to the URL: tells an outside change from our own echo. */
  const lastWrittenParam = useRef<string | null>(agentParamOf(window.location.search));

  /* Check a claimed selection against the server: anything the roster would not show the
   * user (gone, ended, archived) drops to the primary without a word. Every write is
   * guarded on the id still being the selected one, so an in-flight verify cannot clobber it. */
  const verify = useCallback((id: string) => {
    if (verifying.current === id) return;
    verifying.current = id;
    void api.getAgent(id).then((result) => {
      if (verifying.current === id) verifying.current = null;
      /* A FAILED request (network, server restarting) says nothing about the agent: keep the
       * selection, ask again on reconnect. Only a 404 or a good "gone" answer drops it. */
      if (!result.ok && result.status !== 404) {
        failedVerify.current = id;
        return;
      }
      if (failedVerify.current === id) failedVerify.current = null;
      const agent = result.ok ? result.data : null;
      if (!isRestorable(agent) || !agent) {
        setSelected((cur) => (cur && cur.id === id ? null : cur));
        return;
      }
      // Trusted now, and refreshed: a rename or new colour set on another device shows on this load.
      setSelected((cur) =>
        cur && cur.id === id ? { id, name: agent.name, hue: resolveAgentHue(agent, false) } : cur,
      );
    });
  }, []);

  useEffect(() => {
    if (primaryKnownRef.current) return;
    let cancelled = false;
    void Promise.all([
      api.getSetting('primary_agent_id'),
      api.getSetting('primary_agent_name'),
    ]).then(([idResult, nameResult]) => {
      if (cancelled) return;
      if (nameResult.ok && nameResult.data.value) setPrimaryName(nameResult.data.value);
      /* A failed read is not "there is no primary": stay unknown (nothing is written) until a reconnect. */
      if (!idResult.ok) return;
      if (idResult.data.value) setPrimaryId(idResult.data.value);
      primaryKnownRef.current = true;
      setPrimaryKnown(true);
    });
    return () => { cancelled = true; };
  }, [reconnectCount]);

  useEffect(() => {
    const id = failedVerify.current;
    if (id && selected && selected.id === id) verify(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectCount]);

  useEffect(() => {
    if (selected) verify(selected.id);
    // Mount only: later selections are the user's own clicks on live agents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Write-through, not a beforeunload handler: mobile Safari may not run one when it discards a tab.
  useEffect(() => {
    if (!primaryKnown) return;
    rememberAgent(selected && selected.id !== primaryId ? selected : null);
  }, [selected, primaryId, primaryKnown]);

  /* The URL and the selection, reconciled here. A URL id not on screen WINS (a link, bookmark or
   * back button is the user asking for that agent) unless it is our own echo; an absent param is
   * never a signal: panel opens drop the query, so a missing param means "put it back", not reset. */
  useEffect(() => {
    if (!primaryKnown) return;
    const inUrl = agentParamOf(location.search);
    const want = selected && selected.id !== primaryId ? selected.id : null;
    if (inUrl === want) { lastWrittenParam.current = want; return; }

    if (inUrl && inUrl !== lastWrittenParam.current) {
      lastWrittenParam.current = inUrl;
      const stored = readRememberedAgent();
      setSelected(stored && stored.id === inUrl ? stored : { id: inUrl, name: '' });
      verify(inUrl);
      return;
    }

    lastWrittenParam.current = want;
    navigate({ pathname: location.pathname, search: withAgentParam(location.search, want) }, { replace: true });
  }, [location.pathname, location.search, selected, primaryId, primaryKnown, navigate, verify]);

  const value = useMemo<ActiveAgentApi>(() => {
    const isPrimary = !selected || (primaryId != null && selected.id === primaryId);
    return {
      agentId: selected?.id ?? primaryId ?? 'primary',
      agentName: !isPrimary && selected ? selected.name : primaryName,
      primaryName,
      primaryId,
      isPrimary,
      activeHue: isPrimary ? null : (selected?.hue ?? null),
      selectAgent: setSelected,
    };
  }, [selected, primaryId, primaryName]);

  return <ActiveAgentContext.Provider value={value}>{children}</ActiveAgentContext.Provider>;
}

export function useActiveAgent(): ActiveAgentApi {
  return useContext(ActiveAgentContext) ?? FALLBACK;
}
