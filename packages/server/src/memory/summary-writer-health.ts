// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 3 (R-V333-10 item 2) — WHICH MODEL MAY WRITE A SUMMARY RIGHT NOW.
//
// MEASURED on the dev box: the resolver picked the cheapest text model, a free remote one, which
// timed out; the next pick answered 402. Nothing remembered either, so every fold picked the same
// unreachable writer again. Two facts now travel with each provider:
//   · its BILLING BREAKER (`providers/billing-breaker.ts`) — open after permanent failures;
//   · a short COOL-DOWN — any failed summary call (timeout, empty text, an error) on that provider
//     in the last few minutes. A writer that answers clears it at once.
// The order is unchanged — the owner's Settings choice first, then the caller's own model, then
// the cheapest — and the eligible writers are that order with the broken and cooling ones removed.
// A call the OWNER stopped is not the writer's failure and is never recorded against it.
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

const failedAt = new Map<string, number>();

function providerKey(modelId: string): string {
  try {
    const row = getDb().prepare('SELECT provider_id FROM models WHERE id = ?').get(modelId) as { provider_id?: string } | undefined;
    return row?.provider_id ?? `model:${modelId}`;
  } catch {
    return `model:${modelId}`;
  }
}

/** Record how a summary call went. Called by `summarize.ts` for every call it makes. */
export function noteSummaryWriterOutcome(modelId: string | undefined, ok: boolean, abortSignal?: AbortSignal): void {
  if (!modelId) return;
  if (!ok && abortSignal?.aborted && abortSignal.reason === FOLD_STOPPED_BY_OWNER) return;
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

/** Every text-capable writer, in the resolver's order: Settings choice, caller's model, then cheapest. */
export function summaryWriterCandidates(preferredModelId?: string): string[] {
  const db = getDb();
  const TEXT_FILTER = "m.capabilities NOT LIKE '%generation%' AND m.capabilities NOT LIKE '%embedding%'";
  const usable = (db.prepare(
    `SELECT m.id AS id FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.is_enabled = 1 AND p.id != '__system__' AND ${TEXT_FILTER}
      ORDER BY COALESCE(m.input_cost_per_m, 0) ASC, m.id ASC`,
  ).all() as Array<{ id: string }>).map((r) => r.id);
  const explicit = (db.prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get() as { value: string } | undefined)?.value;
  const preferred = preferredModelId && preferredModelId !== 'auto' && preferredModelId !== '__auto__' ? preferredModelId : undefined;
  const head = [explicit, preferred].filter((id): id is string => !!id && usable.includes(id));
  return [...new Set([...head, ...usable])];
}

/** The candidates a summary may be written by NOW: no open breaker, not cooling down. */
export function eligibleSummaryWriters(preferredModelId?: string): string[] {
  return summaryWriterCandidates(preferredModelId).filter((id) => !writerBreaker(id) && !coolingDown(id));
}

/** Test-only reset; the map is per-process. */
export function __resetSummaryWriterHealthForTests(): void {
  failedAt.clear();
}
