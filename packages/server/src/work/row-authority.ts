// ════════════════════════════════════════════════════════════════════════════════════════
// t193 — THE ROW-AUTHORITY GATE: who may move, edit, cancel or close a task, and why.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Before this module a task id was a global capability. Any agent could move a task's
// assignee through three doors (the reassign verb, the status door's `assigned_to` side
// path, and `spawn_agent(task_id)`, which transferred by DEFAULT), cancel or reopen another
// live agent's work, edit any row, and bulk-close a project over other agents' live tasks.
// Only prompt text and t129's blocked-row fence stood in the way. This is the one rule,
// stated once and called by every model-reachable door.
//
// ── THE OWNER'S RULINGS IT ENCODES (v34-owner-decisions.md) ──
//   dec 1  The PM NEVER moves a task. It keeps agents working and escalates.
//   dec 2  No agent takes, cancels or reopens a task held by ANOTHER LIVE agent unless the
//          owner asked. Close-outs (`complete` files a Key-1 request) and escalation stay
//          open. Stated for the main agent; applied to every agent, since the main agent is
//          the most privileged non-owner actor there is.
//   dec 3  Editors of a row: its holder, its creator, the PM, and the main agent.
//   dec 4  spawn_agent(task_id) must say keep or transfer (`planSpawnTask` below).
//   dec 29 close_project over another live agent's open work is refused and escalated.
//
// ── THE MOVE RULE (a closed cause vocabulary; there is no "pace") ──
//   assignee_gone   the holder's agent row is gone or `terminated`, read from the DB, never
//                   taken from the model. An editor of the row may re-home it.
//   coordination    the HOLDER hands its own task to a peer. Nobody else may claim it.
//   user_requested  the owner asked, proven STRUCTURALLY (`ownerAskedInThisTurn`).
//   Blocked work, and work that has come back failed or declined, is never moved on an
//   agent's own say-so: it escalates to the owner (OR-PM-1v2). The owner's word unlocks it.
//
// ── NOT THIS GATE'S BUSINESS ──
//   The owner's dashboard routes (`by: 'owner'`) and the engine's subsystems (scheduler,
//   healer, engine), which have their own fences. The PM's adjudication verbs are PM-only
//   doors fenced by `PM_ONLY_WORK_OPS` and t129/t130; retask keeps the assignee.
//
// ── THE CENSUS ── `work/__tests__/t193-row-authority-census.test.ts`: every writer of the
//   assignee columns is this module or a named, reasoned exception, and every
//   model-reachable tracker door calls into this module.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isPMAgent, isPrimaryAgent, getOwnerName, getPrimaryAgentId } from '../config/platform.js';
import { turnContext } from '../agent/turn-context.js';
import { recordReassignment } from '../tracker/assignee-patience.js';
import { isTerminal, type Actor, type WorkState } from './store.js';
import { pieceIdsExpr } from './validation-drive.js';

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
}

/** A live agent: its row exists and it is not terminated. A parked (`paused`/`error`) agent
 *  is still live — it recovers and the owner is told; it is not gone. */
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
    `SELECT id, kind, title, state, agent_id, assignee_agent, assigned_to_group, requester, requester_id
       FROM work WHERE id = ? AND kind IN ('task', 'project')`,
  ).get(id) as {
    id: string; kind: string; title: string | null; state: WorkState; agent_id: string;
    assignee_agent: string | null; assigned_to_group: string | null;
    requester: string | null; requester_id: string | null;
  } | undefined;
  if (!r) return null;
  const holder = r.assignee_agent ?? r.agent_id;
  return {
    id: r.id, kind: r.kind, title: r.title ?? '(untitled)', state: r.state, holder,
    groupId: r.assigned_to_group, creator: r.requester === 'agent' ? r.requester_id : null,
    holderLive: isLiveAgent(holder),
  };
}

/** The work is the actor's own: it holds it, or it was spawned to work on exactly this row
 *  (`spawn_agent(task_id, task_handling="keep")` links a helper without moving the task). */
function isOwn(f: RowFacts, actorId: string): boolean {
  if (actorId === f.holder) return true;
  try {
    const a = getDb().prepare('SELECT task_id FROM agents WHERE id = ?').get(actorId) as { task_id: string | null } | undefined;
    return !!a && a.task_id === f.id;
  } catch {
    return false;
  }
}

/** OR-PM-1v2's "declined": a delegated piece of this row came back FAILED (an a2a FAIL). Read on
 *  the same two edges the owner-escalation count uses (`pieceIdsExpr`), not a second copy. */
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

/** dec 3: holder (or its spawned helper), creator, PM, main agent. */
const isEditor = (f: RowFacts, actorId: string): boolean =>
  isOwn(f, actorId) || actorId === f.creator || isPMAgent(actorId) || isPrimaryAgent(actorId);

// ── "THE USER ASKED", STRUCTURALLY ─────────────────────────────────────────────────────────
// A model saying "the owner asked me to" is a claim. What the platform KNOWS:
//   1. the turn in flight is serving an inbound ask (`TurnContext.root.kind === 'ask'`), set
//      by the engine at trigger claim, never by the model;
//   2. that message opened an ASK TICKET for this agent (`work.kind = 'ask'`, `root_id` = the
//      message id). The ticket is written only when the ingest stamp says an authorized person
//      on the owner lane asked (`memory/message-store.ts:isOwnerAsk`) — the platform's own
//      verdict, not a reading of the text;
//   3. the words the agent cites (`user_quote`) appear VERBATIM (case and spacing aside) in
//      that message, or in a later owner ask in the same conversation this turn serves.
// All three, or it is not the owner asking.

function normalizeQuote(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/[.!?,;:]+$/g, '').trim();
}

export type OwnerAskProof = { ok: true; messageId: string } | { ok: false; why: string };

export function ownerAskedInThisTurn(agentId: string, quote: unknown): OwnerAskProof {
  const q = typeof quote === 'string' ? normalizeQuote(quote) : '';
  if (!q) return { ok: false, why: 'no user_quote was given (the owner\'s exact words asking for this)' };
  const root = turnContext(agentId)?.root;
  if (!root || root.kind !== 'ask' || !root.sourceMessageId) {
    return { ok: false, why: 'this turn is not answering a message from the owner, so the owner\'s ask cannot be checked' };
  }
  const db = getDb();
  const rootMsg = db.prepare('SELECT conversation_id, created_at FROM messages WHERE id = ?')
    .get(root.sourceMessageId) as { conversation_id: string | null; created_at: unknown } | undefined;
  if (!rootMsg) return { ok: false, why: 'the message this turn is answering could not be found' };
  const asks = db.prepare(
    `SELECT m.id AS id, m.content AS content FROM messages m
       JOIN work a ON a.kind = 'ask' AND a.root_id = m.id AND a.agent_id = ?
      WHERE m.agent_id = ? AND m.role = 'user'
        AND (m.id = ? OR (m.conversation_id IS ? AND m.created_at >= ?))`,
  ).all(agentId, agentId, root.sourceMessageId, rootMsg.conversation_id, rootMsg.created_at) as
    Array<{ id: string; content: string }>;
  if (asks.length === 0) return { ok: false, why: 'the message this turn is answering is not an ask from the owner' };
  const hit = asks.find((m) => normalizeQuote(m.content ?? '').includes(q));
  return hit
    ? { ok: true, messageId: hit.id }
    : { ok: false, why: 'the quoted words are not in the owner\'s message this turn is answering' };
}

const who = (id: string): string => `agent ${id}`;

function escalationPointer(actorId: string): string {
  return isPrimaryAgent(actorId)
    ? `If it should happen anyway, ask ${getOwnerName()} in your conversation and, if they say so, call again with user_quote set to their exact words.`
    : `If it should happen anyway, tell the main agent (send_to_agent) so it can put the decision to ${getOwnerName()}.`;
}

// ── 1. EDIT RIGHTS (dec 3) ──────────────────────────────────────────────────────────────

/** The door check for any write to a task or project row by a MODEL actor: edits, status,
 *  step completion, schedule changes, override requests. `null` = allowed. */
export function taskWriteRefusal(actorId: string, workId: string, what: string): string | null {
  const f = rowFacts(workId);
  if (!f || isEditor(f, actorId)) return null;   // a missing row: the door's own branch says it better
  logger.warn('row write refused: not an editor', { workId, actorId, what });
  return `Error: you cannot ${what} ${f.kind} "${f.title}" (${f.id.slice(0, 8)}). It is held by ${who(f.holder)}, `
    + 'and only its holder, its creator, the PM and the main agent may change it. '
    + 'Tell its holder what you need with send_to_agent, or leave a note with work_note.';
}

// ── 2. TAKEOVER: CANCEL OR REOPEN ANOTHER LIVE AGENT'S WORK (dec 2) ───────────────────────

const DISPOSALS: ReadonlySet<WorkState> = new Set<WorkState>(['failed', 'abandoned']);

/**
 * Cancel/fail, or reopen a terminal row, by a model-driven `agent` actor, on work ANOTHER LIVE
 * agent holds. Called from `setTrackerStatus` — the tracker's one status writer — so no door
 * can step around it, and from the override-request door, so it cannot be laundered through
 * the PM's override verb. The PM has no status door (`PM_ALLOWED_WORK_OPS`); its authoritative
 * verbs are fenced by t129/t130. Engine actors are not model-driven.
 */
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
      + `another agent ${act} it. A slow agent is not a stuck one: leave it with its holder, `
      + `or close it out with status="complete" if the work is really done. ${escalationPointer(actorId)}`,
  };
}

// ── 3. MOVING THE ASSIGNEE ──────────────────────────────────────────────────────────────

export type MoveTarget = { agentId: string } | { groupId: string };

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
  if (req.to && 'agentId' in req.to) {
    if (!isLiveAgent(req.to.agentId)) {
      return { ok: false, text: `Error: ${who(req.to.agentId)} does not exist or has been shut down; it cannot take work.` };
    }
    if (req.to.agentId === f.holder && !f.groupId) return { ok: false, text: `Error: "${f.title}" is already with ${who(f.holder)}.` };
  } else if (req.to && !getDb().prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(req.to.groupId)) {
    return { ok: false, text: `Error: agent group ${req.to.groupId} does not exist.` };
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
  // OR-PM-1v2: blocked or declined work escalates to the owner; only the owner's word moves it.
  if (f.state === 'blocked' || wasDeclined(f.id)) {
    return {
      ok: false,
      text: `Error: "${f.title}" is ${f.state === 'blocked' ? 'blocked' : 'work an agent declined'}, `
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
 * THE assignee-column writer for a task or project row. Every move, the owner's included,
 * writes through here (the census holds that no other writer names these columns outside its
 * named exceptions). M7 / P706: `agent_id` is NOT NULL and is the holder; "nobody in
 * particular" lives in `assignee_agent` alone. t129 / S5: a move writes BOTH columns.
 */
export function writeAssignee(workId: string, to: MoveTarget | { clear: true }): number {
  const db = getDb();
  const at = Date.now();
  if ('clear' in to) return db.prepare('UPDATE work SET assignee_agent = NULL, updated_at = ? WHERE id = ?').run(at, workId).changes;
  if ('agentId' in to) {
    return db.prepare('UPDATE work SET agent_id = ?, assignee_agent = ?, assigned_to_group = NULL, updated_at = ? WHERE id = ?')
      .run(to.agentId, to.agentId, at, workId).changes;
  }
  return db.prepare('UPDATE work SET assignee_agent = NULL, assigned_to_group = ?, updated_at = ? WHERE id = ?')
    .run(to.groupId, at, workId).changes;
}

export type MoveOutcome = { ok: true; from: string; to: MoveTarget; cause: MoveCause } | { ok: false; text: string };

/** Check, write, and record cause, who, from and to on the row's own event log
 *  (`recordReassignment`, which also re-arms the patience ladder against the new holder). */
export function moveAssignee(req: MoveRequest & { to: MoveTarget; door: string }): MoveOutcome {
  const c = checkMove(req);
  if (!c.ok) return c;
  if (writeAssignee(req.taskId, req.to) === 0) return { ok: false, text: `Error: task ${req.taskId} was deleted before the move landed.` };
  recordReassignment({
    taskId: req.taskId, actor: req.actorId, fromAgentId: c.facts.holder,
    toAgentId: 'agentId' in req.to ? req.to.agentId : null,
    toGroupId: 'groupId' in req.to ? req.to.groupId : null,
    reason: `cause=${c.cause} via ${req.door}`,
  });
  return { ok: true, from: c.facts.holder, to: req.to, cause: c.cause };
}

// ── 4. SPAWNING WITH A TASK (dec 4) ─────────────────────────────────────────────────────

export type SpawnTaskPlan = { taskId: string; handling: 'keep' | 'transfer'; cause: MoveCause };

/**
 * Decided BEFORE the agent exists, so a refusal creates nothing. `keep` links a helper and
 * leaves the task where it is (editors only); `transfer` is a move, allowed when the caller
 * holds the task (a hand-off, "coordination") or its holder is gone ("assignee_gone"). No
 * default: the old silent transfer is gone.
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
    const c = checkMove({ taskId, by: 'agent', actorId, cause });
    if (!c.ok) return { ok: false, text: `${c.text} No agent was created.` };
  } else {
    const refused = taskWriteRefusal(actorId, taskId, 'link a helper to');
    if (refused) return { ok: false, text: `${refused} No agent was created.` };
  }
  return { ok: true, plan: { taskId, handling, cause } };
}

// ── 5. CLOSING A WHOLE PROJECT (dec 29) ─────────────────────────────────────────────────

/**
 * dec 29: a bulk close over work another LIVE agent holds — the project row or an open task —
 * is refused unless the owner asked (proven structurally). The agent is told which rows block
 * it; a non-main closer's request goes to the owner through the main agent, the one agent that
 * speaks with them (the relay `work_close_request(action="user_verdict")` uses). `null` = go.
 */
export function projectCloseRefusal(
  actorId: string, projectId: string, title: string, status: string, reason: string, userQuote: string | null,
): string | null {
  const ids = getDb().prepare(
    `SELECT id FROM work WHERE kind = 'task' AND parent_id = ? AND state NOT IN ('done', 'failed', 'abandoned')`,
  ).all(projectId) as Array<{ id: string }>;
  const blockers = [{ id: projectId }, ...ids].map(({ id }) => rowFacts(id))
    .filter((f): f is RowFacts => !!f && f.holderLive && !isOwn(f, actorId));
  if (blockers.length === 0 || (userQuote && ownerAskedInThisTurn(actorId, userQuote).ok)) return null;
  const list = blockers.map((b) => `"${b.title}" (${b.id.slice(0, 8)}, held by ${who(b.holder)})`).join('; ');
  if (!isPrimaryAgent(actorId)) {
    void import('../agent/a2a-notice.js').then(({ deliverA2ANotice }) => deliverA2ANotice({
      intent: 'QUESTION', threadId: '', requiresResponse: true,
      payload: `Please put this decision to ${getOwnerName()}: I (agent ${actorId}) want to close project "${title}" `
        + `(${projectId.slice(0, 8)}) as ${status} because: ${reason}. That would also close work other live agents hold: ${list}. `
        + `The platform refused the close until ${getOwnerName()} decides. If they agree, close it with `
        + `work_update(action="close_project", project_id="${projectId}", status="${status}", reason="...", user_quote="<their exact words>").`,
      toAgent: getPrimaryAgentId(), fromAgent: actorId,
    }, 'Blocked project close relayed to the main agent', { projectId }, actorId)).catch((err) => {
      logger.warn('blocked project close: relay to the main agent failed', { projectId, error: err instanceof Error ? err.message : String(err) });
    });
  }
  return `Error: project "${title}" was NOT closed, and nothing on it changed. Closing it would also close `
    + `${blockers.length} open item(s) other live agents hold: ${list}. That is ${getOwnerName()}'s call, not an agent's. `
    + (isPrimaryAgent(actorId)
      ? `Ask ${getOwnerName()} whether to close it; if they say so, call again with user_quote set to their exact words.`
      : `The main agent has been asked to put this to ${getOwnerName()}; do not retry the close.`);
}
