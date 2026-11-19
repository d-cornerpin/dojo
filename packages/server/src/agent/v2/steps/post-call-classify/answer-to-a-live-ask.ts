// Never-silent backstop: an auto-continued human task's only utterance is delivered as the answer, not
// demoted; a later terminal reply takes the answer key and `teardown/draft-reclassify.ts` demotes this one.

import { v4 as uuidv4 } from 'uuid';
import { stripMoodMarker } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { advance, type AgentTurnState } from '../../state.js';
import type { DisplayKind } from '@dojo/shared';

const logger = createLogger('v2-loop');

/** No `hasUnansweredUser`: it is true on every human turn, so keying on it would promote mid-work preamble. */
export interface LiveAskPromotionInputs {
  readonly interAgentTurn: boolean;
  readonly isHumanContinuation: boolean;
  readonly surfacedReplyThisTurn: boolean;
  readonly startAckRepliedNow: () => boolean;
}

export function answersALiveAsk(p: LiveAskPromotionInputs): boolean {
  if (p.interAgentTurn) return false;
  if (p.surfacedReplyThisTurn || p.startAckRepliedNow()) return false;
  return p.isHumanContinuation;
}

export interface LiveAskPromotionResult {
  readonly state: AgentTurnState;
  readonly answerId: string;
}

/** Delivers the text in place as the turn's answer, with no origin stamp (an `engine-ack` settles nothing).
 *  The id is minted here, since reusing `messageId` would make this pass's `tool_use` INSERT a no-op, and
 *  `noteTerminalAnswer` is required for an ended turn to keep the bubble.
 *  Never sets `compileGateSatisfied`: only an owed compile discharges that duty. */
export async function deliverAsAnswerToLiveAsk(
  state: AgentTurnState,
  p: LiveAskPromotionInputs & {
    readonly agentId: string;
    readonly turnNumber: number;
    readonly answer: string;
    readonly deliverEngineUserAck: (
      text: string, originIntent: string | null, reuseId?: string | null, displayKind?: DisplayKind | null,
    ) => Promise<void>;
    readonly noteTerminalAnswer: (rowId: string, surface: string) => void;
  },
): Promise<LiveAskPromotionResult> {
  const answerId = uuidv4();
  await p.deliverEngineUserAck(p.answer, null, answerId, 'agent-text');
  p.noteTerminalAnswer(answerId, 'the answer to a live ask, delivered from the round it was composed in');
  const next = advance(state, {
    lastAssistantTextForIM: stripMoodMarker(p.answer),
    surfacedReplyThisTurn: true,
  });
  logger.info('v2 never-silent invariant: a continued human task would have ended with its only utterance demoted; delivered as the answer now instead of as a note nobody reads', {
    agentId: p.agentId, turnNumber: p.turnNumber, basis: 'human-continuation',
    answerId, chars: p.answer.length, preview: p.answer.slice(0, 60),
  }, p.agentId);
  return { state: next, answerId };
}
