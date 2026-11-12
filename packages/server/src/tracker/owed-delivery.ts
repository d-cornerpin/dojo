// A task that owes its owner a delivery. A turn WORKING such a task is not on the proactive-send budget:
// the owner asked for that line, so it is not unsolicited (`closeout-floors.ts` reads `tasksOwingADelivery`).
// When the Dojo holds such a line back for another reason, the task records it (`noteDeliveryHeld`, an
// audit entry `delivery_held`) and the PM's review says so (`heldDeliveryLine`); a held line backs no close.
// "Working" is structural: the task the turn is charged to (`jobTaskOf`, passed in), or a claimed task the
// agent itself moved, noted or filed a close on this turn. "Owes": no delivery of the task's agent reached
// a person since the task opened or its current run started; once one has, the budget applies again.

import { getDb } from '../db/connection.js';
import { taskScope } from '../work/tracker-view.js';
import { ENGINE_SENT_TOOLS, NON_ANSWERING_DISPLAY_KINDS } from '../work/ask-settlement.js';
import { START_ACK_ORIGIN_INTENT } from '../memory/origin-intents.js';
import { writeTaskLog } from './task-log.js';
import { workingExpr } from '../work/done/hold.js';

const HELD = 'delivery_held';
const sqlList = (xs: Iterable<string>): string => [...xs].map((k) => `'${k}'`).join(', ');
const PREVIEW_CHARS = 200;

/** When the task's owed delivery window opened: its current run's start, else the task's opening. */
function owedSince(taskId: string): number | null {
  const r = getDb().prepare(
    `SELECT w.opened_at AS opened,
            (SELECT MAX(o.opened_at) FROM work o WHERE o.parent_id = w.id AND o.kind = 'occurrence') AS run
       FROM work w WHERE w.id = ?`,
  ).get(taskId) as { opened: number; run: number | null } | undefined;
  return r ? Math.max(r.opened, r.run ?? 0) : null;
}

/** Has a line of the task's agent reached a person since `sinceMs`? The start ack, an engine-written line
 *  and agent mail are not that line. */
function personDeliveredSince(agentId: string, sinceMs: number): boolean {
  return !!getDb().prepare(
    `SELECT 1 FROM deliveries d LEFT JOIN messages m ON m.id = d.message_id
      WHERE d.agent_id = ? AND d.outcome = 'delivered' AND d.channel <> 'a2a'
        AND d.tool <> 'engine-ack' AND d.tool NOT LIKE '%-door' AND d.tool NOT IN (${sqlList(ENGINE_SENT_TOOLS)})
        AND (m.id IS NULL OR m.display_kind IS NULL OR m.display_kind NOT IN (${sqlList(NON_ANSWERING_DISPLAY_KINDS)}))
        AND (m.id IS NULL OR m.origin_intent IS NULL OR m.origin_intent <> '${START_ACK_ORIGIN_INTENT}')
        AND CAST(strftime('%s', d.created_at) AS INTEGER) * 1000 >= ? LIMIT 1`,
  ).get(agentId, Math.floor(sinceMs / 1000) * 1000);
}

export function taskOwesDelivery(taskId: string): boolean {
  const w = getDb().prepare(`SELECT COALESCE(w.assignee_agent, w.agent_id) AS who FROM work w WHERE w.id = ? AND ${taskScope('w')}`)
    .get(taskId) as { who: string } | undefined;
  const since = w ? owedSince(taskId) : null;
  return !!w && since !== null && !personDeliveredSince(w.who, since);
}

/** The claimed tasks this agent's turn is working that still owe a delivery: `picked` (the task the turn
 *  is charged to) and any claimed task the agent moved, noted or filed a close on since the turn started. */
export function tasksOwingADelivery(agentId: string, turnStartMs: number, picked: string | null): string[] {
  try {
    const worked = (getDb().prepare(
      `SELECT DISTINCT w.id AS id FROM work w JOIN work_events e ON e.work_id = w.id
        WHERE ${taskScope('w')} AND COALESCE(w.assignee_agent, w.agent_id) = ? AND ${workingExpr('w')}
          AND e.actor IN (?, 'agent:' || ?) AND e.created_at >= ?
          AND e.kind IN ('transition', 'validation_requested', 'opened', 'audit')`,
    ).all(agentId, agentId, agentId, turnStartMs) as Array<{ id: string }>).map((r) => r.id);
    const ids = [...new Set([...(picked ? [picked] : []), ...worked])];
    return ids.filter(taskOwesDelivery);
  } catch {
    return [];   // on error the budget applies unchanged
  }
}

export function noteDeliveryHeld(taskIds: readonly string[], p: { turnNumber: number; why: string; text: string }): void {
  const flat = p.text.replace(/\s+/g, ' ').trim();
  for (const taskId of taskIds) {
    writeTaskLog({
      taskId, fromEntity: 'engine', entryKind: HELD, reason: p.why,
      actionTaken: `turn ${p.turnNumber}`,
      note: flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat,
    });
  }
}

export function heldDeliveryLine(taskId: string): string {
  try {
    const held = getDb().prepare(
      `SELECT created_at AS at, json_extract(payload, '$.reason') AS why, json_extract(payload, '$.note') AS words
         FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = ?
        ORDER BY id DESC LIMIT 1`,
    ).get(taskId, HELD) as { at: number; why: string | null; words: string | null } | undefined;
    if (!held) return '';
    const w = getDb().prepare('SELECT COALESCE(assignee_agent, agent_id) AS who FROM work WHERE id = ?').get(taskId) as { who: string } | undefined;
    if (!w || personDeliveredSince(w.who, held.at)) return '';   // a later line reached the person
    const at = new Date(held.at).toISOString().slice(0, 19).replace('T', ' ');
    return `\n  Held by the Dojo: the worker's line at ${at} UTC was not sent (${held.why ?? 'no reason recorded'})`
      + `${held.words ? `: "${held.words}"` : ''}. Nothing from it reached the person, and no line has reached them since.`;
  } catch {
    return '';
  }
}
