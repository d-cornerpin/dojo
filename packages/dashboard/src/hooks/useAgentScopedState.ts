import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/*
 * STATE THAT BELONGS TO AN AGENT (GitHub #14).
 *
 * The chat and the composer are mounted once for the whole shell while the agent under them
 * changes, so plain `useState` there is state that outlives its agent: a busy agent's
 * "working" latches rode over to an idle one, a slow answer for the old agent landed under
 * the new one, an unsent draft and its attached files followed you to the wrong agent.
 *
 * `useAgentState(agentId, initial)` is `useState` whose value is FOR that agent:
 *   - when the agent changes you read a fresh `initial`, in the same render (no frame of the
 *     old agent's value under the new one, and no reset list to keep in step);
 *   - a setter belongs to the agent it was created for. A write from a closure of an agent
 *     that is no longer showing is dropped, which is the cancel token for every async path
 *     (a load, a send) at once.
 *
 * `remember: true` is for an owner's UNSENT work (draft, staged files): each agent keeps its
 * own value, a switch shows the other agent's, and a write from a closure of an agent that
 * is parked lands in that agent's slot (a send that finishes after you switched still clears
 * the draft it sent).
 */
export function useAgentState<T>(
  agentId: string,
  initial: T | (() => T),
  remember = false,
): [T, Dispatch<SetStateAction<T>>] {
  const initialRef = useRef(initial);
  const slots = useRef(new Map<string, T>());
  const shown = useRef(agentId);
  const [, bump] = useState(0);
  const readRef = useRef<(id: string) => T>(() => undefined as T);

  // The agent changed: drop the last one's value (or park it, when remembering) before reading.
  if (shown.current !== agentId) {
    if (!remember) slots.current.clear();
    shown.current = agentId;
  }
  // A slot is filled once, so an untouched value keeps one identity across renders.
  const read = (id: string): T => {
    if (!slots.current.has(id)) {
      const i = initialRef.current;
      slots.current.set(id, typeof i === 'function' ? (i as () => T)() : i);
    }
    return slots.current.get(id) as T;
  };
  readRef.current = read;
  const value = read(agentId);

  const set = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    if (!remember && shown.current !== agentId) return;
    const prev = readRef.current(agentId);
    const next = typeof action === 'function' ? (action as (p: T) => T)(prev) : action;
    if (Object.is(next, prev)) return;
    slots.current.set(agentId, next);
    if (shown.current === agentId) bump((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, remember]);

  return [value, set];
}
