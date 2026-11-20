// A HOLD: an Open or Working task on standby, paused (the asker has the ball) or blocked, with a one-line
// reason. The state does not move; any change of state ends the hold (`transition()` clears the columns).
// A hold the owner set only he lifts, or the main agent citing his words from this turn. The attribute
// door writes the columns and redacts the reason.
import { getDb } from '../../db/connection.js';
import { withUnit } from '../../db/unit.js';
import { appendAuditEntry } from '../audit-trail.js';
import { patchWork } from '../tracker-store.js';
import { noteUnsettled, ownerHoldStands, OWNER_HOLD_REFUSAL } from '../store.js';
import { taskScope } from '../tracker-view.js';
import { workingExpr } from '../terminal-states.js';
import { isPrimaryAgent } from '../../config/platform.js';
import { ownerAskedInThisTurn } from '../row-authority.js';
import { notifyTaskEnded } from '../task-ended.js';
import { announceTaskLiveWork } from '../../agent/v2/serve-later.js';

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

/** Hold an Open or Working task. `pausedUntilMs` is when a pause lifts by itself; `ownerQuote` as in clearHold. */
export function setHold(workId: string, kind: HoldKind, reason: string, by: string, pausedUntilMs: number | null = null, ownerQuote?: unknown): HoldResult {
  const line = reason.trim();
  if (!line || /[\r\n]/.test(line)) return { ok: false, why: `a ${kind} hold needs its reason in one line` };
  return withUnit((): HoldResult => {
    const ownerAsked = ownerAskedToLift(by, ownerQuote);
    if (ownerHoldStands(workId, byOwner(by) || ownerAsked)) return { ok: false, why: OWNER_HOLD_REFUSAL };
    if (!holdable(workId)) return { ok: false, why: 'only an Open or Working task can be held' };
    noteUnsettled(patchWork(workId, { hold_kind: kind, hold_reason: line, hold_at: Date.now(), paused_until: kind === 'paused' ? pausedUntilMs : null }), 'hold set', { taskId: workId });
    announceTaskLiveWork(workId);
    const note = ownerAsked ? `the owner asked: "${String(ownerQuote)}"` : null;
    appendAuditEntry(workId, by, { entryKind: 'hold_set', toStatus: kind, reason: holdOf(workId)?.reason ?? '', note });
    // The owner holding a task ends it for the request held on it: that request is released.
    if (byOwner(by)) {
      const t = getDb().prepare('SELECT agent_id, source_message_id FROM work WHERE id = ?').get(workId) as { agent_id: string; source_message_id: string | null };
      notifyTaskEnded(t.agent_id, t.source_message_id);
    }
    return { ok: true };
  });
}

/** The main agent may lift the owner's hold only on the owner's own words this turn. */
export const ownerAskedToLift = (by: string, quote: unknown): boolean =>
  quote !== undefined && isPrimaryAgent(by) && ownerAskedInThisTurn(by, quote).ok;

/** Lift the hold. False when there was none, or it is the owner's and neither he nor his quoted ask lifts it. */
export function clearHold(workId: string, by: string, ownerQuote?: unknown): boolean {
  return withUnit(() => {
    const was = holdOf(workId);
    const ownerAsked = ownerAskedToLift(by, ownerQuote);
    if (!was || ownerHoldStands(workId, byOwner(by) || ownerAsked)) return false;
    noteUnsettled(patchWork(workId, { hold_kind: null, hold_reason: null, hold_at: null, paused_until: null }), 'hold cleared', { taskId: workId });
    announceTaskLiveWork(workId);
    const note = ownerAsked ? `the owner asked: "${String(ownerQuote)}"` : null;
    appendAuditEntry(workId, by, { entryKind: 'hold_cleared', fromStatus: was.kind, reason: was.reason, note });
    return true;
  });
}
