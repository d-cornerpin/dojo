// The Dreamer's filler judgment, answered by the decision model: at the end of a triage pass the short messages the
// rule judged (`vault/filler.ts`) are asked about in requests of at most 64, and the model's verdicts are handed back
// to the rule for the passes that follow. With no answer the rule stands.

import { createLogger } from '../logger.js';
import type { Question } from '../agent/decide.js';
import { judgment } from '../agent/decision-hooks.js';
import { takeFillerCandidates, setFillerVerdicts } from '../vault/filler.js';

const logger = createLogger('memory-shape');
const MAX_QUESTIONS_PER_CALL = 64;   // `decide()`'s documented limit for one request

/** Ends a triage pass (`beginFillerPass` … here). Never throws. */
export async function settleFiller(agentId: string): Promise<void> {
  const verdicts = new Map<string, boolean>();
  try {
    const seen = takeFillerCandidates();
    for (let from = 0; from < seen.length; from += MAX_QUESTIONS_PER_CALL) {
      const chunk = seen.slice(from, from + MAX_QUESTIONS_PER_CALL);
      const questions: Record<string, Question> = {};
      const state: Record<string, string> = {};
      chunk.forEach(([text], i) => {
        state[`m${i}`] = text;
        questions[`m${i}`] = { type: 'noul', instructions: `Is \`m${i}\` conversational filler or process narration, such as an acknowledgement, "let me check" or "thanks", that carries nothing worth remembering?` };
      });
      const said = await judgment('memory_shape/filler', { agentId, state, questions });
      if (!said) continue;   // not on the model on this box, or no answer: the rule decides these
      chunk.forEach(([, , key], i) => { if (typeof said[`m${i}`] === 'boolean') verdicts.set(key, said[`m${i}`]); });
    }
  } catch (err) {
    verdicts.clear();
    logger.warn('the filler judgments failed; the rule decided', { error: err instanceof Error ? err.message : String(err) });
  }
  setFillerVerdicts(verdicts);
}
