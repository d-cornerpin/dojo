// The row-authority gate: who may move, edit, cancel or close a task. A task id is not a global
// capability; this is the one rule. `work/__tests__/row-authority-census.test.ts` holds every
// model-reachable door and assignee-column writer to calling it or being a named exception.
//   * The PM never moves a task: it keeps agents working and escalates.
//   * No agent takes, cancels or reopens a task held by ANOTHER LIVE agent unless the owner asked
//     (close-outs and escalation stay open; applied to every agent, the main agent included).
//   * Editors of a row: its holder, its creator, the PM, and the main agent.
// Move causes are a closed vocabulary (`MOVE_CAUSES`): assignee_gone (the holder's agent row is gone or
// terminated, read from the DB), coordination (the HOLDER hands its own task to a peer) and user_requested
// (the owner asked, proven structurally by `ownerAskedInThisTurn`). Blocked or declined work escalates,
// except when the main agent moves it.
// Not this gate's business: the owner's dashboard routes (`by: 'owner'`) and engine subsystems, which have
// their own fences; the PM's verbs are PM-only doors fenced by `PM_ONLY_WORK_OPS`.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isPMAgent, isPrimaryAgent, getOwnerName, getPrimaryAgentId } from '../config/platform.js';
import { turnContext } from '../agent/turn-context.js';
import { currentAddress } from '../agent/v2/turn-address.js';
import { recordMove } from './move-record.js';
import { isTerminal, type Actor, type WorkState } from './store.js';
import { holdOf } from './done/hold.js';
import { normalizeQuote, ownerSaidSince } from '../tracker/owner-words.js';

const logger = createLogger('row-authority');

/** The closed reassignment vocabulary. A pace-shaped move cannot even be spelled. */
export const MOVE_CAUSES = ['assignee_gone', 'coordination', 'user_requested'] as const;
export type MoveCause = typeof MOVE_CAUSES[number];
const isMoveCause = (v: unknown): v is MoveCause =>
  typeof v === 'string' && (MOVE_CAUSES as readonly string[]).includes(v);

/** The facts the gate decides on, read from the row itself on every call. */
export interface RowFacts {
  id: string; kind: string; title: string; state: WorkState;
  /** `assignee_agent` when set, else `agent_id` (the holder an unassigned row keeps). */
  holder: string;
  groupId: string | null;
  /** The creator, when an agent created it. */
  creator: string | null;
  holderLive: boolean;
  goal: string | null; measureJson: string | null;
}

/** A live agent: its row exists and it is not terminated (a parked `paused`/`error` agent is still live). */
export function isLiveAgent(agentId: string | null | undefined): boolean {
  if (!agentId) return false;
  try {
    const r = getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
    return !!r && r.status !== 'terminated';
  } catch {
    return true;   // unreadable reads as live: the safe answer for a gate that protects live work
  }
}

export function rowFacts(id: string): RowFacts | null {
  const r = getDb().prepare(
    `SELECT id, kind, title, state, agent_id, assignee_agent, assigned_to_group, requester, requester_id, goal, measure_json
       FROM work WHERE id = ? AND kind IN ('task', 'project')`,
  ).get(id) as {
    id: string; kind: string; title: string | null; state: WorkState; agent_id: string;
    assignee_agent: string | null; assigned_to_group: string | null;
    requester: string | null; requester_id: string | null; goal: string | null; measure_json: string | null;
  } | undefined;
  if (!r) return null;
  const holder = r.assignee_agent ?? r.agent_id;
  return {
    id: r.id, kind: r.kind, title: r.title ?? '(untitled)', state: r.state, holder,
    groupId: r.assigned_to_group, creator: r.requester === 'agent' ? r.requester_id : null,
    holderLive: isLiveAgent(holder), goal: r.goal, measureJson: r.measure_json,
  };
}

/** The work is the actor's own: it holds it, or was spawned to work on exactly this row (`task_handling="keep"`). */
function isOwn(f: RowFacts, actorId: string): boolean {
  if (actorId === f.holder) return true;
  try {
    const a = getDb().prepare('SELECT task_id FROM agents WHERE id = ?').get(actorId) as { task_id: string | null } | undefined;
    return !!a && a.task_id === f.id;
  } catch {
    return false;
  }
}

/** The delegated pieces one row owns, by both recorded edges: `parent_id`, and the ASSIGN task's thread. */
const pieceIdsExpr = (owner: string, extraFrom = '', extraWhere = ''): string =>
  `SELECT c.id FROM work c${extraFrom}`
  + `  WHERE c.kind = 'task' AND c.root_kind = 'a2a_thread' AND c.parent_id IS NOT NULL${extraWhere}`
  + `    AND (c.parent_id = ${owner}.id`
  + `         OR (${owner}.a2a_thread_id IS NOT NULL AND c.root_id = ${owner}.a2a_thread_id))`;

/** A delegated piece of this row came back FAILED (an a2a FAIL): the row was declined. */
function wasDeclined(id: string): boolean {
  try {
    return !!getDb().prepare(
      `SELECT 1 FROM work_events fe WHERE fe.kind = 'transition' AND json_extract(fe.payload, '$.to') = 'failed'
          AND fe.work_id IN (${pieceIdsExpr('ow', ', work ow', ' AND ow.id = @id')}) LIMIT 1`,
    ).get({ id });
  } catch {
    return true;   // unreadable reads as declined: the answer that sends the decision to the owner
  }
}

/** Editors of a row: its holder (or spawned helper), its creator, the PM, and the main agent. */
const isEditor = (f: RowFacts, actorId: string): boolean =>
  isOwn(f, actorId) || actorId === f.creator || isPMAgent(actorId) || isPrimaryAgent(actorId);

// "The owner asked", for this turn: the turn serves an inbound message, and the cited `user_quote` is a whole
// sentence the owner himself wrote in it or since (`tracker/owner-words.ts` decides whose words count).
export type OwnerAskProof = { ok: true } | { ok: false; why: string };

export function ownerAskedInThisTurn(agentId: string, quote: unknown): OwnerAskProof {
  const q = typeof quote === 'string' ? normalizeQuote(quote) : '';
  if (!q) return { ok: false, why: 'no user_quote was given (the owner\'s exact words asking for this)' };
  const root = turnContext(agentId)?.root;
  if (!root || root.kind !== 'ask' || !root.sourceMessageId) {
    return { ok: false, why: 'this turn is not answering a message from the owner, so the owner\'s ask cannot be checked' };
  }
  const rootMsg = getDb().prepare('SELECT sent_at FROM messages WHERE id = ?').get(root.sourceMessageId) as
    { sent_at: number } | undefined;
  if (!rootMsg) return { ok: false, why: 'the message this turn is answering could not be found' };
  return ownerSaidSince(rootMsg.sent_at, q, agentId, true)
    ? { ok: true }
    : { ok: false, why: 'the quoted words are not a whole sentence the owner wrote in the message this turn is answering' };
}

const who = (id: string): string => `agent ${id}`;

export function escalationPointer(actorId: string): string {
  if (!isPrimaryAgent(actorId)) {
    return `If it should happen anyway, tell the main agent (send_to_agent) so it can put the decision to ${getOwnerName()}.`;
  }
  // On a contact's turn "ask the owner in your conversation" would mean asking the contact, whose
  // words can never clear `ownerAskedInThisTurn`.
  const addr = currentAddress(actorId);
  if (addr && addr.kind === 'person' && !addr.isOwner) {
    return `If it should happen anyway: this turn is with ${addr.name}, not ${getOwnerName()}, so do not put it to ${addr.name}. `
      + `Leave it for ${getOwnerName()}'s own next message, or reach ${getOwnerName()} yourself on a channel you may use, `
      + `and only call again with user_quote set to ${getOwnerName()}'s exact words.`;
  }
  return `If it should happen anyway, ask ${getOwnerName()} in your conversation and, if they say so, call again with user_quote set to their exact words.`;
}


/** The door check for any write to a task or project row by a MODEL actor. `null` = allowed. */
export function taskWriteRefusal(actorId: string, workId: string, what: string): string | null {
  const f = rowFacts(workId);
  if (!f || isEditor(f, actorId)) return null;   // a missing row: the door's own branch says it better
  logger.warn('row write refused: not an editor', { workId, actorId, what });
  return `Error: you cannot ${what} ${f.kind} "${f.title}" (${f.id.slice(0, 8)}). It is held by ${who(f.holder)}, `
    + 'and only its holder, its creator, the PM and the main agent may change it. '
    + 'Tell its holder what you need with send_to_agent, or leave a note with work_note.';
}

/** The goal and the measure are the creator's: an agent working a row it did not create may not change them (the
 *  same value sent back is no change). The main agent's change stands and is on the record. */
export function standardEditRefusal(actorId: string, workId: string, next: { goal?: string; measure?: unknown }): string | null {
  const f = rowFacts(workId);
  if (!f || !isOwn(f, actorId) || actorId === f.creator || isPrimaryAgent(actorId)) return null;
  if ((next.goal === undefined || next.goal.trim() === f.goal)
    && (next.measure === undefined || JSON.stringify(next.measure) === f.measureJson)) return null;
  return `Error: the goal and the measure of ${f.kind} "${f.title}" (${f.id.slice(0, 8)}) belong to whoever gave you the work, `
    + 'so you cannot change them. If they are wrong, tell whoever gave you the work: an agent with send_to_agent, the owner in your reply.';
}


const DISPOSALS: ReadonlySet<WorkState> = new Set<WorkState>(['failed', 'abandoned']);

/** Cancel/fail, or reopen a terminal row, by a model-driven `agent` actor, on work ANOTHER LIVE agent holds.
 *  Called from `setTrackerStatus`, the tracker's one status writer. Engine actors are not model-driven. */
export function takeoverRefusal(
  workId: string, to: WorkState, input: { by: Actor; actorId?: string | null; userQuote?: string | null },
): { kind: 'refused'; workId: string; reason: 'takeover-needs-the-owner'; detail: string } | null {
  if (input.by !== 'agent') return null;
  const f = rowFacts(workId);
  const actorId = input.actorId ?? '';
  if (!f || isOwn(f, actorId)) return null;
  const act = DISPOSALS.has(to) ? 'cancel' : (isTerminal(f.state) && !isTerminal(to)) ? 'reopen' : null;
  if (!act || !f.holderLive) return null;   // nobody live to take it from: edit rights decide at the door
  if (input.userQuote && ownerAskedInThisTurn(actorId, input.userQuote).ok) return null;
  logger.warn('takeover refused', { workId, actorId, act, holder: f.holder });
  return {
    kind: 'refused', workId, reason: 'takeover-needs-the-owner',
    detail: `"${f.title}" is held by ${who(f.holder)}, a live agent, and only ${getOwnerName()} may have `
      + `another agent ${act} it. A slow agent is not a stuck one: leave it with its holder. `
      + `${escalationPointer(actorId)}`,
  };
}


export type MoveTarget = { agentId: string };

export interface MoveRequest {
  taskId: string; by: Actor; actorId: string; cause: unknown; userQuote?: unknown;
  /** Omitted only by `planSpawnTask`'s pre-spawn check, before the target exists. */
  to?: MoveTarget;
}

export type MoveCheck = { ok: true; facts: RowFacts; cause: MoveCause } | { ok: false; text: string };

/** Every rule for a move, without writing anything. */
export function checkMove(req: MoveRequest): MoveCheck {
  const f = rowFacts(req.taskId);
  if (!f || f.kind !== 'task') return { ok: false, text: `Error: task ${req.taskId} does not exist.` };
  if (f.state === 'handed_in') return { ok: false, text: `Error: task "${f.title}" is handed in and waits for a decision; it is not moved until it is decided.` };
  const model = req.by === 'agent' || req.by === 'pm';
  if (model && isPMAgent(req.actorId)) {
    return {
      ok: false,
      text: 'Error: the PM does not move tasks between agents. Keep the holder working (poke, retask) '
        + `and escalate to the main agent when ${getOwnerName()} needs to decide.`,
    };
  }
  if (!isMoveCause(req.cause)) {
    return {
      ok: false,
      text: `Error: moving a task needs a cause, one of: ${MOVE_CAUSES.join(', ')}. `
        + '"assignee_gone" = its holder no longer exists; "coordination" = you hold it and are handing it to a peer; '
        + `"user_requested" = ${getOwnerName()} asked for this move (pass user_quote with their exact words). `
        + 'Slowness is not a cause: a slow agent is not a stuck one. To hurry it, leave a note with work_note or message it.',
    };
  }
  const cause = req.cause;
  if (req.to) {
    if (!isLiveAgent(req.to.agentId)) {
      return { ok: false, text: `Error: ${who(req.to.agentId)} does not exist or has been shut down; it cannot take work.` };
    }
    if (req.to.agentId === f.holder && !f.groupId) return { ok: false, text: `Error: "${f.title}" is already with ${who(f.holder)}.` };
  }
  if (cause === 'assignee_gone' && f.holderLive) {
    return {
      ok: false,
      text: `Error: ${who(f.holder)} is still live, so "assignee_gone" does not apply. A slow agent is not a stuck one.`
        + (model ? ` ${escalationPointer(req.actorId)}` : ''),
    };
  }
  if (!model) return { ok: true, facts: f, cause };   // engine subsystems: the cause is still checked against the world

  if (cause === 'user_requested') {
    const owner = ownerAskedInThisTurn(req.actorId, req.userQuote);
    if (!owner.ok) return { ok: false, text: `Error: "user_requested" could not be confirmed: ${owner.why}. ${escalationPointer(req.actorId)}` };
    return { ok: true, facts: f, cause };
  }
  // Blocked or declined work escalates to the owner; only the owner's word moves it. The main agent is not
  // limited here: a live holder's work stays behind the cause checks above and below.
  const blocked = holdOf(f.id)?.kind === 'blocked';
  if (!isPrimaryAgent(req.actorId) && (blocked || wasDeclined(f.id))) {
    return {
      ok: false,
      text: `Error: "${f.title}" is ${blocked ? 'blocked' : 'work an agent declined'}, `
        + `and that escalates to ${getOwnerName()}; agents do not move it. ${escalationPointer(req.actorId)}`,
    };
  }
  if (cause === 'assignee_gone' && !isEditor(f, req.actorId)) {
    return { ok: false, text: 'Error: only the task\'s creator, the PM or the main agent may re-home work whose holder is gone.' };
  }
  if (cause === 'coordination' && req.actorId !== f.holder) {
    return {
      ok: false,
      text: `Error: "coordination" is a hand-off of your OWN task, and "${f.title}" is held by ${who(f.holder)}. `
        + `Only its holder may hand it on. ${escalationPointer(req.actorId)}`,
    };
  }
  return { ok: true, facts: f, cause };
}

/**
 * THE assignee-column writer for a task or project row: every move, the owner's included, writes
 * through here. `agent_id` is NOT NULL and is the holder, so "nobody in particular" lives in
 * `assignee_agent` alone; a move writes BOTH columns.
 */
export function writeAssignee(workId: string, to: MoveTarget | { clear: true }): number {
  const db = getDb();
  const at = Date.now();
  if ('clear' in to) return db.prepare('UPDATE work SET assignee_agent = NULL, updated_at = ? WHERE id = ?').run(at, workId).changes;
  return db.prepare('UPDATE work SET agent_id = ?, assignee_agent = ?, assigned_to_group = NULL, updated_at = ? WHERE id = ?')
    .run(to.agentId, to.agentId, at, workId).changes;
}

/** A terminated agent's work goes back to the agent that spawned it, else to the primary. */
export function workerOfRecord(agentId: string): string {
  const a = getDb().prepare('SELECT status, parent_agent FROM agents WHERE id = ?').get(agentId) as { status: string; parent_agent: string | null } | undefined;
  if (!a || a.status !== 'terminated') return agentId;
  return a.parent_agent ?? getPrimaryAgentId();
}

/** Work its holder `from` has ended on goes to `to`, filed as an engine move. */
export function rehome(workId: string, from: string, to: string, door: string): void {
  if (to !== from && writeAssignee(workId, { agentId: to }) > 0) {
    recordMove({ taskId: workId, actor: 'engine', from, to: { agentId: to }, cause: 'assignee_gone', door });
  }
}

export type MoveOutcome = { ok: true; from: string; to: MoveTarget; cause: MoveCause } | { ok: false; text: string };

/** Check, write, and record the move (`recordMove`). */
export function moveAssignee(req: MoveRequest & { to: MoveTarget; door: string }): MoveOutcome {
  const c = checkMove(req);
  if (!c.ok) return c;
  if (writeAssignee(req.taskId, req.to) === 0) return { ok: false, text: `Error: task ${req.taskId} was deleted before the move landed.` };
  recordMove({ taskId: req.taskId, actor: req.actorId, from: c.facts.holder, to: req.to, cause: c.cause, door: req.door });
  return { ok: true, from: c.facts.holder, to: req.to, cause: c.cause };
}


export type SpawnTaskPlan = { taskId: string; handling: 'keep' | 'transfer'; cause: MoveCause };

/**
 * Decided BEFORE the agent exists, so a refusal creates nothing. `keep` links a helper and leaves the
 * task where it is (editors only); `transfer` is a move, allowed when the caller holds the task
 * ("coordination") or its holder is gone ("assignee_gone"). There is no default.
 */
export function planSpawnTask(actorId: string, taskId: string, handling: unknown): { ok: true; plan: SpawnTaskPlan } | { ok: false; text: string } {
  if (handling !== 'transfer' && handling !== 'keep') {
    return {
      ok: false,
      text: 'spawn_agent with task_id needs task_handling, and no agent was created. Choose one: '
        + '"transfer" hands the task to the new agent (allowed when you hold the task, or its holder is gone); '
        + '"keep" leaves the task with its current holder and the new agent only helps.',
    };
  }
  const f = rowFacts(taskId);
  const cause: MoveCause = f && f.holder !== actorId && !f.holderLive ? 'assignee_gone' : 'coordination';
  if (handling === 'transfer') {
    const thread = getDb().prepare('SELECT a2a_thread_id AS t FROM work WHERE id = ?').get(taskId) as { t: string | null } | undefined;
    if (thread?.t) {
      return { ok: false, text: 'spawn_agent cannot hand over this task: it already has its own thread, so a helper\'s reply could not hand it in. Keep it, and spawn the helper with task_handling="keep" or with no task_id; its work then gets its own task. No agent was created.' };
    }
    const c = checkMove({ taskId, by: 'agent', actorId, cause });
    if (!c.ok) return { ok: false, text: `${c.text} No agent was created.` };
  } else {
    const refused = taskWriteRefusal(actorId, taskId, 'link a helper to');
    if (refused) return { ok: false, text: `${refused} No agent was created.` };
  }
  return { ok: true, plan: { taskId, handling, cause } };
}
