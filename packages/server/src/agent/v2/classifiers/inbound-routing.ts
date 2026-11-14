// A person's message is work when it asks for a job of several steps and, as a reply, is not only a decline; a decline left
// unanswered, or a step answer between the lines, is neither; no answer falls to the word list. A helper's note: finished work?

import type { Question } from '../../decide.js';
import { judgment, type Ask } from '../../decision-hooks.js';
import { getDb } from '../../../db/connection.js';
import { NON_ANSWERING_DISPLAY_KINDS } from '../../../work/ask-settlement.js';
import type { TurnRoot } from '../../turn-context.js';
import { START_ACK_ORIGIN_INTENT } from '../../../memory/origin-intents.js';
import { withSessionBoundary } from '../../../memory/session-boundary.js';

const SEVERAL_STEPS: Question = { type: 'noul', instructions: "Does `message` ask the assistant to do a job that takes several steps, such as researching, comparing, planning, organizing, or producing something over time? If `previous_agent_message` is given, `message` is the person's reply to it.",
  criteria: { true: 'Yes: the person hands over a job of several steps, even in a few words.', false: 'No: chat, news, thanks, a correction, never mind, one question, or one quick action.' } };
/** Asked beside SEVERAL_STEPS when a previous message is attached: a yes here makes a work verdict not work. */
const DECLINED: Question = { type: 'noul', instructions: 'Does `message` only decline, put off, or acknowledge what `previous_agent_message` offered or said? A yes with a condition, or any request, is not.',
  criteria: { true: 'Yes: it declines, postpones or just acknowledges, such as "no leave it", "no, don\'t send it", "maybe later", "ok thanks", "thx!", "got it", "nvm".', false: 'No: it accepts, even with a condition, or asks for something, such as "yes go ahead", "please do", "yes but only weekdays", "all of it please", or a new request.' } };
const DELIVERABLE: Question = { type: 'noul', instructions: 'Does `message` announce that a finished piece of work (a document, post, link, file or result) is ready for someone to receive?' };

/** The tail of the agent's last reply in this conversation and session before the message (not the engine's start line), so
 *  "yes, do it" reads as the reply it is. At most 1,500 characters, starting at a line or a sentence. */
const PREVIOUS_CHARS = 1_500;
function previousAgentMessage(agentId: string, root: TurnRoot | null | undefined): string | null {
  if (!root?.conversationId) return null;
  try {
    const session = withSessionBoundary(agentId);
    const text = (getDb().prepare(
      `SELECT content FROM messages WHERE agent_id = ? AND conversation_id = ? AND role = 'assistant'
         AND display_kind NOT IN (${NON_ANSWERING_DISPLAY_KINDS.map(() => '?').join(', ')}) AND COALESCE(origin_intent, '') <> ?${session.sql}
         AND rowid < (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid DESC LIMIT 1`,
    ).get(agentId, root.conversationId, ...NON_ANSWERING_DISPLAY_KINDS, START_ACK_ORIGIN_INTENT, ...session.params, root.id) as { content: string } | undefined)?.content;
    if (text === undefined || text.length <= PREVIOUS_CHARS) return text ?? null;
    const tail = text.slice(-PREVIOUS_CHARS);
    const start = /[\n.!?]\s+(?=\S)/.exec(tail);
    return start ? tail.slice(start.index + start[0].length) : tail;
  } catch { return null; }
}

// With no answer from the model: two action verbs joined by a conjunction or a new sentence, or three anywhere, is work.
const ACTION_VERBS = new Set([
  'pull', 'fetch', 'get', 'grab', 'download', 'retrieve', 'send', 'email', 'message', 'text', 'imessage', 'post', 'publish',
  'create', 'make', 'build', 'generate', 'draft', 'write', 'compose', 'summarize', 'summarise', 'compile', 'aggregate', 'gather',
  'find', 'search', 'look', 'lookup', 'investigate', 'check', 'research', 'compare', 'contrast', 'weigh',
  'update', 'edit', 'change', 'modify', 'fix', 'patch', 'delete', 'remove', 'clear', 'archive',
  'schedule', 'plan', 'organize', 'organise', 'analyze', 'analyse', 'review', 'audit', 'evaluate', 'remind', 'notify', 'alert',
  'export', 'import', 'backup', 'restore', 'attach', 'upload', 'save', 'split', 'divide', 'distribute', 'combine',
]);
const CONJUNCTIONS = new Set(['and', 'then', 'also', 'plus', 'after', 'next']);
/** A word after one of these is a noun ("any new emails"), not an action. */
const NOUN_AFTER = new Set([
  'any', 'the', 'a', 'an', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'some', 'this', 'that', 'these', 'those',
  'few', 'several', 'many', 'all', 'no', 'every', 'each', 'another', 'such', 'new', 'old', 'recent', 'latest', 'pending', 'unread',
]);
const VERB_ENDINGS: ReadonlyArray<[RegExp, string]> = [[/s$/, ''], [/ed$/, ''], [/ed$/, 'e'], [/ing$/, ''], [/ing$/, 'e']];
const isVerb = (word: string): boolean => ACTION_VERBS.has(word) || VERB_ENDINGS.some(([end, stem]) => end.test(word) && ACTION_VERBS.has(word.replace(end, stem)));
function wordListSaysWork(message: string): boolean {
  const lower = message.toLowerCase();
  const words = lower.replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  const verbs = words.filter((w, i) => isVerb(w) && !NOUN_AFTER.has(words[i - 1] ?? '')).length;
  const joins = words.filter((w) => CONJUNCTIONS.has(w)).length + (lower.match(/[.!?;\n]+\s+(?=[a-z0-9])/g) ?? []).length;
  return verbs >= 3 || (verbs >= 2 && joins >= 1);
}

/** Each turn is judged once, however many times it is assembled and whichever reader asks first. */
const judged = new WeakMap<object, Promise<{ work: boolean | undefined; declined: boolean }>>();

export function inboundIsWork(turnCtx: { root?: TurnRoot | null }, agentId: string, message: string): Promise<boolean | undefined> {
  let said = judged.get(turnCtx);
  if (!said) {
    const previous = message.trim() ? previousAgentMessage(agentId, turnCtx.root) : null;
    const ask: Ask = previous === null
      ? { agentId, state: { message }, questions: { needs_several_steps: SEVERAL_STEPS } }
      : { agentId, state: { message, previous_agent_message: previous }, questions: { needs_several_steps: SEVERAL_STEPS, declined: DECLINED } };
    said = message.trim()
      ? judgment('inbound_routing', ask).then((v) => ({
        work: v === null ? (wordListSaysWork(message) || undefined) : v.needs_several_steps && (previous === null || v.declined !== undefined ? !v.declined : undefined),
        declined: v?.declined === true,
      }))
      : Promise.resolve({ work: undefined, declined: false });
    judged.set(turnCtx, said);
  }
  return said.then((v) => v.work);
}

/** The turn's message only declined or acknowledged the agent's last one, so it asks for nothing; unjudged reads no. */
export const inboundAsksNothing = async (turnCtx: object): Promise<boolean> => (await judged.get(turnCtx))?.declined ?? false;

export const deliverableJudged = async (agentId: string, payload: string, rule: boolean): Promise<boolean> =>
  (await judgment('inbound_routing/deliverable', { agentId, state: { message: payload }, questions: { asked: DELIVERABLE } }))?.asked ?? rule;
