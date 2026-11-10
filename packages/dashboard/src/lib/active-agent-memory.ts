// Which agent the stage is talking to, remembered in `localStorage` per-browser: `sessionStorage` can die
// with a tab mobile Safari discards; the server is never told, so devices don't fight over one "current".

import type { Agent } from '@dojo/shared';

/** The one place this key is spelled. */
export const ACTIVE_AGENT_STORAGE_KEY = 'dojo_active_agent';

export const ACTIVE_AGENT_URL_PARAM = 'agent';

/** Name and hue ride along as a first-paint cache; the provider re-reads both from the server. */
export interface RememberedAgent {
  id: string;
  name: string;
  hue?: number;
}

/** TOTAL by design: this runs in the provider's `useState` initialiser, so a throw here is a white
 *  screen on every load until the user clears site data. Anything unparseable reads as "no selection". */
export function parseRemembered(raw: string | null): RememberedAgent | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.trim() === '') return null;
  return {
    id: v.id,
    name: typeof v.name === 'string' ? v.name : '',
    hue: typeof v.hue === 'number' && Number.isFinite(v.hue) ? v.hue : undefined,
  };
}

export function serializeRemembered(agent: RememberedAgent): string {
  return JSON.stringify({ id: agent.id, name: agent.name, hue: agent.hue });
}

/** Storage failures are swallowed: a private window should cost stickiness, never the app. */
export function rememberAgent(agent: RememberedAgent | null): void {
  try {
    if (agent) localStorage.setItem(ACTIVE_AGENT_STORAGE_KEY, serializeRemembered(agent));
    else localStorage.removeItem(ACTIVE_AGENT_STORAGE_KEY);
  } catch {
  }
}

export function readRememberedAgent(): RememberedAgent | null {
  try {
    return parseRemembered(localStorage.getItem(ACTIVE_AGENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function agentParamOf(search: string): string | null {
  const raw = new URLSearchParams(search).get(ACTIVE_AGENT_URL_PARAM);
  if (raw === null) return null;
  const id = raw.trim();
  return id === '' ? null : id;
}

/** Sets or removes only the agent param; Settings' `tab` and Tracker's `project` must survive. */
export function withAgentParam(search: string, id: string | null): string {
  const params = new URLSearchParams(search);
  if (id) params.set(ACTIVE_AGENT_URL_PARAM, id);
  else params.delete(ACTIVE_AGENT_URL_PARAM);
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
}

/** May a restore land on this agent? The roster's own live-list rule (pages/Agents.tsx): a silent
 *  restore onto an unreachable agent is the broken empty chat; a deliberate History pick still works. */
export function isRestorable(
  agent: Pick<Agent, 'status' | 'agentType'> | null | undefined,
): boolean {
  if (!agent) return false;
  return agent.status !== 'terminated' && agent.agentType !== 'archived';
}

/** THE URL WINS: a link or back button asks for that agent now, the store only says last time;
 *  absence is not the reverse signal (navs drop it), so a bare URL falls through. A claim to verify. */
export function restoreCandidate(
  search: string,
  stored: RememberedAgent | null,
): RememberedAgent | null {
  const fromUrl = agentParamOf(search);
  if (fromUrl) {
    return stored && stored.id === fromUrl ? stored : { id: fromUrl, name: '' };
  }
  return stored;
}
