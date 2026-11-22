// THE INHERITED BACKLOG: on the boot where the release step `orphaned-ask-backlog` is owed
// (`release/release-steps.ts`), an orphan whose dead turn this process did not close goes to `blocked` (owed,
// shown, not served) and its agent is told once; the engine texts nobody. Idempotent: a parked ask is no
// longer `claimed`, so a repeated boot finds nothing.
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { createLogger } from '../logger.js';
import { appendWorkEvent, transition } from './store.js';
import { callOff } from './call-off.js';
import { insertEngineEventIfAbsent } from '../memory/message-store.js';
import { ageInWords } from './hand-back-facts.js';
import { INHERITED_BACKLOG_MARKER, REPLY_IN_FLIGHT, settleAsk } from './ask-settlement.js';
export { INHERITED_BACKLOG_MARKER };

const logger = createLogger('inherited-backlog');

/** When THIS process started, in the form `turns.ended_at` is written in (`datetime('now')`, UTC). A dead turn
 *  closed at or after it was closed by this process's own boot sweep or reaper: the process that just died. */
export const PROCESS_STARTED_AT = new Date().toISOString().replace('T', ' ').slice(0, 19);


/** Where THIS boot's pass records itself: the release step reads it, and only a completed pass of this very
 *  process lets the boundary marker move. Durable, so a lost process cannot fake a completion. */
const PASS_KEY = 'orphaned_ask_backlog_pass';

interface PassRecord { at: string; examined: number; parked: number; completed: boolean }

/** This process's completed pass, or null; on null the release step throws so the next boot parks. */
export function completedInheritedBacklogPass(): PassRecord | null {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(PASS_KEY) as { value: string } | undefined;
  const rec = row ? JSON.parse(row.value) as PassRecord : null;
  return rec && rec.at === PROCESS_STARTED_AT && rec.completed ? rec : null;
}

interface Inherited {
  id: string; agent_id: string; content: string | null; received_at: number | null;
  channel: string | null; counterparty: string | null; sender: string | null;
}

/** Park every orphan an older version stranded; `deadTurn` is the reconcile's own predicate over `t`.
 *  Runs at boot, before any turn, so an open turn here is a dead one. */
export function parkInheritedBacklog(deadTurn: string, bootAt = PROCESS_STARTED_AT): { examined: number; parked: number } {
  const db = getDb();
  const rows = db.prepare(`
    SELECT w.id AS id, w.agent_id AS agent_id, m.content AS content, m.created_at AS received_at,
           COALESCE(c.channel, m.channel) AS channel, COALESCE(c.counterparty_name, c.counterparty_id) AS counterparty,
           m.sender_id AS sender
      FROM work w
      LEFT JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = w.claimed_by_turn
      LEFT JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id
      LEFT JOIN conversations c ON c.id = w.conversation_id
     WHERE w.kind = 'ask' AND w.state = 'claimed'
       AND (t.turn_number IS NULL OR ${deadTurn})
       AND NOT (t.exit_reason IS 'terminated' AND t.ended_at >= ?) AND NOT ${REPLY_IN_FLIGHT}
     ORDER BY w.opened_at
  `).all(bootAt) as Inherited[];
  const byAgent = new Map<string, Inherited[]>();
  for (const r of rows) {
    let res: ReturnType<typeof transition>;
    try {
      res = transition(r.id, {
        to: 'blocked', by: 'agent', actorId: 'engine', expectedState: 'claimed',
        reason: 'inherited from an older version: the run serving it died before this build, and older builds never handed '
          + 'it back. Held OWED and shown, not served automatically; the agent was told and decides',
      });
    } catch (err) {
      logger.warn('an inherited orphan could not be parked; the pass is incomplete', { workId: r.id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (res.kind !== 'applied') continue;
    appendWorkEvent(r.id, 'audit', 'inherited-backlog', { marker: INHERITED_BACKLOG_MARKER });
    byAgent.set(r.agent_id, [...(byAgent.get(r.agent_id) ?? []), r]);
  }
  for (const [agentId, owed] of byAgent) tellAgentOwed(agentId, owed);
  const parked = [...byAgent.values()].reduce((n, a) => n + a.length, 0);
  // COMPLETE means every orphan this pass found was parked; one that refused the move is still `claimed`, and a
  // marker moved past it would let the next boot hand it back as fresh.
  const rec: PassRecord = { at: bootAt, examined: rows.length, parked, completed: parked === rows.length };
  setConfigValue(PASS_KEY, JSON.stringify(rec));
  if (parked > 0 || !rec.completed) logger.warn('inherited orphaned asks parked owed (first boot of this build)', { ...rec, agents: byAgent.size });
  return { examined: rec.examined, parked };
}

/** ONE deliverable notice per agent. The stored row carries ask ids and instructions only (no sender, no words),
 *  because a served engine row stays in later turns' events lane. The list itself is rendered live, whole, on the
 *  one turn this row drives (`inheritedOwedListFor`, delivered by the hand-back steer). */
function tellAgentOwed(agentId: string, owed: Inherited[]): void {
  insertEngineEventIfAbsent({
    id: uuidv4(), agentId, sourceAgentId: null, originIntent: 'owed_messages_inherited', work: null,   // = INHERITED_NOTICE_INTENT (the census reads literals)
    notBefore: Date.now() + 180_000,   // the owner's first message after the update is served before this catch-up
    content: `[SOURCE: AGENT NOTICE from Dojo] After this update the Dojo found ${owed.length} message(s) an older version left `
      + `unanswered, now held owed and NOT answered automatically: ${owed.map((o) => `[${o.id}]`).join(', ')}. `
      + 'Who sent each and what it says is listed for you on this turn. '
      + `Decide which still matter, and settle each one: ${SETTLE_BOTH_WAYS} (say plainly that a reply is late). `
      + 'Nothing closes them on its own. The Dojo has sent nothing to anyone.',
  });
}

export const INHERITED_NOTICE_INTENT = 'owed_messages_inherited';

const SETTLE_BOTH_WAYS = 'answer it in its own conversation, then call work_close_request(<id>, kept); or dropped with your reason';

/** Who a message is from, in the owner's words: "the owner" for his own, else the conversation's name. */
export const senderWords = (counterparty: string | null, sender: string | null = null): string =>
  sender === 'owner' || counterparty === 'owner' ? 'the owner' : (counterparty ?? sender ?? 'an unrecorded sender');

export function inheritedOwedListFor(noticeContent: string): string | null {
  const ids = [...noticeContent.matchAll(/\[(ask:[^\]\s]+)\]/g)].map((m) => m[1]);
  const lines: string[] = [];
  for (const id of ids) {
    const o = getDb().prepare(`
      SELECT w.id AS id, w.agent_id AS agent_id, m.content AS content, m.created_at AS received_at,
             COALESCE(c.channel, m.channel) AS channel, COALESCE(c.counterparty_name, c.counterparty_id) AS counterparty,
             m.sender_id AS sender
        FROM work w LEFT JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id
        LEFT JOIN conversations c ON c.id = w.conversation_id
       WHERE w.id = ? AND w.state = 'blocked'`).get(id) as Inherited | undefined;
    if (!o) continue;
    const from = senderWords(o.counterparty, o.sender);
    const age = o.received_at != null ? `${ageInWords(Date.now() - o.received_at)} ago` : 'at an unrecorded time';
    const snippet = (o.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    lines.push(`(${lines.length + 1}) [${o.id}] from ${from}, in the ${o.channel ?? 'unknown'} conversation, received ${age}: "${snippet}"`);
  }
  return lines.length === 0 ? null
    : `THE MESSAGES AN OLDER VERSION LEFT UNANSWERED, held owed for you to decide on:\n${lines.join('\n')}`;
}

function isInheritedOwed(workId: string): boolean {
  return getDb().prepare(
    `SELECT 1 FROM work w WHERE w.id = ? AND w.kind = 'ask' AND w.state = 'blocked'
        AND EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = w.id AND e.kind = 'audit' AND json_extract(e.payload, '$.marker') = ?)`,
  ).get(workId, INHERITED_BACKLOG_MARKER) !== undefined;
}

/** The tracker door's answer for an INHERITED ask, or null for any other row. Nobody called it off, so a
 *  stand-down is the AGENT's judgement, recorded as that and landing on `abandoned`, never "cancelled by the
 *  user". `kept` is refused with the truth: answering it in its own conversation closes it. */
export function inheritedAskDoor(workId: string, disposition: string, note: string | null, agentId: string):
{ content: string; isError: boolean } | null {
  if (!isInheritedOwed(workId)) return null;
  if (disposition === 'kept') {
    // The agent names it; the engine closes it only on a real delivery of the agent's own in that ask's
    // conversation since the park, and that delivery is the receipt. Nothing else closes it.
    const v = settleAsk(workId, { agentId, actorId: agentId, turnNumber: null, at: 'delivery', inheritedKept: true });
    if (v.verdict === 'closed') return { isError: false, content: `[OK] Closed: ${workId} — answered late, on your delivery ${v.deliveryId}.` };
    return { isError: true, content: `Not closed: nothing you delivered in ${workId}'s own conversation since it was held owed. `
      + `${SETTLE_BOTH_WAYS}.` };
  }
  if (disposition !== 'dropped') return { isError: true, content: `Not closed: ${workId} is an inherited message. ${SETTLE_BOTH_WAYS}.` };
  if (!note) {
    return { isError: true, content: `Not dropped: pass \`note\` with your own reason why ${workId} no longer needs an answer. `
      + 'It goes on the record as your judgement (nobody called it off).' };
  }
  const r = callOff(workId, { deciderAgentId: agentId }, `no longer needs an answer — the agent's judgement on an inherited message (nobody called it off): ${note}`);
  return r.kind === 'decided'
    ? { isError: false, content: `[OK] Stood down: ${workId} — recorded as your judgement that it no longer needs an answer, not as answered.` }
    : { isError: true, content: `Error: could not stand down ${workId} (${r.text}).` };
}
