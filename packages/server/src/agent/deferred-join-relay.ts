// t163 — A DELEGATED ANSWER IS TOLD TO THE OWNER AFTER THE TURN THAT DELEGATED IT, NEVER DURING IT.
//
// MEASURED (Run 9, S3): the helper answered while the delegating turn was still running. The
// transport relayed "Heard back from …" at once, and the turn's own reply — written before the
// answer landed ("nothing back from it yet") — was persisted one second AFTER it, so the owner
// read a stale line under the answer. The relay's job is to reach the owner; its ORDER is not
// the transport's to decide while the agent is still speaking.
//
// So a single-piece relay that arrives while the delegating agent has a turn in flight is only
// NOTED here, by join id, and the runtime's teardown (`handleMessage`'s `finally`, which runs on
// every exit including a throw) releases it the moment the turn is over. No timer: the release
// point is the existing after-run path the wakeup already uses. The join row is untouched in
// between — still complete, still the ledger's truth — so a process that dies with this map in
// memory loses nothing: the boot re-drain (`resolveJoinsAtBoot`) and the join reaper both find a
// complete, unsettled join and relay it, exactly as they do for any other.

const deferred = new Map<string, Map<string, string | undefined>>();

/** Note that this join's relay is waiting for the agent's running turn to end. */
export function deferJoinRelay(agentId: string, joinId: string, senderNameHint?: string): void {
  const forAgent = deferred.get(agentId) ?? new Map<string, string | undefined>();
  forAgent.set(joinId, senderNameHint);
  deferred.set(agentId, forAgent);
}

/** Hand back (and forget) every relay waiting on this agent's turn. */
export function takeDeferredJoinRelays(agentId: string): Array<{ joinId: string; senderNameHint?: string }> {
  const forAgent = deferred.get(agentId);
  if (!forAgent) return [];
  deferred.delete(agentId);
  return [...forAgent].map(([joinId, senderNameHint]) => ({ joinId, senderNameHint }));
}
