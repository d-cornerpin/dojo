// THE STOP WAITERS: waits ON the owner's stop, not calls the stop aborts. Only `stopAgent` notifies
// them; a wait opened while a stop stands is born stopped. Not the abort registry: the barge-in
// counts turn-scoped entries, so a tool-call entry burns its cool-down; and not `background` (live-work).

import { isStopFenced } from './shared-state.js';

const stopWaiters = new Map<string, Set<() => void>>();

/** A wait on this agent's stop. `stopped` settles when the owner presses it; `dispose` on every exit. */
export interface StopWait {
  readonly stopped: Promise<void>;
  /** A stop was already standing when this opened. `stopped` is already settled. */
  readonly already: boolean;
  dispose(): void;
}

export function untilUserStop(agentId: string): StopWait {
  if (isStopFenced(agentId)) return { stopped: Promise.resolve(), already: true, dispose: () => undefined };
  let fire!: () => void;
  const stopped = new Promise<void>((resolve) => { fire = resolve; });
  let set = stopWaiters.get(agentId);
  if (!set) { set = new Set(); stopWaiters.set(agentId, set); }
  set.add(fire);
  return {
    stopped,
    already: false,
    dispose: () => {
      const live = stopWaiters.get(agentId);
      if (!live) return;
      live.delete(fire);
      if (live.size === 0) stopWaiters.delete(agentId);
    },
  };
}

export function notifyUserStop(agentId: string): number {
  const set = stopWaiters.get(agentId);
  if (!set) return 0;
  stopWaiters.delete(agentId);
  for (const fire of set) fire();
  return set.size;
}

/** How many waits are open on this agent's stop. For the tests' no-leak clause. */
export function stopWaiterCount(agentId: string): number {
  return stopWaiters.get(agentId)?.size ?? 0;
}
