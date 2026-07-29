// ── The work spine's ONE writer (PHASE-2 T2 Step 3) ──
//
// `transition()` is the only function in this tree that may change `work.state`. Everything
// that used to be a convention re-typed at each call site — check the project rollup, retire
// the assignment notice, advance the schedule, remember the countdown — is an EFFECT INSIDE
// this function, run once, on every path. That is the whole point: today's tree has 48
// state-writing sites across two routes and no transition function at all
// (`tracker/schema.ts:888` is a generic column patcher whose SQL is
// `UPDATE tasks SET ${setClauses.join(', ')}`, applying no gate), and every one of the four
// documented "forgets" is a site that did four of the five things.
//
// THE FIVE PROPERTIES THIS FILE OWES, EACH TESTED BOTH WAYS:
//   1. A discriminated result the caller MUST read: applied | rejected | noop | conflict.
//      No `catch {}` that turns a failed close into a success message (RC4).
//   2. Gates run INSIDE, never at the call site.
//   3. Effects run INSIDE, once, atomically with the state change.
//   4. `by: 'engine'` REQUIRES an `evidenceRef` that RESOLVES to a real occurrence,
//      delivery or artifact row — "the engine may only assert what it can point at" (OR2).
//   5. `claim` is a TYPE, not a source-scan test: 'requests-validation' | 'authoritative',
//      and there is no third option, so the two-key contract cannot be forgotten.
//
// WHAT IS DELIBERATELY NOT HERE YET, AND WHO OWES IT. `transition()`'s effect set is
// complete for everything that exists in `work` TODAY. Three effects named in the lift
// (research 19 s1c / MAP:4694) have nothing to act on until their own task moves their data
// into the spine, and writing them now would mean writing them against `legacy_tasks` —
// which is the two-mechanism disease this phase deletes:
//   * assignment-notice retirement  -> PHASE-2 T8 (the notices are tracker rows today)
//   * live-schedule termination     -> PHASE-2 T9 (schedules are legacy columns today)
//   * dependency cascade            -> PHASE-2 T8 (`depends_on` is a JSON blob on the
//                                       legacy row; it becomes parent/child rows)
// They are listed here rather than in a plan file so the next person to read this function
// can see what it does not do yet without having to trust that a document is current.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('work-store');

export type WorkState =
  | 'open' | 'claimed' | 'done' | 'failed' | 'abandoned' | 'paused' | 'blocked' | 'on_deck';

export type WorkKind = 'ask' | 'task' | 'project' | 'occurrence' | 'commitment';

/** Who is asking for the change. The authority table below is keyed on this and nothing else. */
export type Actor = 'owner' | 'pm' | 'agent' | 'engine' | 'scheduler' | 'healer';

/** Two-key as a type. There is no third option, so "did this call go through validation?"
 *  is answered by the compiler rather than by a conformance suite reading source. */
export type Claim = 'requests-validation' | 'authoritative';

export const TERMINAL_STATES: readonly WorkState[] = ['done', 'failed', 'abandoned'];
export const isTerminal = (s: WorkState): boolean => TERMINAL_STATES.includes(s);

/** The legal-transition table. A move that is not listed is refused by gate `illegal-transition`,
 *  which is why every row here had to be written down rather than left to the caller's judgement.
 *  Reopening a TERMINAL row is legal but only for an authority (see gate G8): "late answer
 *  reopens the work" is a real requirement, and it is also exactly the move a confused model
 *  makes on a stale id. */
const LEGAL: Record<WorkState, readonly WorkState[]> = {
  open:      ['claimed', 'on_deck', 'paused', 'blocked', 'done', 'failed', 'abandoned'],
  on_deck:   ['open', 'claimed', 'paused', 'blocked', 'failed', 'abandoned'],
  claimed:   ['open', 'paused', 'blocked', 'done', 'failed', 'abandoned'],
  paused:    ['open', 'claimed', 'blocked', 'done', 'failed', 'abandoned'],
  blocked:   ['open', 'claimed', 'paused', 'done', 'failed', 'abandoned'],
  done:      ['open'],
  failed:    ['open', 'abandoned'],
  abandoned: ['open'],
};

/** Only these actors may assert `claim: 'authoritative'`. Everyone else must either bring a
 *  delivery (for `done`) or ask for validation. */
const AUTHORITIES: readonly Actor[] = ['owner', 'pm'];

export interface TransitionInput {
  to: WorkState;
  by: Actor;
  /** Free text, REQUIRED. A state change nobody can explain is the thing this spine replaces. */
  reason: string;
  /** REQUIRED when `by === 'engine'`. Must resolve to a real occurrence / delivery / artifact. */
  evidenceRef?: string | null;
  /** The delivery that makes `done` true. `done` is unreachable without one. */
  resultDeliveryId?: string | null;
  claim?: Claim;
  /** The result this transition carries, recorded on the ROW in the same transaction as the
   *  state change. A delegated piece's delivered text lands here (PHASE-2 T4, requirement
   *  3h): the mechanism it replaces wrote the piece into a `join-piece:<thread>` conv_key
   *  namespace on a second message row, so a crash between "the countdown moved" and "the
   *  content was recorded" lost the piece. One transaction, one row, no gap. */
  note?: string | null;
  /** Optimistic concurrency: the state the caller believed it was acting on. Supplying it
   *  turns a lost race into a `conflict` the caller can see instead of a silent overwrite. */
  expectedState?: WorkState;
  /** Set when `to === 'claimed'`; cleared when the row leaves `claimed`. */
  claimedByTurn?: number | null;
  /** Who specifically (agent id, 'owner', a subsystem name). Recorded on the event. */
  actorId?: string | null;
}

export type TransitionResult =
  | { kind: 'applied'; workId: string; from: WorkState; to: WorkState; eventId: number }
  | { kind: 'rejected'; workId: string; gate: TransitionGate; detail: string }
  | { kind: 'noop'; workId: string; state: WorkState; detail: string }
  | { kind: 'conflict'; workId: string; expected: WorkState; actual: WorkState };

export type TransitionGate =
  | 'no-such-work'
  | 'reason-required'
  | 'illegal-transition'
  | 'engine-needs-evidence'
  | 'engine-evidence-unresolved'
  | 'done-requires-delivery'
  | 'delivery-unresolved'
  | 'authoritative-claim-not-permitted'
  | 'requires-validation'
  | 'reopen-requires-authority'
  // PHASE-2 T4: the two refusals the fan-out join owes. Both were caller-side `if`s in the
  // string machine and both are structural here, so no caller can forget them.
  | 'not-a-join-child'
  | 'empty-piece';

interface WorkRow {
  id: string;
  kind: WorkKind;
  parent_id: string | null;
  state: WorkState;
  result_delivery_id: string | null;
  remaining_children: number | null;
}

const now = (): number => Date.now();

/** An engine assertion must point at something that exists. Occurrences live in `work`
 *  (kind='occurrence') because OR1 gave them the same ID space; deliveries and artifacts are
 *  their own tables. Anything else is not evidence. */
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

/** Append a row to the work event log. The ONE place events are written, so "did anyone
 *  record this?" is not a question a reader has to ask per call site. */
function appendEvent(workId: string, kind: string, actor: string, payload: unknown): number {
  const info = getDb().prepare(
    'INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(workId, kind, payload === undefined ? null : JSON.stringify(payload), actor, now());
  return Number(info.lastInsertRowid);
}

/**
 * The ONE writer of `work.state`.
 *
 * Every gate below refuses by RETURNING, never by throwing: a caller that ignores the result
 * gets a value it did not use rather than an exception it swallowed, and the conformance walk
 * plus the type make the ignoring visible.
 */
export function transition(workId: string, input: TransitionInput): TransitionResult {
  const db = getDb();
  const actorId = input.actorId ?? input.by;

  // ── G1: the row must exist. A stale id from a previous session is the platform's own
  //        recorded baseline red; it must be REFUSED with something steerable, never
  //        silently create or silently succeed. ──
  const row = db.prepare(
    'SELECT id, kind, parent_id, state, result_delivery_id, remaining_children FROM work WHERE id = ?',
  ).get(workId) as WorkRow | undefined;
  if (!row) {
    return {
      kind: 'rejected', workId, gate: 'no-such-work',
      detail: `No work row ${workId}. It may be from an earlier session; list the open work and use a current id.`,
    };
  }

  // ── G2: a state change nobody can explain does not happen. ──
  if (!input.reason || input.reason.trim().length === 0) {
    return { kind: 'rejected', workId, gate: 'reason-required', detail: 'every transition states its reason' };
  }

  // ── G3: lost race, seen instead of silently overwritten. ──
  if (input.expectedState !== undefined && input.expectedState !== row.state) {
    return { kind: 'conflict', workId, expected: input.expectedState, actual: row.state };
  }

  // ── G4: already there. Not an error, and NOT a success either — the caller asked for a
  //        change that did not happen, and #40 of the tracker requirements says an explicit
  //        NO-OP is never reported as [OK]. ──
  if (row.state === input.to) {
    return { kind: 'noop', workId, state: row.state, detail: `already ${row.state}` };
  }

  // ── G5: the legal-transition table. ──
  if (!LEGAL[row.state].includes(input.to)) {
    return {
      kind: 'rejected', workId, gate: 'illegal-transition',
      detail: `${row.state} -> ${input.to} is not a legal move`,
    };
  }

  // ── G6: the engine may only assert what it can point at (OR2). ──
  if (input.by === 'engine') {
    if (!input.evidenceRef) {
      return {
        kind: 'rejected', workId, gate: 'engine-needs-evidence',
        detail: 'transition(by:"engine") requires evidence_ref — an occurrence, delivery or artifact id',
      };
    }
    if (!evidenceResolves(input.evidenceRef)) {
      return {
        kind: 'rejected', workId, gate: 'engine-evidence-unresolved',
        detail: `evidence_ref ${input.evidenceRef} resolves to no occurrence, delivery or artifact row`,
      };
    }
  }

  // ── G7: done means DELIVERED. The DB CHECK enforces the column; this gate enforces that
  //        the id points at a delivery that exists, which a CHECK cannot see. ──
  const deliveryId = input.resultDeliveryId ?? row.result_delivery_id;
  if (input.to === 'done') {
    if (!deliveryId) {
      return {
        kind: 'rejected', workId, gate: 'done-requires-delivery',
        detail: 'work is done because something was delivered — supply result_delivery_id',
      };
    }
    if (!deliveryExists(deliveryId)) {
      return {
        kind: 'rejected', workId, gate: 'delivery-unresolved',
        detail: `result_delivery_id ${deliveryId} is not a delivery row`,
      };
    }
  }

  // ── G8: the two-key contract. ──
  if (input.claim === 'authoritative' && !AUTHORITIES.includes(input.by)) {
    return {
      kind: 'rejected', workId, gate: 'authoritative-claim-not-permitted',
      detail: `${input.by} may not claim authority; that is the owner's and the PM's`,
    };
  }
  // Reopening a settled row is the move a confused model makes on a stale id, so it needs an
  // authority — or the engine, which by G6 already had to point at something real.
  if (isTerminal(row.state) && !isTerminal(input.to)
      && input.claim !== 'authoritative' && input.by !== 'engine') {
    return {
      kind: 'rejected', workId, gate: 'reopen-requires-authority',
      detail: `reopening ${row.state} work needs the owner or the PM`,
    };
  }
  // A worker agent asking to settle work it cannot prove is a REQUEST, recorded as one. The
  // event lands; the state does not move. `done` is exempt because a delivery IS the receipt
  // — that is the whole design, and requiring a second key on top of a proven delivery would
  // re-create the validated-flag columns this phase deletes.
  if (input.claim === 'requests-validation' && isTerminal(input.to) && input.to !== 'done') {
    const eventId = appendEvent(workId, 'validation_requested', actorId, {
      requested_state: input.to, reason: input.reason, from: row.state,
    });
    logger.info('work validation requested', { workId, from: row.state, requested: input.to, eventId });
    return {
      kind: 'rejected', workId, gate: 'requires-validation',
      detail: `recorded as a validation request (event ${eventId}); an authority confirms it`,
    };
  }

  // ══ EFFECTS — all of them, once, in one transaction with the state change ══
  const from = row.state;
  const terminal = isTerminal(input.to);
  let eventId = 0;

  db.transaction(() => {
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
         updated_at = ?
       WHERE id = ?`,
    ).run(
      input.to,
      terminal ? 1 : 0,
      now(),
      input.to === 'done' ? deliveryId : (input.resultDeliveryId ?? row.result_delivery_id),
      input.to === 'claimed' ? (input.claimedByTurn ?? null) : null,
      input.note ?? null,
      terminal ? 1 : 0,
      now(),
      workId,
    );

    eventId = appendEvent(workId, 'transition', actorId, {
      from, to: input.to, by: input.by, reason: input.reason,
      evidence_ref: input.evidenceRef ?? null,
      result_delivery_id: input.to === 'done' ? deliveryId : null,
      claim: input.claim ?? null,
      note: input.note ?? null,
    });

    // EFFECT: the fan-out countdown. A child settling is the ONLY thing that decrements it,
    // and it decrements atomically in the same transaction as the child's own state change —
    // which is what makes "joins are counts, never string arithmetic" true rather than
    // aspirational. Guarded at zero so a double-settle cannot drive it negative.
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
        // EFFECT: THE PARENT WAKES AT ZERO (PHASE-2 T4, requirement 3a), and what it wakes
        // INTO is `compile_pending` — a fact distinct from "the owner got the answer" (3b).
        // This is the same countdown, not a second one: it runs inside the same transaction
        // as the decrement that reached zero, so there is no window in which the join is
        // complete and nobody has recorded it.
        //
        // The outcome is computed from the children, not asserted by the caller: a join
        // whose pieces ALL failed or were abandoned has nothing to compile, and telling the
        // owner "here is your combined answer" from zero pieces is the dishonesty requirement
        // 3e exists to refuse. Nothing landed -> the join is left for the fail-closed notice.
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

    // EFFECT: an authority's verdict is a ROW, not a flag column. `adjudications` carries no
    // 'pending' verdict by design (its CHECK is upheld|rejected), so the REQUEST is the
    // work_events row above and only the ANSWER lands here. Revert count is therefore
    // COUNT(verdict='rejected'), a query, never a maintained counter.
    if (input.claim === 'authoritative') {
      db.prepare(
        `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, evidence_ref, note, created_at)
         VALUES (?, ?, 'upheld', ?, ?, ?, ?)`,
      ).run(workId, input.to, actorId, input.evidenceRef ?? null, input.reason, now());
    }
  })();

  logger.info('work transition applied', { workId, from, to: input.to, by: input.by, eventId });
  return { kind: 'applied', workId, from, to: input.to, eventId };
}

/** Record an authority's REJECTION of a claim. The uphold path lives inside `transition()`
 *  because it moves state; a rejection moves nothing, so it is its own small writer — and it
 *  is here, in the same module, because `adjudications` has one writer for the same reason
 *  `work` does. */
export function rejectClaim(
  workId: string,
  params: { claimState: WorkState; by: Actor; byId?: string; note: string; evidenceRef?: string | null },
): { kind: 'applied'; id: number } | { kind: 'rejected'; gate: TransitionGate; detail: string } {
  if (!AUTHORITIES.includes(params.by)) {
    return {
      kind: 'rejected', gate: 'authoritative-claim-not-permitted',
      detail: `${params.by} may not adjudicate`,
    };
  }
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM work WHERE id = ?').get(workId)) {
    return { kind: 'rejected', gate: 'no-such-work', detail: `no work row ${workId}` };
  }
  const info = db.prepare(
    `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, evidence_ref, note, created_at)
     VALUES (?, ?, 'rejected', ?, ?, ?, ?)`,
  ).run(workId, params.claimState, params.byId ?? params.by, params.evidenceRef ?? null, params.note, now());
  appendEvent(workId, 'claim_rejected', params.byId ?? params.by, { claim_state: params.claimState, note: params.note });
  return { kind: 'applied', id: Number(info.lastInsertRowid) };
}

/** How many times this work item's claims have been thrown back. A COUNT, never a column —
 *  `revert_count` was a maintained integer on `tasks` and it drifted. */
export function revertCount(workId: string): number {
  const r = getDb().prepare(
    "SELECT count(*) AS c FROM adjudications WHERE work_id = ? AND verdict = 'rejected'",
  ).get(workId) as { c: number };
  return r.c;
}

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-2 T3 — THE ASK: every ask is a ticket, and a claim is a STATE.
//
// What this section replaces, named so the removal can be checked rather than trusted:
// `messages.conv_key` was ONE column doing TWO unrelated jobs — the conversation's
// IDENTITY and the turn's CLAIM (`NULL` = nobody has picked this up). `conv_key IS NULL`
// WAS the work queue for an owner's ask. It is now `work.state = 'open'`, and conv_key
// keeps only the job it was named for (07 §3g/3l: state and identity are separate fields).
//
// requirement preserved, in one line each:
//   * a person's message is an obligation the moment it arrives  -> the ask is INSERTed in
//     the same transaction as the message, so there is no instant where one exists alone;
//   * exactly one turn may serve an ask, across processes        -> `transition()`'s
//     `expectedState` CAS; the loser gets `conflict`, which is the D-2 bail;
//   * a transient failure must not strand a person in silence    -> a claim reverts on an
//     abort that produced nothing;
//   * a turn that already acted must never run twice (P6b)       -> the revert is refused
//     when the turn recorded effectful calls, and the refusal is a row, not a silence.
// ════════════════════════════════════════════════════════════════════════════════

/** An ask's id is derived from the message that caused it, so "did this message already
 *  open a ticket?" is answerable without a second index, and a producer retrying an insert
 *  cannot mint a second obligation for one message. */
export function askIdForMessage(messageId: string): string {
  return `ask:${messageId}`;
}

export interface OpenAskInput {
  agentId: string;
  /** The inbound row this obligation is FOR. Becomes `root_id` — origin is required. */
  messageId: string;
  conversationId: string | null;
  requesterId: string | null;
  /** The MESSAGE's own timestamp, not the clock at some later step: every age cliff in the
   *  platform reads `opened_at`, and an obligation is as old as the ask that created it. */
  openedAt: number;
  title: string | null;
}

/**
 * Open the ticket for an inbound ask. Called from inside the message writer's transaction —
 * it deliberately does NOT open one of its own, so the caller owns atomicity and this
 * function cannot silently commit half a pair.
 *
 * Throws on a duplicate. That is the point: two tickets for one message would be two
 * obligations for one question, and swallowing the collision is how the platform grew five
 * partial trackers.
 */
export function openAsk(p: OpenAskInput): string {
  const db = getDb();
  const id = askIdForMessage(p.messageId);
  // `conversation_id` carries a real FK. A producer handing us an id with no conversation
  // row would otherwise take the OWNER'S MESSAGE down with it on the FK violation, so a
  // dangling id is recorded as absent identity and logged — never allowed to drop the ask.
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

/**
 * Pickup. The compare-and-swap that used to be a conditional conv_key stamp on the inbound
 * row, read back through `.changes`.
 *
 * `by: 'agent'` is the honest actor: it is this agent's own turn taking its own ask. The
 * engine actor would need evidence it cannot have yet — the turn has not happened.
 */
export function claimAsk(workId: string, agentId: string): TransitionResult {
  return transition(workId, {
    to: 'claimed', by: 'agent', actorId: agentId, expectedState: 'open',
    reason: 'turn pickup',
  });
}

/**
 * Record WHICH turn holds the claim, once the turn has been allocated its number.
 *
 * Deliberately not part of `claimAsk`: the claim must happen BEFORE the turn record exists,
 * because the D-2 race has to be settled before any work is done, and the turn number is
 * allocated from the turn's own subject — which the claim is what decides. This writes the
 * forward link only; `state` still has exactly one writer, `transition()`. It is the direct
 * counterpart of `markServedByRowid` on the message row.
 *
 * `claimed_by_turn IS NULL` in the WHERE means a later turn can never quietly re-label
 * somebody else's claim.
 */
export function stampClaimingTurn(workId: string, turnNumber: number): number {
  const changed = getDb().prepare(
    `UPDATE work SET claimed_by_turn = ?, updated_at = ?
      WHERE id = ? AND state = 'claimed' AND claimed_by_turn IS NULL`,
  ).run(turnNumber, now(), workId).changes;
  if (changed === 1) appendEvent(workId, 'claim_turn', 'engine', { turn_number: turnNumber });
  return changed;
}

/**
 * P6b, the whole rule in one function.
 *
 * A turn that ended with no answer and NO effectful call may hand its ask back: the person
 * is still waiting and nothing has happened on their behalf, so re-serving costs a retry. A
 * turn that already sent an email, created a task or wrote a file may NOT, because
 * re-serving it would do that a second time — "a duplicate send is worse than a stranded
 * ask" is the recorded direction of error, and it is preserved exactly.
 *
 * Returns the transition when the claim was handed back, or `null` when it was deliberately
 * held. The refusal is written as an event, so a held ask is a fact somebody can find,
 * rather than the absence of a log line.
 */
export function revertAskClaimOnAbort(
  workId: string, effectfulCalls: number, reason: string,
): TransitionResult | null {
  if (effectfulCalls > 0) {
    appendEvent(workId, 'rearm_refused', 'engine', { effectful_calls: effectfulCalls, reason });
    logger.info('ask claim held: the turn performed effectful calls, so it must not re-fire (P6b)', {
      workId, effectfulCalls, reason,
    });
    return null;
  }
  const r = transition(workId, {
    to: 'open', by: 'agent', actorId: 'engine', expectedState: 'claimed', reason,
  });
  return r;
}

/** Tools whose delivery is NOT an answer to the ask that is open. `engine-ack` is the
 *  engine saying "on it" at the START of the work (OR2-PROVISIONAL, PHASE-4 T4 removes the
 *  lane entirely); closing an ask on it would mark a question answered before anybody
 *  looked at it. */
const NON_ANSWERING_DELIVERY_TOOLS = new Set(['engine-ack']);

export interface DeliveryCloseInput {
  agentId: string;
  turnNumber: number | null;
  deliveryId: string;
  conversationId: string | null;
  tool: string;
  outcome: string;
}

/**
 * A quick ask is done when something was DELIVERED for it — never because a model said so.
 *
 * Three narrowings, each of which is a negative control in the test file: the delivery must
 * have succeeded, it must belong to the turn that holds the claim, and it must have gone to
 * the ask's OWN conversation (an email to a third party sent while working on the owner's
 * question is not its answer).
 *
 * PHASE-2 T5 makes deliveries universal; until it lands, the paths that record nothing
 * (dashboard bubbles above all) leave their ask `claimed` rather than `done`. That is
 * visible and inert — a claimed ask is out of the waiting set, so nobody is re-answered —
 * and it is stated here rather than in a plan file.
 */
export function closeAsksForDelivery(p: DeliveryCloseInput): number {
  if (p.outcome !== 'delivered') return 0;
  if (p.turnNumber == null || p.conversationId == null) return 0;
  if (NON_ANSWERING_DELIVERY_TOOLS.has(p.tool)) return 0;
  const rows = getDb().prepare(
    `SELECT id FROM work
      WHERE agent_id = ? AND kind = 'ask' AND state = 'claimed'
        AND claimed_by_turn = ? AND conversation_id = ?`,
  ).all(p.agentId, p.turnNumber, p.conversationId) as Array<{ id: string }>;
  let closed = 0;
  for (const r of rows) {
    const res = transition(r.id, {
      to: 'done', by: 'agent', actorId: p.agentId, resultDeliveryId: p.deliveryId,
      expectedState: 'claimed', reason: `delivered via ${p.tool}`,
    });
    if (res.kind === 'applied') closed++;
  }
  return closed;
}

/** How far back a boot reconciliation will reach. Carried verbatim from the pickup-stamp
 *  reconciliation it replaces (`index.ts` 4b1): a claim stranded by a genuine crash is
 *  seconds-to-minutes old, and anything older is history a restart must not re-answer. */
export const ORPHAN_CLAIM_WINDOW_MINUTES = 30;

/**
 * Crash test B, the durable half: a process killed between the CLAIM and the EFFECT.
 *
 * The claim is in the database and the turn is not, so on restart the ask reads as being
 * served by a turn that will never finish. Two outcomes and no third:
 *   * the dead turn recorded ZERO effectful calls -> hand the ask back, the person is
 *     served again (no orphan claims);
 *   * it recorded some            -> HOLD it, because the effect already happened and a
 *     second turn would repeat it (no duplicate effects).
 *
 * `turns.effectful_calls` is what makes this decidable after the process is gone, which is
 * why T3 writes it as the effects happen instead of only at turn end.
 */
export function reconcileOrphanedClaims(): { reArmed: number; held: number } {
  const db = getDb();
  const since = now() - ORPHAN_CLAIM_WINDOW_MINUTES * 60 * 1000;
  const rows = db.prepare(`
    SELECT w.id AS id, COALESCE(t.effectful_calls, 0) AS effectful_calls
      FROM work w
      LEFT JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = w.claimed_by_turn
     WHERE w.kind = 'ask' AND w.state = 'claimed' AND w.updated_at >= ?
       AND (t.turn_number IS NULL OR t.ended_at IS NULL)
  `).all(since) as Array<{ id: string; effectful_calls: number }>;
  let reArmed = 0; let held = 0;
  for (const r of rows) {
    const res = revertAskClaimOnAbort(
      r.id, r.effectful_calls,
      'boot reconciliation: the claiming turn never finished (process killed between claim and effect)',
    );
    if (res === null) held++;
    else if (res.kind === 'applied') reArmed++;
  }
  if (reArmed > 0 || held > 0) {
    logger.warn('boot reconciliation of orphaned ask claims', { reArmed, held });
  }
  return { reArmed, held };
}

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-2 T4 — FAN-OUT IS PARENT/CHILD ROWS WITH AN ATOMIC COUNTDOWN.
//
// What this section replaces, named so the removal can be checked rather than trusted:
// the PARK STRING MACHINE in `agent/a2a-transport.ts`. One owner ask delegated to N agents
// was held by rewriting the owner message's `conv_key` into `park:~<t1>|<t2>#<remaining>`
// and shrinking the text after the '#' as pieces came back. The join state WAS a string,
// the countdown WAS string arithmetic, and the column it lived in was the same column that
// carries the conversation's identity — so parking an ask DESTROYED the record of where it
// came from (research 07 §3, "worst coupling").
//
// requirement preserved, one line each (research 07-FULL rows 3a–3l):
//   3a  N-way join            -> N child rows with `parent_id`, `remaining_children` on the
//                                parent, decremented INSIDE `transition()`;
//   3b  compile-pending       -> `work.compile_pending`, a column, set by the countdown that
//                                reached zero and cleared by the settle that answers;
//   3c  transactional CAS     -> one guarded UPDATE in the child's own transaction. The old
//                                one retried five times and then returned 'noop' in silence
//                                (07 §3 defect i: "piece lost, join hangs to TTL");
//   3d  TTL fail-closed once  -> `work.ttl_at` + a `transition()` with `expectedState`; the
//                                loser of the race gets `conflict`, a value, not a silence;
//   3e  abandonment           -> a child settling `abandoned` decrements like any other, and
//                                a join with zero landed pieces can only fail closed;
//   3f  late-answer re-open   -> `failed -> open -> done`, both moves recorded, and the
//                                second late answer is refused by the same `expectedState`;
//   3g  state vs identity     -> `state` and `reply_conversation_id` are different columns on
//                                the same row. The owner's message keeps its conv_key;
//   3h  piece result          -> the child's own `notes` + `result_delivery_id`, written in
//                                the transition's transaction (07 §3 defect: the harvest read
//                                a fake `join-piece:` namespace and "could come up empty");
//   3i  answered-by edge      -> `result_delivery_id`, never a string match on the thread;
//   3j  no short-token parks  -> `root_id` holds the FULL thread id and is matched EXACTLY;
//                                `parent_id` is a real FK (07 §3 defect ii: an 8-char token
//                                could not be matched back and `failParksForAbandonedAsk`
//                                silently missed every fan-out park);
//   3l  identity stays        -> nothing here writes `messages.conv_key`.
// ════════════════════════════════════════════════════════════════════════════════

/** How long a delegated join may wait before the engine fails it closed and tells the owner.
 *  Carried verbatim from `PARK_TTL_MINUTES` (`a2a-transport.ts`), which this replaces. */
export const JOIN_TTL_MINUTES = 60;

/** Joins older than this are stale history: nothing re-fires them and telling the owner about
 *  a week-old delegated question is noise. Carried verbatim from `PARK_MAX_AGE_DAYS`. */
export const JOIN_MAX_AGE_DAYS = 7;

/**
 * The A2A per-thread hop cap, declared ONCE, beside the column it now keys on.
 *
 * DECIDED D2 (PHASE-2 T0): the transport's private `MAX_HOPS_PER_THREAD` dissolves into
 * `work.hop_count`. The value is carried over unchanged — 8 — because #14 forbids inventing
 * a threshold, and reconciling it with the classifier's `A2A_HOP_LIMIT = 5` is SWEEP A's job
 * with its own written instruction ("pick one with a reason and delete the other").
 *
 * ⚠ MEASURED CORRECTION TO D2 (PHASE-2 T4, 2026-07-28). D2 records both caps as live —
 * "TWO LIVE VALUES ON ONE CONCEPT ... Both fire." At this HEAD only ONE fires:
 * `git grep -n "a2aIntentValidator" HEAD` returns the definition and its own test file and
 * NOTHING ELSE, so the classifier's cap of 5 has no production caller and cannot reject
 * anything. That makes this the tree's ONLY live hop cap, which is why the enforcement is
 * carried across rather than dropped.
 */
export const THREAD_HOP_CAP = 8;

/** One delegated thread, as the delegation exit knows it. */
export interface DelegationThread {
  /** The FULL A2A thread id. Never an 8-char token — 3j, and the collision that produced it. */
  threadId: string;
  /** Who was asked. The string machine had to re-derive this by scanning messages around the
   *  park's timestamp (`findAskedAgentForPark`); the delegation knows it at the time. */
  assigneeAgent?: string | null;
  /** The A2A intent this thread was opened with (QUESTION / ASSIGN / BLOCK). */
  intent?: string;
  /** The thread's hop count at delegation time — D2's rekey (see THREAD_HOP_CAP). */
  hopCount?: number;
  title?: string | null;
}

export interface OpenJoinInput {
  /** The owner's ask. It is the PARENT: OR1's one ID space, not a second record. */
  parentWorkId: string;
  agentId: string;
  /**
   * The conversation the answer must come back on, COPIED here at delegation time and never
   * resolved later. This is the whole of the "worst coupling" fix: the old machine had to
   * recover the channel from an `inbound_meta` JSON blob because parking had overwritten the
   * identity column, and a park whose meta was missing fell back to the dashboard.
   */
  replyConversationId: string | null;
  /** Absolute epoch-ms deadline. The reaper reads this column and nothing else. */
  ttlAt: number;
  threads: DelegationThread[];
}

/** A child of a join, as its readers need it. */
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
  /** What the peer actually delivered, recorded on the child at land time. */
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
  rootId: string;
  /** What an at-zero join can honestly do: compile the pieces, or admit it got nothing. */
  outcome: 'compile' | 'fail-closed';
}

const CHILD_OPEN_STATES = "('open','claimed','paused','blocked','on_deck')";

/**
 * Open the join for a delegation turn: N children under the owner's ask, the countdown on
 * the parent, and the reply conversation copied onto every row — all in ONE transaction, so
 * there is no instant in which some children exist and the countdown does not.
 *
 * Returns the child ids in hand-off order. An empty thread list is a no-op and says so by
 * returning nothing: a delegation that opened no threads has no join, and writing
 * `remaining_children = 0` would make the reaper believe a join completed.
 */
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
  // Same discipline as `openAsk`: a dangling conversation id is recorded as ABSENT identity
  // rather than allowed to take the whole delegation down on an FK violation.
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
  db.transaction(() => {
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
        t.threadId, t.intent ?? 'ASSIGN', t.hopCount ?? 0, t.title ?? null,
        replyConversationId, p.ttlAt, at, at,
      );
      appendEvent(childId, 'opened', p.agentId, {
        thread_id: t.threadId, parent_id: p.parentWorkId, assignee: t.assigneeAgent ?? null,
      });
      ids.push(childId);
    }
    db.prepare(
      `UPDATE work SET remaining_children = ?, ttl_at = ?, reply_conversation_id = ?,
                       compile_pending = 0, updated_at = ?
        WHERE id = ?`,
    ).run(ids.length, p.ttlAt, replyConversationId, at, p.parentWorkId);
    appendEvent(p.parentWorkId, 'join_opened', p.agentId, {
      children: ids.length, threads: threads.map((t) => t.threadId), ttl_at: p.ttlAt,
    });
  })();
  logger.info('delegation join opened', {
    agentId: p.agentId, parentWorkId: p.parentWorkId, children: ids.length,
  }, p.agentId);
  return ids;
}

/**
 * The OPEN child of a join for this thread, or null.
 *
 * EXACT match on the full thread id. The mechanism this replaces had to sniff the length of
 * a thread reference and prefix-match anything ≤ 8 characters, because a regex fallback
 * minted 8-char park tokens — and `makeThreadId`'s own comment records that an 8-char prefix
 * of a `thread-<hash>-<seed>` id is ~36 buckets and "collides heavily".
 */
export function findJoinChildByThread(agentId: string, threadId: string): JoinChild | null {
  const r = getDb().prepare(`
    SELECT id, parent_id, agent_id, root_id, state, assignee_agent, reply_conversation_id
      FROM work
     WHERE agent_id = ? AND kind = 'task' AND root_kind = 'a2a_thread' AND root_id = ?
       AND parent_id IS NOT NULL AND state IN ${CHILD_OPEN_STATES}
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

/** Read a join's live counts. `total` and `landed` are COUNTED off the children, never
 *  maintained as a second number that can drift from the one the countdown moves. */
export function joinState(parentWorkId: string): JoinState | null {
  const db = getDb();
  const p = db.prepare(
    `SELECT id, agent_id, state, remaining_children, compile_pending, reply_conversation_id,
            ttl_at, root_id
       FROM work WHERE id = ?`,
  ).get(parentWorkId) as
    | { id: string; agent_id: string; state: WorkState; remaining_children: number | null;
        compile_pending: number; reply_conversation_id: string | null; ttl_at: number | null;
        root_id: string }
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
    replyConversationId: p.reply_conversation_id, ttlAt: p.ttl_at, rootId: p.root_id,
    outcome: landed > 0 ? 'compile' : 'fail-closed',
  };
}

/** Every piece of a join, with the content each peer actually delivered. This is the harvest
 *  the compile steer quotes; it reads the CHILDREN, never a conv_key namespace. */
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
  result: TransitionResult;
  join: JoinState & { complete: boolean };
}

function joinAfter(childId: string): JoinState & { complete: boolean } {
  const parentId = (getDb().prepare('SELECT parent_id FROM work WHERE id = ?').get(childId) as
    { parent_id: string | null } | undefined)?.parent_id ?? null;
  const st = parentId ? joinState(parentId) : null;
  return st ?? {
    id: parentId ?? '', agentId: '', parentState: 'open', total: 0, landed: 0, remaining: 0,
    complete: false, compilePending: false, replyConversationId: null, ttlAt: null,
    rootId: '', outcome: 'fail-closed',
  };
}

/**
 * A piece came back. The child settles `done` against the delivery that proves it, its
 * delivered text is recorded on the row in the SAME transaction, and the countdown moves.
 *
 * The empty-reply refusal is HERE rather than at the call site because it was a real
 * incident (2026-07-23, run bmrwsrsi9gl): a worker blurted an instant empty DELIVERABLE, the
 * join advanced on "(no delivered content found)", and the compile steer fired 18 seconds
 * after the ASSIGNs went out. A nothing is not a deliverable; the piece stays outstanding so
 * the real one can land, and if it never does the TTL fails the join closed.
 */
export function landPiece(
  childId: string,
  p: { deliveryId: string; content: string; messageId?: string | null; actorId?: string | null },
): PieceSettleResult {
  const body = (p.content ?? '').trim();
  if (body.length === 0) {
    return {
      result: {
        kind: 'rejected', workId: childId, gate: 'empty-piece',
        detail: 'an empty terminal reply is not a deliverable; the piece stays outstanding',
      },
      join: joinAfter(childId),
    };
  }
  const result = transition(childId, {
    to: 'done', by: 'agent', actorId: p.actorId ?? 'a2a',
    reason: 'the delegated piece came back',
    resultDeliveryId: p.deliveryId,
    note: body.slice(0, 4000),
  });
  return { result, join: joinAfter(childId) };
}

/**
 * A piece settled WITHOUT a result: the peer replied FAIL, or the runtime gave up on it
 * (synthetic ABANDONED). Both count as LANDED — the piece came back, and "it failed" is an
 * answer the owner is entitled to — so both decrement the countdown exactly like a success.
 */
export function settlePieceWithoutResult(
  childId: string,
  p: { to: 'failed' | 'abandoned'; reason: string; content?: string | null; actorId?: string | null },
): PieceSettleResult {
  const result = transition(childId, {
    to: p.to, by: 'agent', actorId: p.actorId ?? 'a2a', reason: p.reason,
    note: p.content ? p.content.slice(0, 4000) : null,
  });
  return { result, join: joinAfter(childId) };
}

/** Joins whose deadline has passed and which have not settled. The reaper reads `ttl_at`
 *  and nothing else — no string scan, no LIKE, no age arithmetic in SQL text. */
export function dueJoins(nowMs: number, limit = 25): JoinState[] {
  const floor = nowMs - JOIN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const rows = getDb().prepare(`
    SELECT id FROM work
     WHERE remaining_children IS NOT NULL AND ttl_at IS NOT NULL
       AND ttl_at <= ? AND opened_at >= ?
       AND state NOT IN ('done','failed','abandoned')
     ORDER BY opened_at ASC LIMIT ?
  `).all(nowMs, floor, limit) as Array<{ id: string }>;
  return rows.map((r) => joinState(r.id)).filter((s): s is JoinState => s !== null);
}

/** Every join of one agent that reached zero and is still waiting for the compiled answer.
 *  Read at turn end, so the loop closes no matter what the model did with the steer. */
export function compilePendingJoins(agentId: string, limit = 5): JoinState[] {
  const rows = getDb().prepare(`
    SELECT id FROM work
     WHERE agent_id = ? AND compile_pending = 1 AND state NOT IN ('done','failed','abandoned')
     ORDER BY opened_at ASC LIMIT ?
  `).all(agentId, limit) as Array<{ id: string }>;
  return rows.map((r) => joinState(r.id)).filter((s): s is JoinState => s !== null);
}

/**
 * Fail a join CLOSED. The `expectedState` IS the exactly-once guard: two reapers, a boot
 * re-drain and a live relay may all reach the same join, and exactly one gets `applied` —
 * the others get `conflict`, which is a VALUE the caller reads, not a zero somebody has to
 * remember to check. The owner notice is sent by the winner and only by the winner.
 *
 * `by: 'scheduler'` is the honest actor and it is deliberate: a deadline decided this, and
 * the engine actor would have to point at an occurrence, delivery or artifact it does not
 * have (G6). Writing `by: 'engine'` here would mean widening that gate to make a caller
 * pass, which is the move this project bans.
 */
export function failJoinClosed(
  parentWorkId: string, p: { reason: string; expectedState: WorkState },
): TransitionResult {
  return transition(parentWorkId, {
    to: 'failed', by: 'scheduler', actorId: 'work-reaper',
    reason: p.reason, expectedState: p.expectedState,
  });
}

/** The join's answer reached the owner. `done` is unreachable without the delivery that
 *  proves it — that gate is `transition()`'s, not this function's. */
export function settleJoinDelivered(
  parentWorkId: string, deliveryId: string, reason: string,
): TransitionResult {
  return transition(parentWorkId, {
    to: 'done', by: 'engine', actorId: 'a2a-join', reason,
    evidenceRef: deliveryId, resultDeliveryId: deliveryId,
  });
}

/**
 * Claim the right to tell the owner about a LATE answer — the first half of the re-open, and
 * the exactly-once guard for it. `failed -> open` succeeds for exactly one caller; everyone
 * else gets `conflict`, which is what stops the owner being told twice.
 *
 * It is a separate call from the settle because the DELIVERY happens between them: the guard
 * has to be won BEFORE the send, and the send is what produces the id the settle points at.
 */
export function claimFailedJoinForLateAnswer(
  parentWorkId: string, evidenceDeliveryId: string, reason: string,
): TransitionResult {
  return transition(parentWorkId, {
    to: 'open', by: 'engine', actorId: 'a2a-join', reason: `late answer: ${reason}`,
    evidenceRef: evidenceDeliveryId, expectedState: 'failed',
  });
}

/**
 * An answer arrived AFTER the join failed closed. It still reaches the owner, once.
 *
 * Two recorded moves rather than one silent overwrite: `failed -> open` (the join is live
 * again) then `open -> done` against the delivery that carried the update. This is the whole
 * composition, and the transport performs exactly these two calls with the send in between.
 */
export function reopenJoinForLateAnswer(
  parentWorkId: string, deliveryId: string, reason: string,
): TransitionResult {
  const reopened = claimFailedJoinForLateAnswer(parentWorkId, deliveryId, reason);
  if (reopened.kind !== 'applied') return reopened;
  return settleJoinDelivered(parentWorkId, deliveryId, reason);
}

/** Every join of this agent that has not settled, newest first. The boot re-drain's input. */
export function openJoins(limit = 50): JoinState[] {
  const floor = now() - JOIN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const rows = getDb().prepare(`
    SELECT id FROM work
     WHERE remaining_children IS NOT NULL AND opened_at >= ?
       AND state NOT IN ('done','failed','abandoned')
     ORDER BY opened_at DESC LIMIT ?
  `).all(floor, limit) as Array<{ id: string }>;
  return rows.map((r) => joinState(r.id)).filter((s): s is JoinState => s !== null);
}

/** The children on a thread, whatever their state. Used by the ABANDONED hook, which must be
 *  able to see a piece it is about to settle. */
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

/** The FAILED-CLOSED join this thread belongs to, if any — the late-answer lookup. */
export function findFailedJoinForThread(
  agentId: string, threadId: string,
): { childId: string; parentId: string } | null {
  const r = getDb().prepare(`
    SELECT c.id AS child_id, c.parent_id AS parent_id
      FROM work c JOIN work p ON p.id = c.parent_id
     WHERE c.agent_id = ? AND c.kind = 'task' AND c.root_kind = 'a2a_thread' AND c.root_id = ?
       AND p.state = 'failed'
     ORDER BY c.opened_at DESC LIMIT 1
  `).get(agentId, threadId) as { child_id: string; parent_id: string } | undefined;
  return r ? { childId: r.child_id, parentId: r.parent_id } : null;
}

/**
 * The compile answered the owner, but through a path that records no delivery yet (dashboard
 * replies — T5 owns the doors). The join stops waiting to be compiled; it deliberately does
 * NOT become `done`, because `done` requires a delivery to point at and inventing one to make
 * a state reachable is the forgery this spine exists to refuse.
 */
export function clearJoinCompilePending(parentWorkId: string, reason: string): number {
  const changed = getDb().prepare(
    'UPDATE work SET compile_pending = 0, updated_at = ? WHERE id = ? AND compile_pending = 1',
  ).run(now(), parentWorkId).changes;
  if (changed === 1) appendEvent(parentWorkId, 'compile_resolved', 'engine', { reason });
  return changed;
}

/**
 * D2: the A2A thread's hop count, on the spine.
 *
 * `null` means "this thread has no work row", which is a different answer from `0` and the
 * caller must be able to tell them apart — a thread nobody delegated on is not a thread that
 * has taken zero hops on the spine.
 */
export function threadHopCount(threadId: string): number | null {
  const r = getDb().prepare(
    `SELECT hop_count FROM work WHERE root_kind = 'a2a_thread' AND root_id = ?
      ORDER BY opened_at DESC LIMIT 1`,
  ).get(threadId) as { hop_count: number } | undefined;
  return r ? r.hop_count : null;
}

/** Count one delivered hop on the thread's work row. Returns the new count, or null when the
 *  thread has no work row. */
export function bumpThreadHopCount(threadId: string): number | null {
  const db = getDb();
  const changed = db.prepare(
    `UPDATE work SET hop_count = hop_count + 1, updated_at = ?
      WHERE root_kind = 'a2a_thread' AND root_id = ?`,
  ).run(now(), threadId).changes;
  if (changed === 0) return null;
  return threadHopCount(threadId);
}
