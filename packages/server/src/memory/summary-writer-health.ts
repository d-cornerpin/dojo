// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 3 (R-V333-10 item 2) — WHICH MODEL MAY WRITE A SUMMARY RIGHT NOW.
//
// MEASURED on the dev box: the resolver picked the cheapest text model, a free remote one, which
// timed out; the next pick answered 402. Nothing remembered either, so every fold picked the same
// unreachable writer again. Two facts now travel with each provider:
//   · its BILLING BREAKER (`providers/billing-breaker.ts`) — open after permanent failures;
//   · round 5: NOT ANSWERING SINCE — its last summary call failed (its transport's patience ran out,
//     empty text, an error), or it did not answer within a turn's patience, and it has not answered
//     since. No clock: the writer's own next answer clears it (owner ruling 2026-10-13, no hard
//     limits — the five-minute bench this replaced kept a writer that was back unused).
// The order: the owner's Settings choice, then the agent's own model and provider, then (only with
// no Settings choice, as before) the cheapest — see `summaryWriterCandidates`. INSIDE A TURN
// (`eligibleSummaryWriters`) that order skips broken writers and those not answering since: the
// owner's turn does not wait on them again. IN THE BACKGROUND (`backgroundSummaryWriters`) it
// skips only broken ones: nobody waits there, and trying the preferred writer is how its return is
// noticed. A call the OWNER stopped, or set aside for the turn's fold, is not the writer's failure.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { writerBreaker } from './compaction-defect.js';

const logger = createLogger('summary-writer-health');

/** The abort reason a fold gives a summary call when the owner pressed Stop. */
export const FOLD_STOPPED_BY_OWNER = 'fold-stopped-by-owner';
/** The turn's patience ran out while the call was still open (round 5: the dialed model's own
 *  declared patience, see `out-of-view-fold.ts`). Not a failure — no card — but the turn will not
 *  wait on that writer again until it answers (`noteDidNotAnswerInTurn`). */
export const FOLD_IN_TURN_LIMIT = 'fold-in-turn-limit';
/** Round 4: a routine background fold was set aside so the turn's own fold could run. */
export const FOLD_PREEMPTED = 'fold-preempted-by-the-turn';
/** Abort reasons that say nothing about the writer. */
const NOT_THE_WRITERS_FAILURE = new Set<unknown>([FOLD_STOPPED_BY_OWNER, FOLD_IN_TURN_LIMIT, FOLD_PREEMPTED]);

/** Providers whose writer has not answered since it last failed or ran past a turn's patience. */
const notAnsweringSince = new Map<string, number>();

function providerKey(modelId: string): string {
  try {
    const row = getDb().prepare('SELECT provider_id FROM models WHERE id = ?').get(modelId) as { provider_id?: string } | undefined;
    return row?.provider_id ?? `model:${modelId}`;
  } catch {
    return `model:${modelId}`;
  }
}

/** Does this abort say anything about the writer? (No for Stop, the in-turn clock, a preemption.) */
export function abortBlamesWriter(signal?: AbortSignal): boolean {
  return !(signal?.aborted && NOT_THE_WRITERS_FAILURE.has(signal.reason));
}

/** Record how a summary call went. Called by `summarize.ts` for every call it makes. */
export function noteSummaryWriterOutcome(modelId: string | undefined, ok: boolean, abortSignal?: AbortSignal): void {
  if (!modelId) return;
  if (!ok && !abortBlamesWriter(abortSignal)) return;
  const key = providerKey(modelId);
  if (ok) {
    if (notAnsweringSince.delete(key)) logger.info('Summary writer answered again; turns use it again', { modelId, providerKey: key });
    return;
  }
  notAnsweringSince.set(key, Date.now());
  logger.warn('Summary writer failed; turns pass it over until it answers again', { modelId, providerKey: key });
}

/** The turn's patience ran out on this writer's call: no failure, but no turn waits on it again
 *  until it has answered (the background keeps trying it). */
export function noteDidNotAnswerInTurn(modelId: string): void {
  const key = providerKey(modelId);
  if (!notAnsweringSince.has(key)) notAnsweringSince.set(key, Date.now());
  logger.info('Summary writer did not answer within the turn\'s patience; turns pass it over until it answers', { modelId, providerKey: key });
}

function notAnswering(modelId: string): boolean {
  return notAnsweringSince.has(providerKey(modelId));
}

/**
 * Every writer a summary of this agent's conversation MAY go to, in order (ruling R-V333-12, round 4:
 * the fallback never sends a conversation to a provider that would not have received it before):
 *   1. the owner's Settings writer, when one is set and usable;
 *   2. the agent's own model, then the other text models on the agent's own provider;
 *   3. ONLY when the owner set no Settings writer — exactly as before t140 — the cheapest text model.
 * An auto-routed agent has no own model: its list is the Settings writer, else the cheapest.
 */
export function summaryWriterCandidates(preferredModelId?: string): string[] {
  const db = getDb();
  const TEXT_FILTER = "m.capabilities NOT LIKE '%generation%' AND m.capabilities NOT LIKE '%embedding%'";
  const usable = db.prepare(
    `SELECT m.id AS id, m.provider_id AS provider FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.is_enabled = 1 AND p.id != '__system__' AND ${TEXT_FILTER}
      ORDER BY COALESCE(m.input_cost_per_m, 0) ASC, m.id ASC`,
  ).all() as Array<{ id: string; provider: string }>;
  const isUsable = (id: string | undefined): id is string => !!id && usable.some((u) => u.id === id);
  const explicitId = (db.prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get() as { value: string } | undefined)?.value;
  const explicit = isUsable(explicitId) ? explicitId : undefined;
  const ownId = preferredModelId && preferredModelId !== 'auto' && preferredModelId !== '__auto__' ? preferredModelId : undefined;
  const own = isUsable(ownId) ? ownId : undefined;
  const ownProvider = usable.find((u) => u.id === own)?.provider;
  const ownProviderModels = ownProvider ? usable.filter((u) => u.provider === ownProvider).map((u) => u.id) : [];
  const list = [
    ...(explicit ? [explicit] : []),
    ...(own ? [own, ...ownProviderModels] : []),
    ...(explicit ? [] : usable.map((u) => u.id)),
  ];
  return [...new Set(list)];
}

/** The writers a TURN may wait on: no open breaker, and answering. */
export function eligibleSummaryWriters(preferredModelId?: string): string[] {
  return summaryWriterCandidates(preferredModelId).filter((id) => !writerBreaker(id) && !notAnswering(id));
}

/** The writers the BACKGROUND tries, in the owner's order: every one without an open breaker. */
export function backgroundSummaryWriters(preferredModelId?: string): string[] {
  return summaryWriterCandidates(preferredModelId).filter((id) => !writerBreaker(id));
}

/** Test-only reset; the map is per-process. */
export function __resetSummaryWriterHealthForTests(): void {
  notAnsweringSince.clear();
}
