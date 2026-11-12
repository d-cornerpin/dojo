// Per reply, the model's verdict: does it claim, past tense, a send to someone other than the
// person being replied to? The claimed-delivery floor reads the verdict; the ledger still decides.

import { isBareNoReplySentinel } from '@dojo/shared';
import type { Question } from '../decide.js';
import { judgment } from '../decision-hooks.js';
import type { AgentTurnState } from './state.js';
import type { PostCallClassifyContext } from './steps/post-call-classify/index.js';

const CLAIMS_SENT: Question = { type: 'noul', instructions: 'Does `reply` claim, in the past tense, that something was sent to someone other than the person being replied to?' };

/** Which reply a floor is reading: the agent, and the id of the model reply this iteration produced. */
export interface ReplyAt { readonly agentId: string; readonly messageId?: string }

/** Per agent, its newest reply and the verdict on it (the next reply replaces it, so this never grows). */
const asked = new Map<string, { messageId: string; said?: boolean; settled: Promise<void> }>();

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
    const e: { messageId: string; said?: boolean; settled: Promise<void> } = { messageId, settled: Promise.resolve() };
    e.settled = judgment('reply_claims/claims_sent_to_third_party', { agentId, state: stateForModel, questions: { claims_sent_to_third_party: CLAIMS_SENT } })
      .then((v) => { e.said = v?.claims_sent_to_third_party; }, () => undefined);
    asked.set(agentId, entry = e);
  }
  await entry.settled;
}

export function claimsSentToThirdParty(at: ReplyAt, ruleSaid: boolean): boolean {
  const e = asked.get(at.agentId);
  return e && e.messageId === at.messageId && e.said !== undefined ? e.said : ruleSaid;
}
