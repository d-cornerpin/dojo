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
import { recordShadow, SHADOW_REPORT_WINDOW_MS } from '../agent/decision-shadow.js';
import { randomUUID } from 'node:crypto';
import type { SummaryResult } from './summarize.js';
import { decisionWindowTokens } from '../services/dojo-working-memory.js';
import { sourceParts, combineParts } from './summary-check-parts.js';

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
 * THE PASS MARK (fix round 1, I-B4-3): a summary fails a question when the model's probability is at or
 * above it. With no recorded data it is 0.5, the binary decision boundary: a noul answer is P(yes), so
 * p ≥ 0.5 is exactly "the model holds yes at least as likely as no" — the same line the shadow score
 * reads a verdict at. With recorded summary_check rows whose truth is known, it is the cut that agrees
 * with the most of them: the candidates are the midpoints between neighbouring recorded probabilities,
 * 0.5, and the midpoint above the highest; a cut at or below the lowest recorded probability (one that
 * fails every summary) is never a candidate; a tie goes to the cut nearest 0.5.
 */
export function passMark(question: string): number {
  let rows: Array<{ model_said: string; truth: string }> = [];
  try {
    rows = getDb().prepare(`SELECT model_said, truth FROM decision_shadow WHERE purpose = ? AND question = ?
      AND truth IS NOT NULL AND model_said IS NOT NULL`).all(PURPOSE, question) as typeof rows;
  } catch { return 0.5; }
  const points = rows.flatMap((r) => {
    try { const a = JSON.parse(r.model_said) as Answer; return a.type === 'noul' ? [{ p: a.noul, bad: r.truth === 'true' }] : []; } catch { return []; }
  });
  if (points.length === 0) return 0.5;
  const ps = [...new Set(points.map((x) => x.p))].sort((a, b) => a - b);
  const candidates = [0.5, (ps[ps.length - 1] + 1) / 2, ...ps.slice(1).map((p, i) => (ps[i] + p) / 2)].filter((t) => t > ps[0]);
  const agree = (t: number): number => points.filter((x) => (x.p >= t) === x.bad).length;
  if (candidates.length === 0) return 0.5;   // every recorded probability is 1.0: nothing to cut between (N6)
  return candidates.reduce((best, t) => {
    const d = agree(t) - agree(best);
    return d > 0 || (d === 0 && Math.abs(t - 0.5) < Math.abs(best - 0.5)) ? t : best;
  });
}
const failsAt = passMark;

/**
 * Three noul questions over { source_rows, summary }. `ok` when every probability is below its
 * question's line. When decide() returns null, `answers` is null and `ok` is true (never blocks).
 */
export async function checkSummary(sourceRows: string, summary: string, agentId: string, timeoutMs?: number): Promise<SummaryCheck> {
  const parts = sourceParts(sourceRows, summary, await decisionWindowTokens(), JSON.stringify(QUESTIONS).length);
  let answers: Record<string, Answer> | null;
  if (parts === null) {
    logger.warn('summary_check_unavailable the summary alone is larger than the decision model\'s window; it is kept unchecked', { summaryChars: summary.length }, agentId);
    answers = null;
  } else if (parts.length === 1) {
    answers = await decide({ source_rows: sourceRows, summary }, QUESTIONS, { purpose: PURPOSE, agentId, timeoutMs });
  } else {
    // One part after another through decide()'s normal path, each with its own clock (fix round 5, NB4-6): the
    // local Ollama answers one request at a time, so parts dialled together would spend their clocks queued.
    const each: Array<Record<string, Answer> | null> = [];
    for (const [i, part] of parts.entries()) {
      each.push(await decide({ source_rows: part, summary, source_part: `${i + 1} of ${parts.length}` }, QUESTIONS, { purpose: PURPOSE, agentId, timeoutMs }));
    }
    answers = combineParts(each);
  }
  const p = (q: keyof typeof QUESTIONS): number => (answers?.[q]?.type === 'noul' ? (answers[q] as { noul: number }).noul : 0);
  const [invented, dropped, statedCurrent] = [p('invented'), p('dropped'), p('stated_current')];
  const ok = !answers || (invented < failsAt('invented') && dropped < failsAt('dropped') && statedCurrent < failsAt('stated_current'));
  // Every answered check joins the shadow log (the rule today keeps every summary: `false`), under a check
  // id a later truth source can join to, so the pass mark can be calibrated from what really happened.
  if (answers) {
    const checkId = `summary-check:${randomUUID()}`;
    for (const q of Object.keys(QUESTIONS)) recordShadow({ purpose: PURPOSE, question: q, agentId, turnId: checkId, ruleSaid: false, modelSaid: answers[q] ?? null });
  }
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
/** One latch PER WRITER MODEL (fix round 1, I-B4-2): `summary_check_noticed.<writer id>`. */
const noticedKey = (writer: string): string => `summary_check_noticed.${writer}`;

/**
 * The owner is told once per writer model, by the existing `chat:error` card, when this writer KEEPS failing
 * its check (`writerFailing`, fix round 4: a failure that repeats; one isolated failure is not it). The mark
 * re-arms when the writer changes, or when this writer's failures have aged out of the kept window (they stopped).
 */
function noticeIfFailing(agentId: string, writer: string): void {
  try {
    const db = getDb();
    const row = writerFailing(writer);
    const failed = row.failed;
    const noticed = !!db.prepare('SELECT 1 FROM config WHERE key = ?').get(noticedKey(writer));
    if (failed === 0) {
      if (noticed) db.prepare('DELETE FROM config WHERE key = ?').run(noticedKey(writer));
      return;
    }
    if (noticed || !row.failing) return;
    db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(noticedKey(writer), writer);
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
  // `checkFailed`: a verdict on this span, not a writer that stopped answering — no caller walks it on to
  // another writer (never the agent's own paid model); the span is left as it is this time (I-B4-1).
  return { ok: false, reason: 'the summary failed the accuracy check twice; the rows stay whole', checkFailed: true };
}

/** Did a summary of this agent's fail its check (and stay unwritten) since `sinceMs`? The fold's writer walk asks. */
export function summaryCheckRefusedSince(agentId: string, sinceMs: number): boolean {
  try {
    return !!getDb().prepare("SELECT 1 FROM summary_checks WHERE agent_id = ? AND outcome = 'not_kept' AND created_at >= ?").get(agentId, sinceMs);
  } catch { return false; }
}

import { spanKeys, spanRefused, recordRefusedSpan, clearRefusedSpan, writerFailing, type SummaryParams } from './summary-check-ledger.js';

/** `generateSummary`'s body: write (settled), then keep only what passes. `write` is the settled writer call. */
export async function writeThenCheck<P extends SummaryParams>(params: P, write: (p: P) => Promise<SummaryResult>): Promise<SummaryResult> {
  const keys = params.modelId ? spanKeys(params) : [];
  if (keys.length > 0 && spanRefused(keys)) {
    return { ok: false, checkFailed: true, reason: 'this span failed its accuracy check; it is left as it is until the summary writer changes or new rows join it' };
  }
  const started = Date.now();
  const written = await write(params);
  if (!written.ok || !params.modelId) return written;
  const kept = await keepOnlyIfChecked(params.content, written, params.agentId, params.modelId,
    (checkFeedback) => write({ ...params, checkFeedback }), Date.now() - started);
  if (!kept.ok && kept.checkFailed) recordRefusedSpan(keys);
  else if (kept.ok) clearRefusedSpan(keys);   // NB-9: a span that is summarized now leaves no refusal behind
  return kept;
}

/** What the writer's system prompt gains on the one rewrite (empty otherwise). */
export function rewriteInstruction(checkFeedback?: string): string {
  return checkFeedback
    ? `\n\nYOUR PREVIOUS SUMMARY OF THIS SAME INPUT FAILED AN ACCURACY CHECK: ${checkFeedback}. Write it again from the input alone.`
    : '';
}
