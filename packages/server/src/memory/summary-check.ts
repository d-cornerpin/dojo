// ════════════════════════════════════════════════════════════════════════════
// v3.5 B4 — EVERY SUMMARY IS CHECKED AGAINST ITS SOURCE BEFORE IT IS KEPT.
//
// OWNER RULING 2026-10-20: "Check each summary against the decision model. If there are significant
// summarization failures on a dojo, the user is encouraged to change the summarization model to
// another larger model." Whoever writes it, the decision model reads the summary against the rows it
// summarizes (`generateSummary`, the one door every summary comes through), and:
//   pass                → kept as written;
//   fail                → rewritten ONCE with the failed questions named, then checked again;
//   fail again          → NOT kept: the caller leaves the rows whole and a later pass tries again
//                         (every caller already treats a refusal that way); logged with its numbers;
//   no answer           → kept, logged `unavailable` — the check never blocks compaction.
// A failed check is not the writer being unreachable: nothing here marks the writer passed over.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { decide, type Answer, type Question } from '../agent/decide.js';
import { scoreQuestion, SHADOW_REPORT_WINDOW_MS } from '../agent/decision-shadow.js';
import type { SummaryResult } from './summarize.js';

const logger = createLogger('summary-check');

export interface SummaryCheck { ok: boolean; invented: number; dropped: number; statedCurrent: number; answers: Record<string, Answer> | null }

const PURPOSE = 'summary_check';
const QUESTIONS: Record<'invented' | 'dropped' | 'stated_current', Question> = {
  invented: { type: 'noul', instructions: 'Does `summary` state anything that `source_rows` does not say?' },
  dropped: { type: 'noul', instructions: 'Does `summary` leave out a request, decision, instruction or name that `source_rows` contains?' },
  stated_current: { type: 'noul', instructions: 'Does `summary` describe anything as currently pending or owed?' },
};
/** What the rewrite is told, per failed question (the writer's own words for the input: "the input"). */
const FEEDBACK: Record<keyof typeof QUESTIONS, string> = {
  invented: 'it stated something the input does not say',
  dropped: 'it left out a request, decision, instruction or name the input contains',
  stated_current: 'it described something as currently pending or owed',
};

/**
 * Where a probability starts to mean "yes" for this question: the bottom of the band the shadow score
 * measured as the model's least reliable (B2), and until there is a measured band, 0.5 — the model's
 * own yes/no line, the same line the score reads a verdict at.
 */
function failsAt(question: string): number {
  return scoreQuestion(PURPOSE, question)?.band[0] ?? 0.5;
}

/**
 * Three noul questions over { source_rows, summary }. `ok` when every probability is below its
 * question's line. When decide() returns null, `answers` is null and `ok` is true (never blocks).
 */
export async function checkSummary(sourceRows: string, summary: string, agentId: string, timeoutMs?: number): Promise<SummaryCheck> {
  const answers = await decide({ source_rows: sourceRows, summary }, QUESTIONS, { purpose: PURPOSE, agentId, timeoutMs });
  const p = (q: keyof typeof QUESTIONS): number => (answers?.[q]?.type === 'noul' ? (answers[q] as { noul: number }).noul : 0);
  const [invented, dropped, statedCurrent] = [p('invented'), p('dropped'), p('stated_current')];
  const ok = !answers || (invented < failsAt('invented') && dropped < failsAt('dropped') && statedCurrent < failsAt('stated_current'));
  return { ok, invented, dropped, statedCurrent, answers };
}

function failedFeedback(c: SummaryCheck): string {
  const failed: string[] = [];
  if (c.invented >= failsAt('invented')) failed.push(FEEDBACK.invented);
  if (c.dropped >= failsAt('dropped')) failed.push(FEEDBACK.dropped);
  if (c.statedCurrent >= failsAt('stated_current')) failed.push(FEEDBACK.stated_current);
  return failed.join('; ');
}

type Outcome = 'ok' | 'rewritten_ok' | 'not_kept' | 'unavailable';

function record(agentId: string, writer: string, outcome: Outcome, c: SummaryCheck | null): void {
  try {
    const db = getDb();
    const now = Date.now();
    // The decision shadow's keep policy: the report window and the one before it.
    db.prepare('DELETE FROM summary_checks WHERE created_at < ?').run(now - 2 * SHADOW_REPORT_WINDOW_MS);
    db.prepare(`INSERT INTO summary_checks (agent_id, writer_model_id, outcome, invented, dropped, stated_current, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(agentId, writer, outcome, c?.answers ? c.invented : null, c?.answers ? c.dropped : null, c?.answers ? c.statedCurrent : null, now);
  } catch (err) {
    logger.warn('could not record a summary check', { error: err instanceof Error ? err.message : String(err) }, agentId);
  }
}

export const SUMMARY_CHECK_NOTICE_CODE = 'SUMMARY_CHECK_FAILING';
const NOTICED_KEY = 'summary_check_noticed_writer';

/**
 * The owner is told once per writer model, by the existing `chat:error` card, when a summary this
 * writer wrote failed its check even after the rewrite (the real signal: two attempts at the same
 * span were wrong). The mark re-arms when the writer changes, or when this writer's failures have
 * aged out of the kept window (they stopped).
 */
function noticeIfFailing(agentId: string, writer: string): void {
  try {
    const db = getDb();
    const row = db.prepare("SELECT SUM(outcome = 'not_kept') AS failed, COUNT(*) AS total FROM summary_checks WHERE writer_model_id = ? AND outcome != 'unavailable'")
      .get(writer) as { failed: number | null; total: number };
    const failed = row.failed ?? 0;
    const noticed = (db.prepare('SELECT value FROM config WHERE key = ?').get(NOTICED_KEY) as { value: string } | undefined)?.value;
    if (failed === 0) {
      if (noticed === writer) db.prepare('DELETE FROM config WHERE key = ?').run(NOTICED_KEY);
      return;
    }
    if (noticed === writer) return;
    db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(NOTICED_KEY, writer);
    broadcast({
      type: 'chat:error',
      agentId,
      error: `This box's memory summaries keep failing the accuracy check (${failed} of the last ${row.total}). `
        + "The small writer may be too small for this box's conversations; pick a larger model under Settings → Models → Summarization Model.",
      code: SUMMARY_CHECK_NOTICE_CODE,
      severity: 'warning',
      retryable: false,
    });
  } catch { /* a notice is a courtesy; never break the summary it rides on */ }
}

/**
 * The flow between "written" and "kept". `written` is an ok result; `rewrite(feedback)` writes the same
 * input again with the failed questions named. `checkTimeoutMs` is how long the writer took on this
 * input: the check reads the same input once, so it is given that long.
 */
export async function keepOnlyIfChecked(
  source: string, written: Extract<SummaryResult, { ok: true }>, agentId: string, writer: string,
  rewrite: (feedback: string) => Promise<SummaryResult>, checkTimeoutMs?: number,
): Promise<SummaryResult> {
  const first = await checkSummary(source, written.text, agentId, checkTimeoutMs);
  if (!first.answers) { record(agentId, writer, 'unavailable', null); return written; }
  if (first.ok) { record(agentId, writer, 'ok', first); noticeIfFailing(agentId, writer); return written; }

  const again = await rewrite(failedFeedback(first));
  if (!again.ok) return again;   // the writer itself refused: its own outcome, recorded by its own door
  const second = await checkSummary(source, again.text, agentId, checkTimeoutMs);
  if (!second.answers) { record(agentId, writer, 'unavailable', null); return again; }
  if (second.ok) { record(agentId, writer, 'rewritten_ok', second); noticeIfFailing(agentId, writer); return again; }

  record(agentId, writer, 'not_kept', second);
  logger.warn('summary_check_failed the summary was not kept; the rows stay whole for a later pass', {
    writer, invented: second.invented, dropped: second.dropped, statedCurrent: second.statedCurrent,
  }, agentId);
  noticeIfFailing(agentId, writer);
  return { ok: false, reason: 'the summary failed the accuracy check twice; the rows stay whole' };
}

type SummaryParams = { content: string; agentId: string; modelId?: string; checkFeedback?: string };

/** `generateSummary`'s body: write (settled), then keep only what passes. `write` is the settled writer call. */
export async function writeThenCheck<P extends SummaryParams>(params: P, write: (p: P) => Promise<SummaryResult>): Promise<SummaryResult> {
  const started = Date.now();
  const written = await write(params);
  if (!written.ok || !params.modelId) return written;
  return keepOnlyIfChecked(params.content, written, params.agentId, params.modelId,
    (checkFeedback) => write({ ...params, checkFeedback }), Date.now() - started);
}

/** What the writer's system prompt gains on the one rewrite (empty otherwise). */
export function rewriteInstruction(checkFeedback?: string): string {
  return checkFeedback
    ? `\n\nYOUR PREVIOUS SUMMARY OF THIS SAME INPUT FAILED AN ACCURACY CHECK: ${checkFeedback}. Write it again from the input alone.`
    : '';
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
