// ════════════════════════════════════════════════════════════════════════════════
// ORPHANED CLAIMS — an ask whose serving turn died with its process
//
// Invocation (c) of the settlement authority (`work/ask-settlement.ts`), split out of that
// file whole when it stopped being boot-only: the boot and the stuck-run reaper are its two
// callers, and they share this one function rather than two copies of its scope.
//
// THE SIGNAL IS THE DEAD TURN, NEVER THE CLOCK. A claiming turn is dead when it is still open
// at boot (the process that ran it is gone) or when the dead-run verdict closed it as
// `terminated` (`agent/v2/turn-record.ts markTurnsTerminated`, the only writer of that exit).
// This used to be bounded by a 30-minute window on the claim's age, so a turn that ran longer
// than that and was then cut off left its owner's message `claimed` for ever. The window is
// gone; the message's real age travels in the hand-back instead, and the agent judges whether
// it still matters (3.5 proof run O2 and its follow-up rulings).
//
// Outcomes, and no fifth:
//   * the dead turn DELIVERED -> the authority closes the ask against that delivery;
//   * it did nothing -> the ask goes back to the agent, with a notice saying when it arrived;
//   * it had already acted -> P6b's hold, for now (see `reArm` below);
//   * it closed the ask and then DELEGATED under it (SWEEP-A TB3's crash window) -> handed back
//     through the authority so the join's nets have something to catch.
// Each row is adjudicated once: the first look moves it out of the state the queries select.
// ════════════════════════════════════════════════════════════════════════════════
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { settleAsk } from './ask-settlement.js';
import { revertAskClaimOnAbort } from './store.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { formatTimeForAgent } from '../services/format-time.js';

const logger = createLogger('orphaned-claims');

/** The claiming (or delivering) turn `t` died with its process. One definition, every arm. */
const DEAD_TURN = `(t.ended_at IS NULL OR t.exit_reason = 'terminated')`;

/** "3 days", "2 hours", "5 minutes", "40 seconds" — the age as a person would say it. */
export function ageInWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const [n, unit] = s >= 86_400 ? [Math.floor(s / 86_400), 'day'] : s >= 3_600 ? [Math.floor(s / 3_600), 'hour']
    : s >= 60 ? [Math.floor(s / 60), 'minute'] : [s, 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

interface Orphan {
  id: string; agent_id: string; turn_number: number | null; effectful_calls: number;
  received_at: number | null; content: string | null;
}

/** The agent is told, on the turn that serves it again, why it has this message back and how old it is. */
function tellAgentHandedBack(o: Orphan): void {
  const snippet = (o.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const when = o.received_at != null
    ? `received ${formatTimeForAgent(o.received_at)} (${ageInWords(Date.now() - o.received_at)} ago)`
    : 'received at a time that was not recorded';
  postAgentNotice({
    toAgentId: o.agent_id, fromName: 'Dojo', selfIntro: false,
    brief: `Your turn ${o.turn_number ?? '(unrecorded)'} stopped before it answered (the Dojo restarted or that run `
      + `stopped responding), so the message it was answering is handed back to you: "${snippet}", ${when}. `
      + 'Answer it now. If it is old, judge whether it still matters and say what has changed rather than acting on it blindly.',
  });
}

/** Hand one orphan back to its agent. `null` = held (P6b), otherwise whether it moved. */
function reArm(o: Orphan, by: string): boolean | null {
  const res = revertAskClaimOnAbort(o.id, o.effectful_calls,
    `${by}: the claiming turn died with its process before it answered`);
  if (res === null) return null;
  if (res.kind !== 'applied') return false;
  tellAgentHandedBack(o);
  return true;
}

/**
 * Adjudicate every ask whose serving turn is dead. `agentId` narrows it to one agent — the
 * stuck-run reaper's scope, where only that agent's run has been judged dead; the boot passes
 * nothing, because at boot every turn of the previous process is dead.
 */
export function reconcileOrphanedClaims(scope: { agentId?: string } = {}):
{ reArmed: number; held: number; closed: number; handedBack: number } {
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

  const rows = db.prepare(`
    SELECT w.id AS id, w.agent_id AS agent_id, w.claimed_by_turn AS turn_number,
           COALESCE(t.effectful_calls, 0) AS effectful_calls, m.created_at AS received_at, m.content AS content
      FROM work w
      LEFT JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = w.claimed_by_turn
      LEFT JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id
     WHERE w.kind = 'ask' AND w.state = 'claimed' AND (? IS NULL OR w.agent_id = ?)
       AND (t.turn_number IS NULL OR ${DEAD_TURN})
  `).all(agent, agent) as Orphan[];
  let reArmed = 0; let held = 0;
  for (const r of rows) {
    const moved = reArm(r, agent === null ? 'boot reconciliation' : 'stuck-run reconciliation');
    if (moved === null) held++;
    else if (moved) reArmed++;
  }
  // ── THE CRASH WINDOW (SWEEP-A TB3) ──
  // `claimed_by_turn` was NULLed by the close, so the serving turn is re-identified through
  // the receipt the close points at — the same re-identification `settleAsksAtTurnFinalize`
  // performs for the same shape, written the same way on purpose.
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

  if (reArmed > 0 || held > 0 || closed > 0 || handedBack > 0) {
    logger.warn('reconciliation of orphaned ask claims', { agentId: agent, reArmed, held, closed, handedBack });
  }
  return { reArmed, held, closed, handedBack };
}
