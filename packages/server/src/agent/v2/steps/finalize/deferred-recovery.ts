// ════════════════════════════════════════
// PHASE-6 T9 (CUT 4) — G-SUP-2: THE ANSWER THAT RODE WITH A TOOL CALL
//
// Relocated verbatim from `agent/v2/loop.ts` (`:7857`–`:7912` at `0942fd9`), the
// first block of the `finalize` span. Bounds, wording and log lines unchanged.
//
// Its requirement got its first test in the commit BEFORE the move
// (`agent/v2/__tests__/integration.test.ts`, "PHASE-6 CUT 4"): a human is waiting,
// the turn's only user-facing text rode with a tool call and was therefore NOT shown
// as a mid-turn bubble, and the turn ended with no tool-less reply — so the
// remembered text is delivered here rather than the ask being answered by silence.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { stripMoodMarker } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { decideClaimedDelivery } from '../../claimed-delivery.js';
import { findRecentDeliveries, findRecentDeliveriesKeyed } from '../../outbound-ledger.js';
import { advance, type AgentTurnState } from '../../state.js';
import { continuationContext } from '../../../turn-state.js';
import { isStopFenced } from '../../../shared-state.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

/**
 * Returns the state it advanced. The block reassigns `state` exactly as it did inside
 * the lexical block — still a whole-state `advance`, so `validate()` still runs on it.
 */
export function recoverDeferredReply(state: AgentTurnState, ctx: FinalizeContext): AgentTurnState {
  const { agentId, turnNumber, turnCtx, counterparty, broadcast, noteTerminalAnswer } = ctx;

  // ── G-SUP-2 recovery (comms-audit) ──
  // A human was waiting, the only user-facing text this turn rode with tool
  // calls (deferred above as possible narration), and the turn delivered NO
  // proper tool-less reply (lastAssistantTextForIM still unset). Recover the
  // deferred text so the ask is answered, never silently dropped, deliver it
  // to the dashboard chat AND hand it to the channel router below. When a real
  // tool-less reply DID land, lastAssistantTextForIM is set and this is skipped,
  // so there is no double-reply.
  // ⚠ R-V333-11 (t139 round 4): NOT ON A TURN THE ENGINE IS CONTINUING. Live at v3.3.2 (t136
  // run bmv64ib0rkc, row #99007) the 15-minute park turned a narration line the model had written
  // pages earlier ("Page 3 found one wrong line. Onward") into a NEW user-visible bubble — the
  // owner's "filler line every 15 minutes" (#10). A turn the engine queued its own continuation
  // for (the same recorded exit fact finalize-record reads: the park, the tool-loop cap, a context
  // rebuild — every one writes the C3 stash, consumed by the next preflight) did not end: the
  // person is not left in silence, the work goes on, and its real answer comes from the
  // continuation. The held-back line stays the working-note it already is.
  // requirement preserved: a turn that genuinely ENDS with only text that rode a tool call still
  // delivers that text, so a waiting human is never answered by silence (G-SUP-2).
  const continuing = continuationContext.has(agentId) && !isStopFenced(agentId);
  if (turnCtx.deferredUserReplyWithTools && !state.lastAssistantTextForIM && continuing) {
    logger.info('v2 G-SUP-2 recovery skipped: the engine is continuing this work; the held-back line stays a working note', {
      agentId, turnNumber,
    }, agentId);
  }
  if (turnCtx.deferredUserReplyWithTools && !state.lastAssistantTextForIM && !continuing) {
    const recoveredId = uuidv4();
    try {
      // RC-12 item 6: the recovery path used to route deferred text WITHOUT the
      // claimed-delivery floor (it only runs on tool-LESS terminal replies above), so a
      // false "sent it" that rode with a tool call slipped straight to the channel.
      // The loop has exited here (no re-entry to correct), so we run the SAME rekeyed
      // decision (PHASE-4 T4 — a ROW, never the prose) and log a LOUD tripwire naming the
      // row. We still deliver: a waiting human must not be left in silence (the very
      // failure G-SUP-2 exists to prevent), and the tool-less terminal gate is the
      // model-visible correction path for the common case.
      try {
        const g = decideClaimedDelivery({
          agentId, turnNumber, responseText: turnCtx.deferredUserReplyWithTools,
          toolCallsThisTurn: state.toolResults.filter((r) => !r.isError).map((r) => ({ name: r.name })),
          counterpartyName: counterparty.name,
          hasDeliveryReceipt: (recipient) =>
            findRecentDeliveriesKeyed(agentId, recipient, 24).length > 0 ||
            findRecentDeliveries(agentId, recipient, 24).length > 0,
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
