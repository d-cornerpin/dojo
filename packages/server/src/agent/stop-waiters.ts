// ════════════════════════════════════════
// t203 (B6) — THE STOP WAITERS: something that WAITS on the owner's stop, as opposed to a
// call the stop ABORTS.
//
// The abort registry (`shared-state.ts`, opened through `abortable-call.ts`) holds calls the
// stop cuts. The executor needs the other thing: to stop WAITING on a tool call the moment the
// owner presses the button, whatever that tool did or did not register. It cannot sit in the
// registry as a controller, and the reason is in `runtime.ts`'s `preemptAgentForUrgentMessage`:
// that door counts the TURN-scoped entries to decide whether a barge-in has anything to cut,
// and an entry per running tool call would make every tool call count — the preempt would burn
// its cool-down and arm `preemptedAgents` over work it was never meant to touch. Nor is it
// `background`: that scope means "outlives the turn" and drives the live-work indicator. So it
// is a separate, plain set, notified by the ONE door that means "the owner pressed stop"
// (`stopAgent`) and by nothing else.
//
// THE SAME RACE `registerAbortable` CLOSES IS CLOSED HERE: a waiter opened while a stop is
// already standing is born stopped. There is no window in which a wait can begin after the
// press and miss it.
// ════════════════════════════════════════

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

/** The owner pressed stop: every wait on this agent ends now. Called by `stopAgent` only. */
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
