// Per reply, the model's verdicts on what it claims, in one request; the floors' receipts still decide.

import { isBareNoReplySentinel } from '@dojo/shared';
import type { Question } from '../decide.js';
import { judgment } from '../decision-hooks.js';
import type { AgentTurnState } from './state.js';
import type { PostCallClassifyContext } from './steps/post-call-classify/index.js';

const QUESTIONS = {
  claims_sent_to_third_party: { type: 'noul', instructions: 'Does `reply` claim, in the past tense, that something was sent to someone other than the person being replied to?' },
  only_promises_to_start: { type: 'noul', instructions: 'Does `reply` END by promising to begin work, with nothing delivered yet?', criteria: { true: 'Let me pull that up; give me a minute', false: 'Delivers content, asks a question, or says "let me know"' } },
  standing_promise: { type: 'noul', instructions: 'Does `reply` promise a behavior for every future occasion?' },
  asserts_board_state: { type: 'noul', instructions: 'Does `reply` assert the current status of scheduled or parked work?' },
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
    const e: { messageId: string; said?: Partial<Record<ReplyClaim, boolean>>; settled: Promise<void> } = { messageId, settled: Promise.resolve() };
    e.settled = judgment('reply_claims', { agentId, state: stateForModel, questions: QUESTIONS })
      .then((v) => { e.said = v ?? undefined; }, () => undefined);
    asked.set(agentId, entry = e);
  }
  await entry.settled;
}

export function replyClaim(at: ReplyAt, name: ReplyClaim): boolean | undefined {
  const e = asked.get(at.agentId);
  return e && e.messageId === at.messageId ? e.said?.[name] : undefined;
}
