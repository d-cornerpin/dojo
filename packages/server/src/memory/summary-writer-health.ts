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
//     the background — until something has CHANGED. Round 7 (re-review I1') named the changes
//     exactly: a person's FRESH message to an agent re-arms it for THAT agent only
//     (`noteAPersonSpoke`); its provider answering any call re-arms it for everyone
//     (`noteProviderAnswered`); the owner changing the Settings writer re-arms it. Not a scheduled
//     turn, a self-wake, a continuation — round 6 re-armed on those, and for every agent at once.
// The order: the owner's Settings choice, then the agent's own model and provider, then (only with
// no Settings choice, as before) the cheapest — see `summaryWriterCandidates`. The eligible writers
// are that order without broken or not-answering ones; when none is left, nothing is dialled and
// placeholder notes stay, labelled. A call the OWNER stopped, or cut by the turn's patience, is not
// the writer's failure.
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
/** Abort reasons that say nothing about the writer. */
const NOT_THE_WRITERS_FAILURE = new Set<unknown>([FOLD_STOPPED_BY_OWNER, FOLD_IN_TURN_LIMIT]);

/** Providers whose writer has not answered since it last failed or ran past a turn's patience. */
/** Providers not answering: the moment (an ordinal) they failed, and the Settings writer then. */
const notAnsweringSince = new Map<string, { at: number; settingsWriter: string | null }>();
/** Per agent: the moment (same ordinal) a person last wrote to it. */
const personSpokeAt = new Map<string, number>();
/** An ordinal, not a clock: "a person spoke after the writer failed" must be exact, never a tie. */
let moment = 0;

function settingsWriter(): string | null {
  try {
    return (getDb().prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get() as { value: string } | undefined)?.value ?? null;
  } catch {
    return null;
  }
}
function markNotAnswering(key: string): void {
  notAnsweringSince.set(key, { at: ++moment, settingsWriter: settingsWriter() });
}

function providerKey(modelId: string): string {
  try {
    const row = getDb().prepare('SELECT provider_id FROM models WHERE id = ?').get(modelId) as { provider_id?: string } | undefined;
    return row?.provider_id ?? `model:${modelId}`;
  } catch {
    return `model:${modelId}`;
  }
}

/** Does this abort say anything about the writer? (No for Stop or the turn's patience.) */
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
  markNotAnswering(key);
  logger.warn('Summary writer failed; it is passed over until it answers, a person writes, or Settings change', { modelId, providerKey: key });
}

/** The turn's patience ran out on this writer's call: no failure, but no turn waits on it again
 *  until it has answered (the background keeps trying it). */
export function noteDidNotAnswerInTurn(modelId: string): void {
  const key = providerKey(modelId);
  if (!notAnsweringSince.has(key)) markNotAnswering(key);
  logger.info('Summary writer did not answer within the turn\'s patience; turns pass it over until it answers', { modelId, providerKey: key });
}

/** Not answering, and nothing has changed since — for this agent, when one is named. */
function notAnswering(modelId: string, agentId?: string): boolean {
  const mark = notAnsweringSince.get(providerKey(modelId));
  if (!mark) return false;
  if (mark.settingsWriter !== settingsWriter()) return false;                        // Settings changed
  if (agentId !== undefined && (personSpokeAt.get(agentId) ?? 0) > mark.at) return false;   // a person wrote to it since
  return true;
}

/** The writer's provider answered a call (any call): it is back, for every agent. */
export function noteProviderAnswered(modelId: string): void {
  const key = providerKey(modelId);
  if (notAnsweringSince.delete(key)) logger.info('A summary writer\'s provider answered a call; it is used again', { modelId, providerKey: key });
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

/** The writers anything may dial now for `agentId`, turn or background: no open breaker, answering. */
export function eligibleSummaryWriters(preferredModelId?: string, agentId?: string): string[] {
  return summaryWriterCandidates(preferredModelId).filter((id) => !writerBreaker(id) && !notAnswering(id, agentId));
}

/** A person's fresh message started this agent's turn: its failed writers get one more try, for it. */
export function noteAPersonSpoke(agentId: string): void {
  personSpokeAt.set(agentId, ++moment);
}

/** Test-only reset; the map is per-process. */
export function __resetSummaryWriterHealthForTests(): void {
  notAnsweringSince.clear();
  personSpokeAt.clear();
}
