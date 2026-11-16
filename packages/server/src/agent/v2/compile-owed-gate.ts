// One place asks whether the owner is still owed the compiled reply; while one is owed the gate refuses
// every call outside a closed set. Never armed on a human-waiting turn (preflight/compile-gate.ts).

import { getDb } from '../../db/connection.js';
import { PROGRESS_WORK_OPS } from '../../tools/work-verbs.js';
import { AUDIT_KIND } from '../../work/audit-trail.js';
import { JOIN_DRIVE_ENTRY } from '../../work/join-drive.js';
import { REPLY_IN_FLIGHT } from '../../work/ask-settlement.js';

// Closed set: ops that move open work plus `send_to_agent` (the redrive steer names it); reads never compose.
export const COMPILE_OWED_ALLOWED_OPS: ReadonlySet<string> = new Set<string>([
  ...PROGRESS_WORK_OPS,
  'send_to_agent',
]);

// Armed only after a genuine redrive rung was spent: a deferred pass is not a rung, and arming
// before steering has ever failed is the shape of a trap.
export function compileOwedAfterRedrive(agentId: string): string[] {
  return (getDb().prepare(`
    SELECT w.id AS id FROM work w
     WHERE w.agent_id = ?
       AND w.compile_pending = 1
       AND w.remaining_children = 0
       AND w.state NOT IN ('done','failed','abandoned')
       AND EXISTS (
         SELECT 1 FROM work_events e
          WHERE e.work_id = w.id AND e.kind = ?
            AND json_extract(e.payload, '$.entry_kind') = ?
       )
     ORDER BY w.opened_at ASC
     LIMIT 5
  `).all(agentId, AUDIT_KIND, JOIN_DRIVE_ENTRY.redrive) as Array<{ id: string }>).map((r) => r.id);
}

// Disarm is a read, never a latch: every road out of the duty passes this predicate, none must
// know the gate. A row that vanished underneath the turn drops; refusing on a dead row is a trap.
// A request whose relay is on its way is owed nothing.
export function stillCompileOwed(ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const live = new Set((getDb().prepare(`
    SELECT w.id AS id FROM work w
     WHERE w.id IN (${ids.map(() => '?').join(',')})
       AND w.compile_pending = 1
       AND w.state NOT IN ('done','failed','abandoned')
       AND NOT ${REPLY_IN_FLIGHT}
  `).all(...ids) as Array<{ id: string }>).map((r) => r.id));
  return ids.filter((id) => live.has(id));
}

export interface CompileOwedGateDecision {
  readonly live: string[];
  readonly refuse: boolean;
  // Armed and owed but the order is not VERIFIED in the emitted bytes: refuse nothing, log the defect.
  readonly standDownUnverified: boolean;
}

// Cheap conditions first (unarmed turns ask the db nothing); refuse only once the order is verified in bytes.
export function compileOwedGateDecision(
  ids: readonly string[], satisfied: boolean, opKey: string, orderReachedModel: boolean,
): CompileOwedGateDecision {
  if (ids.length === 0 || satisfied || COMPILE_OWED_ALLOWED_OPS.has(opKey)) {
    return { live: [...ids], refuse: false, standDownUnverified: false };
  }
  const live = stillCompileOwed(ids);
  const owed = live.length > 0;
  return { live, refuse: owed && orderReachedModel, standDownUnverified: owed && !orderReachedModel };
}
