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
import { randomUUID, createHash } from 'node:crypto';
import type { SummaryResult } from './summarize.js';
import { standardModelRowId } from '../services/local-standard.js';

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
  const answers = await decide({ source_rows: sourceRows, summary }, QUESTIONS, { purpose: PURPOSE, agentId, timeoutMs });
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
    const noticed = !!db.prepare('SELECT 1 FROM config WHERE key = ?').get(noticedKey(writer));
    if (failed === 0) {
      if (noticed) db.prepare('DELETE FROM config WHERE key = ?').run(noticedKey(writer));
      return;
    }
    if (noticed) return;
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

type SummaryParams = { content: string; agentId: string; modelId?: string; checkFeedback?: string; spanIds?: readonly string[] };

// ── A SPAN THAT FAILED ITS CHECK (orchestrator ruling, fix round 2) ──
// It is handed to no other writer by any path, and not retried by the same one, until something changes:
// the owner's summary writer setting, or new rows joining the span. Recorded per row (`healer_state` scope
// `summary_span_refused`, key agent|setting|row id): a span is refused when every one of its rows is.
const REFUSED_SCOPE = 'summary_span_refused';
const spanKeys = (p: SummaryParams): string[] => {
  const setting = (getDb().prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get() as { value: string } | undefined)?.value ?? '';
  const ids = p.spanIds && p.spanIds.length > 0 ? p.spanIds : [`content:${createHash('sha256').update(p.content).digest('hex').slice(0, 32)}`];
  return ids.map((id) => `${p.agentId}|${setting}|${id}`);
};
function spanRefused(keys: string[]): boolean {
  try {
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM healer_state WHERE scope = ? AND key IN (${keys.map(() => '?').join(',')})`).get(REFUSED_SCOPE, ...keys) as { n: number }).n;
    return n === keys.length;
  } catch { return false; }
}
function recordRefusedSpan(keys: string[]): void {
  try {
    const ins = getDb().prepare('INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms');
    for (const k of keys) ins.run(REFUSED_SCOPE, k, Date.now());
  } catch { /* best-effort: the worst case is one more try */ }
}

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
  return kept;
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

/**
 * (iv, fix round 2) What the owner's Summarization Model card says: is the CURRENT summary writer (his pick,
 * else the Dojo's writer) failing the check in the kept window? Owner 2026-10-20: "the user is encouraged to
 * change the summarization model to another larger model" — the card says so while this is true.
 */
export function summaryWriterStatus(): { writer: string | null; failed: number; total: number; failing: boolean } {
  try {
    const db = getDb();
    const writer = (db.prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get() as { value: string } | undefined)?.value
      || standardModelRowId('writer');
    if (!writer) return { writer: null, failed: 0, total: 0, failing: false };
    const r = db.prepare("SELECT SUM(outcome = 'not_kept') AS failed, COUNT(*) AS total FROM summary_checks WHERE writer_model_id = ? AND outcome != 'unavailable'")
      .get(writer) as { failed: number | null; total: number };
    return { writer, failed: r.failed ?? 0, total: r.total, failing: (r.failed ?? 0) > 0 };
  } catch { return { writer: null, failed: 0, total: 0, failing: false }; }
}
