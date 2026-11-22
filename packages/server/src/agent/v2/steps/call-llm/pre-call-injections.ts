// What goes into the call: the capability gate, the volatile injections on the tail past the cached
// prefix, and the context receipt. The tail is ordered most-stable-first because a provider's prefix cache
// breaks at the first differing token; `memory/__tests__/the-tail-holds-still.test.ts` judges the order.

import type { ModelCallParams } from '../../../model.js';

type ModelMessage = ModelCallParams['messages'][number];
import { advance, type AgentTurnState } from '../../state.js';
import { injectRegistryMessage } from '../../../../prompt/registry/assembler.js';
import type { AssemblyContext } from '../../../../prompt/registry/types.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import { collectMessageLaneIds } from '../../../../memory/message-lane-tag.js';
import { recordVaultUse } from '../../../../vault/store.js';
import { renderDeliveriesLaneMessage } from '../../../../memory/deliveries-lane.js';
import { buildOpenWorkInjection } from '../../../../work/obligations.js';
import { buildReportStateInjection } from '../../../../report/state-lane.js';
import { buildOtherThreadsInjection } from '../../../../memory/other-threads-lane.js';
import { otherThreadsRoomTokens } from '../../../../memory/other-threads-room.js';
import { getRecentOutbound, renderRecentOutboundBlock } from '../../outbound-ledger.js';
import {
  recentlyAnsweredAsks, renderRecentlyAnsweredBlock, RECENTLY_ANSWERED_LIMIT,
} from '../../answered-edge.js';
import { pushEngineMessage } from '../../engine-message.js';
import { markSteerAttempted, markSteerDelivered } from '../../steer-queue.js';
import { recordPiecesShown } from '../../../../work/ask-settlement.js';
import { writeContextReceipt } from '../../receipt.js';
import { appendOnlyTurn } from './append-only-turn.js';
import { dialedPolicy, estimateAssembledArrayTokens } from './reassemble-for-fit.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { SteerEntry } from '../../steer-queue.js';
import type { TurnContext } from '../../../turn-context.js';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');

export interface PreCallInjectionInputs {
  readonly agentId: string;
  readonly turnNumber: number;
  readonly modelId: string;
  readonly messages: ModelMessage[];
  readonly systemPrompt: string;
  readonly ctx: AssembledContext;
  readonly mctx: AssemblyContext;
  readonly volatileFrom: number | undefined;
  readonly counterparty: TurnCounterparty;
  readonly steerAwaitingConfirm: SteerEntry | null;
  readonly turnCtx: TurnContext;
  readonly db: Database;
}

export async function injectAndRecord(
  stateIn: AgentTurnState,
  input: PreCallInjectionInputs,
): Promise<{ state: AgentTurnState; useTools: boolean; messages: ModelMessage[] }> {
  const { agentId, turnNumber, modelId, messages, systemPrompt, ctx, mctx, volatileFrom, counterparty, steerAwaitingConfirm, turnCtx } = input;
  let state = stateIn;
  // Captions or strips images the model cannot see, and turns tools off when it cannot use them.
  const { enforceModelCapabilities } = await import('../../../runtime.js');
  const { useTools } = await enforceModelCapabilities(agentId, modelId, messages);

  // Tools off: a one-shot text-only note, first iteration only, after an assistant row (alternation).
  if (!useTools && state.loopCount === 1 && messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
    injectRegistryMessage('msg.tool-note', messages, mctx);
  }

  // The four state lanes lead the tail: they move less often than the channel does.
  const blocksFrom = messages.length; // the state blocks start here; above it, this call's one-shot steers
  mctx.attemptLedgerLane = ctx.attemptLedgerLane ?? null;
  injectRegistryMessage('msg.attempt-ledger', messages, mctx);
  mctx.activeTasksLane = ctx.activeTasksLane ?? null;
  injectRegistryMessage('msg.active-tasks', messages, mctx);
  mctx.scratchpadLane = ctx.scratchpadLane ?? null;
  injectRegistryMessage('msg.scratchpad', messages, mctx);
  mctx.eventsLane = ctx.eventsLane ?? null;
  injectRegistryMessage('msg.events', messages, mctx);

  // Routing and presence (reply destination, channels, counterparty): volatile, so past the cached prefix.
  injectRegistryMessage('msg.turn-context', messages, mctx);

  // Recent outbound receipts ride every agent turn: an engine or peer turn needs the agent's own sends most.
  try {
    const outBlock = renderRecentOutboundBlock(getRecentOutbound(agentId, 24, 5));
    if (outBlock) {
      pushEngineMessage(messages, outBlock, 'engine.recent-outbound'); // registry-exempt: the receipts block reads per-iteration ledger state; migrate with the volatile-injection registry refactor
    }
  } catch (err) {
    logger.debug('RC-12 recent-outbound injection failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  if (counterparty.kind === 'user') {
    const pendConvId = turnCtx.root?.conversationId ?? null;
    try {
      // The agent's recent messages to this counterparty only (`memory/deliveries-lane.ts`), so a bare
      // answer can be bound; `alreadyVisible` skips a send the tail already carries, never quoting it twice.
      mctx.deliveriesLane = renderDeliveriesLaneMessage({
        agentId,
        conversationId: pendConvId,
        counterpartyName: counterparty.name,
        recipientHints: [counterparty.senderId, counterparty.name].filter(
          (h): h is string => !!h && h.trim().length > 0,
        ),
        alreadyVisible: (probe) => probe.length > 0 && messages.some(
          (mRow) => mRow.role === 'assistant' && typeof mRow.content === 'string' &&
            mRow.content.includes('[Sent via') && mRow.content.includes(probe),
        ),
      });
      injectRegistryMessage('msg.deliveries', messages, mctx);
    } catch (err) {
      logger.debug('RC-12/RC-1 volatile outbound injection failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    // Open work, what the agent still owes. Its own try with a WARN: unlike the enrichments above, a
    // person is owed something and the model cannot see it.
    try {
      const openWorkBlock = buildOpenWorkInjection(agentId, pendConvId);
      if (openWorkBlock) pushEngineMessage(messages, openWorkBlock, 'engine.open-work'); // registry-exempt: the open-work block reads conv-scoped rows mid-iteration; migrate with the volatile-injection registry refactor
    } catch (err) {
      logger.warn('OPEN WORK injection FAILED — work this agent owes is NOT in front of the model this call', {
        agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

  }

  // Open commitments, a pure function of the work board: byte-identical on a turn that changed no work row,
  // so it sits ahead of everything per-ask. Every counterparty: what is owed does not depend on the turn.
  if (ctx.openCommitmentsLane) {
    pushEngineMessage(messages, ctx.openCommitmentsLane, 'engine.open-commitments'); // registry-exempt: the STATE half of lane.relevant-memory, computed by the assembler and ordered by the loop; migrate with the volatile-injection registry refactor
  }

  // Report state: what became of the agent's report cards, as current state beside the snapshot above.
  // Empty is absent; its own try, so a lane that cannot build does not cost the turn its other lanes.
  try {
    const reportStateBlock = buildReportStateInjection(agentId);
    if (reportStateBlock) pushEngineMessage(messages, reportStateBlock, 'engine.report-state'); // registry-exempt: per-turn report-row state read mid-iteration, like engine.open-work; migrate with the volatile-injection registry refactor
  } catch (err) {
    logger.warn('REPORT STATE injection FAILED — a withdrawn report card is NOT contradicted in front of the model this call', {
      agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // Peer idle/working status: after the turn context, before the clock, behind the cache boundary.
  injectRegistryMessage('msg.peer-status', messages, mctx);

  // Live integration status outranks a remembered breakage in `msg.relevant-memory` below. It moves on each
  // successful Google or Microsoft call, so it sits last in the stable group. Every counterparty.
  mctx.integrationStatusLane = ctx.integrationStatusLane ?? null;
  injectRegistryMessage('msg.integration-status', messages, mctx);

  // Recently answered: this conversation's last answered asks (`answered-edge.ts`), so the model never
  // re-answers a settled one. It moves on every answered turn, so it sits with the per-ask blocks.
  if (counterparty.kind === 'user' && turnCtx.conversationId) {
    // Other threads: tells the model this thread is one of several. It moves only when another thread does,
    // so it leads the answered block; laid out in the room the assembler reserved (`other-threads-room.ts`).
    const otherThreads = buildOtherThreadsInjection(agentId, turnCtx.conversationId, otherThreadsRoomTokens((await dialedPolicy(agentId, modelId)).policy.assemblyBudgetTokens, systemPrompt));
    if (otherThreads) pushEngineMessage(messages, otherThreads, 'engine.other-threads'); // registry-exempt: per-turn cross-conversation state read mid-iteration, like engine.open-work; migrate with the volatile-injection registry refactor
    try {
      const answeredBlock = renderRecentlyAnsweredBlock(
        recentlyAnsweredAsks(agentId, turnCtx.conversationId, RECENTLY_ANSWERED_LIMIT),
      );
      if (answeredBlock) {
        pushEngineMessage(messages, answeredBlock, 'engine.recently-answered'); // registry-exempt: reads per-iteration conv-scoped answer stamps; migrate with the volatile-injection registry refactor
      }
    } catch { /* best effort */ }
  }

  // Recall, retrieved against the live ask, so it may not sit in the cached prefix. Every counterparty:
  // the recall query has its own branch for peer and engine turns.
  mctx.recallLane = ctx.recallLane ?? null;
  injectRegistryMessage('msg.relevant-memory', messages, mctx);

  injectRegistryMessage('msg.current-time', messages, mctx);

  // A later call of the turn appends to what the previous call sent (`append-only-turn.ts`).
  const sent = await appendOnlyTurn({
    turn: turnCtx, loopCount: state.loopCount, modelId, fresh: messages, volatileFrom: volatileFrom ?? messages.length, blocksFrom,
    fits: async (arr) => estimateAssembledArrayTokens(systemPrompt, arr) <= (await dialedPolicy(agentId, modelId)).policy.assemblyBudgetTokens,
  });

  // Context receipt: what the provider is handed. Delivered lanes are read off this call's blocks.
  const laneIdsForThisCall = collectMessageLaneIds(messages);
  // Latches once recall reached the model this turn; a lane the budget dropped is not a read.
  if (!state.recallLaneReachedModelThisTurn && laneIdsForThisCall.includes('msg.relevant-memory')) {
    state = advance(state, { recallLaneReachedModelThisTurn: true });
    recordVaultUse(ctx.recalledVaultIds ?? []);
  }
  if (steerAwaitingConfirm) {
    const delivered = laneIdsForThisCall.includes('msg.pending-nudge');
    state = advance(state, {
      steerQueue: delivered
        ? markSteerDelivered(state.steerQueue, steerAwaitingConfirm)
        : markSteerAttempted(state.steerQueue, steerAwaitingConfirm),
    });
    for (const shown of delivered ? steerAwaitingConfirm.shown ?? [] : []) recordPiecesShown(shown.askId, agentId, turnNumber, shown.putBackId);
  }
  writeContextReceipt({
    agentId,
    modelId,
    turnNumber,
    loopCount: state.loopCount,
    systemPrompt,
    messages: sent.messages,
    useTools,
    systemEntryIds: ctx.systemEntryIds,
    // Off the sent array: `ctx.messageEntryIds` describes the assembled array and misses the tail.
    messageEntryIds: collectMessageLaneIds(sent.messages),
    volatileFrom: sent.volatileFrom,
    allocation: ctx.allocation,
    freshTailDropped: ctx.freshTailDropped,
    systemVolatileChars: (ctx.systemVolatile ?? '').length,
    reserveTokens: ctx.reserveTokens,
  });

  return { state, useTools, messages: sent.messages };
}
