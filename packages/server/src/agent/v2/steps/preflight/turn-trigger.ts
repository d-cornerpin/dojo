// The turn's trigger and its pickup claim; abandons when another process claimed the trigger first.

import type { Database } from 'better-sqlite3';
import { createLogger } from '../../../../logger.js';
import { getDb } from '../../../../db/connection.js';
import { AgentError } from '../../../errors.js';
import { agentTurnWindow } from '../../../../router/router-window.js';
import { stampConversationIdByRowid } from '../../../../memory/message-store.js';
import { resolveOrCreateConversation } from '../../../../memory/conversations.js';
import { withUnit } from '../../../../db/unit.js';
import { claimAsk, isStateConflict } from '../../../../work/store.js';
import { inFlightOccurrence } from '../../../../work/occurrences.js';
import { serveLater } from '../../serve-later.js';
import { resolveServedWork } from '../../stale-work-ids.js';
import { askRoot, getWaitingHumanConversations, type WaitingConversation } from '../../counterparty.js';
import { nextOwed, type OwedItem } from '../../owed.js';
import { preflightAbandon, preflightProceed, type PreflightOutcome } from '../step-outcome.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';

const logger = createLogger('v2-loop');

export interface TurnTriggerOutputs {
  readonly db: Database;
  readonly agent: Record<string, unknown>;
  readonly configuredModelId: string;
  readonly isAutoRouted: boolean;
  readonly contextModelId: string;
  readonly contextWindow: number;
  readonly waitingConvs: WaitingConversation[];
  readonly openHumanWorkAtTurnStart: boolean;
  /** The first thing this agent owes now, read once before the pickup claim; the turn serves it. */
  readonly item: OwedItem | undefined;
  /** A job's or a run's request row: the turn is addressed from it, though it is not a fresh waiting message. */
  readonly jobRow: WaitingConversation['latest'] | undefined;
  readonly isHumanContinuation: boolean;
  readonly chosenConvKey: string;
  readonly chosenConversationId: string | null;
  readonly triggerRow: WaitingConversation['latest'];
  readonly lastUserMessageContent: string;
  readonly lastUserMessageId: string | null;
  readonly triggerWorkId: string | null;
  readonly triggerConversationId: string | null;
}

export function runTurnTrigger(
  turnCtx: TurnContext,
  ctx: PreflightContext,
): PreflightOutcome<TurnTriggerOutputs> {
  const { agentId, setAgentStatus, startStatusHeartbeat } = ctx;
  const db = getDb();
  turnCtx.pickupSeq = (db.prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(agentId) as { s: number | null }).s;

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
    | Record<string, unknown>
    | undefined;
  if (!agent) {
    throw new AgentError('Agent not found', agentId, { code: 'AGENT_NOT_FOUND' });
  }
  const configuredModelId = agent.model_id as string | null;
  if (!configuredModelId) {
    throw new AgentError('Agent has no model configured', agentId, { code: 'NO_MODEL' });
  }

  const isAutoRouted = configuredModelId === 'auto';
  const contextModelId = isAutoRouted ? '__auto__' : configuredModelId;
  const contextWindow = agentTurnWindow(agentId, contextModelId);


  // The turn serves the first thing owed. A person comes first, and is the waiting reader's first conversation,
  // in the same order (the owner, then never served, then oldest).
  const item = nextOwed(agentId)[0];
  if (item) logger.info('owed: first owed at turn start', { agentId, kind: item.kind, rank: item.rank }, agentId);
  const waitingConvs = getWaitingHumanConversations(agentId);
  // Read before the pickup claim: afterwards this turn's own ask is claimed, and every user turn would
  // look like a settled-context wake.
  const openHumanWorkAtTurnStart = item?.kind === 'person';
  // A parked job is served from its task row; a job started by a person's request continues in that conversation.
  const job = item?.kind === 'job' && waitingConvs.length === 0 ? pickUpJob(agentId, turnCtx, item) : null;
  // A run's turn is addressed from the request that asked for the task, so its result goes where that was asked.
  const jobRow = job?.ask?.row ?? (item?.kind === 'clock' && item.event?.runId ? requestOf(agentId, item.event.taskId) : undefined);
  const isHumanContinuation = job?.ask?.row !== undefined;
  const chosenConvKey = job?.ask ? job.ask.key : (waitingConvs[0]?.key ?? null);
  // `chosenConvKey` stays beside the conversation id because other tables are still keyed by the string.
  let chosenConversationId: string | null = job?.ask?.row ? job.ask.row.conversation_id : (waitingConvs[0]?.oldest?.conversation_id ?? null);
  // Scopes recall_recent_thread to this conversation; null on engine/A2A turns.
  turnCtx.convKey = chosenConvKey;
  // The working status is set once the conversation key is known, so the first frame carries the truth.
  // No `await` precedes it, so the busy row's 409 window does not widen; the heartbeat starts after it.
  setAgentStatus(agentId, 'working');
  startStatusHeartbeat(agentId);
  // Trigger on the oldest unanswered message, so a later ping is never answered before the request.
  const triggerRow = waitingConvs[0]?.oldest;
  const lastUserMessageContent = triggerRow?.content ?? null;
  const lastUserMessageId: string | null = triggerRow?.id != null ? String(triggerRow.id) : null;
  if (!job) turnCtx.root = lastUserMessageId ? { kind: 'ask', id: lastUserMessageId, sourceMessageId: lastUserMessageId, conversationId: (triggerRow as unknown as { conversation_id?: string | null })?.conversation_id ?? null } : null;
  // Claim the ask at pickup (`open` to `claimed`, a CAS) so it reads served however the turn ends: the
  // clock must never re-run a message whose turn did real work. A newer message has its own work item.
  const triggerWorkId: string | null = waitingConvs[0]?.workId ?? null;
  const triggerConversationId: string | null = waitingConvs[0]?.oldest?.conversation_id ?? null;
  if (chosenConvKey && triggerRow) {
    let claimed = true;
    if (triggerWorkId) {
      const res = claimAsk(triggerWorkId, agentId);
      claimed = res.kind === 'applied';
      if (!claimed && !isStateConflict(res)) {
        logger.warn('v2: pickup claim refused by the work spine', { agentId, workId: triggerWorkId, res }, agentId);
      }
    }
    // Identity, independent of the claim. A row no producer resolved gets its conversation here through
    // the one writer, and it logs, because that means a producer is not stamping.
    if (!chosenConversationId) {
      const identity = waitingConvs[0]?.identity;
      if (identity) {
        try {
          chosenConversationId = resolveOrCreateConversation(agentId, identity);
          logger.info('v2: trigger row carried no conversation_id; resolved at pickup', {
            agentId, rowid: triggerRow.rowid, convKey: chosenConvKey, conversationId: chosenConversationId,
          }, agentId);
        } catch { /* best effort; the turn proceeds unscoped exactly as it would have */ }
      }
    }
    if (chosenConversationId) {
      try {
        stampConversationIdByRowid({ rowid: triggerRow.rowid, agentId, conversationId: chosenConversationId });
      } catch { /* best effort, served-tagging also happens at turn end */ }
    }
    if (!claimed) {
      // Another process claimed this trigger between our read and our claim: bail, never a duplicate turn.
      logger.warn('v2: pickup claim lost, another process already claimed this trigger; skipping to avoid a duplicate turn', { agentId, rowid: triggerRow.rowid, workId: triggerWorkId }, agentId);
      setAgentStatus(agentId, 'idle');
      return preflightAbandon('pickup-claim-lost');
    }
  }

  // Published only here, where `chosenConversationId` is final: an early null made the assembler drop
  // the agent's stamped answers and the model answered again. One `.set()`, one owner.
  turnCtx.conversationId = chosenConversationId;

  return preflightProceed({
    db, agent, configuredModelId, isAutoRouted, contextModelId, contextWindow,
    waitingConvs, openHumanWorkAtTurnStart, item, jobRow, isHumanContinuation,
    chosenConvKey, chosenConversationId, triggerRow, lastUserMessageContent,
    lastUserMessageId, triggerWorkId, triggerConversationId,
  });
}

/** The request row a task was asked by, when that request is this agent's. */
function requestOf(agentId: string, taskId: string | null): WaitingConversation['latest'] | undefined {
  const r = taskId ? getDb().prepare('SELECT source_message_id AS m FROM work WHERE id = ?').get(taskId) as { m: string | null } | undefined : undefined;
  return r?.m ? askRoot(agentId, r.m)?.row : undefined;
}

/** A job item's pickup: in one unit its task's due is cleared and its request, held on the job, is claimed. The turn
 *  is rooted where the job started: a person's request, or its run (another agent's thread is rooted at classification). */
function pickUpJob(agentId: string, turnCtx: TurnContext, item: OwedItem): NonNullable<OwedItem['job']> {
  const task = item.ref;
  const job = item.job ?? { origin: null, ask: null };
  withUnit(() => {
    serveLater({ kind: 'task', id: task }, null, 'claimed by its job turn');
    if (job.ask?.state === 'blocked') claimAsk(job.ask.row.work_id, agentId, 'blocked');
  });
  const run = inFlightOccurrence(task)?.id ?? null;
  turnCtx.servedWork = resolveServedWork(task, run);
  turnCtx.servedJob = task;
  const r = job.ask?.row;
  turnCtx.root = r ? { kind: 'ask', id: r.id, sourceMessageId: r.id, conversationId: r.conversation_id }
    : run ? { kind: 'occurrence', id: run, sourceMessageId: null } : null;
  return job;
}
