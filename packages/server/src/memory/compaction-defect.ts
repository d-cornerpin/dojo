// ════════════════════════════════════════════════════════════════════════════
// WHEN COMPACTION DOES NOT WORK, SOMEBODY IS TOLD (OR-COMPACT-1, parts 2 and 3)
//
// The owner, 2026-10-02: *"If compaction fails for a different reason, that is something
// that needs to be repaired."* So there are exactly two audiences for a compaction that
// ended over budget with nothing to show, and this file is both of them:
//
//   · WHOEVER REPAIRS THE PLATFORM gets a structured line at ERROR level naming WHICH
//     STAGE refused and the numbers it refused with. One per pass, never silent. That is
//     the whole of part 3, and it replaces the user-facing dead end part 2 deleted.
//   · THE OWNER gets a card ONLY when the reason is one they can act on — the model that
//     writes summaries is down or is answering with nothing usable. `retryable: true`,
//     because it is: fix the model and compaction resumes with no manual step.
//
// ⚠ ONE OUTAGE, ONE CARD. The provider breaker already cards a 402/401/403 by name
// (`QUOTA_EXHAUSTED`: *"Provider X is out of balance… Top up that account or switch this
// agent to another provider"*) — which is exactly "compaction is failing for a repairable
// reason", said better and said first. So when that breaker is open this file stays quiet
// and logs that it deferred. Stacking a second toast on one outage is how an owner learns
// to ignore toasts, which is the finding t87 was written for.
//
// ⚠ AND WHAT IS *NOT* CARDED. "Nothing left to condense", "every summary is at the floor",
// "the run hit its bound" — those are platform defects, reported in the log for repair. The
// card that used to exist for them told the owner to archive their conversation or reset
// their agent, and the owner abolished it. A person must never be asked to destroy memory
// because the engine ran out of ideas.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getDb } from '../db/connection.js';
import { providerBreaker, type OpenBreaker } from '../providers/billing-breaker.js';

const logger = createLogger('compaction-defect');

/** What a pass reported when it ended over budget with nothing to show. */
export interface CompactionFailure {
  stage: string;
  detail: string | null;
  since: string;
}

/** What the caller knows about the pass it just ran. All optional: a caller that only
 *  wants the anti-thrash brake passes nothing and behaves exactly as it did before. */
export interface CompactionPassFacts {
  /** The stage `condense-until-fits.ts` named as refusing, when one did. */
  stage?: string | null;
  detail?: string | null;
  assembledTokens?: number;
  budgetTokens?: number;
  tokensBefore?: number;
  /** What this agent's summaries cost, and what the assembler will admit of them — the pair
   *  the condenser actually works on (the gate's total above cannot see summary bloat). */
  summaryTokens?: number;
  admittedSummaryTokens?: number;
  compactableRows?: number;
  topLevelSummaries?: number;
  /** The summary-WRITER model, so a writer-caused failure can name and clear itself. */
  modelId?: string;
}

const failures = new Map<string, CompactionFailure>();

/** The stages the owner can repair. Everything else is the platform's own bug. */
const REPAIRABLE_BY_THE_OWNER = new Set([
  'summary_writer_unavailable', 'summariser_refused', 'summariser_threw',
  // review I3: no enabled model can write a summary at all, so compaction cannot even start.
  'summary_writer_unresolvable',
]);

/** The breaker on a summary-writer model's provider, read WITHOUT logging — the brake asks
 *  this on every braked turn, and a warn per turn is the toast spam, in the log. */
export function writerBreaker(modelId: string | null | undefined): OpenBreaker | null {
  if (!modelId) return null;
  try {
    const row = getDb().prepare('SELECT provider_id FROM models WHERE id = ?').get(modelId) as { provider_id?: string } | undefined;
    return row?.provider_id ? providerBreaker(row.provider_id) : null;
  } catch {
    return null;
  }
}

/** The card the owner gets, and the only compaction card that is left. It names the
 *  repairable reason, promises the recovery is automatic, and instructs nothing
 *  destructive — no archiving, no resetting, no "your memory is full". */
export function compactionFailingCardText(stage: string): string {
  const why = stage === 'summary_writer_unresolvable'
    ? 'no enabled model can write its summaries'
    : stage === 'summary_writer_unavailable'
      ? 'the model that writes its summaries is not answering'
      : 'the model that writes its summaries returned nothing usable';
  return `This agent's memory compaction is failing — ${why}. `
    + 'It keeps answering, and compaction resumes by itself as soon as a model can write them. '
    + 'Check the compaction model in Settings → Models, or point this agent at a provider that is answering.';
}

/**
 * THE DEFECT LINE (D3), and the card decision behind it.
 *
 * Logs every time it is called — a pass that failed is a pass worth a line. Records the note
 * and cards at most once per outage, and never while the provider breaker is already carding
 * the same outage.
 *
 * ⚠ WHICH SPACER IS WHICH, CORRECTED — t91 re-review M-b, and the sentence this file and
 * `compaction.ts:596` both got wrong. This said "the brake is what keeps that from being
 * per-turn", and `compaction.ts`'s own `!resolved` branch said "the brake spaces the card".
 * NEITHER IS TRUE OF THAT BRANCH: it returns `NO_COMPACTION` before `runCheckAndCompact`
 * reaches its `compactionIsBraked` check, so a pass that dies on an unresolvable summary
 * writer never consults the brake at all. What is actually true, and what the clause holds:
 *   · THE CARD is spaced by the once-per-outage `failures` map below — for EVERY stage,
 *     brake or no brake, and stronger than the brake (one card per outage, not per window).
 *   · THE LINE is per failing pass, deliberately: it is the repair audience's record, not the
 *     owner's toast, and gating it on the brake would silence the box that needs repairing.
 *     On a mis-set box that is one line per forced pass, which is the intended volume.
 * `compaction-has-no-bottom.test.ts` §6 drives three forced passes and asserts ONE card and
 * THREE lines, so neither sentence can rot back into the other.
 *
 * Returns the note when THIS call created it, so the caller can tell a new failure from a
 * continuing one.
 */
export function reportCompactionDefect(
  agentId: string, stage: string, facts: CompactionPassFacts | undefined,
  result: { leafCreated: number; condensedCreated: number; tokensReclaimed: number },
): CompactionFailure | null {
  const breaker = writerBreaker(facts?.modelId);
  logger.error('COMPACTION_DEFECT a pass ended over budget having reclaimed nothing', {
    stage, detail: facts?.detail ?? null,
    assembledTokens: facts?.assembledTokens ?? null, budgetTokens: facts?.budgetTokens ?? null,
    tokensBefore: facts?.tokensBefore ?? null, tokensReclaimed: result.tokensReclaimed,
    leafCreated: result.leafCreated, condensedCreated: result.condensedCreated,
    summaryTokens: facts?.summaryTokens ?? null, admittedSummaryTokens: facts?.admittedSummaryTokens ?? null,
    compactableRows: facts?.compactableRows ?? null, topLevelSummaries: facts?.topLevelSummaries ?? null,
    summaryWriterModelId: facts?.modelId ?? null, providerBreakerOpen: breaker?.reason ?? null,
    repairableByTheOwner: REPAIRABLE_BY_THE_OWNER.has(stage),
  }, agentId);
  if (failures.has(agentId)) return null;   // one note, one card, per outage
  const note: CompactionFailure = { stage, detail: facts?.detail ?? null, since: new Date().toISOString() };
  failures.set(agentId, note);
  if (!REPAIRABLE_BY_THE_OWNER.has(stage)) return note;
  if (breaker) {
    logger.info('Compaction failure card suppressed: the provider breaker already told the owner', {
      stage, providerId: breaker.providerId, reason: breaker.reason,
    }, agentId);
    return note;
  }
  try {
    broadcast({
      type: 'chat:error',
      agentId,
      error: compactionFailingCardText(stage),
      code: 'COMPACTION_FAILING',
      severity: 'error',
      // TRUE, and the difference between this card and the one it replaces: fix the model
      // and compaction resumes on its own. Nothing here asks the owner to destroy memory.
      retryable: true,
    });
  } catch { /* best effort — the defect line is the fix, the card is the courtesy */ }
  return note;
}

/** A pass worked. Forget the failure, and say out loud that nothing had to be clicked. */
export function noteCompactionRecovered(agentId: string, tokensReclaimed: number): void {
  const was = failures.get(agentId);
  if (!was) return;
  failures.delete(agentId);
  logger.info('Compaction is working again — this pass reclaimed memory, and nothing had to be clicked', {
    wasFailingAt: was.stage, failingSince: was.since, tokensReclaimed,
  }, agentId);
}

/** Drop the note without a recovery claim — a reset gave the agent a fresh start. */
export function clearCompactionFailure(agentId: string): boolean {
  return failures.delete(agentId);
}

/** The stage compaction is currently failing at, or null when it is not failing. */
export function compactionFailureReason(agentId: string): string | null {
  return failures.get(agentId)?.stage ?? null;
}

/** Test-only reset; the map is per-process. */
export function __resetCompactionFailuresForTests(): void {
  failures.clear();
}
