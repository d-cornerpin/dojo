// ════════════════════════════════════════════════════════════════════════════
// v3.5 (t268 breaker fix, ORCHESTRATOR RULING after re-review 3) — A SPAN WAITING FOR A WRITER, AND THE ONE EVENT
// THAT ENDS THE WAIT.
//
// When none of an agent's summary writers can run (the Summarization pick, its own model, the small writer if it
// fits: `summary-writer-health.ts`), its span WAITS, rows whole. Before this file nothing ended the wait but a person
// writing: a forced pass armed no brake, so the full-context park woke at once into the same wall (the 1,216-wakes
// shape, I-1), and nothing ever retried a writer marked not answering (I-2).
//
// "Waiting for a writer" is its own park condition (`agent/v2/full-context-wait.ts`), and its ONE wake is a real
// signal that a writer of the agent's order can run again. Never an immediate wake, never a clock of ours:
//   · a successful call to one of its writer models, by any agent (`recordProviderSuccess`, which every successful
//     model call reaches, `agent/model.ts`): its provider is re-armed FOR THAT WAITING AGENT only. An agent whose span
//     does not wait is not re-armed by a chat answer (t207: a model that answers chat and times out on summaries is
//     not re-dialled after every turn). A summary call is not this signal: its own outcome says whether it wrote
//     (`noteSummaryWriterOutcome`), so two waiting agents can never wake each other with empty answers;
//   · the re-test of a writer nobody is calling. No server-side mechanism re-tests a model nobody calls, so it rides
//     the EXISTING provider health check at its existing cadence (no clock of ours): `GET /api/system/providers/health`
//     (`gateway/routes/services.ts`), polled by the dashboard's Health page every `HEALTH_POLL_INTERVAL_MS`
//     (`dashboard/src/pages/Health.tsx`, FA-DB2). A cloud provider's row there re-tests its waiting writers; an
//     Ollama row runs `checkOllamaHealth` (`services/ollama.ts`), whose answer is the signal for that Ollama;
//   · a summary answering (a mark cleared for everyone) or a person writing to the agent (`noteAPersonSpoke`).
// The agent's ordinary work is not parked on the writer: a turn that still assembles runs; only the over-budget
// forced pass parks here, and the owner is told once through the existing compaction card.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';

const logger = createLogger('writer-wait');

/** An ordinal, not a duration: never repeats, never goes backwards, expires nothing. It starts from the wall clock so
 *  one minted before a restart is smaller than one minted after it (the not-answering marks are minted from it). */
let moment = 0;
export const nextMoment = (): number => (moment = Math.max(moment + 1, Date.now()));

/** `<agent>`: a person wrote to it (every writer re-armed for it); `<agent>|<provider>`: that provider answered while its span waited. */
const rearmedAt = new Map<string, number>();
const SEP = '|';
export function rearmWriters(agentId: string, providerKey?: string): void {
  rearmedAt.set(providerKey === undefined ? agentId : `${agentId}${SEP}${providerKey}`, nextMoment());
}
/** Was this agent's writer on `providerKey` re-armed after the mark made at `at`? */
export function rearmedSince(agentId: string, providerKey: string, at: number): boolean {
  return Math.max(rearmedAt.get(agentId) ?? 0, rearmedAt.get(`${agentId}${SEP}${providerKey}`) ?? 0) > at;
}

interface Waiter {
  /** Does the span still wait (no writer of its order can run)? */
  stillWaits: () => boolean;
  /** Is a writer of its order on this provider (and, when named, this very model)? */
  writesOn: (providerKey: string, modelId?: string) => boolean;
  wake: Promise<void>;
  end: () => void;
}
const waiters = new Map<string, Waiter>();

/** The span of `agentId` waits for a writer (asked where a pass finds none can run). One wait per agent. */
export function noteSpanWaits(agentId: string, how: Pick<Waiter, 'stillWaits' | 'writesOn'>): void {
  if (waiters.has(agentId)) return;
  let end = (): void => {};
  const wake = new Promise<void>((resolve) => { end = resolve; });
  waiters.set(agentId, { ...how, wake, end });
}

/** What a park waiting for a writer waits on: that wait ending. Already over (nothing waits): now. */
export function whenAWriterCanRun(agentId: string): Promise<void> {
  return waiters.get(agentId)?.wake ?? Promise.resolve();
}

/** End every wait whose writer can run again (or this agent's only). Each ends once: its park's one wake. */
export function endWaitsThatAreOver(agentId?: string): void {
  for (const [id, w] of waiters) {
    if (agentId !== undefined && id !== agentId) continue;
    if (w.stillWaits()) continue;
    waiters.delete(id);
    logger.info('A summary writer of this agent can run again: its span stops waiting', {}, id);
    w.end();
  }
}

/**
 * THE SIGNAL: a call to `modelId` on `providerKey` answered (or, with no model, that provider answered its health
 * check). Every agent whose span waits on a writer there gets that provider re-armed, for it; a wait that is over
 * ends. A summary call (`purpose` 'memory_summarize') is not this signal (header).
 */
export function writersMayBeBack(providerKey: string, call?: { modelId?: string; purpose?: string }): void {
  if (call?.purpose === 'memory_summarize' || waiters.size === 0) return;
  for (const [id, w] of waiters) if (w.writesOn(providerKey, call?.modelId)) rearmWriters(id, providerKey);
  endWaitsThatAreOver();
}

/** Test-only reset. */
export function __resetWriterWaitForTests(): void {
  rearmedAt.clear();
  waiters.clear();
}
