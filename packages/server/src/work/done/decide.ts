// THE DECISION: how board work handed in, or closed by the owner, becomes Done, Closed (couldn't be done),
// Sent back or Cancelled. Project ends are `project-state.ts`; service housekeeping is `housekeeping.ts`.
//   - approve / send_back decide a waiting hand-in, by `whoDecides` (never the worker) or the owner. An agent
//     approves only after opening every proof item (`open-proof.ts`); the reason is one line.
//   - owner_done / cancel are the owner's, from the dashboard, from any open state; the main agent may cancel on his words.
//   - a run of a live schedule (scope `run`) is decided on its own: approve or send back returns it to Open.
// The owner may also decide by words an agent relays from the message it answers (`deciderOf`).
// One unit per row (`applyDecision`): adjudication, `decided` event, transition (`claim: 'decided'`), effects.
import { getDb } from '../../db/connection.js';
import { getPMAgentId, isPrimaryAgent } from '../../config/platform.js';
import { ownerAskedInThisTurn } from '../row-authority.js';
import { recordDecisionReceipt, deliveryIdOf } from '../../agent/v2/deliveries.js';
import { transition, appendWorkEvent, isTerminal, askIdForMessage, type Actor, type WorkOutcome, type WorkState } from '../store.js';
import { taskScope, projectScope } from '../tracker-view.js';
import { tellUnfinishedTasks } from './project-state.js';
import { latestHandIn, workerOf, workersOf, unitOrRollback, recordAdjudication, OWNER_ID, ENGINE_ID } from './record.js';
import { openedEveryItem } from './open-proof.js';
import { proofDelivery, engineProof } from './proof.js';
import { inFlightOccurrence, owedRunDelivery } from '../occurrences.js';
import { occurrenceRunStatus } from '../occurrence-runs.js';
import { recordOwnerRemainder } from '../measure-close-gate.js';
import { whoDecides } from './who-decides.js';
import { onDecided } from './effects.js';
import { endStallCard } from '../../healer/owner-notices.js';
import { resultForEndedRequest } from '../../agent/v2/counterparty.js';
import { requestEnded } from '../ask-settlement.js';
import { onPieceEnded } from '../task-ended.js';

export type Verdict = 'approve' | 'send_back' | 'cancel' | 'owner_done';
export interface DecideInput {
  workId: string;
  /** The deciding agent, or null for the owner on the dashboard. */
  deciderAgentId: string | null;
  verdict: Verdict;
  reason: string;
  /** The owner's own words, when an agent relays his decision. */
  ownerQuote?: string;
  /** The engine's ground: absent, a run it counted at 0; `delivered`, a delivered message the model confirmed. */
  engineBasis?: 'delivered';
}
/** `unclosed`: a project's open tasks that did not close with it. */
export type DecideResult = { kind: 'decided'; to: WorkState; text: string; unclosed: string[] } | { kind: 'refused'; text: string };

const VERDICTS: readonly Verdict[] = ['approve', 'send_back', 'cancel', 'owner_done'];
export const refused = (text: string): DecideResult => ({ kind: 'refused', text: `Refused: ${text}` });

/** The owner's open cards: each handed-in row asked of him since its newest hand-in, with when he was asked. */
function openOwnerCards(): Map<string, number> {
  const rows = getDb().prepare(
    `SELECT e.work_id AS id, MAX(e.created_at) AS at FROM work w JOIN work_events e ON e.work_id = w.id
      WHERE w.state = 'handed_in' AND e.kind = 'validation_escalated'
        AND e.id > (SELECT MAX(h.id) FROM work_events h WHERE h.work_id = w.id AND h.kind = 'handed_in')
      GROUP BY e.work_id`,
  ).all() as Array<{ id: string; at: number }>;
  return new Map(rows.map((r) => [r.id, r.at]));
}

type Who = { owner: true } | { owner: false; agentId: string };

/** Who is deciding: the owner on the dashboard, or by his words relayed by an agent (a cancel by the main agent; an
 *  approve or send back, by an agent that did not work the row, of the one hand-in he was asked about, from a message
 *  written after he was asked, an approval only as his whole message), or else the agent itself. */
function deciderOf(input: DecideInput): Who | { refused: string } {
  if (input.deciderAgentId === null) return { owner: true };
  const relayer = input.deciderAgentId;
  if (input.ownerQuote === undefined || input.ownerQuote.trim() === '') return { owner: false, agentId: relayer };
  const no = (why: string): { refused: string } => ({ refused: `${why} Nothing changed.` });
  let after: number | undefined;
  if (input.verdict === 'cancel') {
    if (!isPrimaryAgent(relayer)) return no('only the main agent cancels a task on the owner\'s words.');
  } else if (input.verdict === 'approve' || input.verdict === 'send_back') {
    if (workersOf(input.workId).has(relayer)) return no('you worked this, so you cannot pass on his decision of it; he taps the card.');
    const cards = openOwnerCards();
    after = cards.get(input.workId);
    if (after === undefined) return no('the owner\'s relayed words decide only a hand-in he was asked about.');
    if (cards.size > 1) return no('two of his questions are open, so a yes cannot be matched; he taps the card.');
  } else {
    return no('only the owner closes work directly, on the dashboard.');
  }
  const proof = ownerAskedInThisTurn(relayer, input.ownerQuote, { whole: input.verdict === 'approve', after });
  return proof.ok ? { owner: true } : no(`the owner's words could not be verified: ${proof.why}.`);
}

/** The task's measure was last set by its creator, and at its opening when the creator also works it. */
function measureSetByCreator(workId: string): boolean {
  const r = getDb().prepare(
    `SELECT w.requester_id AS creator, json_extract(e.payload, '$.set_by') AS setBy, json_extract(e.payload, '$.at_open') AS atOpen
       FROM work w JOIN work_events e ON e.work_id = w.id AND e.kind = 'measured' AND json_extract(e.payload, '$.set_by') IS NOT NULL
      WHERE w.id = ? ORDER BY e.id DESC LIMIT 1`,
  ).get(workId) as { creator: string | null; setBy: string; atOpen: number | null } | undefined;
  return !!r && r.setBy === r.creator && (r.creator !== workerOf(workId) || r.atOpen === 1);
}

/** Why this agent may not decide this hand-in, or null. The engine decides only the approval of a finished
 *  run the Dojo recorded complete: one whose measure, set by the task's creator, it counted at 0 itself, or one that delivered what it owes. */
function agentRefusal(agentId: string, workId: string, name: string, verdict: Verdict, basis?: 'delivered'): string | null {
  if (agentId === ENGINE_ID) {
    const h = latestHandIn(workId);
    const run = inFlightOccurrence(workId, { anyState: true });
    const ok = verdict === 'approve' && !!h?.scope && h.outcome === 'finished'
      && !!run && occurrenceRunStatus(run.id) === 'complete' && (basis === 'delivered'
      ? owedRunDelivery(run.id) !== null
      : engineProof(workId).some((i) => i.kind === 'measure') && measureSetByCreator(workId));
    return ok ? null : `${name} is not a run the engine decides.`;
  }
  if (workersOf(workId).has(agentId)) return `${name} is your own work; no agent decides work it worked or handed in.`;
  const decider = whoDecides(workId);
  if (decider?.kind !== 'agent' || decider.agentId !== agentId) {
    return `${name} is not yours to decide; it is decided by ${decider?.kind === 'agent' ? decider.agentId : 'the owner'}.`;
  }
  const opened = verdict === 'approve' ? openedEveryItem(agentId, workId) : { ok: true as const };
  return opened.ok ? null
    : `open the proof before approving: work_validate(action="open_proof", task_id="${workId}", item=N) for item${opened.unopened.length === 1 ? '' : 's'} ${opened.unopened.join(', ')}.`;
}

/** Where a done row settles: the newest delivery the hand-in carries, else the newest on record, else a
 *  decision receipt. Called inside the decision's unit, so a refused decision leaves no receipt. */
function settleOn(workId: string, decider: string): string | null {
  const items = latestHandIn(workId)?.items ?? [];
  const delivered = items.filter((i) => i.kind === 'delivery').pop()?.ref ?? proofDelivery(workId);
  return delivered ?? deliveryIdOf(recordDecisionReceipt(workId, decider === OWNER_ID ? 'The owner' : `Agent ${decider}`, 'a decision on its hand-in'));
}

interface Applied { verdict: Verdict; reason: string; deciderId: string; by: Actor; outcome: 'finished' | 'cant_be_done'; run: boolean; relay?: { relayedBy: string; quote: string } }

/** One row moved by a decision, as one unit, then the decision's effects. */
function applyDecision(id: string, from: WorkState, to: WorkState, p: Applied): WorkOutcome {
  let decisionId = 0;
  const moved = unitOrRollback(() => {
    const resultDeliveryId = to === 'done' ? settleOn(id, p.deciderId) : null;
    const rejected = p.verdict === 'send_back';
    recordAdjudication(id, rejected || p.run ? (p.outcome === 'finished' ? 'done' : 'failed') : to, p.deciderId, resultDeliveryId, p.reason, rejected ? 'rejected' : 'upheld');
    decisionId = appendWorkEvent(id, 'decided', p.deciderId, { verdict: p.verdict, reason: p.reason, to, ...p.relay });
    return transition(id, {
      to, by: p.by, actorId: p.deciderId, reason: `${p.verdict}: ${p.reason}`, expectedState: from,
      claim: to === 'sent_back' ? undefined : 'decided', resultDeliveryId,
      evidenceRef: p.by === 'engine' ? inFlightOccurrence(id, { anyState: true })?.id : undefined,
    });
  });
  if (moved.kind === 'applied') { onDecided(id, decisionId); endStallCard(id); }
  return moved;
}

/** A helper's piece called off ends the job on it in the same unit (`transition`'s cascade): the piece's end is the
 *  ground, recorded as the owner's when that end was his, else the engine's. */
function endJobsOfPiece(pieceId: string, byOwner: boolean): void {
  const jobs = getDb().prepare(`SELECT t.id, t.state FROM work p JOIN work t ON t.kind = 'task' AND t.root_kind <> 'a2a_thread'
      AND t.agent_id = p.assignee_agent AND t.a2a_thread_id = p.root_id AND t.opened_at <= p.closed_at AND t.state NOT IN ('done', 'failed', 'abandoned')
    WHERE p.id = ?`).all(pieceId) as Array<{ id: string; state: WorkState }>;
  for (const t of jobs) {
    applyDecision(t.id, t.state, 'abandoned', { verdict: 'cancel', reason: 'the job it was for was called off', deciderId: byOwner ? OWNER_ID : ENGINE_ID, by: byOwner ? 'owner' : 'agent', outcome: 'cant_be_done', run: false });
  }
}
onPieceEnded(endJobsOfPiece);

/** THE DECISION (header). */
export function decide(input: DecideInput): DecideResult {
  if (!VERDICTS.includes(input.verdict)) return refused(`"${String(input.verdict)}" is not a verdict. Use approve or send_back.`);
  const row = getDb().prepare(
    `SELECT id, title, state, agent_id AS worker, a2a_thread_id AS thread, source_message_id AS request FROM work w WHERE w.id = ? AND ((${taskScope('w')}) OR (${projectScope('w')}))`,
  ).get(input.workId) as { id: string; title: string | null; state: WorkState; worker: string; thread: string | null; request: string | null } | undefined;
  if (!row) return refused(`there is no task or project ${input.workId} on the board.`);
  const name = `"${row.title ?? row.id}" [${row.id}]`;
  const reason = input.reason.trim();
  if (reason === '' || /[\r\n]/.test(reason)) return refused('a decision states its reason in one line.');
  const who = deciderOf(input);
  if ('refused' in who) return refused(who.refused);

  if (input.verdict === 'cancel' || input.verdict === 'owner_done') {
    const ended = input.verdict === 'cancel' && (row.thread ? resultForEndedRequest(row.worker, row.thread)   // its piece was called off
      : requestEnded(askIdForMessage(row.request ?? '')) === 'called_off');
    if (!who.owner && !ended) return refused(`only the owner cancels or closes ${name} directly. Nothing changed.`);
    if (isTerminal(row.state)) return refused(`${name} is already closed (${row.state}).`);
  } else {
    if (row.state !== 'handed_in') return refused(`${name} is ${row.state}, not handed in; there is nothing to decide.`);
    const no = who.owner ? null : agentRefusal(who.agentId, row.id, name, input.verdict, input.engineBasis);
    if (no) return refused(no);
  }

  const deciderId = who.owner ? OWNER_ID : who.agentId;
  const by: Actor = who.owner ? 'owner' : deciderId === ENGINE_ID ? 'engine' : deciderId === getPMAgentId() ? 'pm' : 'agent';
  const last = row.state === 'handed_in' ? latestHandIn(row.id) : null;
  const outcome = last?.outcome ?? 'finished';
  const run = last?.scope === 'run' && (input.verdict === 'approve' || input.verdict === 'send_back');
  const to: WorkState = run ? 'open' : input.verdict === 'send_back' ? 'sent_back' : input.verdict === 'cancel' ? 'abandoned'
    : input.verdict === 'owner_done' || outcome === 'finished' ? 'done' : 'failed';
  const relay = who.owner && input.deciderAgentId !== null ? { relayedBy: input.deciderAgentId, quote: input.ownerQuote ?? '' } : undefined;
  const p = { verdict: input.verdict, reason, deciderId, by, outcome, run, relay };
  const moved = applyDecision(row.id, row.state, to, p);
  if (moved.kind !== 'applied') return refused(`${name} could not move to ${to}: ${moved.detail}.`);
  if (input.verdict === 'owner_done') recordOwnerRemainder(row.id);
  const unclosed: string[] = [];
  if (isTerminal(to)) {
    const open = getDb().prepare(
      `SELECT w.id, w.state FROM work w WHERE w.parent_id = ? AND ${taskScope('w')} AND w.state NOT IN ('done','failed','abandoned')`,
    ).all(row.id) as Array<{ id: string; state: WorkState }>;
    for (const t of open) {   // a task has no proof of its own here, so it never ends done with its project
      const child = applyDecision(t.id, t.state, to === 'done' ? 'abandoned' : to, { ...p, reason: `closed with its project: ${reason}`, outcome: 'cant_be_done', run: false });
      if (child.kind !== 'applied') unclosed.push(t.id);
    }
    if (input.verdict !== 'cancel' && input.verdict !== 'owner_done') tellUnfinishedTasks(row.id);   // his own close is not news to him
  }
  const words: Partial<Record<WorkState, string>> = { done: 'Done', failed: "Closed: couldn't be done", sent_back: 'Sent back to its worker', abandoned: 'Cancelled', open: 'decided for this run; the schedule goes on' };
  const left = unclosed.length > 0 ? ` Not closed with it: ${unclosed.join(', ')}.` : '';
  return { kind: 'decided', to, unclosed, text: `Decided: ${name} is ${words[to]}. Reason: ${reason}${left}` };
}
