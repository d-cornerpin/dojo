// THE HAND-IN DOOR: the one way board work (a task or a project) is handed in, finished or can't be
// done, by its worker or by the engine acting for it. Every rule is an engine check:
//   - the row is board work in open, claimed or sent_back;
//   - a worker hand-in comes from the row's worker (its assignee, else the agent holding it); an engine
//     hand-in names that same worker and says why;
//   - the note is non-empty, a measured task handed in as finished has its measure at 0, and
//     `checkProof` passes every item.
// A refused proof appends `hand_in_refused` with the reasons (the durable count the ladder reads); a call
// on the wrong row or by the wrong agent moves nothing and counts nothing. A good hand-in is one unit:
// the `handed_in` event carrying the resolved items, and the move to handed_in.
import { getDb } from '../../db/connection.js';
import { withUnit } from '../../db/unit.js';
import { redactHandedCredentials } from '../../credentials/secret-values.js';
import { ringValidationDoorbell } from '../validation-drive.js';
import { transition, appendWorkEvent, type WorkOutcome, type WorkState } from '../store.js';
import { taskScope, projectScope } from '../tracker-view.js';
import { measuredItemsLeft } from '../measure-close-gate.js';
import { PATIENCE_ENTRY } from '../../tracker/assignee-patience.js';
import { checkProof, type HandInOutcome, type ProofItemInput, type ResolvedItem } from './proof.js';

export type HandInBy = { kind: 'worker'; agentId: string } | { kind: 'engine'; onBehalfOf: string; because: string };
export interface HandInInput { workId: string; by: HandInBy; outcome: HandInOutcome; items: ProofItemInput[]; note: string }
export type HandInResult = { kind: 'handed_in'; eventId: number; text: string } | { kind: 'refused'; text: string };

/** What a `handed_in` event carries. */
export interface HandInRecord { outcome: HandInOutcome; items: ResolvedItem[]; note: string; filedBy: string }

const HANDS_IN_FROM: readonly WorkState[] = ['open', 'claimed', 'sent_back'];

interface DoorRow { id: string; kind: string; state: WorkState; title: string | null; worker: string; open_tasks: number }

/** The worker of a task: its assignee, else the agent holding it. Empty when there is no such row. */
export function workerOf(workId: string): string {
  const r = getDb().prepare('SELECT COALESCE(assignee_agent, agent_id) AS w FROM work WHERE id = ?').get(workId) as { w: string } | undefined;
  return r?.w ?? '';
}

/** The newest hand-in of a row and its event id, or null when it was never handed in. */
export function latestHandIn(workId: string): (HandInRecord & { eventId: number }) | null {
  const e = getDb().prepare(
    "SELECT id, payload FROM work_events WHERE work_id = ? AND kind = 'handed_in' ORDER BY id DESC LIMIT 1",
  ).get(workId) as { id: number; payload: string } | undefined;
  return e ? { ...(JSON.parse(e.payload) as HandInRecord), eventId: e.id } : null;
}

class Rollback extends Error { constructor(readonly outcome: WorkOutcome) { super('rollback'); } }

/** Run `fn` as one unit, rolled back whole when the transition inside it is not applied. */
export function unitOrRollback(fn: () => WorkOutcome): WorkOutcome {
  try {
    return withUnit(() => { const out = fn(); if (out.kind !== 'applied') throw new Rollback(out); return out; });
  } catch (err) {
    if (err instanceof Rollback) return err.outcome;
    throw err;
  }
}

/** Every agent that worked this row: its worker now, every agent that handed it in, and every holder it
 *  was moved away from. None of them decides it. */
export function workersOf(workId: string): Set<string> {
  const rows = getDb().prepare(
    `SELECT actor AS a FROM work_events WHERE work_id = ? AND kind = 'handed_in' AND actor <> 'engine'
     UNION SELECT json_extract(payload, '$.from_agent') FROM work_events
      WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = ?`,
  ).all(workId, workId, PATIENCE_ENTRY.reassigned) as Array<{ a: string | null }>;
  const out = new Set(rows.map((r) => r.a).filter((a): a is string => !!a));
  const now = workerOf(workId);
  if (now) out.add(now);
  return out;
}

const label = (r: Pick<DoorRow, 'id' | 'title'>): string => `"${r.title ?? r.id}" [${r.id}]`;
const outcomeWords = (o: HandInOutcome): string => (o === 'finished' ? 'finished' : "can't be done");

function doorRow(workId: string): DoorRow | undefined {
  return getDb().prepare(
    `SELECT w.id, w.kind, w.state, w.title, COALESCE(w.assignee_agent, w.agent_id) AS worker,
            (SELECT COUNT(*) FROM work t WHERE t.parent_id = w.id AND ${taskScope('t')}
                AND t.state NOT IN ('done', 'failed', 'abandoned')) AS open_tasks
       FROM work w WHERE w.id = ? AND ((${taskScope('w')}) OR (${projectScope('w')}))`,
  ).get(workId) as DoorRow | undefined;
}

function rowRefusal(row: DoorRow, by: HandInBy): string | null {
  if (row.state === 'handed_in') return `${label(row)} is already handed in and waits for a decision. It is handed in again only after it is sent back.`;
  if (!HANDS_IN_FROM.includes(row.state)) return `${label(row)} is ${row.state}; only open, working or sent-back work is handed in.`;
  if (by.kind === 'worker') return by.agentId === row.worker ? null : `${label(row)} is worked by ${row.worker}, not by you; only its worker hands it in.`;
  if (by.onBehalfOf !== row.worker) return `An engine hand-in of ${label(row)} must act for its worker ${row.worker}.`;
  return by.because.trim() === '' ? `An engine hand-in of ${label(row)} must say why the engine is handing it in.` : null;
}

const refused = (row: DoorRow | undefined, whys: string[]): HandInResult => ({
  kind: 'refused',
  text: [`Refused: the hand-in${row ? ` of ${label(row)}` : ''} was not accepted, and nothing moved.`, ...whys.map((w) => `- ${w}`)].join('\n'),
});

/** The hand-in-time effects (design 5c). Today: the decider is woken. */
function afterHandIn(workId: string): void {
  // 2c: the schedule advance, asker relay, queued-prompt clear and finish ack join here.
  ringValidationDoorbell({ workId, shape: 'close-request' });
}

/** THE HAND-IN DOOR (header). */
export function handIn(input: HandInInput): HandInResult {
  const row = doorRow(input.workId);
  if (!row) return refused(undefined, [`There is no task or project ${input.workId} on the board.`]);
  const wrong = rowRefusal(row, input.by);
  if (wrong) return refused(row, [wrong]);

  const engine = input.by.kind === 'engine';
  const filedBy = engine ? 'engine' : row.worker;
  const note = redactHandedCredentials(row.worker, (input.note ?? '').replace(/\s+/g, ' ').trim());
  const whys: string[] = note === '' ? ['The note must say what was done, or why it cannot be done.'] : [];
  const left = input.outcome === 'finished' ? measuredItemsLeft(row.id) : 0;
  if (left > 0) whys.push(`Its measure still lists ${left} item${left === 1 ? '' : 's'}, so it is not finished. Finish them, or hand it in as can't be done with a remainder item naming them and why.`);
  const proof = checkProof(row.id, row.worker, input.outcome, input.items);
  if (!proof.ok) whys.push(...proof.refusals.map((r) => r.why));
  if (!proof.ok || whys.length > 0) {
    appendWorkEvent(row.id, 'hand_in_refused', filedBy, { outcome: input.outcome, reasons: whys.map((w) => redactHandedCredentials(row.worker, w)) });
    return refused(row, whys);
  }

  const record: HandInRecord = { outcome: input.outcome, items: proof.items, note, filedBy };
  let eventId = 0;
  const moved = unitOrRollback(() => {
    eventId = appendWorkEvent(row.id, 'handed_in', filedBy, record);
    return transition(row.id, {
      to: 'handed_in', by: engine ? 'engine' : 'agent', actorId: filedBy, expectedState: row.state,
      reason: input.by.kind === 'engine' ? `engine hand-in for ${row.worker}: ${input.by.because.trim()}` : `handed in (${outcomeWords(input.outcome)}): ${note}`,
    });
  });
  if (moved.kind !== 'applied') return refused(row, [`The work could not move to handed in: ${moved.detail}.`]);
  afterHandIn(row.id);
  const n = proof.items.length;
  const stillOpen = row.kind === 'project' && row.open_tasks > 0
    ? ` Its ${row.open_tasks} open task${row.open_tasks === 1 ? ' is' : 's are'} not closed by this; each is handed in on its own.` : '';
  return {
    kind: 'handed_in', eventId,
    text: `Handed in: ${label(row)} as ${outcomeWords(input.outcome)}, with ${n} proof item${n === 1 ? '' : 's'}. `
      + `It is not done yet: it waits for a decision by someone other than its worker.${stillOpen}`,
  };
}
