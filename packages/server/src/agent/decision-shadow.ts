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
    return getDb().prepare('DELETE FROM decision_shadow WHERE created_at < ?').run(now - 2 * SHADOW_REPORT_WINDOW_MS).changes;
  } catch (err) {
    logger.warn('decision shadow rotation failed', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

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

/** What really happened for `question` on `turnId`, from the ledger record named by `src`. */
export function recordTruth(turnId: string, question: string, truth: unknown, src: string): void {
  getDb().prepare(`UPDATE decision_shadow SET truth = ?, truth_src = ?, truth_at = ?
    WHERE turn_id = ? AND question = ? AND truth IS NULL`).run(JSON.stringify(truth ?? null), src, Date.now(), turnId, question);
}

export interface QuestionScore {
  purpose: string; question: string; n: number; ruleAcc: number; modelAcc: number;
  ruleCI: [number, number]; modelCI: [number, number]; band: [number, number];
}

/** The model's verdict in the truth's own terms, and the probability it gave it. */
function verdictOf(a: Answer): { said: string; p: number } {
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

/**
 * The score over the judged rows still kept, or null when there are none. `band` is the tenth of the
 * probability range (deciles: the resolution a probability is read at) where the model was right least
 * often; a tie goes to the band with more rows.
 */
export function scoreQuestion(purpose: string, question: string): QuestionScore | null {
  const rows = getDb().prepare(`SELECT rule_said, model_said, truth FROM decision_shadow
    WHERE purpose = ? AND question = ? AND truth IS NOT NULL AND model_said IS NOT NULL`).all(purpose, question) as
    Array<{ rule_said: string; model_said: string; truth: string }>;
  let ruleRight = 0;
  let modelRight = 0;
  const buckets = new Map<number, { n: number; right: number }>();
  let n = 0;   // the rows actually judged (a model answer that does not parse is not one)
  for (const r of rows) {
    let v: { said: string; p: number };
    try { v = verdictOf(JSON.parse(r.model_said) as Answer); } catch { continue; }
    n++;
    const right = v.said === r.truth;
    if (r.rule_said === r.truth) ruleRight++;
    if (right) modelRight++;
    const b = Math.min(9, Math.max(0, Math.floor(v.p * 10)));
    const cur = buckets.get(b) ?? { n: 0, right: 0 };
    buckets.set(b, { n: cur.n + 1, right: cur.right + (right ? 1 : 0) });
  }
  if (n === 0) return null;
  let weakest = -1;
  for (const [b, s] of buckets) {
    const w = weakest < 0 ? null : buckets.get(weakest)!;
    if (!w || s.right / s.n < w.right / w.n || (s.right / s.n === w.right / w.n && s.n > w.n)) weakest = b;
  }
  return {
    purpose, question, n, ruleAcc: ruleRight / n, modelAcc: modelRight / n,
    ruleCI: wilson(ruleRight, n), modelCI: wilson(modelRight, n),
    band: [weakest / 10, (weakest + 1) / 10],
  };
}

/** Test-only: forget when rotation last ran. */
export function __resetShadowRotationForTests(): void { lastRotateCheck = 0; }
