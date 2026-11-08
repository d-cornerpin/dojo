// Every summary (`generateSummary` is its one door) is checked by the decision model before it is kept: does it state anything as pending or owed?
//   pass        kept as written;
//   fail        rewritten once with the failure named, then checked again;
//   fail again  not kept: the rows stay whole and a later pass tries again;
//   no answer   kept, recorded `unavailable`: the check never blocks compaction.
// No owner card is sent on any outcome, and a failed check is not the writer being unreachable.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { Question } from '../agent/decide.js';
import { isYes, onTheModel } from '../agent/decision-policy.js';
import type { SummaryResult } from './summarize.js';
import { decisionWindowTokens } from '../services/dojo-working-memory.js';
import { sourceParts, checkPart } from './summary-check-parts.js';
import { MEASURED_CHARS_PER_TOKEN } from '../services/token-density.js';
import { createHash } from 'node:crypto';
import { clearOn, markWaiting, ownModel, waiting } from './writer.js';

export type SummaryParams = { content: string; agentId: string; modelId?: string; checkFeedback?: string; spanIds?: readonly string[]; spanOpen?: boolean };

const logger = createLogger('summary-check');

const ON_THE_MODEL = 'summary_check/stated_current';
const QUESTIONS: Record<string, Question> = { stated_current: { type: 'noul', instructions: 'Does `summary` describe anything as currently pending or owed?' } };
/** What the rewrite is told (the writer's own words for the input: "the input"). */
const FEEDBACK = 'it described something as currently pending or owed';
/** How long the check's records are kept. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/** The model's probability that the summary states something pending (the highest over the source's parts), or
 *  null when any part went unanswered. */
export async function checkSummary(sourceRows: string, summary: string, agentId: string): Promise<number | null> {
  const parts = sourceParts(sourceRows, summary, await decisionWindowTokens(), QUESTIONS, MEASURED_CHARS_PER_TOKEN);
  if (parts === null) {
    logger.warn('summary_check_unavailable the summary alone is larger than the decision model\'s window; it is kept unchecked', { summaryChars: summary.length }, agentId);
    return null;
  }
  // One part after another, each with its own clock: the local Ollama answers one request at a time.
  let highest = 0;
  for (const [i, part] of parts.entries()) {
    const a = await checkPart(part, parts.length === 1 ? null : `${i + 1} of ${parts.length}`, summary, QUESTIONS, agentId);
    if (!a?.stated_current) return null;
    highest = Math.max(highest, a.stated_current.noul);
  }
  return highest;
}

type Outcome = 'ok' | 'rewritten_ok' | 'not_kept' | 'unavailable';

function record(agentId: string, writer: string, outcome: Outcome, statedCurrent: number | null): void {
  try {
    const db = getDb();
    const now = Date.now();
    db.prepare('DELETE FROM summary_checks WHERE created_at < ?').run(now - KEEP_MS);
    db.prepare(`INSERT INTO summary_checks (agent_id, writer_model_id, outcome, stated_current, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(agentId, writer, outcome, statedCurrent, now);
  } catch (err) {
    logger.warn('could not record a summary check', { error: err instanceof Error ? err.message : String(err) }, agentId);
  }
}

/** The flow between "written" and "kept". `rewrite(feedback)` writes the same input again with the failure named. */
export async function keepOnlyIfChecked(
  source: string, written: Extract<SummaryResult, { ok: true }>, agentId: string, writer: string,
  rewrite: (feedback: string) => Promise<SummaryResult>,
): Promise<SummaryResult> {
  if (!onTheModel(ON_THE_MODEL)) return written;
  const first = await checkSummary(source, written.text, agentId);
  if (first === null || !isYes(first)) { record(agentId, writer, first === null ? 'unavailable' : 'ok', first); return written; }

  const again = await rewrite(FEEDBACK);
  if (!again.ok) return again;   // the writer itself refused: its own outcome, recorded by its own door
  const second = await checkSummary(source, again.text, agentId);
  if (second === null || !isYes(second)) { record(agentId, writer, second === null ? 'unavailable' : 'rewritten_ok', second); return again; }

  record(agentId, writer, 'not_kept', second);
  logger.warn('summary_check_failed the summary was not kept; the rows stay whole for a later pass', { writer, statedCurrent: second }, agentId);
  // A verdict on this span, not a writer that stopped answering: no caller walks it on to another writer, and its rows
  // wait (`check-failed`) until the span closes with new rows in it or the agent's own model changes.
  return { ok: false, reason: 'the summary failed the accuracy check twice; the rows stay whole', checkFailed: true };
}

/** Did a summary of this agent's fail its check (and stay unwritten) since `sinceMs`? The fold's writer walk asks. */
export function summaryCheckRefusedSince(agentId: string, sinceMs: number): boolean {
  try {
    return !!getDb().prepare("SELECT 1 FROM summary_checks WHERE agent_id = ? AND outcome = 'not_kept' AND created_at >= ?").get(agentId, sinceMs);
  } catch { return false; }
}

/** The span's rows as wait keys (or its content when no rows are named). */
const rowKeys = (p: SummaryParams): string[] => p.spanIds && p.spanIds.length > 0
  ? [...p.spanIds] : [`content:${createHash('sha256').update(p.content).digest('hex').slice(0, 32)}`];

/** `generateSummary`'s body: write (settled), then keep only what passes. A span whose rows failed their check is held
 *  while it is the same rows, or while it is still open (the last chunk of a fold, which gains a row on every pass). */
export async function writeThenCheck<P extends SummaryParams>(params: P, write: (p: P) => Promise<SummaryResult>): Promise<SummaryResult> {
  const own = params.modelId ? ownModel(params.agentId) ?? '' : '';
  const keys = params.modelId ? rowKeys(params) : [];
  const failed = keys.filter((k) => waiting(params.agentId, own, k) === 'check-failed').length;
  if (keys.length > 0 && onTheModel(ON_THE_MODEL) && (failed === keys.length || (params.spanOpen === true && failed > 0))) {
    return { ok: false, checkFailed: true, reason: 'this span failed its accuracy check; it is left as it is until the agent\'s model changes or it closes with new rows' };
  }
  const written = await write(params);
  if (!written.ok || !params.modelId) return written;
  const kept = await keepOnlyIfChecked(params.content, written, params.agentId, params.modelId, (checkFeedback) => write({ ...params, checkFeedback }));
  if (!kept.ok && kept.checkFailed) for (const k of keys) markWaiting(params.agentId, own, k, 'check-failed');
  else if (kept.ok) clearOn({ kind: 'span-written', agentId: params.agentId, spanKeys: keys });
  return kept;
}

/** The Healer report's running numbers over the kept window, or null when nothing was checked. */
export function summaryCheckLine(): string | null {
  try {
    const r = getDb().prepare(`SELECT COUNT(*) AS n, SUM(outcome = 'ok') AS ok, SUM(outcome = 'rewritten_ok') AS rw,
      SUM(outcome = 'not_kept') AS failed, SUM(outcome = 'unavailable') AS un FROM summary_checks`).get() as
      { n: number; ok: number | null; rw: number | null; failed: number | null; un: number | null };
    if (r.n === 0) return null;
    return `Summary check (kept window): ${r.n} checked, ${r.ok ?? 0} kept as written, ${r.rw ?? 0} kept after one rewrite, `
      + `${r.failed ?? 0} left the rows whole, ${r.un ?? 0} unchecked (decision model unavailable).`;
  } catch { return null; }
}

/** What the writer's system prompt gains on the one rewrite (empty otherwise). */
export function rewriteInstruction(checkFeedback?: string): string {
  return checkFeedback
    ? `\n\nYOUR PREVIOUS SUMMARY OF THIS SAME INPUT FAILED AN ACCURACY CHECK: ${checkFeedback}. Write it again from the input alone.`
    : '';
}
