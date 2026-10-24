// Test helper (t268, ruling 1): simulate the MEASURED accuracy that flips a summary-check question to
// `model` under B3's policy (`agent/decision-policy.ts modeFor`): judged shadow rows where the model is right
// on every one and the rule ("keep every summary": false) on half, so the model's 95 % range sits above the
// rule's. Nothing is mocked: the real score and the real policy read these rows.
import { recordShadow, recordTruth } from '../../agent/decision-shadow.js';

export const SUMMARY_CHECK_QUESTIONS = ['invented', 'dropped', 'stated_current'] as const;

/** 60 judged rows per question: 30 bad summaries the model scored 0.95, 30 fine ones it scored 0.04. */
export function proveSummaryCheck(questions: readonly string[] = SUMMARY_CHECK_QUESTIONS): void {
  for (const q of questions) {
    for (let i = 0; i < 60; i++) {
      const bad = i < 30;
      const turnId = `proof-${q}-${i}`;
      recordShadow({ purpose: 'summary_check', question: q, turnId, ruleSaid: false, modelSaid: { type: 'noul', noul: bad ? 0.95 : 0.04 } });
      recordTruth(turnId, q, bad, 'test: measured accuracy');
    }
  }
}
