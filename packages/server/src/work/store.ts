// The work spine's one writer: `transition()` is the only function that may change `work.state`. It owes:
//   1. A discriminated result the caller must read: applied | no_change | refused (a lost race is the
//      `state-conflict` refusal).
//   2. Gates inside it, never at the call site. The fan-out countdown and its `compile_pending` wake run
//      inside the transaction; obligation-memory retirement and the task-ended notice run after it commits.
//   3. `by: 'engine'` (except a hand-in) requires an `evidenceRef` that resolves to a real occurrence,
//      delivery or artifact.
//   4. `claim` is a type: 'decided' is the only value, passed only by `work/done/decide.ts`,
//      `work/done/housekeeping.ts` and `work/done/project-state.ts`; board work ends only with it.
// Not effects of this function: assignment-notice retirement, schedule termination, the dependency cascade.

import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { redactHandedCredentials } from '../credentials/secret-values.js';
import { afterCommit, withUnit } from '../db/unit.js';
import { createLogger } from '../logger.js';
import { isPrimaryAgent } from '../config/platform.js';
// `work/outcome.ts` declares the boundary's answer; re-exported here so callers keep one import path.
import type { WorkEventKind } from './event-kinds.js';
import { noSuchWorkDetail } from './outcome.js';
import { retireObligationMemory } from './obligation-memory.js';
import { notifyPieceEnded, notifyTaskEnded } from './task-ended.js';
import { TERMINAL_STATES, isTerminal } from './terminal-states.js';
import type { TransitionApplied, WorkOutcome } from './outcome.js';
import { heldByOwnerSql } from './tracker-view.js';
// A cycle (settlement reads this store): the fragment is read at call time, never at load.
import { REPLY_IN_FLIGHT } from './ask-settlement.js';
export type { TransitionApplied, TransitionGate, WorkOutcome, WorkOutcomeReason, WorkPatchOutcome } from './outcome.js';
export { workSettled, isStateConflict, noteUnsettled, noSuchWorkDetail } from './outcome.js';

const logger = createLogger('work-store');

export type WorkState =
  | 'open' | 'claimed' | 'handed_in' | 'sent_back' | 'done' | 'failed' | 'abandoned' | 'blocked';

export type WorkKind = 'ask' | 'task' | 'project' | 'occurrence' | 'commitment';

export type Actor = 'owner' | 'pm' | 'agent' | 'engine' | 'scheduler' | 'healer';

export type Claim = 'decided';

export { TERMINAL_STATES, isTerminal };

/** The legal-transition table; a move not listed is refused by gate `illegal-transition`. Reopening a
 *  terminal row is legal only for an authority (G8). A hold is not a state (`work/done/hold.ts`);
 *  `blocked` is a chat ask's state, never a board row's. */
const LEGAL: Record<WorkState, readonly WorkState[]> = {
  open:      ['claimed', 'handed_in', 'blocked', 'done', 'failed', 'abandoned'],
  claimed:   ['open', 'handed_in', 'blocked', 'done', 'failed', 'abandoned'],
  sent_back: ['open', 'claimed', 'handed_in', 'done', 'failed', 'abandoned'],
  handed_in: ['open', 'claimed', 'sent_back', 'done', 'failed', 'abandoned'],
  blocked:   ['open', 'claimed', 'done', 'failed', 'abandoned'],
  done:      ['open', 'claimed'],
  failed:    ['open', 'claimed', 'abandoned'],
  abandoned: ['open', 'claimed'],
};

export const OWNER_HOLD_REFUSAL = 'The owner put this task on hold. Only the owner, or the main agent when the owner asks, can release it.';
export function ownerHoldStands(workId: string, ownerActing: boolean): boolean {
  return !ownerActing && !!getDb().prepare(`SELECT 1 FROM work w WHERE w.id = ? AND ${heldByOwnerSql('w')}`).get(workId);
}

/** Who may reopen settled work, besides the main agent (checked by id). Anyone else is a confused model acting on a stale id. */
const REOPENERS: readonly Actor[] = ['owner', 'pm', 'engine'];

/** Board work: tasks and projects, never a join piece; the scope of the `board_done_needs_decision`
 *  trigger. */
const isBoardWork = (row: Pick<WorkRow, 'kind' | 'root_kind'>): boolean =>
  (row.kind === 'task' || row.kind === 'project') && row.root_kind !== 'a2a_thread';

export interface TransitionInput {
  to: WorkState;
  by: Actor;
  reason: string;
  evidenceRef?: string | null;
  resultDeliveryId?: string | null;
  /** Drop `result_delivery_id` in this move (non-terminal `to` only); `resultDeliveryId: null` cannot say
   *  it, as the binding reads `?? row.result_delivery_id`. Opt-in, so tracker status edits and retasks keep
   *  their binding; the event record is untouched. */
  clearResultDelivery?: boolean;
  claim?: Claim;
  /** The result this transition carries, recorded on the row in the same transaction as the state change. */
  note?: string | null;
  expectedState?: WorkState;
  claimedByTurn?: number | null;
  actorId?: string | null;
}

interface WorkRow {
  id: string;
  kind: WorkKind;
  /** Which producer opened this row (read by G9): join pieces are `kind='task'` too. */
  root_kind: string;
  parent_id: string | null;
  state: WorkState;
  result_delivery_id: string | null;
  remaining_children: number | null;
  agent_id: string;
  title: string | null;
  source_message_id: string | null;
  a2a_thread_id: string | null;
}

const now = (): number => Date.now();

function evidenceResolves(ref: string): boolean {
  const db = getDb();
  const hit = db.prepare(
    `SELECT 1 AS ok FROM work WHERE id = ? AND kind = 'occurrence'
     UNION ALL SELECT 1 FROM deliveries WHERE id = ?
     UNION ALL SELECT 1 FROM turn_artifacts WHERE id = ?
     LIMIT 1`,
  ).get(ref, ref, ref) as { ok: number } | undefined;
  return hit !== undefined;
}

function deliveryExists(id: string): boolean {
  return getDb().prepare('SELECT 1 AS ok FROM deliveries WHERE id = ?').get(id) !== undefined;
}

/** The one place work events are written; `work/event-kinds.ts` is the declared list (the column CHECK
 *  mirrors it). */
function appendEvent(workId: string, kind: WorkEventKind, actor: string, payload: unknown, at?: number): number {
  const info = getDb().prepare(
    'INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(workId, kind, payload === undefined ? null : JSON.stringify(payload), actor, at ?? now());
  return Number(info.lastInsertRowid);
}

export { appendEvent as appendWorkEvent };

/** The one writer of `work.state`. Every gate refuses by RETURNING, never by throwing. */
export function transition(workId: string, input: TransitionInput): WorkOutcome {
  const db = getDb();
  const actorId = input.actorId ?? input.by;

  // ── G1: the row must exist; a stale id is refused with something steerable. ──
  const row = db.prepare(
    'SELECT id, kind, root_kind, parent_id, state, result_delivery_id, remaining_children, agent_id, title, source_message_id, a2a_thread_id FROM work WHERE id = ?',
  ).get(workId) as WorkRow | undefined;
  if (!row) {
    return { kind: 'refused', workId, reason: 'no-such-work', detail: noSuchWorkDetail(workId) };
  }

  if (!input.reason || input.reason.trim().length === 0) {
    return { kind: 'refused', workId, reason: 'reason-required', detail: 'every transition states its reason' };
  }

  if (input.expectedState !== undefined && input.expectedState !== row.state) {
    return {
      kind: 'refused', workId, reason: 'state-conflict',
      detail: `expected ${input.expectedState}, found ${row.state}`,
      expected: input.expectedState, actual: row.state,
    };
  }

  // ── G4: already there is a no-op, never reported as a success. ──
  if (row.state === input.to) {
    return {
      kind: 'no_change', workId, reason: 'already-in-state',
      state: row.state, detail: `already ${row.state}`,
    };
  }

  if (!LEGAL[row.state].includes(input.to)) {
    return {
      kind: 'refused', workId, reason: 'illegal-transition',
      detail: `${row.state} -> ${input.to} is not a legal move`,
    };
  }

  // ── G6: the engine may only assert what it can point at; a hand-in points at the door's proof. ──
  if (input.by === 'engine' && input.to !== 'handed_in') {
    if (!input.evidenceRef) {
      return {
        kind: 'refused', workId, reason: 'engine-needs-evidence',
        detail: 'transition(by:"engine") requires evidence_ref — an occurrence, delivery or artifact id',
      };
    }
    if (!evidenceResolves(input.evidenceRef)) {
      return {
        kind: 'refused', workId, reason: 'engine-evidence-unresolved',
        detail: `evidence_ref ${input.evidenceRef} resolves to no occurrence, delivery or artifact row`,
      };
    }
  }

  // ── G7: done means DELIVERED: the DB CHECK covers the column, this gate the delivery. ──
  const deliveryId = input.resultDeliveryId ?? row.result_delivery_id;
  if (input.to === 'done') {
    if (!deliveryId) {
      return {
        kind: 'refused', workId, reason: 'done-requires-delivery',
        detail: 'work is done because something was delivered — supply result_delivery_id',
      };
    }
    if (!deliveryExists(deliveryId)) {
      return {
        kind: 'refused', workId, reason: 'delivery-unresolved',
        detail: `result_delivery_id ${deliveryId} is not a delivery row`,
      };
    }
  }

  // ── G8: reopening settled work needs an authority, or the engine pointing at something real (G6). ──
  if (isTerminal(row.state) && !isTerminal(input.to) && !REOPENERS.includes(input.by) && !(input.by === 'agent' && isPrimaryAgent(actorId))) {
    return {
      kind: 'refused', workId, reason: 'reopen-requires-authority',
      detail: `reopening ${row.state} work needs the owner, the PM or the main agent`,
    };
  }
  // ── G9: board work ends only by a decision (`work/done/decide.ts`); workers hand in. ──
  if (isBoardWork(row) && isTerminal(input.to) && input.claim !== 'decided') {
    return {
      kind: 'refused', workId, reason: 'needs-decision',
      detail: `a ${row.kind} is finished by a decision on its hand-in, not by a status change: the worker hands it in with proof (work_update action="hand_in") and a decider other than the worker decides it`,
    };
  }

  // ── G10: handed-in work waits for its decision; only the next run of its schedule firing moves it sooner. ──
  if (row.state === 'handed_in' && (input.to === 'open' || input.to === 'claimed') && !(input.by === 'scheduler' && input.to === 'claimed') && input.claim !== 'decided') {
    return { kind: 'refused', workId, reason: 'needs-decision', detail: 'handed-in work waits for a decision: it is approved or sent back, not moved' };
  }
  if (ownerHoldStands(workId, input.by === 'owner')) return { kind: 'refused', workId, reason: 'owner-hold', detail: OWNER_HOLD_REFUSAL };

  // ══ EFFECTS: all of them, once, in one transaction with the state change ══
  const from = row.state;
  const terminal = isTerminal(input.to);
  let eventId = 0;

  // One instant for the whole transaction: the state change and its event carry the same time.
  const at = now();

  withUnit(() => {
    // Work that ends ends its open pieces with it, at any depth: called off, they are abandoned; failed, they fail,
    // nobody is told, and a late answer takes the late road. A board task finished leaves nothing it handed on open.
    const ends = (input.to === 'abandoned' || input.to === 'failed') && !isTerminal(from);
    const finished = input.to === 'done' && row.kind === 'task' && row.root_kind !== 'a2a_thread' && !isTerminal(from);
    const pieces = ends || finished ? db.prepare(`SELECT id FROM work WHERE parent_id = ? AND root_kind = 'a2a_thread' AND state IN ${CHILD_OPEN_STATES}`).all(workId) as Array<{ id: string }> : [];
    for (const p of pieces) {
      transition(p.id, {
        to: finished ? 'abandoned' : input.to, by: input.by, actorId, evidenceRef: input.evidenceRef,
        reason: finished ? 'the work it was for is finished' : input.to === 'abandoned' ? 'the request it was for was called off' : 'the request it was for ran out of time',
      });
    }
    if (ends && input.to === 'abandoned' && (row.kind === 'ask' || row.root_kind === 'a2a_thread')) {
      afterCommit(() => void import('../agent/a2a-transport.js')
        .then((m) => m.endTheWorkUnder(workId, input.by === 'owner', actorId))
        .catch((err: unknown) => logger.warn('the work under an ended request was not ended', { workId, error: String(err) })));
    }

    db.prepare(
      `UPDATE work SET
         state = ?,
         closed_at = CASE WHEN ? = 1 THEN COALESCE(closed_at, ?) ELSE NULL END,
         result_delivery_id = ?,
         claimed_by_turn = ?,
         notes = COALESCE(?, notes),
         -- a settled row is not waiting to be compiled. The flag is cleared HERE rather
         -- than at the three call sites that settle a join, so it cannot survive its row.
         compile_pending = CASE WHEN ? = 1 THEN 0 ELSE compile_pending END,
         -- a hold lasts only while the row stays where it is (work/done/hold.ts); a schedule's pause stays
         hold_kind = NULL, hold_reason = NULL, hold_at = NULL, paused_until = CASE WHEN hold_kind IS NULL THEN paused_until END,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      input.to,
      terminal ? 1 : 0,
      at,
      input.to === 'done'
        ? deliveryId
        : (input.clearResultDelivery ? null : (input.resultDeliveryId ?? row.result_delivery_id)),
      input.to === 'claimed' ? (input.claimedByTurn ?? null) : null,
      input.note ?? null,
      terminal ? 1 : 0,
      at,
      workId,
    );

    eventId = appendEvent(workId, 'transition', actorId, {
      from, to: input.to, by: input.by, reason: input.reason,
      evidence_ref: input.evidenceRef ?? null,
      result_delivery_id: input.to === 'done' ? deliveryId : null,
      claim: input.claim ?? null,
      note: input.note ?? null,
    }, at);
    // A piece called off takes its helper's job with it, in this unit (`work/done/decide.ts`).
    if (ends && input.to === 'abandoned' && row.root_kind === 'a2a_thread') notifyPieceEnded(workId, input.by === 'owner');

    // EFFECT: a child settling decrements its parent's countdown in the same transaction as its own state
    // change, guarded at zero so a double-settle cannot drive it negative.
    if (terminal && !isTerminal(from) && row.parent_id) {
      const dec = db.prepare(
        'UPDATE work SET remaining_children = remaining_children - 1, updated_at = ? WHERE id = ? AND remaining_children > 0',
      ).run(now(), row.parent_id);
      if (dec.changes === 1) {
        const parent = db.prepare('SELECT remaining_children FROM work WHERE id = ?')
          .get(row.parent_id) as { remaining_children: number | null } | undefined;
        appendEvent(row.parent_id, 'child_settled', actorId, {
          child_id: workId, child_state: input.to, remaining: parent?.remaining_children ?? null,
        });
        // EFFECT: the parent wakes at zero into `compile_pending` (distinct from the owner getting the
        // answer), in the same transaction. The outcome is computed from the children: a join whose pieces
        // all failed or were abandoned has nothing to compile and is left for the fail-closed notice.
        if ((parent?.remaining_children ?? -1) === 0) {
          const landed = (db.prepare(
            "SELECT count(*) AS c FROM work WHERE parent_id = ? AND state = 'done'",
          ).get(row.parent_id) as { c: number }).c;
          if (landed > 0) {
            db.prepare('UPDATE work SET compile_pending = 1, updated_at = ? WHERE id = ?')
              .run(now(), row.parent_id);
          }
          appendEvent(row.parent_id, 'join_complete', actorId, {
            landed, outcome: landed > 0 ? 'compile' : 'fail-closed',
          });
        }
      }
    }

  });

  logger.info('work transition applied', { workId, from, to: input.to, by: input.by, eventId });

  // A commitment ending means its promise is no longer owed: retire its recalled memory here, after the
  // transaction, so a failure can never undo a decided state change (`retireObligationMemory` swallows its
  // own).
  if (row.kind === 'commitment' && terminal && !isTerminal(from)) {
    retireObligationMemory({ workId, agentId: row.agent_id, title: row.title, state: input.to });
  }

  // A task ended or handed in may settle its owner's request; one ended undone also judges the request on its thread.
  if (row.kind === 'task' && (input.to === 'handed_in' || (terminal && !isTerminal(from)))) notifyTaskEnded(row.agent_id, row.source_message_id, terminal && input.to !== 'done' ? row.a2a_thread_id : null);

  const value: TransitionApplied = { workId, from, to: input.to, eventId };
  return { kind: 'applied', value };
}


// The ask: every owner message is an obligation and a claim is a state. It opens in the same transaction as
// its message; exactly one turn may serve it (`expectedState` CAS, the loser gets `conflict`); a claim
// reverts on an abort that produced nothing and is refused when the turn made effectful calls.

/** An ask's id is derived from its message, so a retried insert cannot mint a second obligation. */
export function askIdForMessage(messageId: string): string {
  return `ask:${messageId}`;
}

export interface OpenAskInput {
  agentId: string;
  messageId: string;
  conversationId: string | null;
  requesterId: string | null;
  /** The message's own timestamp, not a later clock: every age cliff reads `opened_at`. */
  openedAt: number;
  title: string | null;
}

/** Open the ask row for an inbound message inside the message writer's transaction (the caller owns
 *  atomicity). Throws on a duplicate: two asks for one message would be two obligations. */
export function openAsk(p: OpenAskInput): string {
  const db = getDb();
  const id = askIdForMessage(p.messageId);
  // `conversation_id` has a real FK: a dangling id is recorded as absent, never allowed to drop the owner's
  // message.
  let conversationId = p.conversationId;
  if (conversationId != null
      && !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) {
    logger.warn('ask opened without conversation identity: the id resolves to no conversation row', {
      agentId: p.agentId, messageId: p.messageId, conversationId,
    }, p.agentId);
    conversationId = null;
  }
  db.prepare(`
    INSERT INTO work (
      id, kind, agent_id, requester, requester_id, conversation_id,
      root_kind, root_id, state, intent, wakes, closes_thread,
      title, opened_at, updated_at, provenance
    ) VALUES (?, 'ask', ?, 'owner', ?, ?, 'ask', ?, 'open', 'ask', 1, 0, ?, ?, ?, 'live')
  `).run(id, p.agentId, p.requesterId, conversationId, p.messageId, p.title, p.openedAt, p.openedAt);
  appendEvent(id, 'opened', p.requesterId ?? 'owner', {
    message_id: p.messageId, conversation_id: conversationId,
  });
  return id;
}

/** Pickup: `by: 'agent'`, since the engine actor would need evidence the turn has not yet produced. */
export function claimAsk(workId: string, agentId: string, expectedState: WorkState = 'open'): WorkOutcome {
  return transition(workId, {
    to: 'claimed', by: 'agent', actorId: agentId, expectedState,
    reason: 'turn pickup',
  });
}

/** Record which turn holds the claim, once it has its number; separate from `claimAsk` because the claim
 *  is settled before the turn record exists. `claimed_by_turn IS NULL` keeps a later turn from
 *  re-labelling a claim. */
export function stampClaimingTurn(workId: string, turnNumber: number): number {
  return withUnit((): number => {
    const changed = getDb().prepare(
      `UPDATE work SET claimed_by_turn = ?, updated_at = ?
        WHERE id = ? AND state = 'claimed' AND claimed_by_turn IS NULL`,
    ).run(turnNumber, now(), workId).changes;
    if (changed === 1) appendEvent(workId, 'claim_turn', 'engine', { turn_number: turnNumber });
    return changed;
  });
}

/** The turn that picked this row up, read from the event `stampClaimingTurn` writes, not from
 *  `work.claimed_by_turn` (`transition()` nulls it on every move out of `claimed`). `ORDER BY id DESC` is
 *  the latest claim. */
export function claimingTurnOf(workId: string): number | null {
  const r = getDb().prepare(
    `SELECT json_extract(payload, '$.turn_number') AS t FROM work_events
      WHERE work_id = ? AND kind = 'claim_turn' AND json_extract(payload, '$.how') IS NULL ORDER BY id DESC LIMIT 1`,
  ).get(workId) as { t: number | null } | undefined;
  return r?.t ?? null;
}

/** When the request was first served (its first pickup turn's stamp), or null if it never was. */
export function firstServedAt(workId: string): number | null {
  return (getDb().prepare(`SELECT MIN(created_at) AS at FROM work_events WHERE work_id = ? AND kind = 'claim_turn'`)
    .get(workId) as { at: number | null }).at;
}

/** SQL: a helper still works on a piece of request `w`; the engine's reaps never end such a request. */
export const helperWorksOnSql = (w: string): string => `EXISTS (SELECT 1 FROM work x WHERE x.parent_id = ${w}.id
  AND x.root_kind = 'a2a_thread' AND x.state IN ('open', 'claimed', 'blocked'))`;

/** Asks nobody can ever serve or close get an honest terminal state (`abandoned`), in five structural
 *  classes: no conversation identity, root message gone, sender ignored, agent terminated, below its
 *  agent's session boundary. The once-guard is `transition()`'s `expectedState` CAS. The reaper stays
 *  because wipes, kills and resets legitimately make these. One SELECT serves the census and the abandon
 *  pass so they never disagree. No arm may read a clock. The CASE order is the precedence, so a row is
 *  counted once and the class counts sum to the total. */
const UNSERVABLE_OPEN_ASK_SELECT = `
    SELECT w.id AS id, w.agent_id AS agent_id, w.state AS state, w.opened_at AS opened_at,
           CASE
             WHEN w.conversation_id IS NULL              THEN 'no-identity'
             WHEN m.id IS NULL                           THEN 'gone-root'
             WHEN m.authorized = 0                       THEN 'ignored-sender'
             WHEN a.status = 'terminated'                THEN 'dead-agent'
             ELSE                                             'below-session-boundary'
           END AS cls
      FROM work w
      LEFT JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id
      LEFT JOIN agents a ON a.id = w.agent_id
     WHERE w.kind = 'ask' AND w.state IN ('open','claimed')
       AND (
            w.conversation_id IS NULL
         OR m.id IS NULL
         OR m.authorized = 0
         OR a.status = 'terminated'
         OR (a.session_started_at IS NOT NULL
             AND w.opened_at < (unixepoch(a.session_started_at) * 1000))
       ) AND NOT ${helperWorksOnSql('w')}`;

const UNSERVABLE_REASON: Readonly<Record<string, string>> = {
  'no-identity':
    'no conversation identity: no delivery can ever match this ask, so it can never be closed',
  'gone-root':
    'the message this obligation was FOR no longer exists, so it can never be served',
  'ignored-sender':
    'the sender is one this platform is required to IGNORE (its ingest trust stamp says '
    + 'unauthorized), so no turn will ever be spent on it and no answer will ever go back',
  'dead-agent':
    'the agent that owes this answer is TERMINATED and the platform refuses to resurrect one '
    + '(C20), so there is nobody left who could ever serve it',
  'below-session-boundary':
    'this ask predates its own agent\'s session boundary, which is the user\'s own line — the '
    + 'waiting set and the staleness sweep both floor on it, so nothing will ever pick it up',
};

export function abandonUnservableAsks(agentId?: string): {
  abandoned: number; ids: string[]; byClass: Record<string, number>;
} {
  const scoped = agentId != null;
  // Paged (200, keyset on opened_at then id) until the whole set is read: a page bounds a statement,
  // never how many settle.
  const page = getDb().prepare(
    `${UNSERVABLE_OPEN_ASK_SELECT}${scoped ? ' AND w.agent_id = ?' : ''} AND (w.opened_at, w.id) > (?, ?) ORDER BY w.opened_at ASC, w.id ASC LIMIT 200`,
  );
  const ids: string[] = []; const byClass: Record<string, number> = {};
  type Row = { id: string; agent_id: string; state: WorkState; cls: string; opened_at: number };
  for (let rows = page.all(...(scoped ? [agentId] : []), -1, '') as Row[]; rows.length > 0;
    rows = page.all(...(scoped ? [agentId] : []), rows[rows.length - 1].opened_at, rows[rows.length - 1].id) as Row[]) for (const r of rows) {
    const why = UNSERVABLE_REASON[r.cls];
    if (why === undefined) continue;   // a class with no reason is not closed by silence
    const res = transition(r.id, {
      to: 'abandoned', by: 'agent', actorId: 'work-reaper',
      expectedState: r.state, reason: `unservable — ${why}`,
    });
    if (res.kind === 'applied') { ids.push(r.id); byClass[r.cls] = (byClass[r.cls] ?? 0) + 1; }
  }
  if (ids.length > 0) {
    logger.warn('abandoned ask ticket(s) that could never be served or closed', {
      agentId: agentId ?? '(all)', count: ids.length, byClass,
    });
  }
  return { abandoned: ids.length, ids, byClass };
}

// Fan-out: parent/child rows with an atomic countdown. `remaining_children` on the parent is decremented
// inside `transition()`; `compile_pending` is set when it reaches zero and cleared by the settle that
// answers. A late answer reopens `failed -> open -> done`, the second one refused by `expectedState`.
// Nothing here writes `messages.conv_key`.

export const JOIN_TTL_MINUTES = 60;

/** How far back since its last look the sweep and the boot pass scan a join. */
export const JOIN_MAX_AGE_DAYS = 7;

/** SQL: an asker's piece is still open on the thread `thread` (a column or expression). */
export const openPieceOnSql = (thread: string): string => `EXISTS (SELECT 1 FROM work c WHERE c.root_kind = 'a2a_thread'
  AND c.root_id = ${thread} AND c.parent_id IS NOT NULL AND c.state IN ('open', 'claimed', 'blocked'))`;

/** The A2A per-thread hop cap, keyed on `work.hop_count`. */
export const THREAD_HOP_CAP = 8;

/** How long a hop counts against the cap: eight hops inside a rolling window (`JOIN_TTL_MINUTES`, past
 *  which the platform has given up on the previous turn), not a lifetime budget. A tighter window weakens
 *  the cap; a looser one lets a slow thread die at it. */
export const THREAD_HOP_WINDOW_MS = JOIN_TTL_MINUTES * 60_000;

export interface DelegationThread {
  threadId: string;
  assigneeAgent?: string | null;
  intent?: string;
  hopCount?: number;
  title?: string | null;
}

export interface OpenJoinInput {
  parentWorkId: string;
  agentId: string;
  /** The conversation the answer must come back on, copied at delegation time and never resolved later. */
  replyConversationId: string | null;
  /** Absolute epoch-ms deadline; the due-join finders read the deadline from this column alone. */
  ttlAt: number;
  threads: DelegationThread[];
}

export interface JoinChild {
  id: string;
  parentId: string;
  agentId: string;
  threadId: string;
  state: WorkState;
  assigneeAgent: string | null;
  replyConversationId: string | null;
}

export interface JoinPiece {
  childId: string;
  threadId: string;
  state: WorkState;
  content: string | null;
  resultDeliveryId: string | null;
  assigneeAgent: string | null;
}

export interface JoinState {
  id: string;
  agentId: string;
  parentState: WorkState;
  total: number;
  landed: number;
  remaining: number;
  complete: boolean;
  compilePending: boolean;
  replyConversationId: string | null;
  ttlAt: number | null;
  /** When the join opened, so a TTL extension is bounded against its total life, not a deadline it moved. */
  openedAt: number | null;
  rootId: string;
  outcome: 'compile' | 'fail-closed';
}

const CHILD_OPEN_STATES = "('open','claimed','blocked')";

/** Open the join for a delegation turn: N children, the countdown on the parent and the reply
 *  conversation on every row, in one transaction. No threads means no join: `remaining_children = 0`
 *  would read as a completed join. */
export function openDelegationJoin(p: OpenJoinInput): string[] {
  const db = getDb();
  if (p.threads.length === 0) return [];
  const parent = db.prepare('SELECT id, kind, state FROM work WHERE id = ?').get(p.parentWorkId) as
    | { id: string; kind: WorkKind; state: WorkState } | undefined;
  if (!parent) {
    logger.warn('delegation join not opened: no such parent work row', {
      agentId: p.agentId, parentWorkId: p.parentWorkId,
    }, p.agentId);
    return [];
  }
  // Same as `openAsk`: a dangling conversation id is recorded as absent rather than failing the delegation.
  let replyConversationId = p.replyConversationId;
  if (replyConversationId != null
      && !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(replyConversationId)) {
    logger.warn('delegation join: reply conversation id resolves to no conversation row', {
      agentId: p.agentId, parentWorkId: p.parentWorkId, replyConversationId,
    }, p.agentId);
    replyConversationId = null;
  }
  const seen = new Set<string>();
  const threads = p.threads.filter((t) => {
    if (!t.threadId || seen.has(t.threadId)) return false;
    seen.add(t.threadId);
    return true;
  });
  if (threads.length === 0) return [];

  const ids: string[] = [];
  const at = now();
  withUnit(() => {
    for (const t of threads) {
      const childId = `piece:${p.parentWorkId}:${t.threadId}`;
      db.prepare(`
        INSERT OR IGNORE INTO work (
          id, kind, parent_id, agent_id, assignee_agent, requester, requester_id,
          conversation_id, root_kind, root_id, state, intent, wakes, closes_thread,
          hop_count, title, reply_conversation_id, ttl_at, opened_at, updated_at, provenance
        ) VALUES (?, 'task', ?, ?, ?, 'agent', ?, NULL, 'a2a_thread', ?, 'open', ?, 1, 0,
                  ?, ?, ?, ?, ?, ?, 'live')
      `).run(
        childId, p.parentWorkId, p.agentId, t.assigneeAgent ?? null, p.agentId,
        // A thread child's `title` is the sender's model-authored text: redacted against the values handed
        // to that sender.
        t.threadId, t.intent ?? 'ASSIGN', t.hopCount ?? 0,
        typeof t.title === 'string' ? redactHandedCredentials(p.agentId, t.title) : null,
        replyConversationId, p.ttlAt, at, at,
      );
      appendEvent(childId, 'opened', p.agentId, {
        thread_id: t.threadId, parent_id: p.parentWorkId, assignee: t.assigneeAgent ?? null,
      });
      ids.push(childId);
    }
    // The countdown counts children that exist, not attempts (`INSERT OR IGNORE` swallows CHECK failures):
    // rows are counted from `work` for this parent, this call's children and states they can still settle
    // from. A sibling already settled cannot decrement again, so counting it would strand the countdown.
    const ph = ids.map(() => '?').join(', ');
    const live = ids.length === 0 ? [] : (db.prepare(
      `SELECT id FROM work
        WHERE parent_id = ? AND id IN (${ph}) AND state IN ${CHILD_OPEN_STATES}`,
    ).all(p.parentWorkId, ...ids) as Array<{ id: string }>);
    const liveIds = new Set(live.map((r) => r.id));
    const landed = ids.filter((id) => liveIds.has(id));
    if (landed.length !== ids.length) {
      logger.warn('delegation join: some children did not land; the countdown counts the ones that did', {
        agentId: p.agentId, parentWorkId: p.parentWorkId,
        attempted: ids.length, counted: landed.length,
      }, p.agentId);
    }
    // Only a request counts down and is answered; pieces under a task are a record of the work it handed on.
    db.prepare(
      `UPDATE work SET remaining_children = ?, ttl_at = ?, reply_conversation_id = ?,
                       compile_pending = 0, updated_at = ?
        WHERE id = ? AND kind = 'ask'`,
    ).run(landed.length, p.ttlAt, replyConversationId, at, p.parentWorkId);
    appendEvent(p.parentWorkId, 'join_opened', p.agentId, {
      children: landed.length, threads: threads.map((t) => t.threadId), ttl_at: p.ttlAt,
    });
    ids.length = 0;
    ids.push(...landed);
  });
  logger.info('delegation join opened', {
    agentId: p.agentId, parentWorkId: p.parentWorkId, children: ids.length,
  }, p.agentId);
  return ids;
}

/** The open child of a join for this thread, or null; exact match on the full thread id. */
export function findJoinChildByThread(agentId: string, threadId: string): JoinChild | null {
  const r = getDb().prepare(`
    SELECT id, parent_id, agent_id, root_id, state, assignee_agent, reply_conversation_id
      FROM work
     WHERE agent_id = ? AND kind = 'task' AND root_kind = 'a2a_thread' AND root_id = ?
       AND parent_id IS NOT NULL AND state IN ${CHILD_OPEN_STATES}
       AND NOT EXISTS (SELECT 1 FROM work p WHERE p.id = work.parent_id AND p.state = 'failed')
     ORDER BY opened_at DESC LIMIT 1
  `).get(agentId, threadId) as
    | { id: string; parent_id: string; agent_id: string; root_id: string; state: WorkState;
        assignee_agent: string | null; reply_conversation_id: string | null }
    | undefined;
  if (!r) return null;
  return {
    id: r.id, parentId: r.parent_id, agentId: r.agent_id, threadId: r.root_id,
    state: r.state, assigneeAgent: r.assignee_agent, replyConversationId: r.reply_conversation_id,
  };
}

// A `remaining_children > 0` with no child rows is a countdown that can never reach zero. It is hunted by a
// census and cleared by the standing reaper, not forbidden by a schema trigger: a refusing trigger would
// abort a sweep that deletes a join piece and leaves the parent's countdown behind.

export interface PhantomCountdown { id: string; remainingChildren: number }

export function phantomCountdownCensus(): PhantomCountdown[] {
  return (getDb().prepare(`
    SELECT w.id AS id, w.remaining_children AS n
      FROM work w
     WHERE w.remaining_children > 0
       AND NOT EXISTS (SELECT 1 FROM work c WHERE c.parent_id = w.id)
     ORDER BY w.opened_at ASC
  `).all() as Array<{ id: string; n: number }>).map((r) => ({ id: r.id, remainingChildren: r.n }));
}

/** Clear the countdowns no child can ever move; returns the count and ids. The record is never falsified:
 *  the number it used to say rides the event, nothing is deleted or back-dated, and no ask is reopened. */
export function clearPhantomCountdowns(): { cleared: number; ids: string[] } {
  const db = getDb();
  const rows = phantomCountdownCensus();
  const ids: string[] = [];
  for (const r of rows) {
    const info = db.prepare(
      `UPDATE work SET remaining_children = 0, updated_at = ?
        WHERE id = ? AND remaining_children > 0
          AND NOT EXISTS (SELECT 1 FROM work c WHERE c.parent_id = work.id)`,
    ).run(now(), r.id);
    if (info.changes !== 1) continue;
    appendEvent(r.id, 'audit', 'work-reaper', {
      marker: 'phantom_countdown_cleared',
      remaining_children: r.remainingChildren,
      reason: 'the countdown claimed ' + r.remainingChildren + ' outstanding child(ren) and '
        + 'there are no child rows at all, so no settlement could ever move it. The state, the '
        + 'receipt and the close time are untouched — only the number that could never reach '
        + 'zero is cleared.',
    });
    ids.push(r.id);
  }
  if (ids.length > 0) {
    logger.warn('cleared phantom join countdown(s): a countdown with no children to count', {
      count: ids.length,
    });
  }
  return { cleared: ids.length, ids };
}

/** A join's live counts, counted off the children so there is no second number to drift. */
export function joinState(parentWorkId: string): JoinState | null {
  const db = getDb();
  const p = db.prepare(
    `SELECT id, agent_id, state, remaining_children, compile_pending, reply_conversation_id,
            ttl_at, opened_at, root_id
       FROM work WHERE id = ?`,
  ).get(parentWorkId) as
    | { id: string; agent_id: string; state: WorkState; remaining_children: number | null;
        compile_pending: number; reply_conversation_id: string | null; ttl_at: number | null;
        opened_at: number | null; root_id: string }
    | undefined;
  if (!p || p.remaining_children === null) return null;
  const counts = db.prepare(
    `SELECT count(*) AS total, sum(state = 'done') AS landed FROM work WHERE parent_id = ?`,
  ).get(parentWorkId) as { total: number; landed: number | null };
  const landed = counts.landed ?? 0;
  return {
    id: p.id, agentId: p.agent_id, parentState: p.state,
    total: counts.total, landed, remaining: p.remaining_children,
    complete: p.remaining_children === 0, compilePending: p.compile_pending === 1,
    replyConversationId: p.reply_conversation_id, ttlAt: p.ttl_at, openedAt: p.opened_at,
    rootId: p.root_id,
    outcome: landed > 0 ? 'compile' : 'fail-closed',
  };
}

export function joinPieces(parentWorkId: string): JoinPiece[] {
  return (getDb().prepare(
    `SELECT id, root_id, state, notes, result_delivery_id, assignee_agent
       FROM work WHERE parent_id = ? ORDER BY opened_at ASC, id ASC`,
  ).all(parentWorkId) as Array<{
    id: string; root_id: string; state: WorkState; notes: string | null;
    result_delivery_id: string | null; assignee_agent: string | null;
  }>).map((r) => ({
    childId: r.id, threadId: r.root_id, state: r.state, content: r.notes,
    resultDeliveryId: r.result_delivery_id, assigneeAgent: r.assignee_agent,
  }));
}

export interface PieceSettleResult {
  result: WorkOutcome;
  join: JoinState & { complete: boolean };
}

function joinAfter(childId: string): JoinState & { complete: boolean } {
  const parentId = (getDb().prepare('SELECT parent_id FROM work WHERE id = ?').get(childId) as
    { parent_id: string | null } | undefined)?.parent_id ?? null;
  const st = parentId ? joinState(parentId) : null;
  return st ?? {
    id: parentId ?? '', agentId: '', parentState: 'open', total: 0, landed: 0, remaining: 0,
    complete: false, compilePending: false, replyConversationId: null, ttlAt: null,
    openedAt: null, rootId: '', outcome: 'fail-closed',
  };
}

/** Piece-landing wrapper: only ADDS an error log naming the failed row, then rethrows, so a trigger abort
 *  inside the settle is never silent. An in-band refusal (a returned value) stays quiet. */
function loudOnPieceAbort<T>(childId: string, settle: () => T): T {
  try {
    return settle();
  } catch (err) {
    let row: { kind?: string; root_kind?: string; root_id?: string; parent_id?: string; state?: string; agent_id?: string } = {};
    try {
      row = (getDb().prepare(
        'SELECT kind, root_kind, root_id, parent_id, state, agent_id FROM work WHERE id = ?',
      ).get(childId) ?? {}) as typeof row;
    } catch { /* naming the row is best-effort; the error below is not */ }
    logger.error(
      'PIECE LANDING ABORTED: a delegated piece came back and the spine refused to settle it. The join countdown will not reach zero and the answer will not be relayed.',
      {
        workId: childId, kind: row.kind, rootKind: row.root_kind, rootId: row.root_id,
        parentId: row.parent_id, state: row.state, agentId: row.agent_id,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    throw err;
  }
}

/** A piece came back: the child settles `done` against its delivery, its text recorded in the same
 *  transaction, and the countdown moves. An empty reply is refused here: the piece stays outstanding so
 *  the real one can land (else it ends once its helper's work has stopped). */
export function landPiece(
  childId: string,
  p: { deliveryId: string; content: string; messageId?: string | null; actorId?: string | null },
): PieceSettleResult {
  const body = (p.content ?? '').trim();
  if (body.length === 0) {
    return {
      result: {
        kind: 'refused', workId: childId, reason: 'empty-piece',
        detail: 'an empty terminal reply is not a deliverable; the piece stays outstanding',
      },
      join: joinAfter(childId),
    };
  }
  const result = loudOnPieceAbort(childId, () => transition(childId, {
    to: 'done', by: 'agent', actorId: p.actorId ?? 'a2a',
    reason: 'the delegated piece came back',
    resultDeliveryId: p.deliveryId,
    note: body,
  }));
  return { result, join: joinAfter(childId) };
}

/** A piece settled without a result (the peer replied FAIL, or the runtime abandoned it) decrements the
 *  countdown like a success; the join's `landed` count still counts only `done` pieces. */
export function settlePieceWithoutResult(
  childId: string,
  p: { to: 'failed' | 'abandoned'; reason: string; content?: string | null; actorId?: string | null; by?: Actor },
): PieceSettleResult {
  const result = loudOnPieceAbort(childId, () => transition(childId, {
    to: p.to, by: p.by ?? 'agent', actorId: p.actorId ?? 'a2a', reason: p.reason,
    note: p.content || null,
  }));
  return { result, join: joinAfter(childId) };
}

// A hand-off moves the piece's join edge, not its slot: it keeps its parent, countdown slot, reply
// conversation and TTL (the deadline is about the work). What moves is the thread it waits on, its assignee
// and the agent the reply arrives to. The assignee declares the hand-off; the engine never classifies reply
// prose. The chain is bounded by `THREAD_HOP_CAP` over the piece's `hop_count`.

export type HandOffRefusalReason =
  | 'no-live-piece'      // no outstanding piece with this id (settled, or never existed)
  | 'not-the-assignee'   // the sender is not the agent this piece is waiting for
  | 'no-target'          // no hand-off thread given
  | 'same-thread'        // the piece already sits on that thread
  | 'thread-taken'       // another join's piece already roots on it
  | 'hop-cap';           // the chain has reached THREAD_HOP_CAP

export type HandOffOutcome =
  | {
      kind: 'repointed';
      childId: string;
      fromThreadId: string;
      toThreadId: string;
      newAssignee: string | null;
      hopCount: number;
    }
  | { kind: 'refused'; reason: HandOffRefusalReason; detail: string };

/** Re-point a live join piece at the thread its assignee handed the work off on. Refuses by returning;
 *  every refusal leaves the row byte-identical so the transport can settle the reply as usual. */
export function repointJoinPieceToHandOff(p: {
  childId: string;
  handOffSender: string;
  newThreadId: string;
  newAssignee: string | null;
}): HandOffOutcome {
  const db = getDb();
  const target = (p.newThreadId ?? '').trim();
  const refuse = (reason: HandOffRefusalReason, detail: string): HandOffOutcome =>
    ({ kind: 'refused', reason, detail });

  const r = db.prepare(`
    SELECT id, root_id, state, assignee_agent, hop_count
      FROM work
     WHERE id = ? AND kind = 'task' AND root_kind = 'a2a_thread' AND parent_id IS NOT NULL
       AND state IN ${CHILD_OPEN_STATES}
  `).get(p.childId) as
    | { id: string; root_id: string; state: WorkState; assignee_agent: string | null; hop_count: number | null }
    | undefined;
  if (!r) {
    return refuse('no-live-piece', 'there is no outstanding delegated piece to re-point');
  }
  if (!r.assignee_agent || r.assignee_agent !== p.handOffSender) {
    return refuse('not-the-assignee', 'only the agent this piece is waiting for can hand it on');
  }
  if (!target) return refuse('no-target', 'no hand-off thread was named');
  if (target === r.root_id) {
    return refuse('same-thread', 'the piece is already waiting on that thread');
  }
  const taken = db.prepare(
    `SELECT id FROM work WHERE root_kind = 'a2a_thread' AND root_id = ? AND id != ? LIMIT 1`,
  ).get(target, p.childId) as { id: string } | undefined;
  if (taken) {
    return refuse('thread-taken', 'that thread already carries delegated work of its own');
  }
  const nextHop = (r.hop_count ?? 0) + 1;
  if (nextHop > THREAD_HOP_CAP) {
    return refuse(
      'hop-cap',
      `this work has already been passed along ${THREAD_HOP_CAP} times and the chain stops here; `
      + 'reply FAIL instead so the person who asked is told plainly',
    );
  }

  const at = now();
  withUnit(() => {
    db.prepare(`
      UPDATE work
         SET root_id = ?, agent_id = ?, assignee_agent = ?, hop_count = ?, updated_at = ?
       WHERE id = ? AND state IN ${CHILD_OPEN_STATES}
    `).run(target, p.handOffSender, p.newAssignee ?? null, nextHop, at, p.childId);
    // 'audit' with a marker, like `clearPhantomCountdowns`: a repoint is not a state change, so it needs no
    // new `work_events.kind`.
    appendEvent(p.childId, 'audit', p.handOffSender, {
      marker: 'join_edge_repointed',
      from_thread: r.root_id,
      to_thread: target,
      new_assignee: p.newAssignee ?? null,
      hop_count: nextHop,
      reason: 'the assignee declared a hand-off, so the piece follows the work instead of '
        + 'settling on their note',
    }, at);
  });
  logger.info('join piece re-pointed to a declared hand-off', {
    childId: p.childId, from: r.root_id, to: target,
    handOffSender: p.handOffSender, newAssignee: p.newAssignee ?? null, hopCount: nextHop,
  }, p.handOffSender);
  return {
    kind: 'repointed', childId: p.childId, fromThreadId: r.root_id, toThreadId: target,
    newAssignee: p.newAssignee ?? null, hopCount: nextHop,
  };
}

export function dueJoins(nowMs: number, limit = 25): JoinState[] {
  const floor = nowMs - JOIN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const rows = getDb().prepare(`
    SELECT id FROM work
     WHERE remaining_children IS NOT NULL AND ttl_at IS NOT NULL
       AND ttl_at <= ? AND updated_at >= ?
       AND state NOT IN ('done','failed','abandoned')
     ORDER BY opened_at ASC LIMIT ?
  `).all(nowMs, floor, limit) as Array<{ id: string }>;
  return rows.map((r) => joinState(r.id)).filter((s): s is JoinState => s !== null);
}

/** Joins past their deadline whose PARENT already closed `done` with pieces still outstanding (a residual
 *  shape: the settlement authority holds a delegating ask `blocked`). Separate from `dueJoins` because
 *  `failJoinClosed` transitions the parent and `done -> failed` is a move this machine does not make:
 *  this arm's caller settles the outstanding CHILDREN instead. `state = 'done'` only: `failed` parents
 *  already got their notice and `abandoned` ones own their story. */
export function dueJoinsUnderClosedParent(nowMs: number, limit = 25): JoinState[] {
  const floor = nowMs - JOIN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const rows = getDb().prepare(`
    SELECT id FROM work
     WHERE remaining_children > 0 AND ttl_at IS NOT NULL
       AND ttl_at <= ? AND updated_at >= ?
       AND state = 'done'
     ORDER BY opened_at ASC LIMIT ?
  `).all(nowMs, floor, limit) as Array<{ id: string }>;
  return rows.map((r) => joinState(r.id)).filter((s): s is JoinState => s !== null);
}

/** Fail a join CLOSED. `expectedState` is the exactly-once guard: of several reapers, a re-drain and a
 *  live relay, one gets `applied`, the rest a `state-conflict` refusal, and only the winner notifies the
 *  owner. The actor is the scheduler because an engine actor would need evidence (G6). */
export function failJoinClosed(
  parentWorkId: string, p: { reason: string; expectedState: WorkState },
): WorkOutcome {
  return transition(parentWorkId, {
    to: 'failed', by: 'scheduler', actorId: 'work-reaper',
    reason: p.reason, expectedState: p.expectedState,
  });
}

/** Give a waiting join one more deadline (`JOIN_TTL_MINUTES`) from now, never from the expired one: a `ttl_at`
 *  write, not a `transition()`. */
export function extendJoinTtl(parentWorkId: string): void {
  const nowMs = now();
  getDb().prepare('UPDATE work SET ttl_at = ?, updated_at = ? WHERE id = ?')
    .run(nowMs + JOIN_TTL_MINUTES * 60_000, nowMs, parentWorkId);
}

// The join-delivered settle is `settleAskOnJoin` in `work/ask-settlement.ts`;
// `claimFailedJoinForLateAnswer` stays here as a `work.state` write.

/** Claim the right to tell the owner about a late answer: `failed -> open` succeeds for exactly one
 *  caller. Separate from the settle because the guard is won before the send. */
export function claimFailedJoinForLateAnswer(
  parentWorkId: string, evidenceDeliveryId: string, reason: string,
): WorkOutcome {
  return transition(parentWorkId, {
    to: 'open', by: 'engine', actorId: 'a2a-join', reason: `late answer: ${reason}`,
    evidenceRef: evidenceDeliveryId, expectedState: 'failed',
  });
}

export function openJoins(limit = 50): JoinState[] {
  const floor = now() - JOIN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const rows = getDb().prepare(`
    SELECT id FROM work
     WHERE remaining_children IS NOT NULL AND updated_at >= ?
       AND state NOT IN ('done','failed','abandoned')
     ORDER BY opened_at DESC LIMIT ?
  `).all(floor, limit) as Array<{ id: string }>;
  return rows.map((r) => joinState(r.id)).filter((s): s is JoinState => s !== null);
}

export function childrenForThread(threadId: string): JoinChild[] {
  return (getDb().prepare(`
    SELECT id, parent_id, agent_id, root_id, state, assignee_agent, reply_conversation_id
      FROM work
     WHERE kind = 'task' AND root_kind = 'a2a_thread' AND root_id = ? AND parent_id IS NOT NULL
     ORDER BY opened_at DESC LIMIT 5
  `).all(threadId) as Array<{
    id: string; parent_id: string; agent_id: string; root_id: string; state: WorkState;
    assignee_agent: string | null; reply_conversation_id: string | null;
  }>).map((r) => ({
    id: r.id, parentId: r.parent_id, agentId: r.agent_id, threadId: r.root_id, state: r.state,
    assigneeAgent: r.assignee_agent, replyConversationId: r.reply_conversation_id,
  }));
}

export function findFailedJoinForThread(
  agentId: string, threadId: string,
): { childId: string; parentId: string } | null {
  const r = getDb().prepare(`
    SELECT c.id AS child_id, c.parent_id AS parent_id
      FROM work c JOIN work p ON p.id = c.parent_id
     WHERE c.agent_id = ? AND c.kind = 'task' AND c.root_kind = 'a2a_thread' AND c.root_id = ?
       AND (p.state = 'failed' OR (c.state <> 'done' AND EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = p.id AND e.kind = 'compile_resolved' AND json_extract(e.payload, '$.kind') = 'late')))
     ORDER BY c.opened_at DESC LIMIT 1
  `).get(agentId, threadId) as { child_id: string; parent_id: string } | undefined;
  return r ? { childId: r.child_id, parentId: r.parent_id } : null;
}

/** The join stops waiting to be compiled; with `putBack` the event is the record that its answer went back to the
 *  agent (`kind` and `evidence`, read by `newestPutBack`). Returns 1 only for the pass that cleared the flag. */
export function clearJoinCompilePending(
  parentWorkId: string, reason: string, putBack?: { kind: string; evidence: string | null },
): number {
  return withUnit((): number => {
    const changed = getDb().prepare(
      'UPDATE work SET compile_pending = 0, updated_at = ? WHERE id = ? AND compile_pending = 1',
    ).run(now(), parentWorkId).changes;
    if (changed === 1) appendEvent(parentWorkId, 'compile_resolved', 'engine', { reason, ...putBack });
    return changed;
  });
}

/** The A2A thread's stored hop count, unaged; `null` means no work row (not `0`). `delegation-exit.ts`
 *  uses it to copy a chain's count onto a new child row; the cap itself reads `threadHopCountInWindow`. */
export function threadHopCount(threadId: string): number | null {
  const r = getDb().prepare(
    `SELECT hop_count FROM work WHERE root_kind = 'a2a_thread' AND root_id = ?
      ORDER BY opened_at DESC LIMIT 1`,
  ).get(threadId) as { hop_count: number } | undefined;
  return r ? r.hop_count : null;
}

/** The count the cap reads: the stored number aged against the last DELIVERY. The caller supplies that
 *  instant, since `work.updated_at` is stamped by many writes on these rows; the honest clock is
 *  `a2a_threads.updated_at` (set by `ensureThread` and `recordThreadDelivery` in `a2a-transport.ts`). */
export function threadHopCountInWindow(threadId: string, lastDeliveryMs: number | null): number | null {
  const stored = threadHopCount(threadId);
  if (stored === null) return null;
  return hopWindowLapsed(lastDeliveryMs) ? 0 : stored;
}

/** True when the last recorded DELIVERY is outside the rolling window. Pass a delivery instant, never
 *  `work.updated_at`. A null instant is lapsed: deliver rather than drop on a timestamp nobody wrote. */
export function hopWindowLapsed(lastDeliveryMs: number | null | undefined): boolean {
  if (lastDeliveryMs == null) return true;
  return now() - lastDeliveryMs > THREAD_HOP_WINDOW_MS;
}

/** Count one delivered hop on the thread's work row; returns the new count, or null with no work row. A
 *  hop after the window lapsed restarts the count at 1; `lastDeliveryMs` is read BEFORE this delivery
 *  moved it. */
export function bumpThreadHopCount(threadId: string, lastDeliveryMs: number | null): number | null {
  const db = getDb();
  const restart = hopWindowLapsed(lastDeliveryMs);
  const changed = db.prepare(
    restart
      ? `UPDATE work SET hop_count = 1, updated_at = ?
          WHERE root_kind = 'a2a_thread' AND root_id = ?`
      : `UPDATE work SET hop_count = hop_count + 1, updated_at = ?
          WHERE root_kind = 'a2a_thread' AND root_id = ?`,
  ).run(now(), threadId).changes;
  if (changed === 0) return null;
  return threadHopCount(threadId);
}

/** Purge `a2a_threads` rows older than `JOIN_MAX_AGE_DAYS` that no `work` row is rooted on (a delegated
 *  thread's count lives on the spine and its join may be live). Returns the row count. */
export function purgeDeadA2AThreads(): number {
  const floor = now() - JOIN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  try {
    return getDb().prepare(
      // `NOT EXISTS`, never `NOT IN (SELECT ...)`: one NULL in the subquery would make `NOT IN` match
      // nothing and purge silently.
      `DELETE FROM a2a_threads
        WHERE unixepoch(updated_at) * 1000 < ?
          AND NOT EXISTS (
            SELECT 1 FROM work w
             WHERE w.root_kind = 'a2a_thread' AND w.root_id = a2a_threads.thread_id)`,
    ).run(floor).changes;
  } catch (err) {
    // The table predates the spine and a fixture may not have it; that must not fail a reaper tick.
    logger.warn('a2a_threads purge skipped', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// Commitments: the agent's own promises, declared by a caller with their origin; nothing is parsed from
// prose. Ageing is a marker, not a state (`opened_at` against `COMMITMENT_AGING_DAYS`); a commitment closes
// only via `resolveCommitment` (needs a delivery) or `dismissCommitment`.

export const COMMITMENT_AGING_DAYS = 7;

/** The states an obligation is still owed in (a `claimed` ask is being served right now). */
const OWED_STATES = "('open','blocked')";

const OBLIGATION_KINDS = "('ask','commitment')";

export interface OpenCommitmentInput {
  agentId: string;
  description: string;
  conversationId: string | null;
  turnNumber: number;
  sourceMessageId: string | null;
}

/** A commitment's id is derived from (agent, turn, normalized description): a repeat inside one turn owes
 *  one thing, the same words on a later turn are a second promise. Short and whole-printable so the tool
 *  matches exactly. */
function commitmentId(agentId: string, turnNumber: number, description: string): string {
  const norm = description.toLowerCase().replace(/\s+/g, ' ').trim();
  const h = createHash('sha256').update(`${agentId} ${turnNumber} ${norm}`).digest('hex');
  return `cmt:${h.slice(0, 12)}`;
}

/** Open a commitment; returns its id, or null when there is nothing to record. Idempotent per turn. */
export function openCommitment(p: OpenCommitmentInput): string | null {
  // The text is agent-authored prose bound to `work.title`: redacted BEFORE `commitmentId` derives the
  // dedupe id, so the id and the stored title come from the same bytes.
  const description = redactHandedCredentials(p.agentId, (p.description ?? '').trim());
  if (!description) return null;
  const db = getDb();
  const id = commitmentId(p.agentId, p.turnNumber, description);
  if (db.prepare('SELECT 1 FROM work WHERE id = ?').get(id)) return id;

  // Same as `openAsk`: a dangling conversation id is recorded as absent; losing the obligation is worse.
  let conversationId = p.conversationId;
  if (conversationId != null
      && !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) {
    logger.warn('commitment opened without conversation identity: the id resolves to no conversation row', {
      agentId: p.agentId, conversationId,
    }, p.agentId);
    conversationId = null;
  }
  const at = now();
  const rootId = p.sourceMessageId ?? `turn:${p.turnNumber}`;
  withUnit(() => {
    db.prepare(`
      INSERT INTO work (
        id, kind, agent_id, requester, requester_id, conversation_id,
        root_kind, root_id, state, intent, wakes, closes_thread,
        title, opened_at, updated_at, provenance
      ) VALUES (?, 'commitment', ?, 'agent', ?, ?, 'commitment', ?, 'open', 'commitment', 0, 0, ?, ?, ?, 'live')
    `).run(id, p.agentId, p.agentId, conversationId, rootId, description, at, at);
    appendEvent(id, 'opened', p.agentId, {
      turn_number: p.turnNumber, source_message_id: p.sourceMessageId, conversation_id: conversationId,
    });
  });
  logger.info('commitment recorded', { agentId: p.agentId, id, turnNumber: p.turnNumber }, p.agentId);
  return id;
}

/** Resolve a commitment: kept, with the delivery that proves it (G7 refuses `done` without one). An ASK
 *  is refused here, at the writer: the record closes it (`work/ask-settlement.ts` adjudicates every ask
 *  that entered the turn's context at finalize), never the model's close tool. */
export function resolveCommitment(
  workId: string,
  p: { agentId: string; resultDeliveryId: string | null; note?: string | null },
): WorkOutcome {
  const kind = (getDb().prepare('SELECT kind FROM work WHERE id = ?').get(workId) as
    { kind: WorkKind } | undefined)?.kind;
  if (kind === 'ask') {
    return {
      kind: 'refused', workId, reason: 'ask-not-a-commitment',
      detail: 'an owner ask is closed by the delivery record that answers it, not by a close '
        + 'call — the settlement authority does it at the delivery and again at turn end',
    };
  }
  return transition(workId, {
    to: 'done', by: 'agent', actorId: p.agentId,
    reason: p.note && p.note.trim() ? `commitment kept: ${p.note.trim()}` : 'commitment kept',
    resultDeliveryId: p.resultDeliveryId,
  });
}

/** Dismiss a commitment: no longer owed, nothing delivered. `abandoned`, never `done`, which would file a
 *  kept promise. */
export function dismissCommitment(
  workId: string,
  p: { agentId: string; reason: string },
): WorkOutcome {
  return transition(workId, {
    to: 'abandoned', by: 'agent', actorId: p.agentId, reason: p.reason,
  });
}

export interface Obligation {
  id: string;
  kind: 'ask' | 'commitment';
  title: string | null;
  conversationId: string | null;
  channel: string | null;
  counterpartyName: string | null;
  counterpartyId: string | null;
  openedAt: number;
  state: WorkState;
}

const OBLIGATION_COLUMNS = `
  w.id AS id, w.kind AS kind, w.title AS title, w.conversation_id AS conversationId,
  c.channel AS channel, c.counterparty_name AS counterpartyName, c.counterparty_id AS counterpartyId,
  w.opened_at AS openedAt, w.state AS state`;

/** LEFT JOIN, never INNER: an obligation with no conversation identity is still owed. */
const OBLIGATION_FROM = 'work w LEFT JOIN conversations c ON c.id = w.conversation_id';

function agingCutoff(): number {
  return Date.now() - COMMITMENT_AGING_DAYS * 24 * 60 * 60 * 1000;
}

/** Obligations still owed and not yet aged (the per-turn block); aged ones move to the daily brief,
 *  ageing writes nothing. A request whose relay is on its way is not owed. */
export function openObligations(agentId: string): Obligation[] {
  return getDb().prepare(`
    SELECT ${OBLIGATION_COLUMNS}
      FROM ${OBLIGATION_FROM}
     WHERE w.agent_id = ? AND w.kind IN ${OBLIGATION_KINDS} AND w.state IN ${OWED_STATES}
       AND w.opened_at >= ? AND NOT ${REPLY_IN_FLIGHT}
     ORDER BY w.opened_at ASC`).all(agentId, agingCutoff()) as Obligation[];
}

export function agedObligations(agentId: string): Obligation[] {
  return getDb().prepare(`
    SELECT ${OBLIGATION_COLUMNS}
      FROM ${OBLIGATION_FROM}
     WHERE w.agent_id = ? AND w.kind IN ${OBLIGATION_KINDS} AND w.state IN ${OWED_STATES}
       AND w.opened_at < ?
     ORDER BY w.opened_at ASC`).all(agentId, agingCutoff()) as Obligation[];
}

/** An owed obligation a SEND would discharge: a person's unanswered ask or a recorded promise with no
 *  delivery to point at, the receipt side of the claimed-delivery floor (receipt-keyed, never
 *  prose-keyed). `claimed` is excluded on purpose: the ask this turn is serving is claimed by it, and the
 *  reply being written discharges it. */
export interface OwedSendObligation {
  id: string;
  kind: 'ask' | 'commitment';
  title: string | null;
  conversationId: string | null;
  counterpartyName: string | null;
  counterpartyId: string | null;
  state: WorkState;
  openedAt: number;
}

/** Every obligation this agent still owes that a delivery would discharge, newest first. `result_delivery_id
 *  IS NULL` is asked directly, not implied by state, so a later state edit cannot change this floor. Callers
 *  match the claimed recipient with the canonical identity matcher, never a substring. */
export function owedSendObligations(agentId: string, limit = 50): OwedSendObligation[] {
  return getDb().prepare(`
    SELECT w.id AS id, w.kind AS kind, w.title AS title, w.conversation_id AS conversationId,
           c.counterparty_name AS counterpartyName, c.counterparty_id AS counterpartyId,
           w.state AS state, w.opened_at AS openedAt
      FROM ${OBLIGATION_FROM}
     WHERE w.agent_id = ? AND w.kind IN ${OBLIGATION_KINDS} AND w.state IN ${OWED_STATES}
       AND w.result_delivery_id IS NULL
     ORDER BY w.opened_at DESC LIMIT ?`).all(agentId, Math.max(1, Math.floor(limit))) as OwedSendObligation[];
}

/** Resolve an obligation id as a weak model types it: brackets stripped, any case, with or without `cmt:`
 *  (absorb, do not refuse). */
export function findObligationByTypedId(agentId: string, typed: string): Obligation | null {
  const raw = (typed ?? '').trim().replace(/^\[+|\]+$/g, '').toLowerCase();
  if (!raw) return null;
  const withPrefix = raw.startsWith('cmt:') ? raw : `cmt:${raw}`;
  const r = getDb().prepare(`
    SELECT ${OBLIGATION_COLUMNS}
      FROM ${OBLIGATION_FROM}
     WHERE w.agent_id = ? AND w.kind IN ${OBLIGATION_KINDS} AND w.state IN ${OWED_STATES}
       AND (lower(w.id) = ? OR lower(w.id) = ?)
     LIMIT 1`).get(agentId, raw, withPrefix) as Obligation | undefined;
  return r ?? null;
}
