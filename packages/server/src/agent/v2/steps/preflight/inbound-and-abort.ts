// Resolves the turn's inbound channel and builds the abort revert, which marks the turn for its hand-back at
// finalize (`steps/teardown/finalize-record.ts` hands back the ask and the engine event).

import { resolveInbound, type InboundChannel } from '../../inbound-channel.js';
import { findUnrepliedAssignForAgent, type UnrepliedAssign } from '../../../a2a-replies.js';
import type { WaitingConversation } from '../../counterparty.js';
import type { ChannelInboundContext } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';

export interface InboundAndAbortInputs {
  readonly triggerRow: WaitingConversation['latest'];
  readonly lastUserMessageContent: string;
}

export interface InboundAndAbortOutputs {
  readonly revertTriggerStampOnAbort: () => void;
  readonly triggeredByIMessage: boolean;
  readonly inboundChannel: InboundChannel;
  readonly inboundContext: ChannelInboundContext | null;
  readonly unrepliedAssign: UnrepliedAssign | null;
}

export function runInboundAndAbort(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  input: InboundAndAbortInputs,
): InboundAndAbortOutputs {
  const { agentId } = ctx;
  const { triggerRow, lastUserMessageContent } = input;
  // A no-answer abort: finalize hands back the ask and the engine event by the turn's exit.
  const revertTriggerStampOnAbort = () => { turnCtx.abortHandBack = true; };
  const triggeredByIMessage = lastUserMessageContent?.includes('[SOURCE: IMESSAGE FROM') ?? false;
  // One resolver for the inbound channel and reply context; the reply-destination resolver reads them.
  const resolvedInbound = resolveInbound({
    agentId,
    content: lastUserMessageContent,
    channel: triggerRow?.channel ?? null,
    inboundMeta: triggerRow?.inbound_meta ?? null,
  });
  const inboundChannel = resolvedInbound.inboundChannel;
  const inboundContext = resolvedInbound.inboundContext;
  // A live phone call streams sentence chunks to TTS while the model is still generating.
  if (inboundChannel === 'phone' && inboundContext?.phoneCallSid) {
    turnCtx.phoneStreamCallSid = inboundContext.phoneCallSid;
  }
  // Null once the latest ASSIGN/QUESTION/BLOCK was replied to (durable a2a_replies), so the enforcer
  // never fires twice for an inbound already handled.
  const unrepliedAssign = findUnrepliedAssignForAgent(agentId);

  return {
    revertTriggerStampOnAbort, triggeredByIMessage,
    inboundChannel, inboundContext, unrepliedAssign,
  };
}
