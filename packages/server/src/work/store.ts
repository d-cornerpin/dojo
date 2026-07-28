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
