// ════════════════════════════════════════════════════════════════════════════
// v3.5 B3 — RULE → SHADOW → MODEL, PER QUESTION. Owner, 2026-10-19: "the Dojo switches a question
// itself once the model proves better."
//
//   rule   — no decision model on this box, or the owner held it to the rule (`decision_mode.<purpose>.<question>` = rule)
//   model  — the score says the model is better AND its whole 95 % range sits above the rule's
//            (`modelCI[0] > ruleCI[1]`): measured, never a typed threshold
//   shadow — otherwise: the model answers, the rule decides, both are logged. A question in `model`
//            returns here by itself as soon as the ranges overlap again (the score is recomputed).
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getDecisionProvider } from './decision-provider.js';
import { scoreQuestion, type QuestionScore } from './decision-shadow.js';
import type { DiagnosticItem } from '../healer/diagnostic.js';
import { summaryCheckLine } from '../memory/summary-check-ledger.js';

export type Mode = 'rule' | 'shadow' | 'model';

/** The owner may hold a question to the RULE; he may not pin it to the model or to shadow (fix round 1
 *  ruling: the Dojo flips each question itself once the model proves better). */
function pinnedToRule(purpose: string, question: string): boolean {
  try {
    return (getDb().prepare('SELECT value FROM config WHERE key = ?').get(`decision_mode.${purpose}.${question}`) as { value: string } | undefined)?.value === 'rule';
  } catch { return false; }
}

export const modelProvenBetter = (s: QuestionScore | null): boolean =>
  !!s && s.modelAcc > s.ruleAcc && s.modelCI[0] > s.ruleCI[1];

export function modeFor(purpose: string, question: string): Mode {
  if (!getDecisionProvider() || pinnedToRule(purpose, question)) return 'rule';
  return modelProvenBetter(scoreQuestion(purpose, question)) ? 'model' : 'shadow';
}

/** The sentence the Healer report carries under the scores (the plan's words). */
export const SWITCH_SENTENCE = "A question switches to the model when the model's range sits above the rule's, and back when it does not.";

const pct = (x: number): string => `${Math.round(x * 100)}`;

/** The Healer report's section: every question the shadow log holds, scored. Empty when nothing was asked. */
export function getDecisionScoreItems(): DiagnosticItem[] {
  let questions: Array<{ purpose: string; question: string }> = [];
  try {
    questions = getDb().prepare('SELECT DISTINCT purpose, question FROM decision_shadow ORDER BY purpose, question').all() as typeof questions;
  } catch { return []; }
  const summaries = summaryCheckLine();   // B4: the summary check's running numbers ride the same section
  if (questions.length === 0 && !summaries) return [];
  const lines = questions.map(({ purpose, question }) => {
    const s = scoreQuestion(purpose, question);
    const mode = modeFor(purpose, question);
    if (!s) return `${purpose} / ${question}: scored offline only (no production truth), mode ${mode}`;
    return `${purpose} / ${question}: n=${s.n}, rule ${pct(s.ruleAcc)}% [${pct(s.ruleCI[0])}–${pct(s.ruleCI[1])}], `
      + `model ${pct(s.modelAcc)}% [${pct(s.modelCI[0])}–${pct(s.modelCI[1])}], mode ${mode}`;
  });
  return [{
    severity: 'info',
    code: 'decision_score',
    title: 'The decision model, scored against the rules it shadows',
    detail: [lines.length > 0 ? `${lines.join('; ')}. ${SWITCH_SENTENCE}` : '', summaries ?? ''].filter(Boolean).join(' '),
  }];
}
