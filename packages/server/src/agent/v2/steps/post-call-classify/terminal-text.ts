// Decides what is persisted as the agent's text and promotes text riding a tool call when a person
// waits on it. The ack pair is written on `turnCtx`, not returned, because the timer and later gates read it.

import { v4 as uuidv4 } from 'uuid';
import { INTERNAL_WORKING_NOTE_PREFIX, WORKING_NOTE_PREFIX, stripMoodMarker } from '@dojo/shared';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { redactHandedCredentials } from '../../../../credentials/secret-fields.js';
import { insertMessageIfAbsent, START_ACK_ORIGIN_INTENT } from '../../../../memory/message-store.js';
import type { AgentTurnState } from '../../state.js';
import { isRoutedHumanCounterparty } from '../../counterparty.js';
import { outputPersistenceClassifier } from '../../classifiers/output.js';
import { isRowLabelOnly, stripLeadingTimeStamp } from '../../../../memory/message-stamp.js';
import { answersALiveAsk, deliverAsAnswerToLiveAsk } from './answer-to-a-live-ask.js';
import { DELIVERABLE_OWING_TASK_KINDS } from '../../../../work/deliverable-declaration.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

/** Decide the turn's persisted text and, when it is a start line, deliver it as one.
 *  No way out of the loop: every arm of this section proceeds. */
export async function runTerminalText(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const {
    agentId, counterparty, deliverEngineUserAck, hasUnansweredUser, isHumanContinuation,
    messageId, noteTerminalAnswer, result, startAckRepliedNow, turnCtx, turnNumber,
  } = ctx;
  const { interAgentTurn } = sc;
  const persistenceDecision = outputPersistenceClassifier({
    responseText: result.content ?? null,
    toolCallsThisTurn: result.toolCalls,
    isInterAgentTrigger: interAgentTurn,
    sentToAgentThisTurn: state.sentToAgentThisTurn,
  });

  // The single birth point of the tool-less reply: scrubbing credentials here covers every downstream
  // row and the channel copy. Only stored copies carry the placeholder; the live call used the real value.
  let persistedContent: string | null =
    result.content ? redactHandedCredentials(agentId, result.content) : result.content;
  // Strip routing tags and time stamps the model copies from history, before anything reads the text.
  if (persistedContent) {
    const { stripSystemTags } = await import('../../../../services/imessage-bridge.js');
    const cleaned = stripSystemTags(persistedContent);
    persistedContent = cleaned || null;
  }
  if (persistedContent) {
    const destamped = stripLeadingTimeStamp(persistedContent).trim();
    persistedContent = destamped.length > 0 ? destamped : null;
  }
  // Inter-agent turns suppress text even beside tool calls; other turns only standalone trailing text.
  if (persistenceDecision.decision === 'suppress' && (result.toolCalls.length === 0 || interAgentTurn)) {
    logger.debug('v2: suppressed trailing text', {
      agentId,
      reason: persistenceDecision.reason,
      interAgentTurn,
    }, agentId);
    persistedContent = null;
  }
  // Text riding with tool calls is narration, not the reply; it is demoted unless an arm below delivers it.
  let deliveredAsStartLine = false;
  let deliveredAsAnswerToLiveAsk = false;
  if (persistedContent && result.toolCalls.length > 0) {
    // A person may be waiting on this text: a waiting chat row, or a run declared deliverable-owing (the
    // wake is the ask). It is remembered so finalize/deferred-recovery.ts can deliver it if no reply follows.
    const userDeliverableRunTurn =
      turnCtx.root?.kind === 'occurrence' &&
      DELIVERABLE_OWING_TASK_KINDS.includes(turnCtx.servedWork?.taskKind ?? '');
    const answersLiveAsk = answersALiveAsk({
      interAgentTurn, isHumanContinuation,
      surfacedReplyThisTurn: state.surfacedReplyThisTurn, startAckRepliedNow,
    });
    if ((hasUnansweredUser || userDeliverableRunTurn || answersLiveAsk) && !interAgentTurn) {
      turnCtx.deferredUserReplyWithTools = persistedContent;
      turnCtx.deferredNoteId = null;   // set below if a note is written for THIS text
      // noteTerminalAnswer is required: once the turn ends, settlement refuses an agent-text bubble the
      // turn's answer key does not name. A fresh row id: `messageId` holds this iteration's tool_use row.
      // Start line: when a start ack is owed (steer armed, or threshold passed with nothing heard), the
      // model's own words riding a tool call are delivered as the visible ack, consumed so nothing double-sends.
      if (
        (turnCtx.startAckSteerArmedThisTurn || turnCtx.startAckSteerRequested) &&
        !turnCtx.engineStartAckDeliveredThisTurn &&
        stripMoodMarker(turnCtx.deferredUserReplyWithTools ?? '').trim() && !isRowLabelOnly(turnCtx.deferredUserReplyWithTools) &&   // a mood tag alone is no start line
        !startAckRepliedNow()
      ) {
        turnCtx.engineStartAckDeliveredThisTurn = true;
        deliveredAsStartLine = true;
        const startLine = turnCtx.deferredUserReplyWithTools.trim();
        turnCtx.deferredUserReplyWithTools = null;
        turnCtx.deferredDeliveredByAck = true;
        // Stamped as a start line so settlement refuses it as a receipt; 'agent-text' too, or origin_intent
        // alone shows it as fallback.
        await deliverEngineUserAck(startLine, START_ACK_ORIGIN_INTENT, null, 'agent-text');
        logger.info('v2 start-ack steer: model spoke its start line mid-work; delivered as the visible ack', {
          agentId, turnNumber, preview: startLine.slice(0, 60),
          owedVia: turnCtx.startAckSteerArmedThisTurn ? 'steer-armed' : 'threshold-owed',
        }, agentId);
      } else if (answersLiveAsk && turnCtx.deferredUserReplyWithTools) {
        const answer = turnCtx.deferredUserReplyWithTools.trim();
        turnCtx.deferredUserReplyWithTools = null;
        deliveredAsAnswerToLiveAsk = true;
        state = (await deliverAsAnswerToLiveAsk(state, {
          interAgentTurn, isHumanContinuation,
          surfacedReplyThisTurn: state.surfacedReplyThisTurn, startAckRepliedNow,
          agentId, turnNumber, answer, deliverEngineUserAck, noteTerminalAnswer,
        })).state;
      }
    }
    // Demote, don't discard: streamed narration becomes a model-invisible working note and the bubble converts
    // in place. The note is the owner's to read only when the turn serves a waiting person.
    if (!interAgentTurn && !deliveredAsStartLine && !deliveredAsAnswerToLiveAsk && !isRowLabelOnly(persistedContent)) {
      try {
        const noteId = uuidv4();
        // A routed-channel note was never delivered there, so it is internal (hidden by default).
        const routedHumanChannel = isRoutedHumanCounterparty(counterparty);
        const agentOnly = routedHumanChannel || !!turnCtx.servedJob || !(hasUnansweredUser || userDeliverableRunTurn);
        const notePrefix = agentOnly ? INTERNAL_WORKING_NOTE_PREFIX : WORKING_NOTE_PREFIX;
        // No origin stamp: an engine-stamped row would be inter-agent-shaped and belongs in the store.
        insertMessageIfAbsent({
          id: noteId, agentId, role: 'system',
          content: `${notePrefix}${persistedContent}`, turnNumber,
        });
        broadcast({
          type: 'chat:workingnote',
          agentId,
          messageId,
          noteId,
          content: persistedContent,
          ...(agentOnly ? { internal: true } : {}),
        });
        if (turnCtx.deferredUserReplyWithTools === persistedContent) turnCtx.deferredNoteId = noteId;
      } catch { /* cosmetic; never block the turn */ }
    }
    persistedContent = null;
  }

  sc.persistedContent = persistedContent;
  sc.deliveredAsStartLine = deliveredAsStartLine;
  return proceed(state);
}
