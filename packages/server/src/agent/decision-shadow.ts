// ════════════════════════════════════════════════════════════════════════════
// v3.5 B2 — THE DECISION SHADOW LOG AND THE PER-QUESTION SCORE.
//
// For every judgment both the rule and the decision model answer, one `decision_shadow` row: what the
// rule said, what the model said (null when `decide()` returned none), and later the TRUTH from the
// ledger, joined by turn and question. The score compares the two against the truth on the SAME judged
// rows (truth known and the model answered), with Wilson 95 % intervals, so the policy
// (`decision-policy.ts`) can switch a question only on measured evidence. Nothing here is a threshold.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { Answer } from './decide.js';

const logger = createLogger('decision-shadow');

/** The one listener told which questions' score just changed (a truth joined it, or judged rows aged out), so a
 *  switch is noticed the moment the evidence moves rather than at the next ask. `decision-switch.ts` installs it;
 *  this file imports no policy (the policy imports this one). It never throws into the writer. */
type ScoreListener = (questions: Array<{ purpose: string; question: string }>) => void;
let scoreListener: ScoreListener | null = null;
export function onScoreChanged(l: ScoreListener | null): void { scoreListener = l; }
function scoreMoved(questions: Array<{ purpose: string; question: string }>): void {
  if (!scoreListener || questions.length === 0) return;
  try { scoreListener(questions); } catch (err) { logger.warn('a score listener failed', { error: err instanceof Error ? err.message : String(err) }); }
}

/**
 * The window the Healer's score report reads: one week, the report's longest existing look-back
 * (`healer/diagnostic.ts`, closed tasks over 7 days), so the report and the score speak of the same
 * days. ROWS ARE KEPT FOR TWO WINDOWS — the live one and the one before it — which is the log file's
 * keep policy (`log-rotation.ts`: the live file and exactly one backup, never a third) applied to rows.
 * Old evidence ages out, so a question the model stops being better at returns to shadow.
 */
export const SHADOW_REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Rotation is checked at most this often per process, as `logger.ts` checks its file's. */
const ROTATE_CHECK_MS = 60_000;
let lastRotateCheck = 0;

/** Delete rows older than two report windows. Returns how many went. */
export function rotateDecisionShadow(now: number = Date.now()): number {
  lastRotateCheck = now;
  try {
    const before = now - 2 * SHADOW_REPORT_WINDOW_MS;
    const t = loadedTallies();
    const leaving = judgedRows('created_at < ?', before);
    if (t) for (const r of leaving) tally(t, r, -1);   // the judged rows leaving the score
    const gone = getDb().prepare('DELETE FROM decision_shadow WHERE created_at < ?').run(before).changes;
    scoreMoved(distinctQuestions(leaving));   // a question whose evidence aged out may go back to shadow
    return gone;
  } catch (err) {
    logger.warn('decision shadow rotation failed', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

const distinctQuestions = (rows: Array<{ purpose: string; question: string }>): Array<{ purpose: string; question: string }> =>
  [...new Map(rows.map((r) => [`${r.purpose}\u0000${r.question}`, { purpose: r.purpose, question: r.question }])).values()];

export function recordShadow(row: {
  purpose: string; question: string; agentId?: string; turnId?: string; ruleSaid: unknown; modelSaid: Answer | null;
}): number {
  const now = Date.now();
  if (now - lastRotateCheck >= ROTATE_CHECK_MS) rotateDecisionShadow(now);
  return Number(getDb().prepare(`INSERT INTO decision_shadow (purpose, question, agent_id, turn_id, rule_said, model_said, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    row.purpose, row.question, row.agentId ?? null, row.turnId ?? null,
    JSON.stringify(row.ruleSaid ?? null), row.modelSaid ? JSON.stringify(row.modelSaid) : null, now,
  ).lastInsertRowid);
}

/** What really happened for `question` on `turnId`, from the ledger record named by `src`.
 *  NO CALLERS YET (fix round 2, stated rather than invented): nothing in this release supplies truth, so no
 *  question is ever promoted to `model` and the summary check's pass mark stays 0.5 until a truth source
 *  (Part C's clusters, B5's measurement) calls this. */
export function recordTruth(turnId: string, question: string, truth: unknown, src: string): void {
  const judged = JSON.stringify(truth ?? null);
  const t = loadedTallies();
  // The rows this truth judges join the in-memory score as they are written (fix round 1): one indexed read by turn.
  // Read even before the score is held: the switch listener needs to know which question's evidence moved.
  const joining = getDb().prepare(`SELECT purpose, question, rule_said, model_said FROM decision_shadow
    WHERE turn_id = ? AND question = ? AND truth IS NULL AND model_said IS NOT NULL`).all(turnId, question) as Array<Omit<JudgedRow, 'truth'>>;
  getDb().prepare(`UPDATE decision_shadow SET truth = ?, truth_src = ?, truth_at = ?
    WHERE turn_id = ? AND question = ? AND truth IS NULL`).run(judged, src, Date.now(), turnId, question);
  if (t) for (const r of joining) tally(t, { ...r, truth: judged }, 1);
  scoreMoved(distinctQuestions(joining));
}

export interface QuestionScore {
  purpose: string; question: string; n: number; ruleAcc: number; modelAcc: number;
  ruleCI: [number, number]; modelCI: [number, number]; band: [number, number];
}

/** The model's verdict in the truth's own terms, and the probability it gave it (the cut the score measures,
 *  so a caller acting on a verdict reads it here rather than typing its own). */
export function verdictOf(a: Answer): { said: string; p: number } {
  if (a.type === 'noul') return { said: JSON.stringify(a.noul >= 0.5), p: a.noul };
  if (a.type === 'choice') return { said: JSON.stringify(a.choice), p: a.confidence };
  return { said: JSON.stringify(Math.round(a.score)), p: a.confidence };
}

/** Wilson score interval at 95 % (z = 1.96, the normal quantile for a two-sided 95 % interval). */
export function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

/** The tenth of the probability range `p` falls in (0–9; 1.0 is in the top one). */
const decileOf = (p: number): number => Math.min(9, Math.max(0, Math.floor(p * 10)));
/** Is `p` inside the score's band — the tenth where the model was right least often? */
export const inWeakestBand = (s: QuestionScore, p: number): boolean => decileOf(p) === Math.round(s.band[0] * 10);

/**
 * FIX ROUND 1 (t274 review, Important 1) — THE SCORE IS HELD IN MEMORY. Every reply asks the policy about nine
 * questions, and reading the score off the log scanned every kept row of each, so a reply's cost grew with the
 * box's traffic. The judged rows are read ONCE per process (the first time a score is asked for — at boot, in
 * effect), then kept current as they change: a truth written joins it (`recordTruth`), a judged row rotated out
 * leaves it (`rotateDecisionShadow`). With no truth recorded the score is an empty map, so the answer is O(1).
 * Tied to the database it was read from, so a different one (a test's fresh body) is read afresh.
 */
interface JudgedRow { purpose: string; question: string; rule_said: string; model_said: string; truth: string }
interface Tally { n: number; ruleRight: number; modelRight: number; buckets: Map<number, { n: number; right: number }> }
let held: { from: unknown; byQuestion: Map<string, Tally> } | null = null;
const keyOf = (purpose: string, question: string): string => `${purpose}\u0000${question}`;

const judgedRows = (where: string, ...args: unknown[]): JudgedRow[] => getDb().prepare(`SELECT purpose, question, rule_said, model_said, truth
  FROM decision_shadow WHERE ${where} AND truth IS NOT NULL AND model_said IS NOT NULL`).all(...args) as JudgedRow[];

/** One judged row into (+1) or out of (-1) the score. A model answer that does not parse is not judged. */
function tally(byQuestion: Map<string, Tally>, r: JudgedRow, sign: 1 | -1): void {
  let v: { said: string; p: number };
  try { v = verdictOf(JSON.parse(r.model_said) as Answer); } catch { return; }
  const k = keyOf(r.purpose, r.question);
  const t = byQuestion.get(k) ?? { n: 0, ruleRight: 0, modelRight: 0, buckets: new Map() };
  const right = v.said === r.truth;
  t.n += sign;
  if (r.rule_said === r.truth) t.ruleRight += sign;
  if (right) t.modelRight += sign;
  const b = decileOf(v.p);
  const cur = t.buckets.get(b) ?? { n: 0, right: 0 };
  const next = { n: cur.n + sign, right: cur.right + (right ? sign : 0) };
  if (next.n > 0) t.buckets.set(b, next); else t.buckets.delete(b);
  if (t.n > 0) byQuestion.set(k, t); else byQuestion.delete(k);
}

/** The held score when it was already read from this database, else null (nothing to keep current yet). */
function loadedTallies(): Map<string, Tally> | null {
  try { return held && held.from === getDb() ? held.byQuestion : null; } catch { return null; }
}
function tallies(): Map<string, Tally> {
  const db = getDb();
  if (held && held.from === db) return held.byQuestion;
  const byQuestion = new Map<string, Tally>();
  for (const r of judgedRows('1 = 1')) tally(byQuestion, r, 1);
  held = { from: db, byQuestion };
  return byQuestion;
}

/**
 * The score over the judged rows still kept, or null when there are none. `band` is the tenth of the
 * probability range (deciles: the resolution a probability is read at) where the model was right least
 * often; a tie goes to the band with more rows, then to the lower tenth.
 */
export function scoreQuestion(purpose: string, question: string): QuestionScore | null {
  const t = tallies().get(keyOf(purpose, question));
  if (!t || t.n <= 0) return null;
  let weakest = -1;
  for (const [b, s] of [...t.buckets].sort(([a], [c]) => a - c)) {
    const w = weakest < 0 ? null : t.buckets.get(weakest)!;
    if (!w || s.right / s.n < w.right / w.n || (s.right / s.n === w.right / w.n && s.n > w.n)) weakest = b;
  }
  const { n, ruleRight, modelRight } = t;
  return {
    purpose, question, n, ruleAcc: ruleRight / n, modelAcc: modelRight / n,
    ruleCI: wilson(ruleRight, n), modelCI: wilson(modelRight, n),
    band: [weakest / 10, (weakest + 1) / 10],
  };
}

/** Test-only: forget when rotation last ran, and the held score (it is read afresh). */
export function __resetShadowRotationForTests(): void { lastRotateCheck = 0; held = null; }
