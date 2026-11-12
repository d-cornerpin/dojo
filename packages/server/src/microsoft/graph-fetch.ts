// The Graph byte door for calls that must not add activity rows, outbound records or broadcasts.
// Each gets the agent's stop and a finite clock. Owns GRAPH_BASE.

import { openAgentCall, STOPPED_BY_USER } from '../agent/abortable-call.js';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export const GRAPH_TIMEOUT_MS = 60_000;

/** One Graph call under this agent's stop (agentId is undefined for plumbing, which registers nobody).
 *  A stop throws STOPPED_BY_USER, judged on this call's own controller, never from a deadline. */
export async function graphFetch(
  agentId: string | undefined, url: string, init: RequestInit = {},
): Promise<Response> {
  const clock = init.signal ?? AbortSignal.timeout(GRAPH_TIMEOUT_MS);
  const slot = agentId === undefined ? null : openAgentCall(agentId, 'turn', clock);
  if (slot?.refused) {
    slot.release();
    throw new Error(STOPPED_BY_USER);
  }
  try {
    return await fetch(url, {
      ...init,
      signal: slot?.signal ?? clock,
    });
  } catch (err) {
    if (slot?.cutByStop()) throw new Error(STOPPED_BY_USER);
    throw err;
  } finally {
    slot?.release();
  }
}
