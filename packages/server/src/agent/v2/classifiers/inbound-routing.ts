// The two judgments about an arrived message the decision model answers, each falling to its rule:
//   simple_chat   is it a simple conversational ask?                      rule: `complexityClassifier`
//   deliverable   is a sub-agent's FYI a finished deliverable (it wakes the primary)?   rule: the caller's

import type { Question } from '../../decide.js';
import { judgment } from '../../decision-hooks.js';
import { complexityClassifier } from './complexity.js';

const SIMPLE_CHAT: Question = { type: 'noul', instructions: 'Is `message` a simple conversational ask: a greeting, thanks, an acknowledgement, or a one-line question or request that needs no plan?' };
const DELIVERABLE: Question = { type: 'noul', instructions: 'Does `message` announce that a finished piece of work (a document, post, link, file or result) is ready for someone to receive?' };

async function yesNo(question: string, agentId: string, message: string, asked: Question, rule: boolean): Promise<boolean> {
  return (await judgment(question, { agentId, state: { message }, questions: { asked } }))?.asked ?? rule;
}

/** Each turn is judged once, however many times it is assembled. */
const conversational = new WeakMap<object, Promise<boolean>>();

/** Is this turn a quick conversational ask? */
export function isConversational(turnCtx: object, agentId: string, message: string): Promise<boolean> {
  let said = conversational.get(turnCtx);
  if (!said) {
    const rule = complexityClassifier(message).complexity === 'simple';
    said = message.trim() ? yesNo('inbound_routing/simple_chat', agentId, message, SIMPLE_CHAT, rule) : Promise.resolve(rule);
    conversational.set(turnCtx, said);
  }
  return said;
}

/** Is a sub-agent's FYI to the primary really a deliverable, so it wakes the primary? */
export const deliverableJudged = (agentId: string, payload: string, rule: boolean): Promise<boolean> =>
  yesNo('inbound_routing/deliverable', agentId, payload, DELIVERABLE, rule);
