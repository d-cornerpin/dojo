// ════════════════════════════════════════════════════════════════════════════
// v3.5 B4 — EVERY SUMMARY IS CHECKED AGAINST ITS SOURCE BEFORE IT IS KEPT.
//
// OWNER RULING 2026-10-20: "Check each summary against the decision model. If there are significant
// summarization failures on a dojo, the user is encouraged to change the summarization model to
// another larger model." (v3.5 field fix 3, owner ruling: there is no summarization model setting; each agent's
// own model writes, so the notice states the fact and points at no setting.) Whoever writes it, the decision model reads the summary against the rows it
// summarizes (`generateSummary`, the one door every summary comes through), and:
//   pass                → kept as written;
//   fail                → rewritten ONCE with the failed questions named, then checked again;
//   fail again          → NOT kept: the caller leaves the rows whole and a later pass tries again
//                         (every caller already treats a refusal that way); logged with its numbers;
//   no answer           → kept, logged `unavailable` — the check never blocks compaction.
// OR-AUDIT-ANSWERS (c), owner ruling "Redo bad summaries" (supersedes t268 ruling 1's shadow for this check): a
// failing verdict ACTS on every asked question (`actingQuestions`), whatever the policy's mode; each verdict is still
// recorded in `decision_shadow`. No owner card is sent on any outcome.
// A failed check is not the writer being unreachable: nothing here marks the writer passed over.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { measuredDecideTimeoutMs, type Answer, type DecideOpts, type FailureClass, type Question } from '../agent/decide.js';
import { recordShadow, SHADOW_REPORT_WINDOW_MS } from '../agent/decision-shadow.js';
import type { SummaryResult } from './summarize.js';
import { decisionWindowTokens } from '../services/dojo-working-memory.js';
import { sourceParts, combineParts, checkPart } from './summary-check-parts.js';
import { decisionCharsPerToken } from '../services/token-density.js';
import { SUMMARY_CHECK_PURPOSE, actingQuestions, askedQuestions, summaryCheckActs, summaryCheckId, mintSummaryCheckId, noteSummaryKept, passMark, type SummaryCheckQuestion } from './summary-check-ledger.js';
import { createHash } from 'node:crypto';
export { refuseFallbackOverFreeMemory } from './writer-fallback-room.js';   // summarize.ts's one door asks it
/** A span no caller named (a direct check): keyed by its source text instead. */
const contentKey = (t: string): string => createHash('sha256').update(t).digest('hex').slice(0, 32);
export { passMark };

const logger = createLogger('summary-check');

export interface SummaryCheck { ok: boolean; invented: number; dropped: number; statedCurrent: number; answers: Record<string, Answer> | null }

const PURPOSE = SUMMARY_CHECK_PURPOSE;
// Summary-check round (owner ruling 2, his insight verbatim: "if the question is 'does the summary state something the
// messages never did' then the answer will almost always be yes because the point of a summary is to reword ... maybe
// the question needs more specificity"). `invented` and `dropped` are reworded for that; `stated_current` is unchanged.
const QUESTIONS: Record<SummaryCheckQuestion, Question> = {
  invented: { type: 'noul', instructions: 'Does `summary` introduce a fact, concept or meaning that `source_rows` never included? Rewording or shortening what `source_rows` says is not a new fact.' },
  dropped: { type: 'noul', instructions: 'Does `source_rows` contain a decision, a promise, a name, a date, a number or an unfinished task that `summary` does not mention?' },
  stated_current: { type: 'noul', instructions: 'Does `summary` describe anything as currently pending or owed?' },
};
/** What the rewrite is told, per failed question (the writer's own words for the input: "the input"). */
const FEEDBACK: Record<keyof typeof QUESTIONS, string> = {
  invented: 'it introduced a fact, concept or meaning the input never included',
  dropped: 'it left out a decision, promise, name, date, number or unfinished task the input contains',
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
  const opts = (s: unknown, onFailure: (f: FailureClass) => void): DecideOpts => {
    const patienceMs = measuredDecideTimeoutMs(s, Object.keys(questions).length);
    return background ? { purpose: PURPOSE, background: true, patienceMs, onFailure } : { purpose: PURPOSE, agentId, patienceMs, onFailure };
  };
  const parts = sourceParts(sourceRows, summary, await decisionWindowTokens(), questions, decisionCharsPerToken());
  let answers: Record<string, Answer> | null;
  if (parts === null) {
    logger.warn('summary_check_unavailable the summary alone is larger than the decision model\'s window; it is kept unchecked', { summaryChars: summary.length }, agentId);
    answers = null;
  } else if (parts.length === 1) {
    answers = combineParts(await checkPart(sourceRows, null, summary, questions, opts));
  } else {
    // One part after another through decide()'s normal path, each with its own clock (fix round 5, NB4-6): the
    // local Ollama answers one request at a time, so parts dialled together would spend their clocks queued.
    const each: Array<Record<string, Answer> | null> = [];
    for (const [i, part] of parts.entries()) each.push(...await checkPart(part, `${i + 1} of ${parts.length}`, summary, questions, opts));
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
  // OR-AUDIT-ANSWERS (c): every asked question acts (`actingQuestions`); the shadow rows are still recorded.
  const asked = askedQuestions();
  const acting = actingQuestions();
  if (asked.length === 0) return written;   // M-3: every question held to the rule (or no decision model): the model is not asked
  const checkId = newCheckId();   // N-D: each text checked is its own version
  const first = await checkSummary(source, written.text, agentId, { asked, checkId });
  if (!first.answers) { record(agentId, writer, 'unavailable', null); noteSummaryKept(checkId); return written; }
  const failed = actedFailures(first, acting);
  if (failed.length === 0) { record(agentId, writer, 'ok', first); noteSummaryKept(checkId); return written; }

  const again = await rewrite(failed.map((q) => FEEDBACK[q]).join('; '));
  if (!again.ok) return again;   // the writer itself refused: its own outcome, recorded by its own door
  const againId = newCheckId();
  const second = await checkSummary(source, again.text, agentId, { asked, checkId: againId });
  if (!second.answers) { record(agentId, writer, 'unavailable', null); noteSummaryKept(againId); return again; }
  if (actedFailures(second, acting).length === 0) { record(agentId, writer, 'rewritten_ok', second); noteSummaryKept(againId); return again; }

  record(agentId, writer, 'not_kept', second);
  logger.warn('summary_check_failed the summary was not kept; the rows stay whole for a later pass', {
    writer, invented: second.invented, dropped: second.dropped, statedCurrent: second.statedCurrent,
  }, agentId);
  // `checkFailed`: a verdict on this span, not a writer that stopped answering, so no caller walks it on to another
  // writer; the rows stay whole behind the placeholder path, and the span is held (`recordRefusedSpan`) until a real
  // signal (new rows join it, or its writer changes). No card (owner ruling), no timer, no count (I-B4-1).
  return { ok: false, reason: 'the summary failed the accuracy check twice; the rows stay whole', checkFailed: true };
}

/** Did a summary of this agent's fail its check (and stay unwritten) since `sinceMs`? The fold's writer walk asks. */
export function summaryCheckRefusedSince(agentId: string, sinceMs: number): boolean {
  try {
    return !!getDb().prepare("SELECT 1 FROM summary_checks WHERE agent_id = ? AND outcome = 'not_kept' AND created_at >= ?").get(agentId, sinceMs);
  } catch { return false; }
}

import { spanKeys, spanHeld, recordRefusedSpan, clearRefusedSpan, type SummaryParams } from './summary-check-ledger.js';

/** `generateSummary`'s body: write (settled), then keep only what passes. `write` is the settled writer call. */
export async function writeThenCheck<P extends SummaryParams>(params: P, write: (p: P) => Promise<SummaryResult>): Promise<SummaryResult> {
  const keys = params.modelId ? spanKeys(params) : [];
  if (keys.length > 0 && summaryCheckActs() && spanHeld(keys, params.spanOpen === true)) {   // S6: handled; it waits for a real signal
    return { ok: false, checkFailed: true, reason: 'this span failed its accuracy check; it is left as it is until its writer changes or it closes with new rows' };
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
