// Two judgments about an arrived message. A person's message: does it hand over a job of several steps (yes: work, no:
// chat, between the lines: neither)? A helper's note: does it deliver finished work (its rule answers without a model)?

import type { Question } from '../../decide.js';
import { judgment } from '../../decision-hooks.js';
import { getDb } from '../../../db/connection.js';
import { NON_ANSWERING_DISPLAY_KINDS } from '../../../work/ask-settlement.js';
import type { TurnRoot } from '../../turn-context.js';
import { START_ACK_ORIGIN_INTENT } from '../../../memory/origin-intents.js';

const SEVERAL_STEPS: Question = { type: 'noul', instructions: "Does `message` ask the assistant to do a job that takes several steps, such as researching, comparing, planning, organizing, or producing something over time? If `previous_agent_message` is given, `message` is the person's reply to it.",
  criteria: { true: 'Yes: the person hands over a job of several steps, even in a few words.', false: 'No: chat, news, thanks, a correction, never mind, one question, or one quick action.' } };
const DELIVERABLE: Question = { type: 'noul', instructions: 'Does `message` announce that a finished piece of work (a document, post, link, file or result) is ready for someone to receive?' };

/** The tail of the agent's last reply in this conversation before the message (not the engine's start line), so
 *  "yes, do it" reads as the reply it is. At most 1,500 characters, starting at a line or a sentence. */
const PREVIOUS_CHARS = 1_500;
function previousAgentMessage(agentId: string, root: TurnRoot | null | undefined): string | null {
  if (!root?.conversationId) return null;
  try {
    const text = (getDb().prepare(
      `SELECT content FROM messages WHERE agent_id = ? AND conversation_id = ? AND role = 'assistant'
         AND display_kind NOT IN (${NON_ANSWERING_DISPLAY_KINDS.map(() => '?').join(', ')}) AND COALESCE(origin_intent, '') <> ?
         AND rowid < (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid DESC LIMIT 1`,
    ).get(agentId, root.conversationId, ...NON_ANSWERING_DISPLAY_KINDS, START_ACK_ORIGIN_INTENT, root.id) as { content: string } | undefined)?.content;
    if (text === undefined || text.length <= PREVIOUS_CHARS) return text ?? null;
    const tail = text.slice(-PREVIOUS_CHARS);
    const start = /[\n.!?]\s+(?=\S)/.exec(tail);
    return start ? tail.slice(start.index + start[0].length) : tail;
  } catch { return null; }
}

/** Each turn is judged once, however many times it is assembled and whichever reader asks first. */
const judged = new WeakMap<object, Promise<boolean | undefined>>();

/** True: the person handed over a job of several steps; false: chat; undefined: between the lines, or no answer. */
export function inboundIsWork(turnCtx: { root?: TurnRoot | null }, agentId: string, message: string): Promise<boolean | undefined> {
  let said = judged.get(turnCtx);
  if (!said) {
    const previous = message.trim() ? previousAgentMessage(agentId, turnCtx.root) : null;
    const state = previous === null ? { message } : { message, previous_agent_message: previous };
    said = message.trim()
      ? judgment('inbound_routing/needs_several_steps', { agentId, state, questions: { asked: SEVERAL_STEPS } }).then((v) => v?.asked)
      : Promise.resolve(undefined);
    judged.set(turnCtx, said);
  }
  return said;
}

export const deliverableJudged = async (agentId: string, payload: string, rule: boolean): Promise<boolean> =>
  (await judgment('inbound_routing/deliverable', { agentId, state: { message: payload }, questions: { asked: DELIVERABLE } }))?.asked ?? rule;
