// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 3 (R-V333-10 item 2) — WHICH MODEL MAY WRITE A SUMMARY RIGHT NOW.
//
// MEASURED on the dev box: the resolver picked the cheapest text model, a free remote one, which
// timed out; the next pick answered 402. Nothing remembered either, so every fold picked the same
// unreachable writer again. Two facts now travel with each provider:
//   · its BILLING BREAKER (`providers/billing-breaker.ts`) — open after permanent failures;
//   · NOT ANSWERING — its last summary call failed (its transport's patience ran out, empty text, an
//     error), or it did not answer within a turn's patience. No clock (owner ruling 2026-10-13, no
//     hard limits). Round 6 (final review I1, R-V333-15): it is not dialled again — by a turn OR by
//     the background — until something has CHANGED: a person starts a new turn (`noteAPersonSpoke`),
//     the owner picks another writer in Settings (a writer never marked is simply eligible), or the
//     writer answers. Round 5 let the background try every writer on every gate; with writers
//     answering empty that paid all of them on every tool-loop iteration (40 calls where v3.3.2 made 4).
// The order: the owner's Settings choice, then the agent's own model and provider, then (only with
// no Settings choice, as before) the cheapest — see `summaryWriterCandidates`. The eligible writers
// are that order without broken or not-answering ones; when none is left, nothing is dialled and
// placeholder notes stay, labelled. A call the OWNER stopped, or set aside for the turn's fold, is
// not the writer's failure.
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

/** The writers anything may dial now, turn or background: no open breaker, and answering. */
export function eligibleSummaryWriters(preferredModelId?: string): string[] {
  return summaryWriterCandidates(preferredModelId).filter((id) => !writerBreaker(id) && !notAnswering(id));
}

/** A person has started a new turn: something has changed, so every writer gets one more try. */
export function noteAPersonSpoke(): void {
  if (notAnsweringSince.size === 0) return;
  notAnsweringSince.clear();
  logger.info('A person started a new turn: summary writers that were not answering are tried again');
}

/** Test-only reset; the map is per-process. */
export function __resetSummaryWriterHealthForTests(): void {
  notAnsweringSince.clear();
}
