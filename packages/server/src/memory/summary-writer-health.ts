// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 3 (R-V333-10 item 2) — WHICH MODEL MAY WRITE A SUMMARY RIGHT NOW.
//
// MEASURED on the dev box: the resolver picked the cheapest text model, a free remote one, which
// timed out; the next pick answered 402. Nothing remembered either, so every fold picked the same
// unreachable writer again. Two facts now travel with each provider:
//   · its BILLING BREAKER (`providers/billing-breaker.ts`) — open after permanent failures;
//   · a short COOL-DOWN — any failed summary call (timeout, empty text, an error) on that provider
//     in the last few minutes. A writer that answers clears it at once.
// The order: the owner's Settings choice, then the agent's own model and provider, then (only with
// no Settings choice, as before) the cheapest — see `summaryWriterCandidates`. The eligible writers
// are that order with the broken and cooling ones removed. A call the OWNER stopped, cut by the
// turn's own clock, or set aside for the turn's fold is not the writer's failure and is never
// recorded against it; a timeout at the background replacement's longer bound is.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { writerBreaker } from './compaction-defect.js';

const logger = createLogger('summary-writer-health');

/** How long a provider whose summary call failed is passed over. Long enough that one turn's fold
 *  does not dial it again; short enough that a provider back from a bad minute is used again soon. */
export const WRITER_COOLDOWN_MS = 5 * 60_000;

/** The abort reason a fold gives a summary call when the owner pressed Stop. */
export const FOLD_STOPPED_BY_OWNER = 'fold-stopped-by-owner';
/** Round 4 (re-review 3 F4): the door's IN-TURN clock cut the call. A writer merely slower than
 *  that is not failing — the background replacement gives it the longer bound. */
export const FOLD_IN_TURN_LIMIT = 'fold-in-turn-limit';
/** Round 4: a routine background fold was set aside so the turn's own fold could run. */
export const FOLD_PREEMPTED = 'fold-preempted-by-the-turn';
/** Abort reasons that say nothing about the writer. */
const NOT_THE_WRITERS_FAILURE = new Set<unknown>([FOLD_STOPPED_BY_OWNER, FOLD_IN_TURN_LIMIT, FOLD_PREEMPTED]);

const failedAt = new Map<string, number>();

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
    failedAt.delete(key);
    return;
  }
  failedAt.set(key, Date.now());
  logger.warn('Summary writer failed; its provider is passed over for a few minutes', { modelId, providerKey: key, cooldownMs: WRITER_COOLDOWN_MS });
}

function coolingDown(modelId: string): boolean {
  const at = failedAt.get(providerKey(modelId));
  return at !== undefined && Date.now() - at < WRITER_COOLDOWN_MS;
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

/** The candidates a summary may be written by NOW: no open breaker, not cooling down. */
export function eligibleSummaryWriters(preferredModelId?: string): string[] {
  return summaryWriterCandidates(preferredModelId).filter((id) => !writerBreaker(id) && !coolingDown(id));
}

/** Test-only reset; the map is per-process. */
export function __resetSummaryWriterHealthForTests(): void {
  failedAt.clear();
}
