// Engine-side judgment of whether a person's message is work, and the start-ack steer the verdict arms.
// Returns state (it enqueues on the steer queue). staleTaskWindowMinutes is an INPUT, never an
// import: a guard pins the constant's declaration to `loop.ts` by path and the `execute` span reads it too.

import { getDb } from '../../../../db/connection.js';
import { isDreamerAgent, isHealerAgent, isPMAgent } from '../../../../config/platform.js';
import { notWaitingForItsTimeSql, taskScope } from '../../../../work/tracker-view.js';
import { type AgentTurnState } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import { type TurnCounterparty } from '../../counterparty.js';
import { createLogger } from '../../../../logger.js';
import { armStartAck, startAckDoorOpen } from './start-ack-door.js';
import { workingExpr } from '../../../../work/done/hold.js';
import { inboundIsWork } from '../../classifiers/inbound-routing.js';
import { looksLikeEngineMessage, userExplicitlyAsksToCreateTracker } from '../../classifiers/multistep.js';

const logger = createLogger('v2-loop');

export interface MultistepInput {
  readonly agentId: string;
  /** The turn the start-ack steer's durable row is stamped with. */
  readonly turnNumber: number;
  readonly turnCtx: TurnContext;
  readonly db: import('better-sqlite3').Database;
  readonly counterparty: TurnCounterparty;
  readonly counterpartyIsAgentSender: boolean;
  readonly lastUserMessageContent: string | null;
  readonly engineStartAckDeliveredThisTurn: boolean;
  readonly staleTaskWindowMinutes: number;
}

export async function detectMultistepAndScaffold(stateIn: AgentTurnState, input: MultistepInput): Promise<AgentTurnState> {
  const {
    agentId, turnNumber, turnCtx, counterparty, counterpartyIsAgentSender, lastUserMessageContent,
    engineStartAckDeliveredThisTurn,
  } = input;
  const STALE_TASK_WINDOW_MINUTES = input.staleTaskWindowMinutes;
  let state = stateIn;

  // Never start-ack an agent-flagged counterparty (ack ping-pong); the shared door arms synchronously,
  // so a second opener on one turn is a no-op.
  const thisOpenerMayArm = (): boolean =>
    counterparty.kind === 'user' && !counterpartyIsAgentSender
    && startAckDoorOpen(turnCtx, engineStartAckDeliveredThisTurn);
  // Arming here: the steer rides the call being built, so the first response opens with its start line.
  const arm = (s: AgentTurnState): AgentTurnState =>
    armStartAck(s, { agentId, turnNumber, turnCtx, engineStartAckDeliveredThisTurn });

  // Engine classifies rather than trusting prompt instructions: first loop with a real user message.
  // PM/Healer/Dreamer skip: their engine-synthetic rows are not user asks; the Healer has no tracker tools.
  if (state.loopCount === 1 && lastUserMessageContent && !isPMAgent(agentId) && !isHealerAgent(agentId) && !isDreamerAgent(agentId)) {
    try {
      // The verdict is recorded whatever tasks exist. The start line is skipped only on an open task touched inside
      // the stale window that can be worked now (a quick follow-up rides under the task it continues); a stale task
      // or a schedule waiting for its time does not skip it.
      const db = getDb();
      const existingTask = db.prepare(`
        SELECT w.id AS id FROM work w
        WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w', true)}
          AND w.updated_at >= ? AND ${notWaitingForItsTimeSql('w')}
        LIMIT 1
      `).get(agentId, Date.now() - STALE_TASK_WINDOW_MINUTES * 60_000, Date.now()) as { id: string } | undefined;

      // Also skip a creation prompt: it is byte-identical to a system row (the bootstrap twin).
      const bootstrapTwin = db.prepare(
        `SELECT 1 FROM messages WHERE agent_id = ? AND role = 'system' AND content = ? LIMIT 1`,
      ).get(agentId, lastUserMessageContent);
      if (!bootstrapTwin && !looksLikeEngineMessage(lastUserMessageContent)) {
        const explicit = userExplicitlyAsksToCreateTracker(lastUserMessageContent);
        const work = !explicit && await inboundIsWork(turnCtx, agentId, lastUserMessageContent) === true;
        turnCtx.inboundClassifiedAsWork = work || explicit;
        logger.info('v2 inbound judged', { agentId, work, explicit }, agentId);
        // Nothing is created on a prediction: the >=6 engine floor opens the row only on OBSERVED work.
        if (work && !existingTask && thisOpenerMayArm()) state = arm(state);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(msg)) {
        logger.debug('v2 inbound judgment: tracker tables not present (expected in tests/fresh DBs)', { agentId }, agentId);
      } else {
        logger.warn('v2 inbound judgment failed (non-fatal)', { agentId, error: msg }, agentId);
      }
    }
  }

  return state;
}
