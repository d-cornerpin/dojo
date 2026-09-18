// ════════════════════════════════════════
// WHICH AGENT THE STAGE IS TALKING TO, REMEMBERED ACROSS A RELOAD (T78b).
//
// ── WHY THE BROWSER AND NOT THE SERVER ──
// The active agent is a VIEW PREFERENCE OF THIS DEVICE, not a fact about the
// account. The owner reads one agent's thread on the iPhone while the desktop
// sits on another; an account-level "current agent" would have those two fight
// each other over a websocket, and every extra tab would be a third voice. So
// the memory is per-browser and the server is never told.
//
// ── WHY `localStorage` AND NOT `sessionStorage` ──
// The case that actually annoys the owner is the phone: mobile Safari discards a
// backgrounded page's process to reclaim memory, and on return it reloads the tab
// from scratch. `sessionStorage` is scoped to that page's session and can go with
// it; `localStorage` is the only web store that is still there afterwards. The
// desktop F5 case would pass on either, which is exactly how a half-fix ships.
//
// ── WHAT IS STORED, AND WHY IT IS MORE THAN AN ID ──
// The name and hue ride along so the very FIRST paint after a reload is already
// the right agent — wordmark, orb tint, composer placeholder — instead of showing
// "DOJO" for the round trip it takes to look the agent up. They are a cache, not
// the truth: `ActiveAgentProvider` re-reads both from the server and overwrites
// them, so a rename or a colour change lands on the next load.
// ════════════════════════════════════════

import type { Agent } from '@dojo/shared';

/** The one place this key is spelled. */
export const ACTIVE_AGENT_STORAGE_KEY = 'dojo_active_agent';

/** The query param that carries the same choice in a link. */
export const ACTIVE_AGENT_URL_PARAM = 'agent';

/** The selection as the browser remembers it between loads. */
export interface RememberedAgent {
  id: string;
  /** Display name at the time of storing — a first-paint cache, re-verified on load. */
  name: string;
  /** Orb hue at the time of storing, absent for an agent with no chosen colour. */
  hue?: number;
}

/**
 * Read a stored selection back.
 *
 * TOTAL, and deliberately so: this runs inside the provider's `useState`
 * initialiser, i.e. during the first render of the whole app. A throw there is a
 * white screen on every single load until the user clears their site data, which
 * is a far worse failure than the one this feature fixes. Anything unparseable,
 * unrecognisable or half-written reads as "no selection".
 */
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

/** Persist (or clear) the selection. Storage failures are swallowed: a private
 *  window or a full quota should cost the user stickiness, never the app. */
export function rememberAgent(agent: RememberedAgent | null): void {
  try {
    if (agent) localStorage.setItem(ACTIVE_AGENT_STORAGE_KEY, serializeRemembered(agent));
    else localStorage.removeItem(ACTIVE_AGENT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** The selection the browser last stored, if any. */
export function readRememberedAgent(): RememberedAgent | null {
  try {
    return parseRemembered(localStorage.getItem(ACTIVE_AGENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** The agent id a query string names, or null. Blank counts as null. */
export function agentParamOf(search: string): string | null {
  const raw = new URLSearchParams(search).get(ACTIVE_AGENT_URL_PARAM);
  if (raw === null) return null;
  const id = raw.trim();
  return id === '' ? null : id;
}

/**
 * The same query string with the agent param set (or removed), every OTHER param
 * left exactly where it was — Settings owns `tab`/`section`, Tracker owns
 * `project`, and this must not be the thing that eats them.
 */
export function withAgentParam(search: string, id: string | null): string {
  const params = new URLSearchParams(search);
  if (id) params.set(ACTIVE_AGENT_URL_PARAM, id);
  else params.delete(ACTIVE_AGENT_URL_PARAM);
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
}

/**
 * May a restore land on this agent?
 *
 * The rule is not invented here — it is the one the Agents roster already draws
 * its live list with (`status !== 'terminated' && agentType !== 'archived'`,
 * pages/Agents.tsx). An agent the user cannot find in the roster is one whose
 * chat can never answer, so restoring onto it is the broken-empty-chat this
 * feature must never produce. A DELIBERATE pick of an ended agent from the
 * History section still works; it is only the silent restore that is refused.
 */
export function isRestorable(
  agent: Pick<Agent, 'status' | 'agentType'> | null | undefined,
): boolean {
  if (!agent) return false;
  return agent.status !== 'terminated' && agent.agentType !== 'archived';
}

/**
 * What to show on this load, from the two places a choice can come from.
 *
 * THE URL WINS when it names an agent: a link, a bookmark or the back button is
 * the user asking for that agent in THIS request, where the store only says what
 * they did last time. ABSENCE of the param is not a signal in the other
 * direction — most in-app navigations (`navigate('/settings?tab=x')`) drop the
 * query string entirely — so a bare URL falls through to the store.
 *
 * The answer is a CLAIM. `ActiveAgentProvider` checks it against the server
 * before trusting it.
 */
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
