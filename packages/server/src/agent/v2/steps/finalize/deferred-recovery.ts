// Deferred-reply recovery: a waiting human whose only reply text rode with a tool call (so it was
// not shown mid-turn) gets that text delivered here instead of silence.

import { v4 as uuidv4 } from 'uuid';
import { stripMoodMarker } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent, retireById } from '../../../../memory/message-store.js';
import { decideClaimedDelivery } from '../../claimed-delivery.js';
import { findRecentDeliveriesKeyed } from '../../outbound-ledger.js';
import { advance, type AgentTurnState } from '../../state.js';
import { turnParkedTheJob } from '../../engine-exit.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

/** Returns the advanced state; a whole-state `advance`, so `validate()` still runs. */
export function recoverDeferredReply(state: AgentTurnState, ctx: FinalizeContext): AgentTurnState {
  const { agentId, turnNumber, turnCtx, counterparty, broadcast, noteTerminalAnswer } = ctx;

  // Runs only when no tool-less reply landed (lastAssistantTextForIM unset), so never a double reply.
  // Skipped when the turn parked the job: the work goes on, its continuation gives the real answer,
  // and the held-back line stays a working note.
  const continuing = turnParkedTheJob(agentId);
  if (turnCtx.deferredUserReplyWithTools && !state.lastAssistantTextForIM && continuing) {
    logger.info('v2 G-SUP-2 recovery skipped: the engine is continuing this work; the held-back line stays a working note', {
      agentId, turnNumber,
    }, agentId);
  }
  if (turnCtx.deferredUserReplyWithTools && !state.lastAssistantTextForIM && !continuing) {
    const recoveredId = uuidv4();
    try {
      // The loop has exited, so a delivery claim the ledger contradicts is only logged, then still
      // delivered: a waiting human must not be left in silence.
      try {
        const g = decideClaimedDelivery({
          agentId, turnNumber, responseText: turnCtx.deferredUserReplyWithTools,
          toolCallsThisTurn: state.toolResults.filter((r) => !r.isError).map((r) => ({ name: r.name })),
          counterpartyName: counterparty.name,
          hasDeliveryReceipt: (recipient) => findRecentDeliveriesKeyed(agentId, recipient, 24).length > 0,
        });
        if (g.fires) {
          logger.warn('v2 G-SUP-2 recovery: delivered text claims a delivery the LEDGER contradicts; no re-entry available at finalize', {
            agentId, turnNumber, recipient: g.recipient, basis: g.basis,
            obligationId: g.obligation?.id ?? null, failedDeliveryId: g.failedDeliveryId,
          }, agentId);
        }
      } catch { /* detection is best-effort; never block the recovery delivery */ }
      insertMessageIfAbsent({
        id: recoveredId, agentId, role: 'assistant',
        content: turnCtx.deferredUserReplyWithTools, turnNumber,
      });
      // Retire the working note the seam recorded, by id, never by text.
      if (turnCtx.deferredNoteId) { try { retireById(turnCtx.deferredNoteId); } catch { /* answer already stored */ } }
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: recoveredId, agentId, role: 'assistant' as const, content: turnCtx.deferredUserReplyWithTools,
          tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString(),
        },
      });
      state = advance(state, { lastAssistantTextForIM: stripMoodMarker(turnCtx.deferredUserReplyWithTools) });
    noteTerminalAnswer(recoveredId, 'recovered reply delivered');
      logger.info('v2 G-SUP-2 recovery: delivered deferred text-with-tools reply (turn ended with no tool-less reply)', {
        agentId, turnNumber,
      }, agentId);
    } catch (err) {
      logger.warn('v2 G-SUP-2 recovery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
    }
  }

  return state;
}
