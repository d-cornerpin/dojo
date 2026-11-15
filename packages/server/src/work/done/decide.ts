// THE DECISION: how board work handed in, or closed by the owner, becomes Done, Closed (couldn't be done),
// Sent back or Cancelled. Project ends are `project-state.ts`; service housekeeping is `housekeeping.ts`.
//   - approve / send_back decide a waiting hand-in, by `whoDecides` (never the worker) or the owner. An agent
//     approves only after opening every proof item (`open-proof.ts`); the reason is one line.
//   - owner_done / cancel are the owner's alone, from the dashboard, from any open state.
//   - a run of a live schedule (scope `run`) is decided on its own: approve or send back returns it to Open.
// The owner may also decide by words an agent relays, verified against his messages (`ownerQuoteProof`).
// One unit per row (`applyDecision`): adjudication, `decided` event, transition (`claim: 'decided'`), effects.
import { getDb } from '../../db/connection.js';
import { getPMAgentId } from '../../config/platform.js';
import { ownerQuoteProof } from '../../tracker/owner-words.js';
import { recordDecisionReceipt, deliveryIdOf } from '../../agent/v2/deliveries.js';
import { transition, appendWorkEvent, isTerminal, type Actor, type WorkOutcome, type WorkState } from '../store.js';
import { taskScope, projectScope } from '../tracker-view.js';
import { tellUnfinishedTasks } from './project-state.js';
import { latestHandIn, workersOf, unitOrRollback, recordAdjudication, OWNER_ID } from './record.js';
import { openedEveryItem } from './open-proof.js';
import { proofDelivery } from './proof.js';
import { recordOwnerRemainder } from '../measure-close-gate.js';
import { whoDecides } from './who-decides.js';
import { onDecided } from './effects.js';
import { endStallCard } from '../../healer/owner-notices.js';

export type Verdict = 'approve' | 'send_back' | 'cancel' | 'owner_done';
export interface DecideInput {
  workId: string;
  /** The deciding agent, or null for the owner on the dashboard. */
  deciderAgentId: string | null;
  verdict: Verdict;
  reason: string;
  /** The owner's own words, when an agent relays his decision. */
  ownerQuote?: string;
}
/** `unclosed`: a project's open tasks that did not close with it. */
export type DecideResult = { kind: 'decided'; to: WorkState; text: string; unclosed: string[] } | { kind: 'refused'; text: string };

const VERDICTS: readonly Verdict[] = ['approve', 'send_back', 'cancel', 'owner_done'];
const refused = (text: string): DecideResult => ({ kind: 'refused', text: `Refused: ${text}` });

/** The newest ask to the owner about this row since its newest hand-in, or 0 when there is none. */
function ownerAskSinceHandIn(workId: string, handInId: number): number {
  return (getDb().prepare(
    "SELECT COALESCE(MAX(id), 0) AS id FROM work_events WHERE work_id = ? AND kind = 'validation_escalated' AND id > ?",
  ).get(workId, handInId) as { id: number }).id;
}

type Who = { owner: true } | { owner: false; agentId: string };

/** Who is deciding: the owner on the dashboard, or by his words relayed after he was asked about this
 *  hand-in (approve or send back only), or an agent. */
function deciderOf(input: DecideInput, state: WorkState): Who | { refused: string } {
  if (input.deciderAgentId === null) return { owner: true };
  if (input.ownerQuote === undefined || input.ownerQuote.trim() === '') return { owner: false, agentId: input.deciderAgentId };
  const handIn = state === 'handed_in' ? latestHandIn(input.workId) : null;
  if (!handIn || !ownerAskSinceHandIn(input.workId, handIn.eventId) || (input.verdict !== 'approve' && input.verdict !== 'send_back')) {
    return { refused: 'the owner\'s relayed words decide only a hand-in he was asked about, and only to approve or send it back. Nothing changed.' };
  }
  const proof = ownerQuoteProof(input.workId, input.ownerQuote, input.deciderAgentId);
  return proof.ok ? { owner: true } : { refused: `the owner's words could not be verified: ${proof.why}. Nothing changed.` };
}

/** Why this agent may not decide this hand-in, or null. */
function agentRefusal(agentId: string, workId: string, name: string, verdict: Verdict): string | null {
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
    });
  });
  if (moved.kind === 'applied') { onDecided(id, decisionId); endStallCard(id); }
  return moved;
}

/** THE DECISION (header). */
export function decide(input: DecideInput): DecideResult {
  if (!VERDICTS.includes(input.verdict)) return refused(`"${String(input.verdict)}" is not a verdict. Use approve or send_back.`);
  const row = getDb().prepare(
    `SELECT id, title, state FROM work w WHERE w.id = ? AND ((${taskScope('w')}) OR (${projectScope('w')}))`,
  ).get(input.workId) as { id: string; title: string | null; state: WorkState } | undefined;
  if (!row) return refused(`there is no task or project ${input.workId} on the board.`);
  const name = `"${row.title ?? row.id}" [${row.id}]`;
  const reason = input.reason.trim();
  if (reason === '' || /[\r\n]/.test(reason)) return refused('a decision states its reason in one line.');
  const who = deciderOf(input, row.state);
  if ('refused' in who) return refused(who.refused);

  if (input.verdict === 'cancel' || input.verdict === 'owner_done') {
    if (!who.owner) return refused(`only the owner cancels or closes ${name} directly. Nothing changed.`);
    if (isTerminal(row.state)) return refused(`${name} is already closed (${row.state}).`);
  } else {
    if (row.state !== 'handed_in') return refused(`${name} is ${row.state}, not handed in; there is nothing to decide.`);
    const no = who.owner ? null : agentRefusal(who.agentId, row.id, name, input.verdict);
    if (no) return refused(no);
  }

  const deciderId = who.owner ? OWNER_ID : who.agentId;
  const by: Actor = who.owner ? 'owner' : deciderId === getPMAgentId() ? 'pm' : 'agent';
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
    if (input.verdict !== 'cancel') tellUnfinishedTasks(row.id);   // the owner's own cancel of a project is not news to him
  }
  const words: Partial<Record<WorkState, string>> = { done: 'Done', failed: "Closed: couldn't be done", sent_back: 'Sent back to its worker', abandoned: 'Cancelled', open: 'decided for this run; the schedule goes on' };
  const left = unclosed.length > 0 ? ` Not closed with it: ${unclosed.join(', ')}.` : '';
  return { kind: 'decided', to, unclosed, text: `Decided: ${name} is ${words[to]}. Reason: ${reason}${left}` };
}
