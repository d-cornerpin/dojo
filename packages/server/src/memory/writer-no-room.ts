// ════════════════════════════════════════════════════════════════════════════
// v3.5 (t268 fix round 4, N-B, ORCHESTRATOR RULING) — THE DOJO'S WRITER HAD NO ROOM FOR THIS AGENT'S FALLBACK.
//
// When the small writer, as an agent's fallback, cannot fit even a summary in the memory free at that moment
// (`writer-fallback-room.ts`), it is passed over for that agent (`summary-writer-health.ts writerPassedOver`): the
// span goes to the next writer in the order, or, with none, waits with its rows kept — never a refusal asked again
// and again. It is tried again when something has changed: a writer that was not answering answers again (the
// agent's own model reachable again), or a person writes to the agent. In memory only: a restart checks once more.
// ════════════════════════════════════════════════════════════════════════════

const noRoomFor = new Set<string>();

export const noteWriterHadNoRoom = (agentId: string): void => { noRoomFor.add(agentId); };
export const writerHadNoRoom = (agentId: string): boolean => noRoomFor.has(agentId);
/** Something changed: for this agent, or (no agent named) for every agent. */
export const writerMayRunAgain = (agentId?: string): void => { if (agentId === undefined) noRoomFor.clear(); else noRoomFor.delete(agentId); };
