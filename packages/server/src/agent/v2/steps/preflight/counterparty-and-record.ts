// ════════════════════════════════════════
// PHASE-6 T2 (CUT 9) — `preflight` §4: THE COUNTERPARTY, THE TURN RECORD, AND THE
// STATE ITSELF.
//
// Who this turn is addressing, the owner-channel affinity decision, the turn's own
// IDENTITY allocated by the `turns` table in-transaction, the serve edges that link
// the ask and the engine event to that number — and, last, `initState`.
//
// ⚠ THIS IS WHERE THE STEP MAKES THE THING EVERY OTHER STEP TAKES. `preflight` is the
// one step whose signature is not `(state, ctx)`, because before this statement there
// is no state to take; inventing one to satisfy a signature is a lie the type system
// would then carry for eight tranches. The state is published to the turn's BAG
// (`turnCtx.state`) rather than returned, because three closures this span declares
// read it LIVE — one of them from a wall-clock timer — and a returned value is a
// snapshot.
//
// `initState` ALSO SEEDS THE PHASE. `'preflight'` has been a member of `TurnPhase`
// since the union existed, and it is the one phase the driver does not advance INTO,
// because the step that owns it is the step that creates the record. The shared rule
// ("the driver advances ahead of the call, so `validate()` runs on the transition")
// is met here by CONSTRUCTION rather than by a call site: there is no transition,
// there is a birth, and `initState` runs the same validation on it.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import { claimEngineEventByRowid, markServedByRowid } from '../../../../memory/message-store.js';
import { stampClaimingTurn } from '../../../../work/store.js';
import { turnBoundary } from '../../../turn-state.js';
import type { TurnContext } from '../../../turn-context.js';
import { initState } from '../../state.js';
import type { ChannelInboundContext } from '../../state.js';
import type { InboundChannel } from '../../inbound-channel.js';
import { resolveTurnCounterparty, type TurnCounterparty, type WaitingConversation } from '../../counterparty.js';
import { resolveOwnerAffinityChannel, affinityPromotionAllowed } from '../../owner-affinity.js';
import { resetProactiveSendStreak } from '../../proactive-budget.js';
import { startTurn } from '../../turn-record.js';
import type { PreflightContext, PreflightScratch } from './index.js';

const logger = createLogger('v2-loop');

/** What the sections before this one produced that it reads. */
export interface CounterpartyAndRecordInputs {
  readonly isHumanContinuation: boolean;
  readonly continuation: { convKey: string; conversationId: string | null; counterparty: TurnCounterparty } | undefined;
  readonly a2aCounterpartyIdentity: { intent: string; threadShort: string; fromName: string } | null;
  readonly lastUserMessageContent: string;
  readonly lastUserMessageId: string | null;
  readonly triggerRow: WaitingConversation['latest'];
  readonly triggerWorkId: string | null;
  readonly chosenConvKey: string;
  readonly inboundChannel: InboundChannel;
  readonly inboundContext: ChannelInboundContext | null;
  readonly latestUserSource: 'voice' | 'text' | null;
  readonly triggeredByIMessage: boolean;
  readonly isA2ATurn: boolean;
  readonly isEngineTurn: boolean;
  readonly terminalWakeA2A: { intent: string; threadShort: string; threadId: string; fromName: string; rowid: number } | null;
  readonly terminalWakeDrivesTurn: boolean;
  readonly pendingEngineEvent: { rowid: number; id: string; taskId: string | null; runId: string | null; content: string; originIntent: string | null } | null;
  readonly a2aReplyContext: { intent: string; threadShort: string; fromName: string } | null;
  readonly contextWindow: number;
  readonly isAutoRouted: boolean;
  readonly configuredModelId: string;
}

/** What this section hands the sections after it. The STATE is not among them: it
 *  goes on the bag, live, for the reason in this file's header. */
export interface CounterpartyAndRecordOutputs {
  readonly counterparty: TurnCounterparty;
  readonly turnNumber: number;
  readonly turnStartedAt: string;
}

export async function runCounterpartyAndRecord(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  sc: PreflightScratch,
  input: CounterpartyAndRecordInputs,
): Promise<CounterpartyAndRecordOutputs> {
  const { agentId } = ctx;
  const {
    isHumanContinuation, continuation, a2aCounterpartyIdentity, lastUserMessageContent,
    lastUserMessageId, triggerRow, triggerWorkId, chosenConvKey, inboundChannel,
    inboundContext, latestUserSource, triggeredByIMessage, isA2ATurn, isEngineTurn,
    terminalWakeA2A, terminalWakeDrivesTurn, pendingEngineEvent, a2aReplyContext,
    contextWindow, isAutoRouted, configuredModelId,
  } = input;
  // ── Turn counterparty (attribution redesign, Phase 3) ──
  // The single entity this turn is addressing, resolved from structured origin.
  // Drives the explicit "who you're talking to" header (Phase 3) and the
  // fresh-tail scoping (Phase 4). Derived from the same signals computed above.
  // C3: on a human-task continuation, restore the ORIGINAL counterparty so the final
  // answer routes to the conversation's real channel/person (the empty-trigger
  // continuation has no inbound to resolve from). Otherwise resolve normally.
  const counterparty: TurnCounterparty = isHumanContinuation
    ? continuation!.counterparty
    : resolveTurnCounterparty({
        isA2ATurn,
        a2aFromName: a2aCounterpartyIdentity?.fromName ?? null,
        a2aThreadShort: a2aCounterpartyIdentity?.threadShort ?? null,
        triggerContent: lastUserMessageContent,
        triggerLane: triggerRow?.lane ?? null,
        triggerChannel: triggerRow?.channel ?? null,
        triggerInboundMeta: triggerRow?.inbound_meta ?? null,
        inboundChannel,
      });

  // T-4: publish this turn's iMessage recipient (the human counterparty) so an
  // explicit no-recipient imessage_send / image_create reply goes to THIS person.
  if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
    turnCtx.imRecipient = counterparty.senderId;
  } else {
    turnCtx.imRecipient = undefined;
  }

  // RC-10: owner-channel affinity, resolved ONCE here so the SAME value drives both the
  // counterparty header (so the model is never told "dashboard" on a turn the engine
  // will text) and the end-of-turn reply routing. Applies only when: the counterparty
  // is the owner (never a contact), the natural destination would be the dashboard (not
  // a bound routed channel, and never voice/phone), the owner's most recent contact was
  // iMessage within 48h, the bridge is configured, and the per-conversation rate limit
  // allows a promotion. The presence-away override at end-of-turn remains stronger.
  // RC-5.3: an authorized owner inbound (the owner is present and engaging) resets the
  // proactive-send backoff. A settled-context wake has no trigger row, so only a genuine
  // owner message clears the streak; every unanswered proactive ping keeps it climbing.
  if (triggerRow && counterparty.kind === 'user' && counterparty.relation === 'owner') {
    resetProactiveSendStreak(agentId);
  }

  // P5c: the affinity cooldown is keyed by the CONVERSATION ROW. Owner-addressed
  // dashboard-default turns (the only promotion case) all belong to the owner's
  // one dashboard conversation per agent, the same identity the chat route
  // stamps, so resolve that row lazily inside the promotion guard.
  // PHASE-6 T9 (CUT 4), RULING P6-R3(1): both live on the turn's bag — the pair is one
  // mechanism (the destination is meaningless without the conversation its cooldown is
  // keyed to) and both cross into the `finalize` span, which decides the reply's
  // destination and records the promotion. Written once each, here, in straight-line code.
  {
    const destinationWouldBeDashboard =
      counterparty.channel !== 'imessage' && counterparty.channel !== 'teams' &&
      counterparty.channel !== 'email' && counterparty.channel !== 'sms' &&
      counterparty.channel !== 'phone' && counterparty.channel !== 'voice';
    if (counterparty.kind === 'user' && counterparty.relation === 'owner' && destinationWouldBeDashboard) {
      try {
        const { isImessageConfigured } = await import('../../../../services/presence.js');
        const bridgeConfigured = isImessageConfigured();
        const affinity = resolveOwnerAffinityChannel(agentId, { imessageBridgeConfigured: bridgeConfigured });
        if (affinity === 'imessage') {
          const { resolveOrCreateConversation } = await import('../../../../memory/conversations.js');
          turnCtx.ownerAffinityConversationId = resolveOrCreateConversation(agentId, {
            channel: 'dashboard', provider: null, counterpartyId: 'owner', threadRoot: null,
          });
          if (affinityPromotionAllowed(agentId, turnCtx.ownerAffinityConversationId)) {
            turnCtx.ownerAffinityDestination = 'imessage';
          }
        }
      } catch { /* best effort; a resolution failure just leaves the reply on the dashboard */ }
    }
  }

  // ── P4 turn record: allocate this turn's IDENTITY and record what it SERVES ──
  //
  // PHASE-2 T2: the turn number is allocated by the `turns` table itself, in-transaction
  // (`INSERT … SELECT COALESCE(MAX(turn_number),0)+1 … RETURNING`), and NOT derived here from
  // `MAX(messages.turn_number)`. The old derivation was wrong in two live situations — a turn
  // that writes no messages, and an agent whose history was cleared — because `messages`
  // restarts while `turns` keeps climbing, so the derived number collided with an already
  // recorded turn and the old `ON CONFLICT DO UPDATE` overwrote it in silence. Both facts now
  // come from one place. Per Part XVIII §E turn_number stays per-agent and monotonic; it no
  // longer resets when history is cleared, which is the honest reading of "turn 41 of this
  // agent's life".
  const turnNumber: number = (() => {
    const root = turnCtx.root ?? null;
    const kind: 'user' | 'a2a' | 'engine' | null =
      isEngineTurn ? 'engine' : ((isA2ATurn || terminalWakeA2A) ? 'a2a' : (chosenConvKey ? 'user' : null));
    const subjectKind = isEngineTurn ? 'engine_event' as const
      : (isA2ATurn || terminalWakeA2A) ? 'a2a_thread' as const
      : chosenConvKey ? 'conv' as const
      : isHumanContinuation ? 'continuation' as const
      : 'none' as const;
    const subjectId = isEngineTurn ? (pendingEngineEvent?.id ?? null)
      : terminalWakeA2A ? terminalWakeA2A.threadId
      : isA2ATurn ? ((terminalWakeA2A as unknown as { a2a_thread_id?: string | null } | null)?.a2a_thread_id ?? null)
      : chosenConvKey;
    turnCtx.modelRequestId = `req_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    return startTurn({
      agentId, kind, subjectKind, subjectId,
      // P8: typed spoken-stream lane on the record.
      lane: latestUserSource === 'voice' ? 'voice' : inboundChannel === 'phone' ? 'phone' : null,
      rootKind: root?.kind ?? null, rootId: root?.id ?? null,
      sourceMessageId: root?.sourceMessageId ?? null, convKey: chosenConvKey,
    });
  })();
  // RC-12: publish the turn number so writeToolReceipt can stamp turn_number on
  // engine receipts without threading it through every send executor. Cleared at
  // the turn's `finally`, like every other fact in the bag.
  turnCtx.turnNumber = turnNumber;
  // S3 (PHASE-3 T3): restart rehydration, at the TURN, once per agent per process.
  // `memory/assembler.ts:1262-1281` (pre-repin) did this from inside the assembly read path
  // on EVERY assembly — a mutation on a read, and one that re-broke the cached tools prefix
  // for every agent on the first assembly after any restart. The requirement it encoded (an
  // agent should not have to re-call load_tool_docs for a tool it was already using before
  // the server restarted) is preserved exactly, at the boundary where a restart is visible.
  try {
    const { rehydrateSessionToolsFromHistory } = await import('../../../../tools/tool-docs.js');
    rehydrateSessionToolsFromHistory(agentId);
  } catch { /* best effort — never break a turn over a cache warm-up */ }
  // Per-ask forward link: the claimed trigger records WHICH turn serves it (the claim
  // above only made it invisible to the waiting set). Two rows, one fact: the ticket's
  // `claimed_by_turn` is what the delivery close and the boot reconciliation read; the
  // message's `served_by_turn` is the message-side lineage the answer stamp joins on.
  // The ticket is stamped HERE and not at the claim because the turn number is allocated
  // from the subject the claim itself decides — and the D-2 race has to be settled before
  // any of that runs.
  try {
    if (triggerWorkId) {
      stampClaimingTurn(triggerWorkId, turnNumber);
    }
    if (triggerRow) {
      markServedByRowid(triggerRow.rowid, turnNumber);
    }
    // PHASE-2 T9 — THE ENGINE EVENT'S ATOMIC CLAIM, and it is this stamp.
    // It used to be an unconditional re-stamp of a row already claimed by the
    // `conv_key='engine'` sentinel 155 lines above. With the sentinel gone, the stamp IS the
    // claim: a CAS on `served_by_turn IS NULL`. A loss means another process took the event,
    // and the turn continues WITHOUT owning it — so no revert and no delivery-failure
    // bookkeeping is recorded against a claim it never held.
    if (sc.pendingEngineClaim) {
      const won = claimEngineEventByRowid({ rowid: sc.pendingEngineClaim.rowid, agentId, turnNumber }) > 0;
      if (won) {
        sc.claimedEngineEvent = { rowid: sc.pendingEngineClaim.rowid, turnNumber };
      } else {
        logger.warn('v2: engine-event claim lost at the serve edge; this turn does not own the event', {
          agentId, rowid: sc.pendingEngineClaim.rowid, turnNumber,
        }, agentId);
      }
    }
    // GATED on driving the turn, and that gate is load-bearing since T4. A terminal wake that
    // exists but LOST the turn (an unreplied QUESTION/ASSIGN/BLOCK wins the counterparty, or a
    // human is waiting) must stay UNSERVED so it gets its own turn later — that is the whole
    // point of "the A2A re-defers to its own turn". Before T4 the wake's un-served-ness was
    // tracked by a second column (`conv_key`), so stamping `served_by_turn` unconditionally
    // here was inert; now it is the finder's own predicate, so an ungated stamp would
    // SWALLOW the wake. The two stamps disagreed; they agree now.
    if (terminalWakeA2A && terminalWakeDrivesTurn) {
      markServedByRowid(terminalWakeA2A.rowid, turnNumber);
    }
  } catch { /* best effort */ }

  // Snapshot turn boundary so context assembly excludes mid-run user messages
  const turnStartedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  turnBoundary.set(agentId, turnStartedAt);

  // Remediation Phase 5 (5a): if a technique gets injected this turn, the
  // turn's outcome (completed vs errored) is written back to its usage row.
  // PHASE-6 T9 (CUT 4), RULING P6-R3(1): on the turn's bag — it crosses into the
  // `finalize` span (the success write-back) and the teardown package already takes it
  // as a context field, which the driver closure below now feeds from the bag.

  // D6: the technique-acknowledgement gate no longer blocks (the hard gate was
  // removed, see the tool loop) and is per-turn only. Do NOT hydrate it from
  // agents.config across turns: a pending ack left over from a prior turn used
  // to resurrect a global tool lock on an unrelated later turn with no expiry.
  const initialPendingTechniqueAck: import('../../state.js').AgentTurnState['pendingTechniqueAck'] = null;

  // Initial state
  turnCtx.state = initState({
    agentId,
    contextWindow,
    isAutoRouted,
    configuredModelId,
    turnNumber,
    triggeredByIMessage,
    triggeredByA2AReplyIntent: a2aReplyContext,
    lastUserMessageContent,
    lastUserMessageId,
    inboundChannel,
    inboundContext,
    pendingTechniqueAck: initialPendingTechniqueAck,
  });

  return { counterparty, turnNumber, turnStartedAt };
}
