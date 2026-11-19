// Resolves the turn's inbound channel and builds the abort revert, which marks the turn for its hand-back at
// finalize (`steps/teardown/finalize-record.ts` hands back the ask and the engine event).

import { resolveInbound, type InboundChannel } from '../../inbound-channel.js';
import type { WaitingConversation } from '../../counterparty.js';
import type { ChannelInboundContext } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';

export interface InboundAndAbortInputs {
  readonly triggerRow: WaitingConversation['latest'];
  /** A job turn's request row: its channel is the turn's, though no fresh message triggered it. */
  readonly jobRow?: WaitingConversation['latest'];
  readonly lastUserMessageContent: string;
}

export interface InboundAndAbortOutputs {
  readonly revertTriggerStampOnAbort: () => void;
  readonly triggeredByIMessage: boolean;
  readonly inboundChannel: InboundChannel;
  readonly inboundContext: ChannelInboundContext | null;
}

export function runInboundAndAbort(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  input: InboundAndAbortInputs,
): InboundAndAbortOutputs {
  const { agentId } = ctx;
  const { triggerRow, jobRow, lastUserMessageContent } = input;
  const row = triggerRow ?? jobRow;
  // A no-answer abort: finalize hands back the ask and the engine event by the turn's exit.
  const revertTriggerStampOnAbort = () => { turnCtx.abortHandBack = true; };
  const triggeredByIMessage = lastUserMessageContent?.includes('[SOURCE: IMESSAGE FROM') ?? false;
  // One resolver for the inbound channel and reply context; the reply-destination resolver reads them.
  const resolvedInbound = resolveInbound({
    agentId,
    content: lastUserMessageContent ?? row?.content ?? null,
    channel: row?.channel ?? null,
    inboundMeta: row?.inbound_meta ?? null,
  });
  const inboundChannel = resolvedInbound.inboundChannel;
  const inboundContext = resolvedInbound.inboundContext;
  // A live phone call streams sentence chunks to TTS while the model is still generating.
  if (triggerRow && inboundChannel === 'phone' && inboundContext?.phoneCallSid) {
    turnCtx.phoneStreamCallSid = inboundContext.phoneCallSid;
  }

  return { revertTriggerStampOnAbort, triggeredByIMessage, inboundChannel, inboundContext };
}
