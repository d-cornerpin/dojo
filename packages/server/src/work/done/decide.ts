// THE DECISION: the one way board work becomes Done, Closed (couldn't be done), Sent back or Cancelled.
//   - approve / send_back decide a waiting hand-in. The caller is `whoDecides` (never the worker) or
//     the owner. An agent approves only after opening every proof item (`open-proof.ts`); the owner
//     is exempt. The reason is one line saying how the proof meets the goal, or what is missing.
//   - owner_done / cancel are the owner's alone, from the dashboard, from any open state.
// The owner decides from the dashboard (decider null), or approves or sends back a hand-in he was
// asked about by his own words relayed by an agent, verified against his messages (`ownerQuoteProof`).
// One unit: the adjudication, the `decided` event and the transition with `claim: 'decided'`, which is
// the only claim that ends board work.
import { getDb } from '../../db/connection.js';
import { getPMAgentId } from '../../config/platform.js';
import { ownerQuoteProof } from '../../tracker/owner-words.js';
import { recordDecisionReceipt, deliveryIdOf } from '../../agent/v2/deliveries.js';
import { transition, appendWorkEvent, isTerminal, type Actor, type WorkState } from '../store.js';
import { taskScope, projectScope } from '../tracker-view.js';
import { latestHandIn, workersOf, unitOrRollback } from './hand-in.js';
import { openedEveryItem } from './open-proof.js';
import { proofDelivery } from './proof.js';
import { recordOwnerRemainder } from '../measure-close-gate.js';
import { whoDecides } from './who-decides.js';

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
export type DecideResult = { kind: 'decided'; to: WorkState; text: string } | { kind: 'refused'; text: string };

const OWNER_ID = 'user';
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
  const proof = ownerQuoteProof(input.workId, input.ownerQuote);
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
  const outcome = latestHandIn(row.id)?.outcome ?? 'finished';
  const to: WorkState = input.verdict === 'send_back' ? 'sent_back' : input.verdict === 'cancel' ? 'abandoned'
    : input.verdict === 'owner_done' || outcome === 'finished' ? 'done' : 'failed';
  const moved = unitOrRollback(() => {
    const resultDeliveryId = to === 'done' ? settleOn(row.id, deciderId) : null;
    getDb().prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, evidence_ref, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, to === 'sent_back' ? (outcome === 'finished' ? 'done' : 'failed') : to, to === 'sent_back' ? 'rejected' : 'upheld',
      deciderId, resultDeliveryId, reason, Date.now());
    appendWorkEvent(row.id, 'decided', deciderId, { verdict: input.verdict, reason, to });
    return transition(row.id, {
      to, by, actorId: deciderId, reason: `${input.verdict}: ${reason}`, expectedState: row.state,
      claim: to === 'sent_back' ? undefined : 'decided', resultDeliveryId,
    });
  });
  if (moved.kind !== 'applied') return refused(`${name} could not move to ${to}: ${moved.detail}.`);
  if (input.verdict === 'owner_done') recordOwnerRemainder(row.id);
  // 2c: the decision-time effects (design 5c: dependents, project roll-up, schedule stop) run here.
  const words: Partial<Record<WorkState, string>> = { done: 'Done', failed: "Closed: couldn't be done", sent_back: 'Sent back to its worker', abandoned: 'Cancelled' };
  return { kind: 'decided', to, text: `Decided: ${name} is ${words[to]}. Reason: ${reason}` };
}
