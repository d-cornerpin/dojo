// HOUSEKEEPING: a service agent's own upkeep, opened by that agent or by the engine, is nobody's assigned
// work. It opens with `root_kind = 'service'` (`tracker-store.ts`), outside the board and every decider's
// queue, and when its worker hands it in the engine settles it on its own receipt.
import { getDb } from '../../db/connection.js';
import { recordDecisionReceipt, deliveryIdOf } from '../../agent/v2/deliveries.js';
import { transition, type WorkState } from '../store.js';
import { SERVICE_ROOT_KIND } from '../tracker-view.js';
import { unitOrRollback, recordAdjudication } from './record.js';
import type { HandInInput, HandInResult } from './hand-in.js';

export const isHousekeeping = (workId: string): boolean =>
  !!getDb().prepare('SELECT 1 FROM work WHERE id = ? AND root_kind = ?').get(workId, SERVICE_ROOT_KIND);

/** Settle a housekeeping row on the engine's receipt: done when finished, failed when it can't be done. */
export function settleHousekeeping(input: HandInInput): HandInResult {
  const row = getDb().prepare('SELECT state, COALESCE(assignee_agent, agent_id) AS worker FROM work WHERE id = ?').get(input.workId) as { state: WorkState; worker: string };
  if (input.by.kind === 'worker' && input.by.agentId !== row.worker) return { kind: 'refused', text: `Refused: ${input.workId} is ${row.worker}'s housekeeping, not yours.` };
  const to: WorkState = input.outcome === 'finished' ? 'done' : 'failed';
  const moved = unitOrRollback(() => {
    const receipt = deliveryIdOf(recordDecisionReceipt(input.workId, 'The engine', 'its own housekeeping receipt'));
    recordAdjudication(input.workId, to, 'engine', receipt, 'housekeeping settled on its own receipt');
    return transition(input.workId, {
      to, by: 'engine', actorId: 'engine', claim: 'decided', expectedState: row.state, evidenceRef: receipt,
      resultDeliveryId: to === 'done' ? receipt : null, reason: `housekeeping handed in: ${input.note.trim() || input.outcome}`,
    });
  });
  return moved.kind === 'applied' ? { kind: 'handed_in', eventId: 0, text: `Settled: housekeeping ${input.workId} is ${to}.` }
    : { kind: 'refused', text: `Refused: housekeeping ${input.workId} could not settle: ${moved.detail}.` };
}
