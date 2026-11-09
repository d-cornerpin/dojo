// A HOLD: an Open or Working task put on standby, paused (the asker has the ball) or blocked (something
// is in the way), with a one-line reason. The row's state does not move, so a hold is never a way out of
// the work: a held task is still handed in and decided, or cancelled by the owner, and it needs no verdict.
// Any change of state ends the hold (`transition()` clears the columns). Each set and clear is one entry
// on the task's trail. The columns are written through the attribute door, which redacts the reason.
import { getDb } from '../../db/connection.js';
import { withUnit } from '../../db/unit.js';
import { appendAuditEntry } from '../audit-trail.js';
import { patchWork } from '../tracker-store.js';
import { noteUnsettled, ownerHoldStands, OWNER_HOLD_REFUSAL } from '../store.js';
import { taskScope } from '../tracker-view.js';
import { workingExpr } from '../terminal-states.js';

export type HoldKind = 'paused' | 'blocked';
export interface Hold { kind: HoldKind; reason: string; at: number }
export type HoldResult = { ok: true } | { ok: false; why: string };

/** The hold on a row, or null when it is not held. */
export function holdOf(workId: string): Hold | null {
  const r = getDb().prepare('SELECT hold_kind, hold_reason, hold_at FROM work WHERE id = ?').get(workId) as
    { hold_kind: HoldKind | null; hold_reason: string | null; hold_at: number | null } | undefined;
  return r?.hold_kind ? { kind: r.hold_kind, reason: r.hold_reason ?? '', at: r.hold_at ?? 0 } : null;
}

/** SQL: the row under alias `a` is held (with this kind, when given). Negate it with NOT. */
export const heldExpr = (a: string, kind?: HoldKind): string =>
  kind ? `(${a}.hold_kind IS '${kind}')` : `(${a}.hold_kind IS NOT NULL)`;

export { WORKING_STATES, workingExpr } from '../terminal-states.js';

const byOwner = (by: string): boolean => by === 'owner' || by === 'user';

const holdable = (workId: string): boolean => !!getDb().prepare(
  `SELECT 1 FROM work w WHERE w.id = ? AND ${workingExpr('w', true)} AND ${taskScope('w')}`,
).get(workId);

/** Hold an Open or Working task. `pausedUntilMs` is when a pause lifts by itself. */
export function setHold(workId: string, kind: HoldKind, reason: string, by: string, pausedUntilMs: number | null = null): HoldResult {
  const line = reason.trim();
  if (!line || /[\r\n]/.test(line)) return { ok: false, why: `a ${kind} hold needs its reason in one line` };
  return withUnit((): HoldResult => {
    if (ownerHoldStands(workId, byOwner(by))) return { ok: false, why: OWNER_HOLD_REFUSAL };
    if (!holdable(workId)) return { ok: false, why: 'only an Open or Working task can be held' };
    noteUnsettled(patchWork(workId, { hold_kind: kind, hold_reason: line, hold_at: Date.now(), paused_until: kind === 'paused' ? pausedUntilMs : null }), 'hold set', { taskId: workId });
    appendAuditEntry(workId, by, { entryKind: 'hold_set', toStatus: kind, reason: holdOf(workId)?.reason ?? '' });
    return { ok: true };
  });
}

/** Lift the hold. False when there was none. */
export function clearHold(workId: string, by: string): boolean {
  return withUnit(() => {
    const was = holdOf(workId);
    if (!was || ownerHoldStands(workId, byOwner(by))) return false;
    noteUnsettled(patchWork(workId, { hold_kind: null, hold_reason: null, hold_at: null, paused_until: null }), 'hold cleared', { taskId: workId });
    appendAuditEntry(workId, by, { entryKind: 'hold_cleared', fromStatus: was.kind, reason: was.reason });
    return true;
  });
}
