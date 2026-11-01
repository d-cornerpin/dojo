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
// Outcomes, and no fourth:
//   * the dead turn DELIVERED -> the authority closes the ask against that delivery;
//   * it did not answer -> the ask goes back to the agent, with a notice saying when it arrived
//     and naming, from the ledger, every effect the dead turn had already made so the agent
//     does not repeat it. P6b's boot HOLD is retired here: it left the message `claimed` for
//     ever, and the agent can act (coordinator ruling on proof-fix-f, under OR-ENGINE-LABELLED);
//   * it closed the ask and then DELEGATED under it (SWEEP-A TB3's crash window) -> handed back
//     through the authority so the join's nets have something to catch.
// Each row is adjudicated once: the first look moves it out of the state the queries select.
// ════════════════════════════════════════════════════════════════════════════════
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { settleAsk } from './ask-settlement.js';
import { transition } from './store.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { formatTimeForAgent } from '../services/format-time.js';
import { isEffectfulTool } from '../agent/v2/steps/execute/effectful-call.js';
import { redactDeclaredSecretArgs } from '../credentials/secret-fields.js';

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

/** One effectful call the dead turn made, read back from its own stored tool rows. */
interface DeadTurnEffect { name: string; input: unknown; finished: boolean }

/**
 * What the dead turn already DID, from the ledger it wrote as it went: its `tool_use` rows and
 * their `tool_result` rows on `messages`. Counted by the same rule as `turns.effectful_calls`
 * (`isEffectfulTool`); a call whose result errored did nothing and is left out, and a call with
 * no result at all is the one the process died inside — it may or may not have happened.
 */
function effectsOf(agentId: string, turnNumber: number | null): DeadTurnEffect[] {
  if (turnNumber == null) return [];
  const rows = getDb().prepare(
    `SELECT role, content FROM messages
      WHERE agent_id = ? AND turn_number = ? AND role IN ('assistant', 'tool') AND content LIKE '[%'
      ORDER BY seq`,
  ).all(agentId, turnNumber) as Array<{ role: string; content: string }>;
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  const results = new Map<string, boolean>();          // tool_use_id -> is_error
  for (const r of rows) {
    let blocks: unknown;
    try { blocks = JSON.parse(r.content); } catch { continue; }
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        calls.push({ id: b.id, name: b.name, input: b.input });
      } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        results.set(b.tool_use_id, b.is_error === true);
      }
    }
  }
  return calls
    .filter((c) => isEffectfulTool(c.name) && results.get(c.id) !== true)
    .map((c) => ({ name: c.name, input: c.input, finished: results.has(c.id) }));
}

function describeEffect(e: DeadTurnEffect): string {
  const args = e.input && typeof e.input === 'object'
    ? redactDeclaredSecretArgs(e.name, e.input as Record<string, unknown>) : e.input;
  const shown = JSON.stringify(args ?? {}).slice(0, 200);
  return `${e.name} ${shown}${e.finished ? '' : ' (no result was recorded: the run stopped inside it, so it may or may not have happened — check)'}`;
}

/** The agent is told, on the turn that serves it again, why it has this message back, how old it is,
 *  and exactly what the dead turn had already done. */
function tellAgentHandedBack(o: Orphan, effects: DeadTurnEffect[]): void {
  const snippet = (o.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const when = o.received_at != null
    ? `received ${formatTimeForAgent(o.received_at)} (${ageInWords(Date.now() - o.received_at)} ago)`
    : 'received at a time that was not recorded';
  const done = effects.length === 0 ? ''
    : ` Before it stopped, that turn had already done this, and it is on the record: ${effects.map((e, i) => `(${i + 1}) ${describeEffect(e)}`).join('; ')}. `
      + 'Do not repeat any of it: finish only what is left, and tell the person what was already done.';
  postAgentNotice({
    toAgentId: o.agent_id, fromName: 'Dojo', selfIntro: false,
    brief: `Your turn ${o.turn_number ?? '(unrecorded)'} stopped before it answered (the Dojo restarted or that run `
      + `stopped responding), so the message it was answering is handed back to you: "${snippet}", ${when}. `
      + 'Answer it now. If it is old, judge whether it still matters and say what has changed rather than acting on it blindly.'
      + done,
  });
}

/** Hand one orphan back to its agent. Never held: an agent can act, so it finishes the job (no duplicate effects —
 *  the notice names them). Returns whether the row moved. */
function reArm(o: Orphan, by: string): boolean {
  const effects = effectsOf(o.agent_id, o.turn_number);
  const acted = effects.length > 0 || o.effectful_calls > 0;
  const res = transition(o.id, {
    to: 'open', by: 'agent', actorId: 'engine', expectedState: 'claimed',
    reason: `${by}: the claiming turn died with its process before it answered`
      + (acted ? ` (it had already made ${Math.max(effects.length, o.effectful_calls)} effectful call(s); the hand-back names them)` : ''),
  });
  if (res.kind !== 'applied') return false;
  tellAgentHandedBack(o, effects);
  return true;
}

/**
 * Adjudicate every ask whose serving turn is dead. `agentId` narrows it to one agent — the
 * stuck-run reaper's scope, where only that agent's run has been judged dead; the boot passes
 * nothing, because at boot every turn of the previous process is dead.
 */
export function reconcileOrphanedClaims(scope: { agentId?: string } = {}):
{ reArmed: number; closed: number; handedBack: number } {
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
  let reArmed = 0;
  for (const r of rows) if (reArm(r, agent === null ? 'boot reconciliation' : 'stuck-run reconciliation')) reArmed++;
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

  if (reArmed > 0 || closed > 0 || handedBack > 0) {
    logger.warn('reconciliation of orphaned ask claims', { agentId: agent, reArmed, closed, handedBack });
  }
  return { reArmed, closed, handedBack };
}

/**
 * The stuck-run reaper's call (`agent/runtime.ts`), WHILE THE SERVER STAYS UP: each agent it just
 * judged dead gets its orphaned asks back through the same reconcile the boot runs, and is woken
 * to serve them. At boot the reaper leaves this to index.ts step 4b1, after the staleness sweep.
 */
export function handBackOrphansOf(agentIds: string[], wake: (agentId: string) => Promise<unknown>): void {
  for (const id of agentIds) {
    try {
      if (reconcileOrphanedClaims({ agentId: id }).reArmed === 0) continue;
      wake(id).catch((err) => {
        logger.error('orphaned-claim wake failed', { agentId: id, error: err instanceof Error ? err.message : String(err) }, id);
      });
    } catch (err) {
      logger.warn('orphaned-claim hand-back failed', { agentId: id, error: err instanceof Error ? err.message : String(err) }, id);
    }
  }
}
