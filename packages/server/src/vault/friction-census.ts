// The friction census: which tracker tasks went badly since an instant (deterministic SQL over engine records).
// A task has friction when, in the window, any of these happened to it:
//   claim_rejected          the PM rejected its close
//   rearm_refused           a re-arm was refused
//   floor_ghosted           a floor's steer went unanswered
//   stall_escalated         the stall ladder brought in the PM or the main agent (`work/done/ladder.ts`)
//   identical_call_refused  a turn that claimed it had a call refused by the repeat rule
//   destructive_hold        a turn that claimed it had a destructive call held for approval
//   task_failed             the task itself ended failed (its helper errored out, or the reaper gave up on it)
// The last two are tied to the task by the `claim_turn` event that recorded which turn took it.

import { getDb } from '../db/connection.js';
import { taskScope } from '../work/tracker-view.js';

export interface FrictionTask {
  taskId: string;
  agentId: string;
  kinds: string[];
  /** `work_events.id`s that show the friction: the evidence a lesson may cite. */
  eventIds: number[];
}

interface Hit { work_id: string; event_id: number }

/** Each source answers: which (task, evidence event) happened at or after `@since` (epoch ms)? */
const SOURCES: ReadonlyArray<{ kind: string; sql: string }> = [
  ...['claim_rejected', 'rearm_refused', 'floor_ghosted'].map((kind) => ({
    kind,
    sql: `SELECT e.work_id AS work_id, e.id AS event_id FROM work_events e
           WHERE e.kind = '${kind}' AND e.created_at >= @since`,
  })),
  {
    kind: 'stall_escalated',
    sql: `SELECT e.work_id AS work_id, e.id AS event_id FROM work_events e
           WHERE e.kind = 'audit' AND e.created_at >= @since
             AND json_extract(e.payload, '$.entry_kind') IN ('ladder_pm', 'ladder_decider')`,
  },
  {
    kind: 'task_failed',
    sql: `SELECT e.work_id AS work_id, e.id AS event_id FROM work_events e
           WHERE e.kind = 'transition' AND e.created_at >= @since
             AND json_extract(e.payload, '$.to') = 'failed'`,
  },
  {
    kind: 'identical_call_refused',
    sql: `SELECT c.work_id AS work_id, c.id AS event_id FROM work_events c
            JOIN work w ON w.id = c.work_id
            JOIN turns t ON t.agent_id = COALESCE(w.assignee_agent, w.agent_id)
                        AND t.turn_number = CAST(json_extract(c.payload, '$.turn_number') AS INTEGER)
           WHERE c.kind = 'claim_turn' AND t.exit_reason = 'identical_call'
             AND t.ended_at >= datetime(@since / 1000, 'unixepoch')`,
  },
  {
    kind: 'destructive_hold',
    sql: `SELECT c.work_id AS work_id, c.id AS event_id FROM work_events c
            JOIN work w ON w.id = c.work_id
            JOIN destructive_approvals d ON d.agent_id = COALESCE(w.assignee_agent, w.agent_id)
                        AND d.turn_number = CAST(json_extract(c.payload, '$.turn_number') AS INTEGER)
           WHERE c.kind = 'claim_turn' AND d.created_at >= datetime(@since / 1000, 'unixepoch')`,
  },
];

export function frictionCensus(sinceMs: number): FrictionTask[] {
  const db = getDb();
  const byTask = new Map<string, { kinds: Set<string>; eventIds: Set<number> }>();
  for (const source of SOURCES) {
    for (const h of db.prepare(source.sql).all({ since: sinceMs }) as Hit[]) {
      const cur = byTask.get(h.work_id) ?? { kinds: new Set<string>(), eventIds: new Set<number>() };
      cur.kinds.add(source.kind);
      cur.eventIds.add(h.event_id);
      byTask.set(h.work_id, cur);
    }
  }
  if (byTask.size === 0) return [];
  const ids = [...byTask.keys()];
  const owners = db.prepare(
    `SELECT w.id AS id, COALESCE(w.assignee_agent, w.agent_id) AS agent_id FROM work w
      WHERE ${taskScope('w')} AND w.id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as Array<{ id: string; agent_id: string }>;
  return owners.map((o) => {
    const t = byTask.get(o.id)!;
    return { taskId: o.id, agentId: o.agent_id, kinds: [...t.kinds].sort(), eventIds: [...t.eventIds].sort((a, b) => a - b) };
  }).sort((a, b) => a.taskId.localeCompare(b.taskId));
}
