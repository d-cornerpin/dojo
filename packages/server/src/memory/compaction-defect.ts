// A compaction that ends over budget with nothing to show is told to two audiences. Whoever repairs the
// platform gets one ERROR line per pass naming the refusing stage and its numbers. The owner gets a card ONLY
// when the reason is theirs to fix (the summary writer model is down or unusable), once per outage; when the
// provider breaker is open it already cards that outage, so this file stays quiet. Platform defects (a pass
// that won nothing over budget) are logged, never carded.

import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getDb } from '../db/connection.js';
import { writerBreaker } from './writer.js';

const logger = createLogger('compaction-defect');

export interface CompactionFailure {
  stage: string;
  detail: string | null;
  since: string;
}

export interface CompactionPassFacts {
  stage?: string | null;
  detail?: string | null;
  assembledTokens?: number;
  budgetTokens?: number;
  tokensBefore?: number;
  /** What the summaries cost and what the assembler admits of them (the gate total cannot see summary bloat). */
  summaryTokens?: number;
  admittedSummaryTokens?: number;
  compactableRows?: number;
  /** The summary-WRITER model, so a writer-caused failure can name and clear itself. */
  modelId?: string;
  /** No writer of the agent's order could run, so the span waits: still told, never braked. */
  waiting?: boolean;
}

const failures = new Map<string, CompactionFailure>();

/** One card per incident: a new outage within this long of the last card is recorded and logged but not
 *  carded again, so a flaky writer cannot card repeatedly. */
export const CARD_QUIET_AFTER_MS = 60 * 60_000;
const lastCardAt = new Map<string, number>();

const REPAIRABLE_BY_THE_OWNER = new Set([
  'summary_writer_unavailable', 'summariser_refused', 'summariser_threw',
  'summary_writer_unresolvable',
]);

/** The card text: a short fact naming the agent and its own model, asking the owner to change nothing because
 *  it retries by itself. Nothing destructive; informational (a warning frame), never red. */
export function compactionFailingCardText(stage: string, agentId?: string): string {
  let name = 'This agent';
  try {
    if (agentId) name = (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string | null } | undefined)?.name || name;
  } catch { /* the generic name */ }
  const what = stage === 'summary_writer_unresolvable'
    ? `${name} has no model that can write a memory summary right now`
    : stage === 'summary_writer_unavailable'
      ? `${name}'s own model is not answering for a memory summary`
      : `${name}'s own model returned nothing usable for a memory summary`;
  return `${what}; it retries by itself. Older messages are kept whole until then.`;
}

/**
 * The defect line and the card decision. Logs once per failing pass (the repair audience's record, never gated
 * on the brake). Records the note and cards at most once per outage, never while the provider breaker already
 * cards the same outage. Returns the note when THIS call created it, so the caller can tell a new failure
 * from a continuing one. */
export function reportCompactionDefect(
  agentId: string, stage: string, facts: CompactionPassFacts | undefined,
  result: { leafCreated: number; condensedCreated: number; tokensReclaimed: number },
): CompactionFailure | null {
  const breaker = writerBreaker(facts?.modelId);
  // A pass waiting for a writer is one outage however many passes meet it: error once, then debug.
  (facts?.waiting && failures.has(agentId) ? logger.debug : logger.error)('COMPACTION_DEFECT a pass ended over budget having reclaimed nothing', {
    stage, detail: facts?.detail ?? null,
    assembledTokens: facts?.assembledTokens ?? null, budgetTokens: facts?.budgetTokens ?? null,
    tokensBefore: facts?.tokensBefore ?? null, tokensReclaimed: result.tokensReclaimed,
    leafCreated: result.leafCreated, condensedCreated: result.condensedCreated,
    summaryTokens: facts?.summaryTokens ?? null, admittedSummaryTokens: facts?.admittedSummaryTokens ?? null,
    compactableRows: facts?.compactableRows ?? null,
    summaryWriterModelId: facts?.modelId ?? null, providerBreakerOpen: breaker?.reason ?? null,
    repairableByTheOwner: REPAIRABLE_BY_THE_OWNER.has(stage),
  }, agentId);
  if (failures.has(agentId)) return null;   // one note, one card, per outage
  const note: CompactionFailure = { stage, detail: facts?.detail ?? null, since: new Date().toISOString() };
  failures.set(agentId, note);
  // The work is not moving, whatever the stage, so the catch-up glyph ends.
  void import('./out-of-view.js').then((m) => m.withdrawCatchUpProgress(agentId),   // loaded late: the door imports the compactor
    (err: unknown) => logger.warn('The catch-up glyph could not be withdrawn', { error: err instanceof Error ? err.message : String(err) }, agentId));
  if (!REPAIRABLE_BY_THE_OWNER.has(stage)) return note;
  if (breaker) {
    logger.info('Compaction failure card suppressed: the provider breaker already told the owner', {
      stage, providerId: breaker.providerId, reason: breaker.reason,
    }, agentId);
    return note;
  }
  const carded = lastCardAt.get(agentId);
  if (carded !== undefined && Date.now() - carded < CARD_QUIET_AFTER_MS) {
    logger.info('Compaction failure card not repeated: the owner was told about this agent within the hour', {
      stage, lastCardAt: new Date(carded).toISOString(),
    }, agentId);
    return note;
  }
  lastCardAt.set(agentId, Date.now());
  try {
    broadcast({
      type: 'chat:error', cardClass: 'informational',
      agentId,
      error: compactionFailingCardText(stage, agentId),
      code: 'COMPACTION_FAILING',
      severity: 'warning',   // informational: the owner has nothing to do
      retryable: true,
    });
  } catch { /* best effort: the defect line is the fix, the card is the courtesy */ }
  return note;
}

export function noteCompactionRecovered(agentId: string, tokensReclaimed: number): void {
  const was = failures.get(agentId);
  if (!was) return;
  failures.delete(agentId);
  logger.info('Compaction is working again — this pass reclaimed memory, and nothing had to be clicked', {
    wasFailingAt: was.stage, failingSince: was.since, tokensReclaimed,
  }, agentId);
}

export function clearCompactionFailure(agentId: string): boolean {
  lastCardAt.delete(agentId);   // a reset is a fresh start for the card too
  return failures.delete(agentId);
}

export function compactionFailureReason(agentId: string): string | null {
  return failures.get(agentId)?.stage ?? null;
}

export function __resetCompactionFailuresForTests(): void {
  failures.clear();
  lastCardAt.clear();
}
