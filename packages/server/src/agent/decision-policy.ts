// ════════════════════════════════════════════════════════════════════════════
// v3.5 B3 — RULE → SHADOW → MODEL, PER QUESTION. Owner, 2026-10-19: "the Dojo switches a question
// itself once the model proves better."
//
//   rule   — no decision model on this box, or the owner pinned it (`decision_mode.<purpose>.<question>`)
//   model  — the score says the model is better AND its whole 95 % range sits above the rule's
//            (`modelCI[0] > ruleCI[1]`): measured, never a typed threshold
//   shadow — otherwise: the model answers, the rule decides, both are logged. A question in `model`
//            returns here by itself as soon as the ranges overlap again (the score is recomputed).
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getDecisionProvider } from './decision-provider.js';
import { scoreQuestion, type QuestionScore } from './decision-shadow.js';
import type { DiagnosticItem } from '../healer/diagnostic.js';

export type Mode = 'rule' | 'shadow' | 'model';
const MODES: readonly Mode[] = ['rule', 'shadow', 'model'];

function pinned(purpose: string, question: string): Mode | null {
  try {
    const v = (getDb().prepare('SELECT value FROM config WHERE key = ?').get(`decision_mode.${purpose}.${question}`) as { value: string } | undefined)?.value;
    return v && (MODES as readonly string[]).includes(v) ? v as Mode : null;
  } catch { return null; }
}

const modelProvenBetter = (s: QuestionScore | null): boolean =>
  !!s && s.modelAcc > s.ruleAcc && s.modelCI[0] > s.ruleCI[1];

export function modeFor(purpose: string, question: string): Mode {
  if (!getDecisionProvider()) return 'rule';
  const pin = pinned(purpose, question);
  if (pin) return pin;
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
  if (questions.length === 0) return [];
  const lines = questions.map(({ purpose, question }) => {
    const s = scoreQuestion(purpose, question);
    const mode = modeFor(purpose, question);
    if (!s) return `${purpose} / ${question}: no judged turns yet, mode ${mode}`;
    return `${purpose} / ${question}: n=${s.n}, rule ${pct(s.ruleAcc)}% [${pct(s.ruleCI[0])}–${pct(s.ruleCI[1])}], `
      + `model ${pct(s.modelAcc)}% [${pct(s.modelCI[0])}–${pct(s.modelCI[1])}], mode ${mode}`;
  });
  return [{
    severity: 'info',
    code: 'decision_score',
    title: 'The decision model, scored against the rules it shadows',
    detail: `${lines.join('; ')}. ${SWITCH_SENTENCE}`,
  }];
}
