// Resolves the turn's inbound channel and builds the abort revert, which hands back both claims (the
// human ask and the engine event) when a turn aborts with no answer.

import { resolveInbound, type InboundChannel } from '../../inbound-channel.js';
import { findUnrepliedAssignForAgent, type UnrepliedAssign } from '../../../a2a-replies.js';
import { releaseEngineEventByRowid } from '../../../../memory/message-store.js';
import { recordEngineEventDeliveryFailure, type WaitingConversation } from '../../counterparty.js';
import { revertAskClaimOnAbort, noteUnsettled } from '../../../../work/store.js';
import type { ChannelInboundContext } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext, PreflightScratch } from './index.js';

export interface InboundAndAbortInputs {
  readonly triggerRow: WaitingConversation['latest'];
  readonly triggerWorkId: string | null;
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
  sc: PreflightScratch,
  input: InboundAndAbortInputs,
): InboundAndAbortOutputs {
  const { agentId } = ctx;
  const { triggerRow, triggerWorkId, lastUserMessageContent } = input;
  // Hands a stranded ask back to the waiting set so the runtime drain re-serves it after a transient
  // failure. Only on no-answer abort paths, and refused once the turn made a side effect (read live from
  // the bag at abort time), or the ask would be answered or acted on twice.
  const revertTriggerStampOnAbort = () => {
    if (triggerWorkId) {
      try {
        noteUnsettled(revertAskClaimOnAbort(
          triggerWorkId, turnCtx.state!.nonIdempotentCallsThisTurn,
          'turn aborted with no answer; handing the ask back to the waiting set (N-1)',
        ), 'v2: ask hand-back on abort', { workId: triggerWorkId });
      } catch { /* best effort, recovery, never block the abort */ }
    }
    // Same for an engine trigger: release our own claim and record the failed delivery so the retry
    // timer re-serves it (bounded), only when the turn made no side effect.
    if (sc.claimedEngineEvent != null) {
      try {
        if (turnCtx.state!.nonIdempotentCallsThisTurn === 0) {
          const reverted = releaseEngineEventByRowid({
            rowid: sc.claimedEngineEvent.rowid, agentId, turnNumber: sc.claimedEngineEvent.turnNumber,
          });
          if (reverted > 0) recordEngineEventDeliveryFailure(agentId, sc.claimedEngineEvent.rowid);
        }
      } catch { /* best effort, recovery, never block the abort */ }
    }
  };
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
