// The Dreamer's filler judgment, answered by the decision model: at the end of a triage pass each short message the rule
// judged (`vault/filler.ts`) is asked about on its own, and the verdicts are handed back to the rule for the passes that
// follow. Filler is little content and much narration, weighed together; with no answer the rule stands.

import { createLogger } from '../logger.js';
import type { Question } from '../agent/decide.js';
import { judgment } from '../agent/decision-hooks.js';
import { takeFillerCandidates, setFillerVerdicts } from '../vault/filler.js';

const logger = createLogger('memory-shape');

const QUESTIONS: Record<string, Question> = {
  content: { type: 'noul', instructions: 'Does `message` contain a fact, a decision, a choice, an instruction, a preference, a date, an amount, a name, a promise or an outcome?',
    criteria: { true: "ok, but only the small one / the plumber's number is 555-0142 / Booked the vet for Friday 10am / I will drop the parcel off tomorrow", false: 'thank you so much! / okay great / Let me look into that now / Hi, hope you are well' } },
  narr: { type: 'noul', instructions: 'Is `message` only a note that the speaker is starting or doing a task right now, with no result, fact or promise for later?',
    criteria: { true: 'On it, checking the folder now / Let me look that up / Reading the file now', false: 'I will call the school tomorrow at 9 / The folder has 12 files / Done, the order is placed' } },
};
const fillerOf = (p: Record<string, number>): number => ((1 - p.content) + p.narr) / 2;

/** Ends a triage pass (`beginFillerPass` … here). Never throws. */
export async function settleFiller(agentId: string): Promise<void> {
  const verdicts = new Map<string, boolean>();
  try {
    for (const [message, , key] of takeFillerCandidates()) {
      const said = await judgment('memory_shape/filler', { agentId, state: { message }, questions: QUESTIONS, combine: fillerOf });
      if (!said) break;   // not on the model on this box, or no answer: the rule decides the rest
      if (said.filler !== undefined) verdicts.set(key, said.filler);
    }
  } catch (err) {
    verdicts.clear();
    logger.warn('the filler judgments failed; the rule decided', { error: err instanceof Error ? err.message : String(err) });
  }
  setFillerVerdicts(verdicts);
}
