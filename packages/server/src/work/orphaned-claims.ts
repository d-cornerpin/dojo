// An ask whose serving turn died with its process: invocation (c) of the settlement authority
// (`work/ask-settlement.ts`), shared by the boot and the stuck-run reaper. The signal is the dead
// turn, never the clock: still open at boot, or closed `terminated` by the dead-run verdict
// (`agent/v2/turn-record.ts markTurnsTerminated`). Outcomes, and no fourth: the dead turn delivered
// -> the authority closes the ask; it did not answer -> the ask goes back to the agent with the
// facts recorded on it (`work/hand-back-facts.ts`), a send it died inside named so it is sent again;
// it closed and then delegated under it -> handed back through the authority.
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { REPLY_IN_FLIGHT, handBackAsk, settleAsk } from './ask-settlement.js';
import { abandonUnservableAsks } from './store.js';
import { recordHandBack } from './hand-back-facts.js';
import { parkInheritedBacklog, PROCESS_STARTED_AT } from './inherited-backlog.js';
export { handBackFactsFor } from './hand-back-facts.js';

const logger = createLogger('orphaned-claims');

/** The claiming (or delivering) turn `t` died with its process. One definition, every arm. */
const DEAD_TURN = `(t.ended_at IS NULL OR t.exit_reason = 'terminated')`;

/** An ask whose claiming turn `t` (left-joined) is gone or dead: this file's to adjudicate, never the boot heal's. */
export const ORPHANED_CLAIM = `(t.turn_number IS NULL OR ${DEAD_TURN})`;

interface Orphan { id: string; agent_id: string; turn_number: number | null; effectful_calls: number }

/** Hand one orphan back to its agent as a crash (counted, so a request that keeps killing its run stands down);
 *  the facts recorded on the ask name its effects. */
function reArm(o: Orphan, by: string): boolean {
  const res = handBackAsk(o.id, {
    agentId: o.agent_id, turnNumber: o.turn_number, cause: 'crash', actorId: 'engine',
    reason: `${by}: the claiming turn died with its process before it answered`
      + (o.effectful_calls > 0 ? ` (it had already made ${o.effectful_calls} effectful call(s); the hand-back names what it can)` : ''),
  });
  if (res.verdict !== 'reopened') return false;
  recordHandBack(o, by);
  return true;
}

/** Adjudicate every ask whose serving turn is dead; `agentId` narrows to one agent (the stuck-run reaper).
 *  `inheritedBacklog` parks what an older version stranded, after the answered arm, before any hand-back. */
export function reconcileOrphanedClaims(scope: { agentId?: string; inheritedBacklog?: boolean } = {}):
{ reArmed: number; closed: number; handedBack: number; parked: number } {
  const db = getDb();
  const agent = scope.agentId ?? null;
  const answered = db.prepare(`
    SELECT w.id AS id, w.agent_id AS agent_id, w.claimed_by_turn AS turn_number
      FROM work w
      JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = w.claimed_by_turn
     WHERE w.kind = 'ask' AND w.state = 'claimed' AND (? IS NULL OR w.agent_id = ?) AND ${DEAD_TURN}
     GROUP BY w.id
  `).all(agent, agent) as Array<{ id: string; agent_id: string; turn_number: number }>;
  let closed = 0;
  for (const a of answered) {
    const s = settleAsk(a.id, { agentId: a.agent_id, turnNumber: a.turn_number, at: 'boot', actorId: 'boot-reconciliation' });
    if (s.verdict === 'closed') closed++;
  }
  const backlog = scope.inheritedBacklog === true && agent === null;
  const parked = backlog ? parkInheritedBacklog(DEAD_TURN).parked : 0;

  const rows = db.prepare(`
    SELECT w.id AS id, w.agent_id AS agent_id, w.claimed_by_turn AS turn_number,
           COALESCE(t.effectful_calls, 0) AS effectful_calls
      FROM work w
      LEFT JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = w.claimed_by_turn
     WHERE w.kind = 'ask' AND w.state = 'claimed' AND (? IS NULL OR w.agent_id = ?)
       AND ${ORPHANED_CLAIM} AND NOT ${REPLY_IN_FLIGHT}
       -- On the boundary boot only what THIS process closed (the just-died process's orphans) is handed back; an
       -- inherited one the park could not move stays claimed for the next owed boot, never served (review R3-2).
       AND (? = 0 OR (t.exit_reason IS 'terminated' AND t.ended_at >= ?))
  `).all(agent, agent, backlog ? 1 : 0, PROCESS_STARTED_AT) as Orphan[];
  let reArmed = 0;
  for (const r of rows) if (reArm(r, agent === null ? 'boot reconciliation' : 'stuck-run reconciliation')) reArmed++;
  // The close clears `claimed_by_turn`, so the serving turn is re-identified through the receipt,
  // exactly as `settleAsksAtTurnFinalize` does for the same shape.
  const crashed = db.prepare(`
    SELECT w.id AS id, w.agent_id AS agent_id, d.turn_number AS turn_number
      FROM work w
      JOIN deliveries d ON d.id = w.result_delivery_id AND d.agent_id = w.agent_id
                       AND d.outcome = 'delivered'
      JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = d.turn_number
     WHERE w.kind = 'ask' AND w.state = 'done'
       AND (w.remaining_children > 0 OR w.compile_pending = 1)
       AND (? IS NULL OR w.agent_id = ?) AND ${DEAD_TURN}
     GROUP BY w.id
  `).all(agent, agent) as Array<{ id: string; agent_id: string; turn_number: number | null }>;
  let handedBack = 0;
  for (const c of crashed) {
    const s = settleAsk(c.id, { agentId: c.agent_id, turnNumber: c.turn_number, at: 'boot', actorId: 'boot-reconciliation' });
    if (s.verdict === 'held' || s.verdict === 'reopened') handedBack++;
  }

  if (reArmed > 0 || closed > 0 || handedBack > 0 || parked > 0) {
    logger.warn('reconciliation of orphaned ask claims', { agentId: agent, reArmed, closed, handedBack, parked });
  }
  return { reArmed, closed, handedBack, parked };
}

/** The stuck-run reaper's call (`agent/runtime.ts`) while the server stays up: reconcile, then
 *  wake. At boot the reaper leaves this to index.ts step 4b1, after the staleness sweep. */
export function handBackOrphansOf(agentIds: string[], wake: (agentId: string) => Promise<unknown>): void {
  for (const id of agentIds) {
    try {
      abandonUnservableAsks(id);   // the boot's own servability sweep first, never a second rule
      if (reconcileOrphanedClaims({ agentId: id }).reArmed === 0) continue;
      wake(id).catch((err) => {
        logger.error('orphaned-claim wake failed', { agentId: id, error: err instanceof Error ? err.message : String(err) }, id);
      });
    } catch (err) {
      logger.warn('orphaned-claim hand-back failed', { agentId: id, error: err instanceof Error ? err.message : String(err) }, id);
    }
  }
}
