import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/** useState scoped to agentId: a switch reads the new agent's fresh initial in the same render,
 *  a stale agent's closure write is dropped. remember:true keeps unsent work per agent, so a
 *  parked agent's late write lands in its own slot instead of being dropped. */
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

  // The agent changed: the last one's value is dropped (or parked, when remembering).
  if (shown.current !== agentId) {
    if (!remember) slots.current.clear();
    shown.current = agentId;
  }
  // A slot is filled once: an untouched value keeps one identity across renders.
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
