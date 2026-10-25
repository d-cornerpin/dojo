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
// t268 (orchestrator ruling 1, after B5 measured the check): a failing verdict ACTS only on the questions
// B3's policy has flipped to `model` on measured accuracy (`actingQuestions`). Until then every summary is
// checked and its verdict recorded in `decision_shadow`, and the summary is kept as it was before v3.5.
// A failed check is not the writer being unreachable: nothing here marks the writer passed over.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { decide, measuredDecideTimeoutMs, type Answer, type DecideOpts, type Question } from '../agent/decide.js';
import { recordShadow, SHADOW_REPORT_WINDOW_MS } from '../agent/decision-shadow.js';
import type { SummaryResult } from './summarize.js';
import { decisionWindowTokens } from '../services/dojo-working-memory.js';
import { sourceParts, combineParts } from './summary-check-parts.js';
import { decisionCharsPerToken } from '../services/token-density.js';
import { getDecisionProvider } from '../agent/decision-provider.js';
import { SUMMARY_CHECK_PURPOSE, actingQuestions, askedQuestions, summaryCheckActs, summaryCheckId, mintSummaryCheckId, noteSummaryKept, passMark, type SummaryCheckQuestion } from './summary-check-ledger.js';
import { createHash } from 'node:crypto';
export { refuseFallbackOverFreeMemory } from './writer-fallback-room.js';   // summarize.ts's one door asks it
/** A span no caller named (a direct check): keyed by its source text instead. */
const contentKey = (t: string): string => createHash('sha256').update(t).digest('hex').slice(0, 32);
export { passMark };

const logger = createLogger('summary-check');

export interface SummaryCheck { ok: boolean; invented: number; dropped: number; statedCurrent: number; answers: Record<string, Answer> | null }

const PURPOSE = SUMMARY_CHECK_PURPOSE;
const QUESTIONS: Record<SummaryCheckQuestion, Question> = {
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

const failsAt = passMark;

/**
 * The noul questions over { source_rows, summary } — the ones not held to the rule (fix round 1, M-3: a
 * question in `rule` mode never asks the model). `ok` when every probability is below its question's line.
 * When decide() returns null, `answers` is null and `ok` is true (never blocks).
 */
export async function checkSummary(
  sourceRows: string, summary: string, agentId: string,
  { asked = askedQuestions(), background = false, checkId = summaryCheckId(agentId, [`source:${contentKey(sourceRows)}`]) } = {},
): Promise<SummaryCheck> {
  const questions = Object.fromEntries(asked.map((q) => [q, QUESTIONS[q]]));
  // t274 fix round 1: every ask states its patience — the call's own measured timeout, so nobody waits longer than
  // the call is allowed — and a background ask names no agent (it holds no turn's stop slot).
  const opts = (s: unknown): DecideOpts => {
    const patienceMs = measuredDecideTimeoutMs(s, Object.keys(questions).length);
    return background ? { purpose: PURPOSE, background: true, patienceMs } : { purpose: PURPOSE, agentId, patienceMs };
  };
  const parts = sourceParts(sourceRows, summary, await decisionWindowTokens(), questions, decisionCharsPerToken(), getDecisionProvider()?.model ?? '');
  let answers: Record<string, Answer> | null;
  if (parts === null) {
    logger.warn('summary_check_unavailable the summary alone is larger than the decision model\'s window; it is kept unchecked', { summaryChars: summary.length }, agentId);
    answers = null;
  } else if (parts.length === 1) {
    const s = { source_rows: sourceRows, summary };
    answers = await decide(s, questions, opts(s));
  } else {
    // One part after another through decide()'s normal path, each with its own clock (fix round 5, NB4-6): the
    // local Ollama answers one request at a time, so parts dialled together would spend their clocks queued.
    const each: Array<Record<string, Answer> | null> = [];
    for (const [i, part] of parts.entries()) {
      const s = { source_rows: part, summary, source_part: `${i + 1} of ${parts.length}` };
      each.push(await decide(s, questions, opts(s)));
    }
    answers = combineParts(each);
  }
  const p = (q: keyof typeof QUESTIONS): number => (answers?.[q]?.type === 'noul' ? (answers[q] as { noul: number }).noul : 0);
  const [invented, dropped, statedCurrent] = [p('invented'), p('dropped'), p('stated_current')];
  const ok = !answers || (invented < failsAt('invented') && dropped < failsAt('dropped') && statedCurrent < failsAt('stated_current'));
  // Every answered check joins the shadow log (the rule today keeps every summary: `false`) under the check's id,
  // derived from the summary's own text (I-4), so a truth source can join it to the summary row it judged.
  if (answers) for (const q of asked) recordShadow({ purpose: PURPOSE, question: q, agentId, turnId: checkId, ruleSaid: false, modelSaid: answers[q] ?? null });
  return { ok, invented, dropped, statedCurrent, answers };
}

/** The questions this check failed that ACT (t268): failed, and flipped to `model` by the policy. */
function actedFailures(c: SummaryCheck, acting: readonly SummaryCheckQuestion[]): SummaryCheckQuestion[] {
  const p: Record<SummaryCheckQuestion, number> = { invented: c.invented, dropped: c.dropped, stated_current: c.statedCurrent };
  return c.answers ? acting.filter((q) => p[q] >= failsAt(q)) : [];
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
  if (!summaryCheckActs()) return;   // t268: a verdict in shadow tells no one
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
        + "This box's summary writer may be too small for its conversations; pick a larger model under Settings → Models → Summarization Model.",
      code: SUMMARY_CHECK_NOTICE_CODE,
      severity: 'warning',
      retryable: false,
    });
  } catch { /* a notice is a courtesy; never break the summary it rides on */ }
}

/** The shadow checks still running after their summaries were kept. */
const lateChecks = new Set<Promise<void>>();
/** Resolves when every shadow check started so far has recorded its verdict. Starts nothing. */
export async function summaryChecksSettled(): Promise<void> { while (lateChecks.size > 0) await Promise.all([...lateChecks]); }

/**
 * The flow between "written" and "kept". `written` is an ok result; `rewrite(feedback)` writes the same
 * input again with the failed questions named. The check's time is `decide()`'s own measured formula for its
 * size (t268 ruling 4: how long the WRITER took says nothing about the decision model — a fast cloud writer
 * gave the check almost no time at all).
 */
export async function keepOnlyIfChecked(
  source: string, written: Extract<SummaryResult, { ok: true }>, agentId: string, writer: string,
  rewrite: (feedback: string) => Promise<SummaryResult>, newCheckId: () => string | undefined = () => undefined,
): Promise<SummaryResult> {
  // t268: only a failure on a question the policy flipped to `model` acts; a shadow verdict is recorded
  // (`decision_shadow`, and this row's numbers) and the summary is kept as written.
  const asked = askedQuestions();
  const acting = actingQuestions();
  if (asked.length === 0) return written;   // M-3: every question held to the rule (or no decision model): the model is not asked
  const checkId = newCheckId();   // N-D: each text checked is its own version
  if (acting.length === 0) {   // M-2: a verdict that cannot act never holds the summary up: kept now, checked after
    noteSummaryKept(checkId);
    const late = checkSummary(source, written.text, agentId, { asked, background: true, checkId }).then((c) => record(agentId, writer, c.answers ? 'ok' : 'unavailable', c.answers ? c : null))
      .catch(() => undefined).finally(() => { lateChecks.delete(late); });
    lateChecks.add(late);
    return written;
  }
  const first = await checkSummary(source, written.text, agentId, { asked, checkId });
  if (!first.answers) { record(agentId, writer, 'unavailable', null); noteSummaryKept(checkId); return written; }
  const failed = actedFailures(first, acting);
  if (failed.length === 0) { record(agentId, writer, 'ok', first); noticeIfFailing(agentId, writer); noteSummaryKept(checkId); return written; }

  const again = await rewrite(failed.map((q) => FEEDBACK[q]).join('; '));
  if (!again.ok) return again;   // the writer itself refused: its own outcome, recorded by its own door
  const againId = newCheckId();
  const second = await checkSummary(source, again.text, agentId, { asked, checkId: againId });
  if (!second.answers) { record(agentId, writer, 'unavailable', null); noteSummaryKept(againId); return again; }
  if (actedFailures(second, acting).length === 0) { record(agentId, writer, 'rewritten_ok', second); noticeIfFailing(agentId, writer); noteSummaryKept(againId); return again; }

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
  if (!summaryCheckActs()) return false;   // t268: no verdict holds anything while the check is in shadow
  try {
    return !!getDb().prepare("SELECT 1 FROM summary_checks WHERE agent_id = ? AND outcome = 'not_kept' AND created_at >= ?").get(agentId, sinceMs);
  } catch { return false; }
}

import { spanKeys, spanRefused, recordRefusedSpan, clearRefusedSpan, writerFailing, type SummaryParams } from './summary-check-ledger.js';

/** `generateSummary`'s body: write (settled), then keep only what passes. `write` is the settled writer call. */
export async function writeThenCheck<P extends SummaryParams>(params: P, write: (p: P) => Promise<SummaryResult>): Promise<SummaryResult> {
  const keys = params.modelId ? spanKeys(params) : [];
  if (keys.length > 0 && summaryCheckActs() && spanRefused(keys)) {   // t268: the hold acts only in `model` mode
    return { ok: false, checkFailed: true, reason: 'this span failed its accuracy check; it is left as it is until the summary writer changes or new rows join it' };
  }
  const written = await write(params);
  if (!written.ok || !params.modelId) return written;
  const kept = await keepOnlyIfChecked(params.content, written, params.agentId, params.modelId,
    (checkFeedback) => write({ ...params, checkFeedback }), () => (params.spanIds?.length ? mintSummaryCheckId(params.agentId, params.spanIds) : undefined));
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
