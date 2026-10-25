// ════════════════════════════════════════════════════════════════════════════
// v3.5 C3 — MEMORY SHAPE, ASKED ALONGSIDE THE RULES (spec A19–A22).
//
// Four judgments about text on its way into (or out of) memory, each still decided by its rule:
//   standing_instruction (A19)  "remember that … / always / never": saved as written, never bounced   rule: the trigger-phrase list
//   prose_shaped         (A19)  a narrative, not one compressed line: bounced for a rewrite            rule: over half its cap and 3+ sentences
//   obligation           (A20)  a promise, not a fact: refused, it belongs on the board                rule: `obligationShape`
//   filler               (A21)  a message the Dreamer is not shown                                     rule: `vault/filler.ts`
//   worth_summary        (A22)  a span with conversation worth a summary, not only tool traffic        rule: the 120-character floor
//
// The vault entry's three questions share ONE `decide()` call. In `rule` and `shadow` mode every function here
// returns its rule's answer, unchanged; the model's answer is logged beside it. In `model` mode the verdict
// stands in only outside the question's measured weak band. The Dreamer soul's own rules are the criteria text.
// The credential gate (`vault/credential-gate.ts`) is a safety gate and is not here and never will be.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import type { Question } from '../agent/decide.js';
import { judgment, type Judgment } from '../agent/decision-ask.js';
import { takeFillerCandidates, setFillerVerdicts } from '../vault/filler.js';

const logger = createLogger('memory-shape');

export const MEMORY_SHAPE_PURPOSE = 'memory_shape';

const QUESTIONS: Record<string, Question> = {
  standing_instruction: { type: 'noul', instructions: 'Is `entry` a standing instruction from the person, such as "remember that", "always", "never" or "from now on", to be kept exactly as they said it?' },
  prose_shaped: { type: 'noul', instructions: 'Is `entry` written as narrative prose, a story of several sentences, rather than one compressed telegraphic line?' },
  obligation: { type: 'noul', instructions: 'Does `entry` say that its writer promised, or still has to do, something (an obligation), rather than state a fact about the world?' },
  worth_summary: { type: 'noul', instructions: 'Does `span` contain conversation, such as requests, answers or decisions, worth a summary, rather than only tool traffic and plumbing?' },
};
const FILLER_QUESTION = 'filler';
const MAX_QUESTIONS_PER_CALL = 64;   // `decide()`'s documented limit for one request

/** One vault_remember call: the entry's three shape questions, one request, joined by whichever site reports first. */
export interface EntryShape {
  standing(rule: boolean): Promise<boolean>;
  prose(rule: boolean): Promise<boolean>;
  /** The marker the rule found (it names the refusal's reason), or null. In `model` mode the model may add or remove one. */
  obligation(ruleMarker: string | null): Promise<string | null>;
}

export function entryShape(agentId: string, entry: string): EntryShape {
  const j: Judgment = judgment({
    purpose: MEMORY_SHAPE_PURPOSE, agentId, state: { entry },
    questions: { standing_instruction: QUESTIONS.standing_instruction, prose_shaped: QUESTIONS.prose_shaped, obligation: QUESTIONS.obligation },
  });
  const yesNo = async (name: string, rule: boolean): Promise<boolean> => {
    const said = await j.alongside(name, rule);
    return typeof said === 'boolean' ? said : rule;
  };
  return {
    standing: (rule) => yesNo('standing_instruction', rule),
    prose: (rule) => yesNo('prose_shaped', rule),
    obligation: async (marker) => {
      const said = await yesNo('obligation', marker !== null);
      return said ? (marker ?? 'the decision model read it as an obligation') : null;
    },
  };
}

/** A22 — is this span worth a model summary (so it is rebuilt, not given the deterministic placeholder)? */
export async function spanWorthJudged(agentId: string, span: string, rule: boolean): Promise<boolean> {
  const said = await judgment({ purpose: MEMORY_SHAPE_PURPOSE, agentId, state: { span }, questions: { worth_summary: QUESTIONS.worth_summary } })
    .alongside('worth_summary', rule);
  return typeof said === 'boolean' ? said : rule;
}

/**
 * A21 — ends a triage pass (`beginFillerPass` … here): asks about the short messages the rule judged, in requests
 * of at most 64, and in `model` mode hands the confident verdicts back to the rule for the passes that follow.
 * In `rule` and `shadow` mode no verdict is applied. Never throws.
 */
export async function settleFiller(agentId: string): Promise<void> {
  try {
    const seen = takeFillerCandidates();
    const verdicts = new Map<string, boolean>();
    for (let from = 0; from < seen.length; from += MAX_QUESTIONS_PER_CALL) {
      const chunk = seen.slice(from, from + MAX_QUESTIONS_PER_CALL);
      const questions: Record<string, Question> = {};
      const state: Record<string, string> = {};
      chunk.forEach(([text], i) => {
        state[`m${i}`] = text;
        questions[`m${i}`] = { type: 'noul', instructions: `Is \`m${i}\` conversational filler or process narration, such as an acknowledgement, "let me check" or "thanks", that carries nothing worth remembering?` };
      });
      const j = judgment({ purpose: MEMORY_SHAPE_PURPOSE, agentId, state, questions, questionOf: () => FILLER_QUESTION });
      const said = await Promise.all(chunk.map(([, rule], i) => j.alongside(`m${i}`, rule)));
      said.forEach((v, i) => { if (typeof v === 'boolean') verdicts.set(chunk[i][2], v); });
    }
    setFillerVerdicts(verdicts);
  } catch (err) {
    setFillerVerdicts(new Map());
    logger.warn('the filler judgments failed; the rule decided', { error: err instanceof Error ? err.message : String(err) });
  }
}
