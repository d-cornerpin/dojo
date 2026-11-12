// Two judgments about an arrived message: simple_chat via complexityClassifier,
// deliverable via the caller's rule; the model answers, these are the fallback.

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

export function isConversational(turnCtx: object, agentId: string, message: string): Promise<boolean> {
  let said = conversational.get(turnCtx);
  if (!said) {
    const rule = complexityClassifier(message).complexity === 'simple';
    said = message.trim() ? yesNo('inbound_routing/simple_chat', agentId, message, SIMPLE_CHAT, rule) : Promise.resolve(rule);
    conversational.set(turnCtx, said);
  }
  return said;
}

export const deliverableJudged = (agentId: string, payload: string, rule: boolean): Promise<boolean> =>
  yesNo('inbound_routing/deliverable', agentId, payload, DELIVERABLE, rule);
