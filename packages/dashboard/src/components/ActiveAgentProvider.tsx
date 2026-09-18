import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { resolveAgentHue } from '../lib/agent-hue';
import {
  agentParamOf,
  isRestorable,
  readRememberedAgent,
  rememberAgent,
  restoreCandidate,
  withAgentParam,
} from '../lib/active-agent-memory';

/*
 * The dojo3 stage always has ONE active agent. By default it is the primary
 * agent (the "dojo master"), shown as "DOJO". Selecting an agent from the
 * Agents panel makes the whole stage that agent's: the chat thread, the
 * composer target, the orb, the wordmark, and the composer placeholder all
 * follow the active agent. Selecting back to the primary (or selectAgent(null))
 * returns to the Dojo default.
 *
 * This lives in the persistent Dojo3Shell, so the selection survives panel
 * navigation (opening Vault, Settings, etc. does not lose the active agent).
 *
 * ── AND IT SURVIVES THE PAGE ITSELF (T78b) ──
 * It used to live in one `useState` and nowhere else, so a desktop reload — or
 * an iPhone leaving the tab long enough for Safari to discard it — came back on
 * the primary, every time. The selection now has two homes outside this
 * component, and this provider is the only thing that writes either:
 *
 *   `localStorage`   the device's memory of what you were doing. Per-BROWSER on
 *                    purpose: see lib/active-agent-memory.ts for why this is not
 *                    account state.
 *   `?agent=<id>`    the same choice in the URL, so a view is linkable and the
 *                    back button behaves. When the two disagree the URL wins.
 *
 * Both are updated the moment the selection changes, and a restored id is
 * CHECKED against the server before it is trusted (deleted / ended / archived →
 * back to the primary, silently).
 */
interface SelectedAgent { id: string; name: string; hue?: number }

export interface ActiveAgentApi {
  /** The id the chat/composer/orb target. Equals the primary id when none selected. */
  agentId: string;
  /** The active agent's display name (the primary's own name when none selected). */
  agentName: string;
  /** The primary "dojo master" agent's name (for the "back to X" affordance). */
  primaryName: string;
  /** The primary "dojo master" agent's id (so cards can tell which one is primary). */
  primaryId: string | null;
  /** True when the active agent is the primary "dojo master". */
  isPrimary: boolean;
  /** The active agent's orb hue (0..360), or null for the primary (champagne). */
  activeHue: number | null;
  /** Select an agent, or pass null to return to the primary (dojo master). */
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
  /* Until the primary is known we cannot tell "agent X" from "the default", so
   * neither the store nor the URL may be written — a premature write would
   * erase a restored selection or stamp the primary's own id into the link. */
  const [primaryKnown, setPrimaryKnown] = useState(false);
  /* Restored SYNCHRONOUSLY, inside the initialiser, so the first paint is
   * already the right agent instead of flashing DOJO for a round trip. The
   * cached name/hue make that paint correct; `verify` below makes it TRUE. */
  const [selected, setSelected] = useState<SelectedAgent | null>(
    () => restoreCandidate(window.location.search, readRememberedAgent()),
  );
  /** The id currently being checked, so a re-render cannot fire a second fetch. */
  const verifying = useRef<string | null>(null);
  /** The last agent id THIS provider put in the URL. It is what tells an outside
   *  change (deep link, back button) apart from our own echo. */
  const lastWrittenParam = useRef<string | null>(agentParamOf(window.location.search));

  /* Check a claimed selection against the server. Anything the roster would not
   * show the user — gone, ended, archived — drops back to the primary without a
   * word: an empty chat that can never answer is worse than the default one.
   * Every write is guarded on the id still being the selected one, so a verify
   * in flight can never clobber a pick the user made while it was running. */
  const verify = useCallback((id: string) => {
    if (verifying.current === id) return;
    verifying.current = id;
    void api.getAgent(id).then((result) => {
      if (verifying.current === id) verifying.current = null;
      const agent = result.ok ? result.data : null;
      if (!isRestorable(agent) || !agent) {
        setSelected((cur) => (cur && cur.id === id ? null : cur));
        return;
      }
      /* Trusted now — and refreshed, so a rename or a new colour chosen on
       * another device shows up on this one's next load. */
      setSelected((cur) =>
        cur && cur.id === id ? { id, name: agent.name, hue: resolveAgentHue(agent, false) } : cur,
      );
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.getSetting('primary_agent_id'),
      api.getSetting('primary_agent_name'),
    ]).then(([idResult, nameResult]) => {
      if (cancelled) return;
      if (idResult.ok && idResult.data.value) setPrimaryId(idResult.data.value);
      if (nameResult.ok && nameResult.data.value) setPrimaryName(nameResult.data.value);
      setPrimaryKnown(true);
    });
    return () => { cancelled = true; };
  }, []);

  /* The restored claim, checked once the app is up. */
  useEffect(() => {
    if (selected) verify(selected.id);
    // Mount only: later selections are the user's own clicks on live agents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Write-through. Not a `beforeunload` handler: mobile Safari does not promise
   * to run one when it discards a tab, which is the case this must survive. */
  useEffect(() => {
    if (!primaryKnown) return;
    rememberAgent(selected && selected.id !== primaryId ? selected : null);
  }, [selected, primaryId, primaryKnown]);

  /* The URL and the selection, reconciled in one place.
   *
   * An id in the URL that is not the one on screen WINS — it arrived from a
   * link, a bookmark or the back button, and all three are the user asking for
   * that agent — unless it is the value we just wrote ourselves, which is only
   * an echo. Absence of the param is never a signal: `navigate('/settings')`
   * and friends drop the query string on every panel open, so a missing param
   * means "put it back", not "return to the primary". */
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
      // Always the active agent's own name, including the default/primary.
      agentName: !isPrimary && selected ? selected.name : primaryName,
      primaryName,
      primaryId,
      isPrimary,
      // Champagne for the primary; the selected agent's chosen hue otherwise.
      activeHue: isPrimary ? null : (selected?.hue ?? null),
      selectAgent: setSelected,
    };
  }, [selected, primaryId, primaryName]);

  return <ActiveAgentContext.Provider value={value}>{children}</ActiveAgentContext.Provider>;
}

export function useActiveAgent(): ActiveAgentApi {
  return useContext(ActiveAgentContext) ?? FALLBACK;
}
