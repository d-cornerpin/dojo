// THE HAND-IN DOOR: the one way board work (a task or a project) is handed in, finished or can't be
// done, by its worker or by the engine acting for it. Every rule is an engine check:
//   - the row is board work in open, claimed or sent_back;
//   - a worker hand-in comes from the row's worker (its assignee, else the agent holding it); an engine
//     hand-in names that same worker and says why;
//   - the note is non-empty, a measured task handed in as finished has its measure at 0, and
//     `checkProof` passes every item.
// A refused proof appends `hand_in_refused` with the reasons (the durable count the ladder reads); a call
// on the wrong row or by the wrong agent moves nothing and counts nothing. A good hand-in is one unit:
// the `handed_in` event carrying the resolved items, and the move to handed_in. A run of a live schedule
// with a next run is handed in with scope `run`. Housekeeping rows (`housekeeping.ts`) settle on the engine's receipt.
import { FINAL_REPLY_INTENTS } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { redactHandedCredentials } from '../../credentials/secret-values.js';
import { transition, appendWorkEvent, type WorkState } from '../store.js';
import { taskScope, projectScope } from '../tracker-view.js';
import { measuredItemsLeft } from '../measure-close-gate.js';
import { checkProof, proofFor, type HandInOutcome, type ProofItemInput } from './proof.js';
import { workerOf, unitOrRollback, type HandInRecord, type HandInScope } from './record.js';
import { onHandedIn } from './effects.js';
import { isHousekeeping, settleHousekeeping } from './housekeeping.js';
import { WORKING_STATES, workingExpr } from './hold.js';

export type HandInBy = { kind: 'worker'; agentId: string } | { kind: 'engine'; onBehalfOf: string; because: string };
/** `wordsFollow`: the caller sends the worker's last words itself, after the hand-in is applied. */
export interface HandInInput {
  workId: string; by: HandInBy; outcome: HandInOutcome; items: ProofItemInput[]; note: string; scope?: HandInScope; wordsFollow?: true;
}
export type HandInResult = { kind: 'handed_in'; eventId: number; text: string } | { kind: 'refused'; text: string };

const HANDS_IN_FROM: readonly WorkState[] = ['open', ...WORKING_STATES];

interface DoorRow { id: string; kind: string; state: WorkState; title: string | null; worker: string; open_tasks: number; live_schedule: number }

const label = (r: Pick<DoorRow, 'id' | 'title'>): string => `"${r.title ?? r.id}" [${r.id}]`;
const outcomeWords = (o: HandInOutcome): string => (o === 'finished' ? 'finished' : "can't be done");

function doorRow(workId: string): DoorRow | undefined {
  return getDb().prepare(
    `SELECT w.id, w.kind, w.state, w.title, COALESCE(w.assignee_agent, w.agent_id) AS worker,
            (SELECT COUNT(*) FROM work t WHERE t.parent_id = w.id AND ${taskScope('t')}
                AND t.state NOT IN ('done', 'failed', 'abandoned')) AS open_tasks,
            (w.repeat_interval IS NOT NULL AND w.next_run_at IS NOT NULL AND w.schedule_status IN ('waiting', 'running')) AS live_schedule
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

/** THE HAND-IN DOOR (header). */
export function handIn(input: HandInInput): HandInResult {
  if (isHousekeeping(input.workId)) return settleHousekeeping(input);
  const row = doorRow(input.workId);
  if (!row) return refused(undefined, [`There is no task or project ${input.workId} on the board.`]);
  const wrong = rowRefusal(row, input.by);
  if (wrong) return refused(row, [wrong]);

  const engine = input.by.kind === 'engine';
  const filedBy = engine ? 'engine' : row.worker;
  const note = redactHandedCredentials(row.worker, (input.note ?? '').replace(/\s+/g, ' ').trim());
  const whys: string[] = note === '' ? ['The note must say what was done, or why it cannot be done.'] : [];
  const left = input.outcome === 'finished' ? measuredItemsLeft(row.id) : 0;
  if (row.kind === 'project' && input.outcome === 'finished' && row.open_tasks > 0) {
    whys.push(`Its ${row.open_tasks} open task${row.open_tasks === 1 ? ' is' : 's are'} not finished; a project is done when its tasks are. Hand it in as can't be done to close them with it.`);
  }
  if (left > 0) whys.push(`Its measure still lists ${left} item${left === 1 ? '' : 's'}, so it is not finished. Finish them, or hand it in as can't be done with a remainder item naming them and why.`);
  const proof = checkProof(row.id, row.worker, input.outcome, input.items, engine);
  if (!proof.ok) whys.push(...proof.refusals.map((r) => r.why));
  if (!proof.ok || whys.length > 0) {
    appendWorkEvent(row.id, 'hand_in_refused', filedBy, { outcome: input.outcome, reasons: whys.map((w) => redactHandedCredentials(row.worker, w)) });
    return refused(row, whys);
  }

  const scope = input.scope ?? (row.live_schedule ? 'run' : undefined);
  const record: HandInRecord = { outcome: input.outcome, items: proof.items, note, filedBy, ...(scope ? { scope } : {}) };
  let eventId = 0;
  const moved = unitOrRollback(() => {
    eventId = appendWorkEvent(row.id, 'handed_in', filedBy, record);
    return transition(row.id, {
      to: 'handed_in', by: engine ? 'engine' : 'agent', actorId: filedBy, expectedState: row.state,
      reason: input.by.kind === 'engine' ? `engine hand-in for ${row.worker}: ${input.by.because.trim()}` : `handed in (${outcomeWords(input.outcome)}): ${note}`,
    });
  });
  if (moved.kind !== 'applied') return refused(row, [moved.reason === 'owner-hold' ? moved.detail : `The work could not move to handed in: ${moved.detail}.`]);
  onHandedIn(row.id, eventId, input.wordsFollow);
  const n = proof.items.length;
  const withTasks = row.kind === 'project' && row.open_tasks > 0 ? ` Its ${row.open_tasks} open task${row.open_tasks === 1 ? ' closes' : 's close'} with it.` : '';
  return {
    kind: 'handed_in', eventId,
    text: `Handed in: ${label(row)} as ${outcomeWords(input.outcome)}, with ${n} proof item${n === 1 ? '' : 's'}. `
      + `It is not done yet: it waits for a decision by someone other than its worker.${withTasks}`,
  };
}

/** The engine hands work in for its worker, from the worker's own records: finished on what `proofFor`
 *  finds (or `items`) when that proof passes, else can't be done on an engine record that says why.
 *  `outcome` asks for one of the two only. One hand-in is filed; it never sets done. */
export function engineHandIn(
  workId: string, because: string, opts: { outcome?: HandInOutcome; items?: ProofItemInput[]; scope?: HandInScope } = {},
): HandInResult {
  const worker = workerOf(workId);
  const by: HandInBy = { kind: 'engine', onBehalfOf: worker, because };
  const items = opts.items ?? (opts.outcome === 'cant_be_done' ? [] : proofFor(workId).map(({ kind, ref }) => ({ kind, ref })));
  const finished = opts.outcome !== 'cant_be_done' && items.length > 0 && measuredItemsLeft(workId) === 0
    && checkProof(workId, worker, 'finished', items, true).ok;
  if (finished) return handIn({ workId, by, outcome: 'finished', items, note: because, scope: opts.scope });
  if (opts.outcome === 'finished') return { kind: 'refused', text: `Refused: the engine found no proof on record for ${workId}.` };
  const reason = opts.outcome === 'cant_be_done' ? because : `no proof on record, so it is handed in as can't be done: ${because}`;
  const record: ProofItemInput = { kind: 'remainder', ref: 'engine record', facts: { reason } };
  return handIn({ workId, by, outcome: 'cant_be_done', items: [...(opts.outcome === 'cant_be_done' ? items : []), record], note: because, scope: opts.scope });
}

/** A receiver's final reply on the thread of an assign task it holds (Open or Working) hands that task in:
 *  finished on the reply's own delivery, can't be done on a FAIL. A progress reply hands in nothing. */
export function handInOnAssignReply(threadId: string, workerId: string, intent: string, deliveryId: string | null): void {
  if (!FINAL_REPLY_INTENTS.has(intent)) return;
  const row = getDb().prepare(
    `SELECT w.id FROM work w WHERE ${taskScope('w')} AND w.a2a_thread_id = ? AND w.agent_id = ? AND ${workingExpr('w', true)} AND w.repeat_interval IS NULL LIMIT 1`,
  ).get(threadId, workerId) as { id: string } | undefined;
  if (!row) return;
  if (intent === 'FAIL') engineHandIn(row.id, 'the assignee replied FAIL on its assignment thread', { outcome: 'cant_be_done' });
  else if (deliveryId) engineHandIn(row.id, 'the assignee delivered the work on its assignment thread', { outcome: 'finished', items: [{ kind: 'delivery', ref: deliveryId }] });
}
