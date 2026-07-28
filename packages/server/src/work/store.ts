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
  | 'reopen-requires-authority';

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
         updated_at = ?
       WHERE id = ?`,
    ).run(
      input.to,
      terminal ? 1 : 0,
      now(),
      input.to === 'done' ? deliveryId : (input.resultDeliveryId ?? row.result_delivery_id),
      input.to === 'claimed' ? (input.claimedByTurn ?? null) : null,
      now(),
      workId,
    );

    eventId = appendEvent(workId, 'transition', actorId, {
      from, to: input.to, by: input.by, reason: input.reason,
      evidence_ref: input.evidenceRef ?? null,
      result_delivery_id: input.to === 'done' ? deliveryId : null,
      claim: input.claim ?? null,
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
