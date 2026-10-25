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
//     (`noteAPersonSpoke`); a SUMMARY call its provider answers re-arms it for everyone
//     (`noteSummaryWriterOutcome`); the owner changing the Settings writer re-arms it. Not a scheduled
//     turn, a self-wake, a continuation — round 6 re-armed on those, and for every agent at once.
// t207 (D9): the mark is PERSISTED (`healer_state`), so a restart does not forget an unreachable writer;
// and "answered" means a SUMMARY call: round 7's re-arm on any call (a chat turn) is gone.
// The order (`summaryWriterCandidates`): the Settings choice, the agent's own model (an auto agent's: its router's
// pick), the Dojo's writer — nothing after it (t268 round 5). Eligible = that order without broken, not-answering or
// (t268 N-B) no-room ones; none left: the span WAITS (`writer-wait.ts`), rows whole, until one can run — and a call to
// one of its writer models answering re-arms it for that waiting agent (t268 breaker fix). A call the OWNER stopped,
// or cut by the turn's patience, is not the writer's failure.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { writerBreaker } from './compaction-defect.js';
import { contextWindowPolicy, estimateRequestTokens } from './budget.js';
import { measuredDivisorsFor } from '../costs/estimator-divisors.js';
import { isStopFenced } from '../agent/shared-state.js';
import { standardModelRowId } from '../services/local-standard.js';
import { standardTierChain } from '../router/standing-filters.js';
import { writerHadNoRoom, writerMayRunAgain } from './writer-no-room.js';
import { nextMoment, rearmWriters, rearmedSince, noteSpanWaits, endWaitsThatAreOver, __resetWriterWaitForTests } from './writer-wait.js';
import type { SummaryResult } from './summarize.js';

const logger = createLogger('summary-writer-health');

/** The abort reason a fold gives a summary call when the owner pressed Stop. */
export const FOLD_STOPPED_BY_OWNER = 'fold-stopped-by-owner';
/** The turn's patience ran out while the call was still open (round 5: the dialed model's own declared patience,
 *  `out-of-view-fold.ts`). No failure, no card, but no turn waits on that writer again until it answers. */
export const FOLD_IN_TURN_LIMIT = 'fold-in-turn-limit';
/** Abort reasons that say nothing about the writer. Any other abort (a forced pass cut by the turn's patience) still
 *  marks the writer as not answering, so the next turn does not wait on it again (t220: provider-health and log only). */
const NOT_THE_WRITERS_FAILURE = new Set<unknown>([FOLD_STOPPED_BY_OWNER, FOLD_IN_TURN_LIMIT]);

/** Providers whose writer has not answered since it failed or ran past a turn's patience: one `healer_state`
 *  row each, `key` = provider + separator + the Settings writer then (so a Settings change stops it matching). */
const MARK_SCOPE = 'summary_writer_not_answering';
const MARK_SEP = '|';

function settingsWriter(): string | null {
  try {
    return (getDb().prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get() as { value: string } | undefined)?.value ?? null;
  } catch {
    return null;
  }
}
const markKey = (provider: string, settings: string | null): string => `${provider}${MARK_SEP}${settings ?? ''}`;

/** Best effort: a failed write leaves the writer dialled. */
function markNotAnswering(provider: string): void {
  try {
    clearMark(provider);
    getDb().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)')
      .run(MARK_SCOPE, markKey(provider, settingsWriter()), nextMoment());
  } catch (err) {
    logger.warn('could not record that a summary writer is not answering', { providerKey: provider, error: err instanceof Error ? err.message : String(err) });
  }
}
/** Forget the provider's marks, whatever Settings writer they were made under. True when there was one. */
function clearMark(provider: string): boolean {
  try {
    const prefix = `${provider}${MARK_SEP}`;
    return getDb().prepare('DELETE FROM healer_state WHERE scope = ? AND substr(key, 1, ?) = ?')
      .run(MARK_SCOPE, prefix.length, prefix).changes > 0;
  } catch { return false; }
}
/** The ordinal of the provider's live mark (under the CURRENT Settings writer), or null. */
function markOf(provider: string): number | null {
  try {
    const row = getDb().prepare('SELECT at_ms FROM healer_state WHERE scope = ? AND key = ?')
      .get(MARK_SCOPE, markKey(provider, settingsWriter())) as { at_ms: number } | undefined;
    return row ? row.at_ms : null;
  } catch { return null; }
}

function providerKey(modelId: string): string {
  try {
    const row = getDb().prepare('SELECT provider_id FROM models WHERE id = ?').get(modelId) as { provider_id?: string } | undefined;
    return row?.provider_id ?? `model:${modelId}`;
  } catch {
    return `model:${modelId}`;
  }
}

/**
 * t149 F4 — WHAT A WRITER CAN HOLD. The messages a tool-less summary call to `modelId` may carry, beside a system
 * prompt of `systemPromptTokens`: the provider boundary's own budget (`assembly-validation.ts`,
 * `validateAtProviderBoundary`) for that model's window and output cap. A call over it is repaired or refused at the
 * boundary, so the writer is not dialled with it. A model with no declared window is not refused here.
 */
export function summaryRoom(modelId: string, systemPromptTokens = 0): number {
  try {
    // The model's DECLARED window and output cap, exactly as the boundary reads them (read straight
    // off the row: this module must not import the model layer, which imports the compactor).
    const row = getDb().prepare('SELECT context_window, max_output_tokens FROM models WHERE id = ?').get(modelId) as
      { context_window: number | null; max_output_tokens: number | null } | undefined;
    if (!row?.context_window || row.context_window <= 0) return Number.MAX_SAFE_INTEGER;
    const maxOutputTokens = row.max_output_tokens && row.max_output_tokens > 0 ? row.max_output_tokens : undefined;
    const policy = contextWindowPolicy(row.context_window, { toolPayloadTokens: 0, maxOutputTokens });
    return Math.max(0, policy.assemblyBudgetTokens - systemPromptTokens);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * A writer is dialled only with what it can hold. The provider boundary would repair or refuse the
 * call ("11184 against 9853", "against a budget of 0"); the writer is not asked and nothing is
 * recorded against it — `tooBig`: it simply was not the writer for this input. Null when it holds.
 */
export function refuseWhatTheWriterCannotHold(
  modelId: string, systemPrompt: string, content: string, agentId: string,
): SummaryResult | null {
  // The size of the input as the fit gate sizes a request: the constant, or this writer's provider's own
  // measured ratio where it has measured itself (never smaller than the constant's answer).
  const divisors = measuredDivisorsFor(providerKey(modelId));
  const inputTokens = estimateRequestTokens({ proseChars: content.length, schemaChars: 0 }, divisors).tokens;
  if (inputTokens <= summaryRoom(modelId, estimateRequestTokens({ proseChars: systemPrompt.length, schemaChars: 0 }, divisors).tokens)) return null;
  logger.warn('SUMMARY_REFUSED the writer cannot hold this input; it was not dialled', { modelId, inputTokens, agentId });
  return { ok: false, reason: 'the summary writer cannot hold this input', tooBig: true };
}

/**
 * What a settled summary call says about its writer. `stopped`: the owner's Stop cut or refused it
 * (t149 F3) — it reaches the call through the registry (`shared-state.ts`), never through the
 * caller's own abort signal, so nothing is recorded against the writer and the caller, told so,
 * stops walking writers. `tooBig` calls were never dialled; no outcome either.
 */
export function settleSummaryCall(
  result: SummaryResult, agentId: string, modelId: string | undefined, abortSignal?: AbortSignal,
): SummaryResult {
  if (!result.ok && isStopFenced(agentId)) return { ...result, stopped: true };
  if (result.ok || !result.tooBig) noteSummaryWriterOutcome(modelId, result.ok, abortSignal);
  return result;
}

/** Does this abort say anything about the writer? (No for Stop or the fold's in-turn limit.) */
export function abortBlamesWriter(signal?: AbortSignal): boolean {
  return !(signal?.aborted && NOT_THE_WRITERS_FAILURE.has(signal.reason));
}

/** Record how a summary call went. Called by `summarize.ts` for every call it makes. */
export function noteSummaryWriterOutcome(modelId: string | undefined, ok: boolean, abortSignal?: AbortSignal): void {
  if (!modelId) return;
  if (!ok && !abortBlamesWriter(abortSignal)) return;
  const key = providerKey(modelId);
  if (ok) {
    if (clearMark(key)) { writerMayRunAgain(); endWaitsThatAreOver(); logger.info('Summary writer answered again; turns use it again', { modelId, providerKey: key }); }   // t268: and a writer with no room is tried again
    return;
  }
  markNotAnswering(key);
  logger.warn('Summary writer failed; it is passed over until it answers, a person writes, or Settings change', { modelId, providerKey: key });
}

/** The turn's patience ran out on this writer's call: no failure, but no turn waits on it again until something
 *  changes. The mark is minted afresh (t268 re-review 4, N-1): a re-arm bought this one try, and it is spent. */
export function noteDidNotAnswerInTurn(modelId: string): void {
  const key = providerKey(modelId);
  markNotAnswering(key);
  logger.info('Summary writer did not answer within the turn\'s patience; turns pass it over until it answers', { modelId, providerKey: key });
}

/** Not answering, and nothing has changed since — for this agent, when one is named. */
function notAnswering(modelId: string, agentId?: string): boolean {
  const key = providerKey(modelId);
  const at = markOf(key);       // a mark made under another Settings writer is not found: Settings changed
  return at !== null && !(agentId !== undefined && rearmedSince(agentId, key, at));   // a person wrote, or (span waiting) it answered since
}

/**
 * Every writer a summary of this agent's conversation MAY go to, in order — and only these (t268 fix round 5, the
 * owner's law: a fix must not quietly move work onto pricier models):
 *   1. the owner's Settings writer (the Summarization pick), when one is set and usable;
 *   2. the agent's own model (owner 2026-10-24: "The agents model."); an auto-routed agent's is its router's
 *      standard-tier pick, through the router's own order and filters;
 *   3. the Dojo's small local writer — the FALLBACK, when it fits the memory free then (`writer-fallback-room.ts`).
 * None of them can run: nothing is dialled and the span waits, rows whole, until one can.
 */
export function summaryWriterCandidates(preferredModelId?: string, agentId?: string): string[] {
  const db = getDb();
  const TEXT_FILTER = "m.capabilities NOT LIKE '%generation%' AND m.capabilities NOT LIKE '%embedding%' AND m.capabilities NOT LIKE '%decision%'";   // the decision model writes nothing
  const usable = (db.prepare(
    `SELECT m.id AS id, m.provider_id AS provider FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.is_enabled = 1 AND p.id != '__system__' AND ${TEXT_FILTER}
      ORDER BY COALESCE(m.input_cost_per_m, 0) ASC, m.id ASC`,
  ).all() as Array<{ id: string; provider: string }>)
    .filter((u) => summaryRoom(u.id) > 0);   // t149 F4: a window with no budget left (4K, "against a budget of 0") holds no call
  const isUsable = (id: string | undefined): id is string => !!id && usable.some((u) => u.id === id);
  const explicitId = (db.prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get() as { value: string } | undefined)?.value;
  const explicit = isUsable(explicitId) ? explicitId : undefined;
  const fixed = preferredModelId && preferredModelId !== 'auto' && preferredModelId !== '__auto__' ? preferredModelId : undefined;
  const own = fixed ? (isUsable(fixed) ? fixed : undefined) : standardTierChain(agentId).find(isUsable);
  // t268 fix round 5: NOTHING after the small writer (no "cheapest text model", no other model of the agent's provider).
  return [...new Set([explicit, own, standardModelRowId('writer') ?? undefined].filter(isUsable))];
}

/** The writers anything may dial now for `agentId`, turn or background: no open breaker, answering. */
export function eligibleSummaryWriters(preferredModelId?: string, agentId?: string): string[] {
  return summaryWriterCandidates(preferredModelId, agentId).filter((id) => !writerPassedOver(id, agentId));
}

/** t268 fix round 5: does this agent have writers, none of which can run now? Then its span WAITS, rows whole, until
 *  one can: a wait, not a failed pass, so nothing arms the compaction brake for it (no writer at all is a defect). The
 *  wait is recorded (breaker fix), so a writer of its order answering again reaches it (`writer-wait.ts`). */
export function spanWaitsForAWriter(agentId: string): boolean {
  const own = (): string | undefined => (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? undefined;   // read afresh: the owner may change it
  const waits = (): boolean => summaryWriterCandidates(own(), agentId).length > 0 && eligibleSummaryWriters(own(), agentId).length === 0;
  if (!waits()) return false;
  noteSpanWaits(agentId, { stillWaits: waits, writesOn: (p, m) => summaryWriterCandidates(own(), agentId).some((id) => (m ? id === m : providerKey(id) === p)) });
  return true;
}

/** Was this writer passed over — its provider's breaker open, or it has not answered since it failed? */
export function writerPassedOver(modelId: string, agentId?: string): boolean {
  return !!writerBreaker(modelId) || notAnswering(modelId, agentId) || (!!agentId && writerHadNoRoom(agentId) && modelId === standardModelRowId('writer'));
}

/** A person's fresh message started this agent's turn: its failed writers (and a writer with no room) get one more try, for it. */
export function noteAPersonSpoke(agentId: string): void {
  rearmWriters(agentId);
  writerMayRunAgain(agentId);
  endWaitsThatAreOver(agentId);
}

/** Test-only reset: who was last written to, and the marks in the test's own database. */
export function __resetSummaryWriterHealthForTests(): void {
  __resetWriterWaitForTests(); writerMayRunAgain();
  try { getDb().prepare('DELETE FROM healer_state WHERE scope = ?').run(MARK_SCOPE); } catch { /* no database in this test */ }
}
