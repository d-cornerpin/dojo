// Per reply, the model's verdicts on what it claims, in one request; the floors' receipts still decide.
// A turn that opened a work row is not asked about a standing promise: the row is where that promise is kept.

import { isBareNoReplySentinel } from '@dojo/shared';
import type { Question } from '../decide.js';
import { judgment } from '../decision-hooks.js';
import type { AgentTurnState } from './state.js';
import type { PostCallClassifyContext } from './steps/post-call-classify/index.js';

const QUESTIONS = {
  claims_sent_to_third_party: { type: 'noul', instructions: 'Does `reply` say the agent itself already sent or said something to someone other than the person it is replying to?',
    criteria: { true: "The agent already sent it: \"Texted Mom the time\", \"Shared the list with Alex\", \"Pinged the group\", \"I've asked Sam\", \"Sam has been notified\"", false: 'The agent did not send anything: it plans or offers to, says it has not, refuses, sent it to the person themself ("sent you"), or reports what someone else sent or said ("the pharmacy texted")' } },
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
      reply,
      last_user_message: ctx.lastUserMessageContent ?? null,
      tool_calls_this_turn: state.toolResults.map((r) => r.name).filter(Boolean),
    };
    const { standing_promise, ...rest } = QUESTIONS;
    const questions = openedWorkThisTurn(ctx) ? rest : { ...rest, standing_promise };
    const e: { messageId: string; said?: Partial<Record<ReplyClaim, boolean>>; settled: Promise<void> } = { messageId, settled: Promise.resolve() };
    e.settled = judgment('reply_claims', { agentId, state: stateForModel, questions })
      .then((v) => { e.said = v ?? undefined; }, () => undefined);
    asked.set(agentId, entry = e);
  }
  await entry.settled;
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
