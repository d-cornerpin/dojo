// The thrash ladder, run before each model call. Soft drift (8 iterations under the gate) nudges once
// and never blocks, because real progress varies signatures too; the nudge does NOT reset the drift
// window, so a signature-varying spiral still reaches the hard limit (24). Hard drift and the refusal
// breaker (6) are terminal. The PM agent is exempt. The engine never speaks as the agent here.

import { v4 as uuidv4 } from 'uuid';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { getDb } from '../../../../db/connection.js';
import { isPMAgent } from '../../../../config/platform.js';
import { insertMessageIfAbsent, insertEngineEventIfAbsent } from '../../../../memory/message-store.js';
import { taskScope, ENGINE_SCAFFOLD_ROOT_KIND } from '../../../../work/tracker-view.js';
import { setHold, heldExpr, workingExpr } from '../../../../work/done/hold.js';
import { advance, type AgentTurnState } from '../../state.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { steerFired } from '../../steer-queue.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PreCallGatesContext, PreCallGatesExitReason } from './index.js';
import { currentAddress, userWords } from '../../turn-address.js';

const logger = createLogger('v2-loop');

/** Refusals the per-signature gate will absorb before the engine blocks the task. */
const THRASH_GATE_BREAKER_LIMIT = 6;
// Soft drift: the engine nudges once and never blocks.
const THRASH_GATE_DRIFT_LIMIT = 8;
// Hard drift: a signature-varying spiral never raises the refusal count, so this is its terminal stop.
const THRASH_GATE_DRIFT_HARD_LIMIT = 24;

/** The thrash ladder. Returns `proceed` unless the terminal block fired and the turn is over. */
export function runThrashGate(state: AgentTurnState, ctx: PreCallGatesContext): StepOutcome {
  const { agentId, turnNumber, counterparty, broadcast, detectTaskThrashing } = ctx;

  // Drift counts iterations since the gate activated; a closing tracker transition clears the gate
  // (`execute/dispatch-bookkeeping.ts`).
  const drift =
    state.thrashGateActivatedAtLoopCount !== null
      ? state.loopCount - state.thrashGateActivatedAtLoopCount
      : 0;
  const refusalTrip = state.thrashGateRefusalCount >= THRASH_GATE_BREAKER_LIMIT;
  const driftSoftTrip = drift >= THRASH_GATE_DRIFT_LIMIT;
  const driftHardTrip = drift >= THRASH_GATE_DRIFT_HARD_LIMIT;
  if (!isPMAgent(agentId) && driftSoftTrip && !driftHardTrip && !refusalTrip) {
    if (!steerFired(state.steerQueue, 'thrash-drift')) {
      const driftNudge =
        `[Engine hint] The engine thrash gate has been active for ${drift} iterations and you keep ` +
        `varying your tool calls without recording progress. If you ARE making progress, record it with ` +
        `work_update(action="status") (or work_note), then continue. If you are stuck, tell ${userWords(currentAddress(agentId))} ` +
        `where things stand and what you need.`;
      // One model-facing channel: `persistEngineSteer` enqueues the steer and writes its durable row.
      state = persistEngineSteer(
        state,
        { agentId, content: driftNudge, turnNumber, floor: 'thrash-drift', atLoop: state.loopCount },
        { broadcast },
      );
      logger.info('v2: thrash drift nudge (one-shot; drift keeps accruing to the hard limit)', {
        agentId, drift, loopCount: state.loopCount,
      }, agentId);
    }
    // fall through, soft drift never blocks; the hard limit below is the stop
  } else if (!isPMAgent(agentId) && (refusalTrip || driftHardTrip)) {
    // TERMINAL BLOCK: the task is held blocked, the agent is told on the events lane, the person by a
    // platform owner-alert row if the work is theirs, and a toast fires.
    const breakerReason = refusalTrip
      ? `agent repeated refused calls ${state.thrashGateRefusalCount}× without changing course`
      : `agent kept varying call signatures for ${drift} iterations around the thrash gate without recording progress`;
    // Second person for the agent's note, which prepends "because".
    const breakerReasonSecondPerson = refusalTrip
      ? `you repeated refused calls ${state.thrashGateRefusalCount}× without changing course`
      : `you kept varying call signatures for ${drift} iterations around the thrash gate without recording progress`;
    // Does the blocked work trace to a user request? An engine-scaffold project also counts.
    let blockedWorkIsUserOrigin = counterparty.kind === 'user';
    try {
      const db2 = getDb();
      const task = db2.prepare(`
        SELECT w.id AS id, w.title AS title, w.parent_id AS project_id,
               w.root_kind AS root_kind FROM work w
        WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w')} AND NOT ${heldExpr('w')}
        ORDER BY w.updated_at DESC LIMIT 1
      `).get(agentId) as { id: string; title: string; project_id: string | null; root_kind: string } | undefined;
      if (task) {
        if (!blockedWorkIsUserOrigin && task.root_kind === ENGINE_SCAFFOLD_ROOT_KIND) {
          blockedWorkIsUserOrigin = true;
        }
        const held = setHold(task.id, 'blocked', `engine auto-block: ${breakerReason}`, 'engine');
        if (!held.ok) logger.warn('thrash gate: engine auto-block refused', { taskId: task.id, why: held.why }, agentId);
        void import('../../../../tracker/schema.js').then(({ getTask: schemaGetTask }) => {
          const fresh = schemaGetTask(task.id);
          if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
        }).catch(() => { /* best effort */ });
        logger.warn('v2: thrash gate breaker tripped, task auto-blocked', {
          taskId: task.id, refusalCount: state.thrashGateRefusalCount, loopCount: state.loopCount,
        }, agentId);
      }
      // The agent's note rides the events lane on its next turn: no steer, since the turn ends here, and
      // a role='system' row never reaches the model. The agent decides what the person hears.
      const agentNoteId = uuidv4();
      insertEngineEventIfAbsent({
        work: null,
        id: agentNoteId,
        agentId,
        content:
          `[System] The engine auto-blocked your current task because ${breakerReasonSecondPerson}. Next turn, either ` +
          `re-state the goal and resume (work_update(action="status")), or tell ${userWords(currentAddress(agentId))} it is blocked and why. ` +
          `If ${userWords(currentAddress(agentId))} should know this — and if they were waiting on this work, they should — WRITE it to them ` +
          `in your own words, directly in the conversation (the engine routes your reply; do not call a send tool). ` +
          `If this block looks wrong and is stopping something ${userWords(currentAddress(agentId))} needs, tell them what you were attempting so they can decide.`,
        sourceAgentId: null,
        originIntent: 'thrash_block',
        turnNumber,
      });
    } catch (err) {
      logger.warn('v2: thrash auto-block failed', { error: err instanceof Error ? err.message : String(err) }, agentId);
    }
    // The platform tells the person as the platform: a role='system' owner-alert row, announced only if
    // it was written. No `floor_ghosted` row: no steer was written, so nothing was ghosted.
    if (blockedWorkIsUserOrigin) {
      try {
        const noteId = uuidv4();
        const content =
          `${OWNER_ALERT_HEADS_UP_PREFIX} your agent kept retrying the same step without getting anywhere, `
          + `so the platform stopped it rather than let it spin. The work is left open and flagged. `
          + `Ask your agent about it and it can pick the work back up or explain what it was attempting.`;
        const persisted = insertMessageIfAbsent({ id: noteId, agentId, role: 'system', content, turnNumber });
        if (persisted) {
          broadcast({
            type: 'chat:message', agentId,
            message: {
              id: noteId, agentId, role: 'system', content,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: persisted.createdAt,
            },
          });
        }
      } catch { /* the toast below still fires; a note is not worth the turn */ }
    }
    try {
      broadcast({
        type: 'chat:error', cardClass: 'informational',
        agentId,
        error: `Engine auto-blocked task, ${breakerReason}.`,
        code: 'TASK_THRASH_PAUSED',
        severity: 'warning',
        retryable: true,
      });
    } catch { /* best effort */ }
    // No idle status write here: teardown owns it.
    return requestExit(state, 'thrash-auto-block' satisfies PreCallGatesExitReason);
  }

  // Per-signature gate: the same canonical signature 4+ times across this turn and the one before
  // gets a steer naming the exact call, and from then on only that signature is refused.
  if (!isPMAgent(agentId) && state.loopCount >= 4) {
    const thrash = detectTaskThrashing(agentId);
    if (thrash.thrashing && thrash.signature && !state.thrashGatedSignatures.includes(thrash.signature)) {
      // The signature is `name:{json}`; the JSON tail shows the args verbatim.
      const argsPart = thrash.signature.includes(':')
        ? thrash.signature.slice(thrash.signature.indexOf(':') + 1)
        : '{}';
      // The steer may say the first result is already here only because `canonicalToolSignature` carries
      // every argument: a match means the model asked for the same work.
      const steerMsg =
        `[Engine thrash gate] You've called \`${thrash.toolName}(${argsPart})\` ${thrash.count}× on this turn (and its continuation), ` +
        `with the SAME arguments every time. The first call's result is already in this conversation; ` +
        `further calls with these exact args are refused.\n\n` +
        `Your next action MUST be one of:\n` +
        `  (a) Continue the work from that result: the next item or step, or \`${thrash.toolName}\` with DIFFERENT args (e.g., a different id / target) if you genuinely have more to read.\n` +
        `  (b) Reply to ${userWords(currentAddress(agentId))} with the answer you can give using the data you already have, if that is what they asked for.\n` +
        `  (c) Call work_update(action="status", status='blocked') if you genuinely cannot proceed.\n` +
        `  (d) Send ${userWords(currentAddress(agentId))} a specific question if you need clarification.\n` +
        `  (e) Only if a tracker task is done: work_update(action="hand_in") with its proof.\n\n` +
        `If you keep hitting refused signatures the engine will auto-block this task to stop the loop.`;
      logger.warn('v2: thrash gate activated for signature', {
        toolName: thrash.toolName, signature: thrash.signature,
        count: thrash.count, loopCount: state.loopCount,
      }, agentId);
      // Keyed on the signature, so a second gated signature is still its own steer.
      state = persistEngineSteer(
        state,
        { agentId, content: steerMsg, turnNumber, floor: 'thrash-gate', key: thrash.signature, atLoop: state.loopCount },
        { broadcast },
      );
      state = advance(state, {
        thrashGatedSignatures: [...state.thrashGatedSignatures, thrash.signature],
        thrashGateActivatedAtLoopCount: state.thrashGateActivatedAtLoopCount ?? state.loopCount,
      });
      try {
        broadcast({
          type: 'chat:error', cardClass: 'informational',
          agentId,
          error: `Engine refusing further ${thrash.toolName} calls with these args, continue with different input, or block the task if it cannot proceed.`,
          code: 'TASK_THRASH_PAUSED',
          severity: 'warning',
          retryable: true,
        });
      } catch { /* best effort */ }
      // No exit: the loop continues and `execute/refusal-gates.ts` refuses the gated signature.
    }
  }
  return proceed(state);
}
