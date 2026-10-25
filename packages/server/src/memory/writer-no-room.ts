// ════════════════════════════════════════════════════════════════════════════
// v3.5 (t268 fix round 4, N-B, ORCHESTRATOR RULING) — THE DOJO'S WRITER HAD NO ROOM FOR THIS AGENT'S FALLBACK.
//
// When the small writer, as an agent's fallback, cannot fit even a summary in the memory free at that moment
// (`writer-fallback-room.ts`), it is passed over for that agent (`summary-writer-health.ts writerPassedOver`): nothing
// follows it in the order (fix round 5), so the span waits with its rows kept — never a refusal asked again and
// again. It is tried again when something has changed: a writer that was not answering answers again (the
// agent's own model reachable again), or a person writes to the agent. In memory only: a restart checks once more.
// t268 breaker fix (minor c): memory that cannot be READ (a failed `/api/ps` or `/api/show`) is UNKNOWN, never "all
// free": the writer is passed over the same way, and Ollama answering again lets it be sized again.
// ════════════════════════════════════════════════════════════════════════════

/** Agent → why: the memory free was too small (`false`) or could not be read (`true`). */
const noRoomFor = new Map<string, boolean>();

export const noteWriterHadNoRoom = (agentId: string, unknown = false): void => { noRoomFor.set(agentId, unknown); };
export const writerHadNoRoom = (agentId: string): boolean => noRoomFor.has(agentId);
/** Something changed: for this agent, or (no agent named) for every agent. */
export const writerMayRunAgain = (agentId?: string): void => { if (agentId === undefined) noRoomFor.clear(); else noRoomFor.delete(agentId); };
/** Ollama answered: an agent refused because the memory could not be read may be sized again (`services/ollama.ts`). */
export const freeMemoryMayBeReadable = (): void => { for (const [id, unknown] of noRoomFor) if (unknown) noRoomFor.delete(id); };
