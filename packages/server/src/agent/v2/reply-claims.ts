// Per reply, the model's verdicts on what it claims, in one request; the floors' receipts still decide.
// A turn that opened a work row is not asked about a standing promise: the row is where that promise is kept.

import { isBareNoReplySentinel, stripMoodMarker } from '@dojo/shared';
import type { Question } from '../decide.js';
import { judgment } from '../decision-hooks.js';
import type { AgentTurnState } from './state.js';
import type { PostCallClassifyContext } from './steps/post-call-classify/index.js';

const QUESTIONS = {
  claims_sent_to_third_party: { type: 'noul', instructions: 'Does `reply` claim, in the past tense, that something was sent to someone other than the person being replied to?' },
  only_promises_to_start: { type: 'noul', instructions: 'Does `reply` end with the agent saying it is starting the work now?',
    criteria: { true: "Starting now: \"Let me check\", \"On it, working on it now\", \"I'll look into it and get back to you\"", false: 'Not starting: an answer, a result, a question, an offer that waits for a yes, a promise to watch for something later, a refusal, or small talk' } },
  standing_promise: { type: 'noul', instructions: 'Does `reply` contain the agent promising how it will act from now on, on every future occasion?',
    criteria: { true: "The agent commits to a lasting habit: \"From now on I'll...\", \"I'll always...\", \"I'll never ... again\", \"Short replies from here on\"", false: "A one-time promise, a reminder or schedule that repeats, someone else's rule, advice, or \"I'm always here\"" } },
  asserts_board_state: { type: 'noul', instructions: "Does `reply` say when one of the person's reminders, alarms, appointments or tasks is set for, or whether one is still pending, paused, waiting or open?",
    criteria: { true: 'Yes: it states the status of a reminder, alarm, appointment, calendar entry or task: "the reminder is set for 5pm", "it goes off Friday", "the task is on hold", "nothing is scheduled Sunday"', false: 'No: it gives other information, or a status taken from someone else ("the airline says", "the shop says")' } },
} satisfies Record<string, Question>;
export type ReplyClaim = keyof typeof QUESTIONS;

/** Which reply a floor is reading: the agent, and the id of the model reply this iteration produced. */
export interface ReplyAt { readonly agentId: string; readonly messageId?: string }

/** Per agent, its newest reply and the verdict on it (the next reply replaces it, so this never grows). */
const asked = new Map<string, { messageId: string; said?: Partial<Record<ReplyClaim, boolean>>; settled: Promise<void> }>();

/** Ask about this reply once, however many floors read it, and wait for the answer (or its failure). Never throws. */
export async function askReplyClaims(state: AgentTurnState, ctx: PostCallClassifyContext, reply: string | null): Promise<void> {
  const { agentId, messageId, result } = ctx;
  if (!messageId || !reply?.trim() || result.toolCalls.length > 0 || isBareNoReplySentinel(reply)) return;
  let entry = asked.get(agentId);
  if (entry?.messageId !== messageId) {
    const stateForModel = {
      reply: stripMoodMarker(reply),
      last_user_message: ctx.lastUserMessageContent ?? null,
      tool_calls_this_turn: state.toolResults.map((r) => r.name).filter(Boolean),
    };
    const { standing_promise, ...rest } = QUESTIONS;
    const questions = openedWorkThisTurn(ctx) ? rest : { ...rest, standing_promise };
    const e: { messageId: string; said?: Partial<Record<ReplyClaim, boolean>>; settled: Promise<void> } = { messageId, settled: Promise.resolve() };
    e.settled = judgment('reply_claims', { agentId, state: stateForModel, questions })
      .then((v) => { e.said = v ? withListInBand(v, questions, reply) : undefined; }, () => undefined);
    asked.set(agentId, entry = e);
  }
  await entry.settled;
}

// The word lists that answer standing_promise and asserts_board_state inside the model's unsure band (an asked
// question the model left without a verdict); outside the band, and with no answer at all, they are not read.
const STANDING_SCOPE_PATTERNS: readonly RegExp[] = [
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bmoving forward\b/i,
  /\bfrom here on(?: out)?\b/i,
  /\b(?:every|each) time\b/i,
  /\bwhenever\b/i,
  /\bany time (?:you|that|there|a|an|the)\b/i,
  /\bin (?:the )?future\b/i,
];
const FIRST_PERSON_COMMITMENT = /\bi(?:'|’)?ll\b|\bi will\b|\bi(?:'|’)?m going to\b/i;
const DISCLOSED_INABILITY =
  /\bi\s(?:can(?:no|’|')?t|cannot|won(?:’|')?t be able|am not able|(?:’|')?m not able|do(?:n(?:’|')?t| not) have)\b/i;

function isStandingPromiseReply(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (s.includes('?')) return false;
  if (DISCLOSED_INABILITY.test(s)) return false;
  const sentences = s.split(/(?<=[.!])\s+/).map((x) => x.trim()).filter(Boolean);
  return (sentences.length > 0 ? sentences : [s]).some(
    (sentence) => STANDING_SCOPE_PATTERNS.some((re) => re.test(sentence))
      && FIRST_PERSON_COMMITMENT.test(sentence),
  );
}

const STANDING_STATE_PATTERNS: readonly RegExp[] = [
  /\bon deck\b/i,
  /\bstill (?:parked|pending|outstanding|owed|queued|scheduled|set|booked|waiting|unresolved|in progress)\b/i,
  /\bschedule (?:is |looks |remains )?intact\b/i,
  /\bwill (?:still )?(?:fire|go off|run|trigger|remind you|nudge you|ping you|kick off)\b/i,
  /\b(?:on|in) (?:the|your) (?:books|board|tracker|calendar|schedule|queue)\b/i,
  /\b(?:remains?|stays?) (?:on|set|scheduled|open|pending|parked|unchanged|in place)\b/i,
];
const DISCLOSED_FROM_MEMORY =
  /\bfrom memory\b|\bgoing (?:off|from) memory\b|\bwithout checking\b|\bnot (?:yet )?verified\b|\b(?:have|has|did|do)(?:n(?:’|')?t| not)\s+(?:re-?)?check(?:ed)?\b|\bi(?:’|')?d need to (?:check|look)\b/i;

function standingStateClaimSentence(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (DISCLOSED_FROM_MEMORY.test(s)) return null;
  const sentences = s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  for (const sentence of sentences.length > 0 ? sentences : [s]) {
    if (sentence.includes('?')) continue;
    if (STANDING_STATE_PATTERNS.some((re) => re.test(sentence))) return sentence;
  }
  return null;
}

const LIST_IN_BAND: Partial<Record<ReplyClaim, (reply: string) => boolean>> = {
  standing_promise: isStandingPromiseReply,
  asserts_board_state: (reply) => standingStateClaimSentence(reply) !== null,
};
function withListInBand(said: Partial<Record<ReplyClaim, boolean>>, asked: object, reply: string): Partial<Record<ReplyClaim, boolean>> {
  const out = { ...said };
  for (const [name, list] of Object.entries(LIST_IN_BAND) as Array<[ReplyClaim, (r: string) => boolean]>) {
    if (name in asked && out[name] === undefined) out[name] = list(reply);
  }
  return out;
}

/** Did this turn open a work row (a task, a schedule, a commitment)? Such a row records any lasting promise. A read
 *  that cannot run says no, so the standing promise is still asked. */
function openedWorkThisTurn({ db, agentId, turnNumber }: PostCallClassifyContext): boolean {
  try {
    return !!db.prepare('SELECT 1 FROM work w WHERE (w.agent_id = ? OR w.requester_id = ?) AND w.origin_turn = ? LIMIT 1').get(agentId, agentId, turnNumber);
  } catch { return false; }
}

export function replyClaim(at: ReplyAt, name: ReplyClaim): boolean | undefined {
  const e = asked.get(at.agentId);
  return e && e.messageId === at.messageId ? e.said?.[name] : undefined;
}
