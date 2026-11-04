// ════════════════════════════════════════════════════════════════════════════
// v3.5 item 29 — A QUESTION'S SWITCH IS NOTICED, RECORDED AND TOLD (per question, both ways).
//
// `decision-policy.ts modeFor` already decides, from the held score, whether a question is answered by the model
// (`modelAcc > ruleAcc` and the model's whole 95 % range above the rule's) or stays in shadow, and it re-decides on
// every call, so a model that gets worse goes back by itself. What it did not do was SAY so. This module watches the
// evidence (it is told by `decision-shadow.ts` whenever a question's score moves) and, when a question's evidence
// state flips, it
//   - records the flip: `config` key `decision_switch.<purpose>.<question>` (state, when, the numbers) and a log line;
//   - tells the owner through the existing dashboard card (`owner-card-frames.ts`), one card per question.
// Nothing here changes how a question is answered, types a threshold, or counts cases: the numbers are the score's.
// A question the owner pinned to the rule, or a box with no decision model, records the flip but shows no card (the
// model is not answering it). The four judgments the 3.5 product decision puts on the model (`ownerDecidedQuestions`) are
// a shipped default, nothing the owner of a box did: they are recorded silently, never told as his choice (field failure 2,
// owner ruling OR-UPKEEP-AUTOMATIC: zero cards after an update). Safety gates never import this module.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { ownerCardEnded, ownerCardFrame } from '../services/owner-card-frames.js';
import { modeFor, modelProvenBetter, ownerDecidedQuestions, ownerOnTheModel } from './decision-policy.js';
import { getDecisionProvider } from './decision-provider.js';
import { onScoreChanged, scoreQuestion, type QuestionScore } from './decision-shadow.js';

const logger = createLogger('decision-switch');

export type SwitchState = 'shadow' | 'model';
export interface SwitchRecord { state: SwitchState; at: number; n: number; ruleAcc: number; modelAcc: number }

const keyOf = (purpose: string, question: string): string => `decision_switch.${purpose}.${question}`;
const cardKeyOf = (purpose: string, question: string): string => `decision-switch:${purpose}:${question}`;
const plain = (s: string): string => s.replace(/_/g, ' ');
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** The recorded state of a question (`shadow` until a switch was recorded). */
export function switchRecord(purpose: string, question: string): SwitchRecord | null {
  try {
    const v = (getDb().prepare('SELECT value FROM config WHERE key = ?').get(keyOf(purpose, question)) as { value: string } | undefined)?.value;
    return v ? JSON.parse(v) as SwitchRecord : null;
  } catch { return null; }
}

/** Every question the model currently answers, as recorded (the Healer report reads this). */
export function switchedQuestions(): Array<{ purpose: string; question: string; record: SwitchRecord }> {
  try {
    const rows = getDb().prepare("SELECT key, value FROM config WHERE key LIKE 'decision_switch.%'").all() as Array<{ key: string; value: string }>;
    const out: Array<{ purpose: string; question: string; record: SwitchRecord }> = [];
    for (const r of rows) {
      const [purpose, ...rest] = r.key.slice('decision_switch.'.length).split('.');
      const record = JSON.parse(r.value) as SwitchRecord;
      if (record.state === 'model') out.push({ purpose, question: rest.join('.'), record });
    }
    return out;
  } catch { return []; }
}

const words = (purpose: string, question: string, s: QuestionScore | null, to: SwitchState): string => to === 'model'
  ? `The decision model now answers the question "${plain(question)}" (${plain(purpose)}) itself. Over ${s?.n ?? 0} real cases it was right ${pct(s?.modelAcc ?? 0)} of the time against the old rule's ${pct(s?.ruleAcc ?? 0)}, and the gap was wide enough to be sure. If it gets worse, the Dojo goes back to the rule by itself.`
  : `The decision model no longer answers the question "${plain(question)}" (${plain(purpose)}): its recent results are no longer clearly better than the old rule's, so the Dojo went back to the rule. The model keeps being scored.`;

/** Look at one question's evidence; if its state flipped since last recorded, record and tell. Never throws. */
export function reviewSwitch(purpose: string, question: string): SwitchState | null {
  try {
    const s = scoreQuestion(purpose, question);
    const decided = ownerOnTheModel(purpose, question);   // the owner's 3.5 decision: on the model while a model is here
    if (decided && !getDecisionProvider()) return null;      // a box without the model keeps the rule: nothing switched, nothing told
    const now: SwitchState = decided || modelProvenBetter(s) ? 'model' : 'shadow';
    const was: SwitchState = switchRecord(purpose, question)?.state ?? 'shadow';
    if (now === was) return null;
    const record: SwitchRecord = { state: now, at: Date.now(), n: s?.n ?? 0, ruleAcc: s?.ruleAcc ?? 0, modelAcc: s?.modelAcc ?? 0 };
    if (now === 'model') {
      getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(keyOf(purpose, question), JSON.stringify(record));
    } else {
      getDb().prepare('DELETE FROM config WHERE key = ?').run(keyOf(purpose, question));   // back to shadow: the default state carries no row
    }
    logger.info(`decision question ${now === 'model' ? 'switched to the model' : 'went back to shadow'}`, { purpose, question, n: record.n, ruleAcc: record.ruleAcc, modelAcc: record.modelAcc });
    // Pinned to the rule / no model: nothing changed for the owner. A shipped default (`decided`) is no evidence: recorded, never told.
    if (!decided && modeFor(purpose, question) === (now === 'model' ? 'model' : 'shadow')) {
      if (now === 'model') ownerCardFrame(words(purpose, question, s, now), 'warning', cardKeyOf(purpose, question));
      else { ownerCardEnded(words(purpose, question, s, 'shadow'), cardKeyOf(purpose, question)); }
    }
    return now;
  } catch (err) {
    logger.warn('could not review a decision switch', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Record the four judgments the product puts on the model (once each, silently; a box without the decision model records
 *  nothing, so they are recorded when the model arrives). Called at boot and when the standard models are ready. Never throws. */
export function announceDecidedSwitches(): void {
  for (const q of ownerDecidedQuestions()) reviewSwitch(q.purpose, q.question);
}

onScoreChanged((qs) => { for (const q of qs) reviewSwitch(q.purpose, q.question); });
