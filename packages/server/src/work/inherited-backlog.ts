// ════════════════════════════════════════════════════════════════════════════════
// THE INHERITED BACKLOG — orphaned asks an OLDER version left `claimed`, on the first boot of
// the build that hands orphans back (proof-fix-f, review B2, coordinator ruling 2026-11-01).
//
// Since t93 (v3.3.0) the boot sweep closed a dead turn before the old reconcile looked for it, so
// every restart mid-turn stranded an ask, and nothing ever handed those back. This build hands
// back every dead claim with no window — and on its first boot that would serve the whole backlog,
// message after message, contacts included, about asks days or weeks old.
//
// THE VERSION BOUNDARY DECIDES, NOT A CLOCK OR A CAP. On the boot where the release step
// `orphaned-ask-backlog` is owed (`release/release-steps.ts`), an orphan whose dead turn was NOT
// closed by this process — its boot sweep or its reaper, both of which run after this module is
// loaded — was stranded by an older version. It goes to `blocked`: owed, on the open-work surface,
// not served by the drain (the same state the re-serve ladder's stand-down uses for "owed, stop
// serving"). Each affected agent is told ONCE, by a deliverable engine event that drives its own
// turn (where the driving row is kept whole), listing each message. The agent decides; the engine
// texts nobody. Idempotent: a parked ask is no longer `claimed`, so a repeated boot finds nothing.
// ════════════════════════════════════════════════════════════════════════════════
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { appendWorkEvent, dismissCommitment, transition } from './store.js';
import { insertEngineEventIfAbsent } from '../memory/message-store.js';
import { ageInWords } from './hand-back-facts.js';
import { INHERITED_BACKLOG_MARKER } from './ask-settlement.js';
export { INHERITED_BACKLOG_MARKER };

const logger = createLogger('inherited-backlog');

/** When THIS process started, in the form `turns.ended_at` is written in (`datetime('now')`, UTC). A dead turn
 *  closed at or after it was closed by this process's own boot sweep or reaper: the process that just died. */
export const PROCESS_STARTED_AT = new Date().toISOString().replace('T', ' ').slice(0, 19);


/** Where THIS boot's pass records itself (review R3-2): the release step reads it, and only a completed pass of
 *  this very process lets the boundary marker move. Durable, so a lost process cannot fake a completion. */
const PASS_KEY = 'orphaned_ask_backlog_pass';

interface PassRecord { at: string; examined: number; parked: number; completed: boolean }

/** This process's completed pass, or null — the release step throws on null so its marker stays and the next boot parks. */
export function completedInheritedBacklogPass(): PassRecord | null {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(PASS_KEY) as { value: string } | undefined;
  const rec = row ? JSON.parse(row.value) as PassRecord : null;
  return rec && rec.at === PROCESS_STARTED_AT && rec.completed ? rec : null;
}

interface Inherited {
  id: string; agent_id: string; content: string | null; received_at: number | null;
  channel: string | null; counterparty: string | null; sender: string | null;
}

/**
 * Park every orphan an older version stranded. `deadTurn` is the reconcile's own predicate over `t`,
 * so "dead" has one definition. Runs at boot, before any turn, so an open turn here is a dead one.
 */
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
       AND NOT (t.exit_reason IS 'terminated' AND t.ended_at >= ?)
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
  db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(PASS_KEY, JSON.stringify(rec));
  if (parked > 0 || !rec.completed) logger.warn('inherited orphaned asks parked owed (first boot of this build)', { ...rec, agents: byAgent.size });
  return { examined: rec.examined, parked };
}

/** ONE deliverable notice per agent. The STORED row carries ask ids and instructions only — no sender, no words
 *  (review R3-3: a served engine row stays in the events lane of later turns, every conversation's). The list itself
 *  is rendered live, whole, on the one turn this row drives (`inheritedOwedListFor`, delivered by the hand-back steer). */
function tellAgentOwed(agentId: string, owed: Inherited[]): void {
  insertEngineEventIfAbsent({
    id: uuidv4(), agentId, sourceAgentId: null, originIntent: 'owed_messages_inherited', work: null,   // = INHERITED_NOTICE_INTENT (the census reads literals)
    content: `[SOURCE: AGENT NOTICE from Dojo] After this update the Dojo found ${owed.length} message(s) an older version left `
      + `unanswered, now held owed and NOT answered automatically: ${owed.map((o) => `[${o.id}]`).join(', ')}. `
      + 'Who sent each and what it says is listed for you on this turn. '
      + 'Decide which still matter. To answer one, reply in its own conversation and say plainly the reply is late: it closes '
      + 'itself when your answer is delivered there. If one no longer needs an answer, call work_close_request with its id, '
      + 'disposition "dropped" and your reason as the note. The Dojo has sent nothing to anyone.',
  });
}

export const INHERITED_NOTICE_INTENT = 'owed_messages_inherited';

/** The list for the turn a notice row drives: each ask it names that is still owed — who, conversation, age, words. */
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
    const from = o.sender === 'owner' || o.counterparty === 'owner' ? 'the owner' : (o.counterparty ?? o.sender ?? 'an unrecorded sender');
    const age = o.received_at != null ? `${ageInWords(Date.now() - o.received_at)} ago` : 'at an unrecorded time';
    const snippet = (o.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    lines.push(`(${lines.length + 1}) [${o.id}] from ${from}, in the ${o.channel ?? 'unknown'} conversation, received ${age}: "${snippet}"`);
  }
  return lines.length === 0 ? null
    : `THE MESSAGES AN OLDER VERSION LEFT UNANSWERED, held owed for you to decide on:\n${lines.join('\n')}`;
}

/** Is `workId` an ask parked as inherited and still owed? */
function isInheritedOwed(workId: string): boolean {
  return getDb().prepare(
    `SELECT 1 FROM work w WHERE w.id = ? AND w.kind = 'ask' AND w.state = 'blocked'
        AND EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = w.id AND e.kind = 'audit' AND json_extract(e.payload, '$.marker') = ?)`,
  ).get(workId, INHERITED_BACKLOG_MARKER) !== undefined;
}

/**
 * The tracker door's answer for an INHERITED ask (review R3-1(b)), or null for any other row. Nobody called it off,
 * so a stand-down is the AGENT'S judgement, recorded as that and landing on `abandoned` — never "cancelled by the
 * user". `kept` is refused with the truth: answering it in its own conversation closes it.
 */
export function inheritedAskDoor(workId: string, disposition: string, note: string | null, agentId: string):
{ content: string; isError: boolean } | null {
  if (!isInheritedOwed(workId)) return null;
  if (disposition !== 'dropped') {
    return { isError: true, content: `Not closed: ${workId} is a message an older version left unanswered. It closes itself the moment you `
      + 'deliver a real answer in its own conversation. If it no longer needs an answer, call work_close_request with '
      + 'disposition "dropped" and your own reason as the note.' };
  }
  if (!note) {
    return { isError: true, content: `Not dropped: pass \`note\` with your own reason why ${workId} no longer needs an answer. `
      + 'It goes on the record as your judgement (nobody called it off).' };
  }
  const r = dismissCommitment(workId, { agentId, reason: `no longer needs an answer — the agent's judgement on an inherited message (nobody called it off): ${note}` });
  return r.kind === 'applied'
    ? { isError: false, content: `[OK] Stood down: ${workId} — recorded as your judgement that it no longer needs an answer, not as answered.` }
    : { isError: true, content: `Error: could not stand down ${workId} (${r.kind}).` };
}
