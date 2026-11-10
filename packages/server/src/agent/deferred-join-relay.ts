// A delegated answer is told to the owner AFTER the delegating turn ends, never during it.
// Mid-turn a relay is noted by join id only; the run's teardown releases it; the join row stays the truth.

const deferred = new Map<string, Map<string, string | undefined>>();

export function deferJoinRelay(agentId: string, joinId: string, senderNameHint?: string): void {
  const forAgent = deferred.get(agentId) ?? new Map<string, string | undefined>();
  forAgent.set(joinId, senderNameHint);
  deferred.set(agentId, forAgent);
}

export function takeDeferredJoinRelays(agentId: string): Array<{ joinId: string; senderNameHint?: string }> {
  const forAgent = deferred.get(agentId);
  if (!forAgent) return [];
  deferred.delete(agentId);
  return [...forAgent].map(([joinId, senderNameHint]) => ({ joinId, senderNameHint }));
}
