import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as api from '../lib/api';

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
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [primaryName, setPrimaryName] = useState<string>('');
  const [selected, setSelected] = useState<SelectedAgent | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getSetting('primary_agent_id').then((r) => {
      if (!cancelled && r.ok && r.data.value) setPrimaryId(r.data.value);
    });
    api.getSetting('primary_agent_name').then((r) => {
      if (!cancelled && r.ok && r.data.value) setPrimaryName(r.data.value);
    });
    return () => { cancelled = true; };
  }, []);

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
