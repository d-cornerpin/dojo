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
// into the spine, and writing them now would mean writing them against the legacy tables —
// which is the two-mechanism disease this phase deletes:
//   * assignment-notice retirement  -> PHASE-2 T8 (the notices are tracker rows today)
//   * live-schedule termination     -> PHASE-2 T9 (schedules are legacy columns today)
//   * dependency cascade            -> PHASE-2 T8 (`depends_on` is a JSON blob on the
//                                       legacy row; it becomes parent/child rows)
// They are listed here rather than in a plan file so the next person to read this function
// can see what it does not do yet without having to trust that a document is current.

import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';
import { createLogger } from '../logger.js';
// PHASE-4 T1. `work/outcome.ts` DECLARES the boundary's answer (and carries the
// `TransitionResult` STRIP record); this module is its public surface, exactly as
// it was for `TransitionResult`, so every caller keeps ONE import path and the
// split is an implementation detail rather than a second place to look.
import type { WorkEventKind } from './event-kinds.js';
import type { TransitionApplied, TransitionGate, WorkOutcome } from './outcome.js';
export type { TransitionApplied, TransitionGate, WorkOutcome, WorkOutcomeReason } from './outcome.js';
export { workSettled, isStateConflict, noteUnsettled } from './outcome.js';

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
// ⚠ PHASE-2 T8c2 item 7 — `on_deck` WAS UNREACHABLE, AND THE MEASUREMENT IS WHY THIS ROW
// CHANGED. Eleven production call sites ask to put work back in the queue: the scheduler's
// recurring cadence reset ("run finished; waiting for the next occurrence",
// `runner.ts:1010`), its unfired release, the PM ladder's rung-4 auto-reset
// (`pm-agent.ts:1771`), scheduling a task for later, resuming a paused schedule, resolving
// missed runs, the healer, and the owner dragging a card on the dashboard. Every one of them
// moves from `claimed` or `paused`, and NEITHER had `on_deck` in its row — so every one was
// refused with `illegal-transition`, silently, because most of those callers do not read the
// result. Measured on this box before the fix: 536 recorded transitions across 8 distinct
// moves and **ZERO into `on_deck` from any state**, with zero rows sitting in it.
//
// It is a regression with a date: before PHASE-2 T8b these went through
// `tracker/schema.ts:updateTask({status})`, an ungated column patch, and simply worked. T8b
// correctly routed them through this gate; the table it routed them into was written (T2)
// before those callers existed and nobody enumerated them against it. `on_deck -> claimed`
// was already legal, so the asymmetry was an omission, not a decision.
//
// THE RULE, stated so the next reader does not have to infer it: `on_deck` is a NON-TERMINAL
// QUEUE state, and every non-terminal state may return to it. Terminal states are untouched —
// they still have exactly the one `open` reopen edge, so the reopen-requires-authority gate
// below keeps its whole subject. Asserted with negative controls in
// `__tests__/transition.test.ts`.
const LEGAL: Record<WorkState, readonly WorkState[]> = {
  open:      ['claimed', 'on_deck', 'paused', 'blocked', 'done', 'failed', 'abandoned'],
  on_deck:   ['open', 'claimed', 'paused', 'blocked', 'failed', 'abandoned'],
  claimed:   ['open', 'on_deck', 'paused', 'blocked', 'done', 'failed', 'abandoned'],
  paused:    ['open', 'claimed', 'on_deck', 'blocked', 'done', 'failed', 'abandoned'],
  blocked:   ['open', 'claimed', 'on_deck', 'paused', 'done', 'failed', 'abandoned'],
  done:      ['open'],
  failed:    ['open', 'abandoned'],
  abandoned: ['open'],
};

/** Only these actors may assert `claim: 'authoritative'`. Everyone else must either bring a
 *  delivery (for `done`) or ask for validation. */
const AUTHORITIES: readonly Actor[] = ['owner', 'pm'];

/**
 * PHASE-2 T8T — WHO TURNS THE SECOND KEY (progress.md RULING 1).
 *
 * The subsystems that close work on the platform's own receipts rather than on somebody's
 * say-so. They are named here rather than derived from "not an agent" because the list is
 * the ruling's own enum widened by a measurement: the MAP's `adjudication.authority` was
 * `('pm','owner','engine')`, and this tree's `Actor` type has two more subsystem values that
 * did not exist when the MAP was written. Enumerated by command at HEAD `214ba3a` —
 * `git grep -n "setTrackerStatus(.*'complete'" -- packages/server/src` plus the `by:` line
 * under each — the closers of a task/project `done` are: `owner`, `pm` (authorities),
 * `engine` (three sanctioned receipt closes), `scheduler` (three schedule finals),
 * `healer` (project auto-close), and `agent`.
 *
 * G7 has already refused every `done` that cannot point at a delivery row that EXISTS, so
 * "with resolved delivery evidence" is not an extra condition on this list — it is a
 * property of every close that reaches this far.
 *
 * The AGENT is deliberately absent. That is the whole ruling: a worker's own close is Key 1
 * and only Key 1.
 */
const SYSTEM_CLOSERS: readonly Actor[] = ['engine', 'scheduler', 'healer'];

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

// PHASE-4 T1: `TransitionResult` (four private arms) and `TransitionGate` moved to
// `work/outcome.ts` and became `WorkOutcome`, the shared five-way. The STRIP entry,
// the arm-for-arm mapping and the requirement it preserves are in that file's header.
interface WorkRow {
  id: string;
  kind: WorkKind;
  /** Which producer opened this row. G9 reads it: `kind='task'` alone does not mean "a
   *  tracker row" — T4's join pieces are `kind='task'` too. */
  root_kind: string;
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
 *  record this?" is not a question a reader has to ask per call site.
 *
 *  PHASE-2 T8b: exported as `appendWorkEvent` for the rest of the `work/` directory. The
 *  directory is the single-writer boundary now (T6 acceptance §3), and `work_events` keeps
 *  ONE writing FUNCTION rather than spreading the INSERT across the modules that need it.
 *
 *  PHASE-4 T4-SCHEMA: `kind` was a bare `string` beside a column with no CHECK, so `135`'s
 *  "12-value enum" comment was never true of either side. `work/event-kinds.ts` is the
 *  declared list now, migration `152` is the same list as the column's CHECK, and an
 *  undeclared kind fails to COMPILE here — before the database is ever asked. */
function appendEvent(workId: string, kind: WorkEventKind, actor: string, payload: unknown, at?: number): number {
  const info = getDb().prepare(
    'INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(workId, kind, payload === undefined ? null : JSON.stringify(payload), actor, at ?? now());
  return Number(info.lastInsertRowid);
}

export { appendEvent as appendWorkEvent };

/**
 * The ONE writer of `work.state`.
 *
 * Every gate below refuses by RETURNING, never by throwing: a caller that ignores the result
 * gets a value it did not use rather than an exception it swallowed, and the conformance walk
 * plus the type make the ignoring visible.
 */
export function transition(workId: string, input: TransitionInput): WorkOutcome {
  const db = getDb();
  const actorId = input.actorId ?? input.by;

  // ── G1: the row must exist. A stale id from a previous session is the platform's own
  //        recorded baseline red; it must be REFUSED with something steerable, never
  //        silently create or silently succeed. ──
  const row = db.prepare(
    'SELECT id, kind, root_kind, parent_id, state, result_delivery_id, remaining_children FROM work WHERE id = ?',
  ).get(workId) as WorkRow | undefined;
  if (!row) {
    return {
      kind: 'refused', workId, reason: 'no-such-work',
      detail: `No work row ${workId}. It may be from an earlier session; list the open work and use a current id.`,
    };
  }

  // ── G2: a state change nobody can explain does not happen. ──
  if (!input.reason || input.reason.trim().length === 0) {
    return { kind: 'refused', workId, reason: 'reason-required', detail: 'every transition states its reason' };
  }

  // ── G3: lost race, seen instead of silently overwritten. ──
  if (input.expectedState !== undefined && input.expectedState !== row.state) {
    return {
      kind: 'refused', workId, reason: 'state-conflict',
      detail: `expected ${input.expectedState}, found ${row.state}`,
      expected: input.expectedState, actual: row.state,
    };
  }

  // ── G4: already there. Not an error, and NOT a success either — the caller asked for a
  //        change that did not happen, and #40 of the tracker requirements says an explicit
  //        NO-OP is never reported as [OK]. ──
  if (row.state === input.to) {
    return {
      kind: 'no_change', workId, reason: 'already-in-state',
      state: row.state, detail: `already ${row.state}`,
    };
  }

  // ── G5: the legal-transition table. ──
  if (!LEGAL[row.state].includes(input.to)) {
    return {
      kind: 'refused', workId, reason: 'illegal-transition',
      detail: `${row.state} -> ${input.to} is not a legal move`,
    };
  }

  // ── G6: the engine may only assert what it can point at (OR2). ──
  if (input.by === 'engine') {
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

  // ── G7: done means DELIVERED. The DB CHECK enforces the column; this gate enforces that
  //        the id points at a delivery that exists, which a CHECK cannot see. ──
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

  // ── G8: the two-key contract. ──
  if (input.claim === 'authoritative' && !AUTHORITIES.includes(input.by)) {
    return {
      kind: 'refused', workId, reason: 'authoritative-claim-not-permitted',
      detail: `${input.by} may not claim authority; that is the owner's and the PM's`,
    };
  }
  // Reopening a settled row is the move a confused model makes on a stale id, so it needs an
  // authority — or the engine, which by G6 already had to point at something real.
  if (isTerminal(row.state) && !isTerminal(input.to)
      && input.claim !== 'authoritative' && input.by !== 'engine') {
    return {
      kind: 'refused', workId, reason: 'reopen-requires-authority',
      detail: `reopening ${row.state} work needs the owner or the PM`,
    };
  }
  // ── G9: TWO-KEY COMPLETION IS STRUCTURAL (PHASE-2 T8T, progress.md RULING 1) ──
  //
  // Migration `139`'s trigger refuses a `task`/`project` row reaching `done` without an
  // upheld `claim_state='done'` adjudication. This gate is the same rule stated one layer
  // up, so a worker gets a steerable sentence instead of a SQLite ABORT — and so the Key-1
  // filing is RECORDED rather than lost with the aborted statement.
  //
  // What changed from T2's G8, and why (the comment this replaces said the opposite):
  //   "`done` is exempt because a delivery IS the receipt … requiring a second key on top of
  //    a proven delivery would re-create the validated-flag columns this phase deletes."
  // That reasoning holds for asks, commitments and occurrences, and it still governs them —
  // they close by delivery and are untouched below. It does NOT hold for the two tracker
  // nouns, where research 19 §1c's two-key contract is the requirement and the flag columns
  // are being replaced by adjudication ROWS, not by an exemption. The delivery stays
  // mandatory (G7 above); it is now the FIRST key rather than both.
  //
  // The worker is not being refused a capability it had — it is being told which door.
  // `work_close_request` files Key 1 (this event); `work_validate` turns Key 2; and for the
  // common case the engine's own delivery-receipt close turns it at the turn boundary
  // without anyone waiting.
  //
  // SUBJECT: the TRACKER's two nouns, which is not the same set as `kind IN ('task','project')`.
  // T4's fan-out opens its countdown children as `kind='task'` with `root_kind='a2a_thread'`
  // and `landPiece` (below, in this file) settles each one `by: 'agent'` — 17 such rows on the
  // box when this landed. They are pieces of an ask, not board rows (`tracker-view.ts:104-112`),
  // and two-key completion is not about them. Same discriminator as migration `139`'s trigger,
  // stated in both places on purpose: a gate and a constraint that disagree is worse than
  // either alone.
  const twoKeySubject = (row.kind === 'task' || row.kind === 'project')
    && row.root_kind !== 'a2a_thread'
    && input.to === 'done';
  const turnsKeyTwo = input.claim === 'authoritative' || SYSTEM_CLOSERS.includes(input.by);
  if (twoKeySubject && !turnsKeyTwo) {
    const eventId = appendEvent(workId, 'validation_requested', actorId, {
      requested_state: 'done', reason: input.reason, from: row.state,
      result_delivery_id: deliveryId ?? null,
    });
    logger.info('work close requested (Key 1 filed)', { workId, kind: row.kind, from: row.state, eventId });
    return {
      kind: 'refused', workId, reason: 'requires-validation',
      detail: `close request recorded (event ${eventId}); a ${row.kind} is closed by an authority or by the engine's own delivery receipt, not by the worker that did it`,
    };
  }

  // A worker agent asking to settle work it cannot prove is a REQUEST, recorded as one. The
  // event lands; the state does not move. `done` is handled by G9 above for the two tracker
  // nouns; for the kinds OR1 folded onto this table it stays exempt, because an ask closes
  // when something was DELIVERED and there is no second party to adjudicate it.
  if (input.claim === 'requests-validation' && isTerminal(input.to) && input.to !== 'done') {
    const eventId = appendEvent(workId, 'validation_requested', actorId, {
      requested_state: input.to, reason: input.reason, from: row.state,
    });
    logger.info('work validation requested', { workId, from: row.state, requested: input.to, eventId });
    return {
      kind: 'refused', workId, reason: 'requires-validation',
      detail: `recorded as a validation request (event ${eventId}); an authority confirms it`,
    };
  }

  // ══ EFFECTS — all of them, once, in one transaction with the state change ══
  const from = row.state;
  const terminal = isTerminal(input.to);
  let eventId = 0;

  // ONE instant for the whole transaction. Two `Date.now()` readings a millisecond apart is
  // the defect class this phase has now hit three times (the poke ladder's window, the
  // scheduler's occurrence CAS): the adjudication below is filed BEFORE the UPDATE — it has
  // to be, the trigger is BEFORE UPDATE and reads the row it is about to allow — and
  // `validatedExpr` scopes the verdict to "at or after the row entered the state". A
  // one-millisecond drift between the two writes reads back as an UNVALIDATED close.
  const at = now();

  withUnit(() => {
    // EFFECT: an authority's verdict is a ROW, not a flag column, and RULING 1 makes the
    // system closers' delivery receipt the same kind of row. Filed FIRST so migration
    // `139`'s BEFORE-UPDATE trigger can see it in this transaction.
    //
    // `by_agent` is the ROLE for a system close and the ACTOR for an authority's, and that
    // asymmetry is load-bearing rather than sloppy: `tracker-view.ts:validatedExpr` reads
    // this column to answer the PM's question ("did an authority bless this?"), which is a
    // DIFFERENT question from the trigger's ("is this close adjudicated at all?"). The
    // strike-0 close runs with `actorId: <the agent's id>`, so writing the actor here would
    // make an engine close indistinguishable from a person's — and stamping
    // `complete_validated=1` on an engine close is migration `108`'s demolished forgery,
    // re-created. Owner ruling 2026-07-19, `tracker/tools.ts:256-270`.
    if (input.claim === 'authoritative' || (twoKeySubject && SYSTEM_CLOSERS.includes(input.by))) {
      db.prepare(
        `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, evidence_ref, note, created_at)
         VALUES (?, ?, 'upheld', ?, ?, ?, ?)`,
      ).run(
        workId, input.to,
        input.claim === 'authoritative' ? actorId : input.by,
        input.evidenceRef ?? null, input.reason, at,
      );
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
         updated_at = ?
       WHERE id = ?`,
    ).run(
      input.to,
      terminal ? 1 : 0,
      at,
      input.to === 'done' ? deliveryId : (input.resultDeliveryId ?? row.result_delivery_id),
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

    // (The adjudication INSERT used to live HERE, after the UPDATE. PHASE-2 T8T moved it to
    // the top of this transaction: migration `139`'s trigger is BEFORE UPDATE, so a verdict
    // written afterwards is a verdict the trigger cannot see. `adjudications` still carries
    // no 'pending' verdict by design — its CHECK is upheld|rejected — so the REQUEST is the
    // `validation_requested` work_events row and only the ANSWER lands in that table. Revert
    // count is therefore COUNT(verdict='rejected'), a query, never a maintained counter.)
  });

  logger.info('work transition applied', { workId, from, to: input.to, by: input.by, eventId });
  const value: TransitionApplied = { workId, from, to: input.to, eventId };
  return { kind: 'applied', value };
}

/** Record an authority's REJECTION of a claim. The uphold path lives inside `transition()`
 *  because it moves state; a rejection moves nothing, so it is its own small writer — and it
 *  is here, in the same module, because `adjudications` has one writer for the same reason
 *  `work` does. */
export function rejectClaim(
  workId: string,
  params: { claimState: WorkState; by: Actor; byId?: string; note: string; evidenceRef?: string | null },
): { kind: 'applied'; id: number } | { kind: 'refused'; reason: TransitionGate; detail: string } {
  if (!AUTHORITIES.includes(params.by)) {
    return {
      kind: 'refused', reason: 'authoritative-claim-not-permitted',
      detail: `${params.by} may not adjudicate`,
    };
  }
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM work WHERE id = ?').get(workId)) {
    return { kind: 'refused', reason: 'no-such-work', detail: `no work row ${workId}` };
  }
  // T2: the verdict and the event that records it are ONE unit — a rejection nobody
  // can find in the event log is the silence this phase exists to close.
  return withUnit((): { kind: 'applied'; id: number } => {
    const info = db.prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, evidence_ref, note, created_at)
       VALUES (?, ?, 'rejected', ?, ?, ?, ?)`,
    ).run(workId, params.claimState, params.byId ?? params.by, params.evidenceRef ?? null, params.note, now());
    appendEvent(workId, 'claim_rejected', params.byId ?? params.by, { claim_state: params.claimState, note: params.note });
    return { kind: 'applied', id: Number(info.lastInsertRowid) };
  });
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
export function claimAsk(workId: string, agentId: string): WorkOutcome {
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
  return withUnit((): number => {
    const changed = getDb().prepare(
      `UPDATE work SET claimed_by_turn = ?, updated_at = ?
        WHERE id = ? AND state = 'claimed' AND claimed_by_turn IS NULL`,
    ).run(turnNumber, now(), workId).changes;
    if (changed === 1) appendEvent(workId, 'claim_turn', 'engine', { turn_number: turnNumber });
    return changed;
  });
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
/* PHASE-4 T2, MEASURED AND NOT WRAPPED (#14). §T0-PINS B lists this as un-atomic
 * ("transition + appendEvent"). Re-derived at 9d3507e: there is no pair. The refusal
 * branch writes ONE event and returns; the other branch calls `transition`, which is
 * already one unit. Wrapping a single write in a transaction is the ceremony this step
 * was told not to add — the point is ownership. Recorded here so the next reader does
 * not re-open it from the pin list. */
export function revertAskClaimOnAbort(
  workId: string, effectfulCalls: number, reason: string,
): WorkOutcome | null {
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

/** Tools whose delivery is NOT an answer to the ask that is open.
 *
 *  ⚠ OR2-PROVISIONAL: CLOSED, PHASE-4 T4 (2026-08-02). The marker said T4 would remove the
 *  `engine-ack` lane entirely. It removed the ENGINE'S PROSE from it instead: the lane's one
 *  surviving caller delivers the model's own opening line early, which is the shape OR2
 *  wants. The exclusion stands for the reason it always really had — a START-ACK IS NOT AN
 *  ANSWER — and closing an ask on one would mark a question answered before anybody looked
 *  at it. Kept in step with `answered-edge.ts`'s `NON_ANSWERING_TOOLS` by the conformance
 *  test beside it. */
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

/**
 * 2b, CAUSE 3 — an ask NOBODY CAN EVER SERVE OR CLOSE gets an honest terminal state.
 *
 * Two shapes, both structural and both unservable by construction:
 *   * no conversation identity — `closeAsksForDelivery` matches on the conversation, so a
 *     ticket without one can never be closed by any delivery, ever;
 *   * the root message is GONE — a cleared history or a terminated agent takes the row the
 *     obligation was FOR, and nothing can be served against a message nobody can read.
 *
 * `abandoned` is the honest word for both: the platform is not going to answer this, and
 * saying so is better than a ticket that sits `open` forever poisoning the settled read.
 * The once-guard is `transition()`'s own `expectedState` CAS — the same guard the quarantine
 * and the delegated-piece abandon use, which is what makes `abandoned` "reachable from >= 3
 * causes with a SINGLE-transition once-guard" rather than three hand-rolled ones.
 *
 * PHASE-2 T6 also closed the PRODUCERS (`memory/message-store.ts`, the ingest-channel gate),
 * so on a tree from this commit forward this reaper finds nothing to do. It stays because a
 * producer nobody has met yet is exactly what #15 says not to assume away, and because the
 * gone-root shape has no producer to close.
 */
export function abandonUnservableAsks(agentId?: string): { abandoned: number; ids: string[] } {
  const db = getDb();
  const scoped = agentId != null;
  const rows = db.prepare(`
    SELECT w.id AS id, w.state AS state,
           (w.conversation_id IS NULL) AS no_identity,
           (m.id IS NULL) AS no_root
      FROM work w LEFT JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id
     WHERE w.kind = 'ask' AND w.state IN ('open','claimed')
       AND (w.conversation_id IS NULL OR m.id IS NULL)
       ${scoped ? 'AND w.agent_id = ?' : ''}
     ORDER BY w.opened_at ASC LIMIT 200
  `).all(...(scoped ? [agentId] : [])) as Array<{
    id: string; state: WorkState; no_identity: number; no_root: number;
  }>;
  const ids: string[] = [];
  for (const r of rows) {
    const why = r.no_root === 1
      ? 'the message this obligation was FOR no longer exists, so it can never be served'
      : 'no conversation identity: no delivery can ever match this ask, so it can never be closed';
    const res = transition(r.id, {
      to: 'abandoned', by: 'agent', actorId: 'work-reaper',
      expectedState: r.state, reason: `unservable — ${why}`,
    });
    if (res.kind === 'applied') ids.push(r.id);
  }
  if (ids.length > 0) {
    logger.warn('abandoned ask ticket(s) that could never be served or closed', {
      agentId: agentId ?? '(all)', count: ids.length,
    });
  }
  return { abandoned: ids.length, ids };
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
export function reconcileOrphanedClaims(): { reArmed: number; held: number; closed: number } {
  const db = getDb();
  const since = now() - ORPHAN_CLAIM_WINDOW_MINUTES * 60 * 1000;
  // PHASE-2 T5 — THE OTHER HALF OF THE REKEY, which `index.ts` named as owed here.
  //
  // T3 removed the string inference (a later row happening to carry the same conv_key) and
  // put this on the two recorded turn facts. What it could not read yet was the DELIVERY
  // EDGE, because before T5 the dashboard path recorded no delivery at all — so this query
  // deliberately did not ask "was it answered", only "did the turn finish and had it acted".
  //
  // Deliveries are universal now, so the answered edge is readable and it is a THIRD outcome,
  // not a tweak to the other two: a process killed between the send and the close leaves an
  // ask that was genuinely ANSWERED sitting at `claimed`. Handing it back re-answers a
  // question the person already had answered; holding it strands it forever. It is closed,
  // pointing at the delivery that answered it — the same evidence `closeAsksForDelivery`
  // would have used had the process lived one more statement.
  const answered = db.prepare(`
    SELECT w.id AS id, d.id AS delivery_id, d.tool AS tool
      FROM work w
      JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = w.claimed_by_turn
      JOIN deliveries d ON d.agent_id = w.agent_id AND d.turn_number = w.claimed_by_turn
                       AND d.conversation_id = w.conversation_id AND d.outcome = 'delivered'
     WHERE w.kind = 'ask' AND w.state = 'claimed' AND w.updated_at >= ?
       AND t.ended_at IS NULL
       AND d.tool NOT IN (${[...NON_ANSWERING_DELIVERY_TOOLS].map(() => '?').join(', ')})
     GROUP BY w.id
  `).all(since, ...NON_ANSWERING_DELIVERY_TOOLS) as Array<{ id: string; delivery_id: string; tool: string }>;
  let closed = 0;
  for (const a of answered) {
    const res = transition(a.id, {
      to: 'done', by: 'agent', actorId: 'boot-reconciliation', resultDeliveryId: a.delivery_id,
      expectedState: 'claimed',
      reason: `boot reconciliation: the claiming turn delivered via ${a.tool} and was killed before it could close`,
    });
    if (res.kind === 'applied') closed++;
  }

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
  if (reArmed > 0 || held > 0 || closed > 0) {
    logger.warn('boot reconciliation of orphaned ask claims', { reArmed, held, closed });
  }
  return { reArmed, held, closed };
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
  });
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
/**
 * ── PHASE-2 T10, RULING 7 rider (b): a piece landing that ABORTS names its row ──
 *
 * On 2026-07-29 a database-side trigger (present on the box, present in no commit) raised
 * `two-key: completion requires an upheld adjudication` on every fan-out piece landing. The
 * throw unwound into `a2a-transport.ts`, which logged `A2A close-the-loop delivery failed`
 * with the error string and nothing else, at `warn`. For six hours the countdown never
 * reached zero, the engine's deterministic single-piece relay never fired, and the ordinary
 * "surface this deliverable" hint stayed deliberately suppressed because a join owned the
 * thread — the platform had taken responsibility for a delivery and was then prevented from
 * making it, silently.
 *
 * The loudness belongs HERE and not at the catch sites, on the same reasoning the empty-piece
 * refusal already uses: inside the settle function, no caller can forget it. This wrapper only
 * ADDS a log line — it rethrows, so control flow is exactly as before, and an in-band refusal
 * (which returns a value rather than throwing) stays quiet.
 */
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
    note: body.slice(0, 4000),
  }));
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
  const result = loudOnPieceAbort(childId, () => transition(childId, {
    to: p.to, by: 'agent', actorId: p.actorId ?? 'a2a', reason: p.reason,
    note: p.content ? p.content.slice(0, 4000) : null,
  }));
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

/**
 * Joins past their deadline whose PARENT has already closed — the second timeout arm, and the
 * whole of issues-log #19.
 *
 * WHY THE POPULATION EXISTS AT ALL. The parent ask closes on the reply the agent sends the owner
 * (T5's `closeAsksForDelivery`) and the join opens in the SAME turn: in the event log
 * `join_opened` lands AFTER the `claimed -> done` transition. A `done` parent with a live
 * countdown is therefore the NORMAL product of every delegating turn, not an exotic state.
 * `dueJoins` above and `openJoins` below both carry `state NOT IN ('done','failed','abandoned')`
 * on the parent, so neither ever yielded one — T11 measured 14 delegated pieces sitting `open`
 * 8–13 HOURS past their TTL under 13 such parents, with the fail-closed owner notice never sent.
 * A late reply still lands (`landPiece` is happy under a terminal parent), so the row was
 * reachable by the peer and by nothing else, and the person who asked was never told.
 *
 * IT IS A SEPARATE FINDER RATHER THAN A WIDENED ONE, deliberately. Dropping the state predicate
 * from `dueJoins` hands `resolveOpenJoin` — and therefore `failJoinClosed` — a terminal parent,
 * and `failJoinClosed` transitions the PARENT with its current state as the exactly-once guard.
 * `done -> failed` is a terminal-to-terminal move this machine does not make, and teaching it to
 * would let a reaper re-open work whose answer was already delivered. This arm's caller settles
 * the outstanding CHILDREN instead: a move the machine already makes, on the same countdown,
 * leaving every fact that describes the owner's answer exactly as it was.
 *
 * `remaining_children > 0`, not `IS NOT NULL`: a terminal parent at zero has nothing
 * outstanding. (`dueJoins` needs `IS NOT NULL` because a LIVE parent at zero still owes the
 * compile relay.) Same `ttl_at` read and the same age cap as the first arm — no second clock and
 * no invented staleness bound.
 *
 * ⚠ `state = 'done'` AND NOT "any terminal state", and the reason was found by the test rather
 * than reasoned out. The first draft matched all three terminal states, and
 * `join-closed-parent-reaper.test.ts`'s first-arm control went red immediately: the first arm's
 * own `failJoinClosed` leaves the parent `failed` WITH the countdown still above zero, which is
 * character-for-character the shape this finder hunts — so the owner got the fail-closed notice
 * and then a second notice about the same join, in the same pass, every pass. The distinguishing
 * fact is what the owner has already been told:
 *   * `done`      — the parent's answer was DELIVERED and said nothing about the outstanding
 *                   piece. That silence is #19, and it is this arm's whole subject.
 *   * `failed`    — reached by `failJoinClosed`, which delivers its own notice. Nothing is owed.
 *   * `abandoned` — reached by the ask-abandon paths (quarantine, unservable-ask reaper), which
 *                   own their own honesty story. Speaking here would be a new behaviour, not a
 *                   repair, so it is deliberately out of scope and asserted as such.
 */
export function dueJoinsUnderClosedParent(nowMs: number, limit = 25): JoinState[] {
  const floor = nowMs - JOIN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const rows = getDb().prepare(`
    SELECT id FROM work
     WHERE remaining_children > 0 AND ttl_at IS NOT NULL
       AND ttl_at <= ? AND opened_at >= ?
       AND state = 'done'
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
): WorkOutcome {
  return transition(parentWorkId, {
    to: 'failed', by: 'scheduler', actorId: 'work-reaper',
    reason: p.reason, expectedState: p.expectedState,
  });
}

/** The join's answer reached the owner. `done` is unreachable without the delivery that
 *  proves it — that gate is `transition()`'s, not this function's. */
export function settleJoinDelivered(
  parentWorkId: string, deliveryId: string, reason: string,
): WorkOutcome {
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
): WorkOutcome {
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
): WorkOutcome {
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
  return withUnit((): number => {
    const changed = getDb().prepare(
      'UPDATE work SET compile_pending = 0, updated_at = ? WHERE id = ? AND compile_pending = 1',
    ).run(now(), parentWorkId).changes;
    if (changed === 1) appendEvent(parentWorkId, 'compile_resolved', 'engine', { reason });
    return changed;
  });
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

// ════════════════════════════════════════════════════════════════════════════════
// PHASE-2 T7 — COMMITMENTS. Requirements 4a + 4b.
//
// The obligation that had no home. An ASK is created at ingest (T3, above): a person sent a
// message, and the message row and its ticket are written in one transaction. A COMMITMENT is
// the other direction — the agent said it would do something — and until this task the
// platform had no structural record of one at all. It recovered them AFTERWARDS, from prose,
// by parsing a fenced section out of a summary and matching entries with a Jaccard similarity
// function (`memory/open-loops.ts`, 623 lines, deleted here).
//
// Why that had to go, in the ledger's own words: the parser could not tell an OBLIGATION from
// a SELF-NARRATION. A transient "I couldn't read your last message" became a durable row and
// was re-raised to the owner five times over 36 hours. The module's answer was a second regex
// guarding the first. The answer here is that there is no parser — an obligation exists
// because a caller declared one, and the declaration carries its own origin.
//
// AGEING IS A MARKER, NOT A STATE (4b). The deleted module wrote `status='stale'` from inside
// the daily-brief generator — a read that mutated rows. Here "aged" is `opened_at` compared
// against `COMMITMENT_AGING_DAYS`; nothing is written, no state exists for it, and the only
// two ways a commitment closes are `resolveCommitment` (which needs the delivery that makes
// `done` true) and `dismissCommitment` (`abandoned` — honest that nothing was delivered).
// ════════════════════════════════════════════════════════════════════════════════

/**
 * The ageing threshold, carried VERBATIM from the deleted `STALE_AFTER_DAYS = 7`
 * (`memory/open-loops.ts:49`). #14: a threshold that is carried is not a threshold that is
 * invented, and this one is not re-derived.
 */
export const COMMITMENT_AGING_DAYS = 7;

/** The states an obligation is still owed in. A `claimed` ask is being served RIGHT NOW by the
 *  turn holding it, so it is not something the model needs reminding about. */
const OWED_STATES = "('open','paused','blocked','on_deck')";

/** Kinds that are obligations to a person rather than board work. Both are hidden from the
 *  project board by the same rule (T3: `kind='ask'` never appears there). */
const OBLIGATION_KINDS = "('ask','commitment')";

export interface OpenCommitmentInput {
  agentId: string;
  /** What was promised, in the agent's own words. Stored on `title`; never parsed. */
  description: string;
  conversationId: string | null;
  /** The turn that made the promise. Half of the row's identity — see `commitmentId`. */
  turnNumber: number;
  /** The message the promise was made in, when there is one. Becomes `root_id`. */
  sourceMessageId: string | null;
}

/**
 * A commitment's id is derived from (agent, turn, normalized description).
 *
 * That derivation IS the dedup rule, and it draws a line the Jaccard matcher could not: a
 * model repeating itself inside ONE turn owes ONE thing, and the same words on a LATER turn
 * are a SECOND promise. The deleted matcher collapsed anything 60% similar across the whole
 * agent for ever, so "send the invoice" promised on Monday and again on Friday was one loop,
 * and closing it closed both.
 *
 * Short and whole-printable on purpose: the block shows the WHOLE id, so the tool matches
 * exactly and the deleted module's ambiguous-prefix branch has nothing left to do.
 */
function commitmentId(agentId: string, turnNumber: number, description: string): string {
  const norm = description.toLowerCase().replace(/\s+/g, ' ').trim();
  const h = createHash('sha256').update(`${agentId} ${turnNumber} ${norm}`).digest('hex');
  return `cmt:${h.slice(0, 12)}`;
}

/**
 * Open a commitment. Returns its id, or null when there is nothing to record.
 *
 * The derived id is what makes it idempotent per turn: a model that says "I'll send it" twice
 * in one turn gets one row, and the second call returns the same id rather than a second
 * obligation or an error.
 */
export function openCommitment(p: OpenCommitmentInput): string | null {
  const description = (p.description ?? '').trim();
  if (!description) return null;
  const db = getDb();
  const id = commitmentId(p.agentId, p.turnNumber, description);
  if (db.prepare('SELECT 1 FROM work WHERE id = ?').get(id)) return id;

  // Same discipline as `openAsk` and `openDelegationJoin`: a dangling conversation id is
  // recorded as ABSENT identity rather than allowed to take the promise down on an FK
  // violation. Losing the obligation is worse than losing the attribution.
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

/**
 * Resolve a commitment: it was kept, and here is the delivery that proves it.
 *
 * There is no "the model says so" path, deliberately. `transition()`'s G7 refuses `done`
 * without a delivery that RESOLVES, so a promise cannot be closed by announcing it — which is
 * the single behaviour every honesty floor in this tree exists to prevent.
 */
export function resolveCommitment(
  workId: string,
  p: { agentId: string; resultDeliveryId: string | null; note?: string | null },
): WorkOutcome {
  return transition(workId, {
    to: 'done', by: 'agent', actorId: p.agentId,
    reason: p.note && p.note.trim() ? `commitment kept: ${p.note.trim()}` : 'commitment kept',
    resultDeliveryId: p.resultDeliveryId,
  });
}

/**
 * Dismiss a commitment: it is no longer owed, and nothing was delivered for it.
 *
 * `abandoned`, never `done` — 4b's "dismissal" is the owner (or the agent on their word)
 * dropping the obligation, and calling that "done" would file a kept-promise record on a
 * promise nobody kept. The same reading T12's status map gives `cancelled`.
 */
export function dismissCommitment(
  workId: string,
  p: { agentId: string; reason: string },
): WorkOutcome {
  return transition(workId, {
    to: 'abandoned', by: 'agent', actorId: p.agentId, reason: p.reason,
  });
}

/** One obligation, as the surfaces that render it need it. */
export interface Obligation {
  id: string;
  kind: 'ask' | 'commitment';
  title: string | null;
  conversationId: string | null;
  /** The party label's inputs, read from the CONVERSATION's own identity columns.
   *
   *  The deleted module derived the label by string-parsing `conv_key` — the column that also
   *  carried the claim token and the park sigils, so a parked row silently changed which party
   *  its loops were attributed to. Phase 1 gave conversations real identity columns; this reads
   *  those, and it is why nothing here depends on the column T10 deletes. */
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

/** LEFT JOIN, never INNER: an obligation whose conversation identity is absent is still owed,
 *  and an inner join would silently drop it from both surfaces. */
const OBLIGATION_FROM = 'work w LEFT JOIN conversations c ON c.id = w.conversation_id';

function agingCutoff(): number {
  return Date.now() - COMMITMENT_AGING_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Obligations still owed and NOT yet aged — what the per-turn block renders.
 *
 * The ageing split is the whole of 4b's "aging is a marker": an aged row is still `open` and
 * still owed, it simply moves from the per-turn lane to the daily brief, exactly as the
 * deleted `status='stale'` flip arranged — without a second state and without a write.
 */
export function openObligations(agentId: string): Obligation[] {
  return getDb().prepare(`
    SELECT ${OBLIGATION_COLUMNS}
      FROM ${OBLIGATION_FROM}
     WHERE w.agent_id = ? AND w.kind IN ${OBLIGATION_KINDS} AND w.state IN ${OWED_STATES}
       AND w.opened_at >= ?
     ORDER BY w.opened_at ASC`).all(agentId, agingCutoff()) as Obligation[];
}

/** Obligations still owed that have gone past the ageing threshold — the daily brief's set. */
export function agedObligations(agentId: string): Obligation[] {
  return getDb().prepare(`
    SELECT ${OBLIGATION_COLUMNS}
      FROM ${OBLIGATION_FROM}
     WHERE w.agent_id = ? AND w.kind IN ${OBLIGATION_KINDS} AND w.state IN ${OWED_STATES}
       AND w.opened_at < ?
     ORDER BY w.opened_at ASC`).all(agentId, agingCutoff()) as Obligation[];
}

/**
 * PHASE-4 T4 — THE OBLIGATION HALF OF THE CLAIMED-DELIVERY FLOOR (the owner's live fixture).
 *
 * The floor that steers a model claiming a delivery it never made was keyed on PROSE, and on
 * 2026-08-01 the owner caught it firing three times on the words "told Michael" in a wedding
 * transcript he had asked about — each fire ordering the agent to "do it NOW", which produced
 * double answers and a re-done delivery. Research 21's binding caution names that class
 * exactly: honesty floors are receipt-keyed, never prose-keyed.
 *
 * This is the receipt side of the rekey. An obligation a SEND would discharge is a ROW: a
 * person's own unanswered ask, or a promise the agent recorded, still owed and with no delivery
 * to point at. The engine may only assert what it can point at (G6), so a claim about somebody
 * the platform holds no owed row for is not something the engine gets to contradict.
 *
 * `claimed` is EXCLUDED with the rest of `OWED_STATES` and that exclusion is load-bearing here,
 * not inherited: the ask this turn is serving is claimed BY this turn, and the reply being
 * written is what discharges it. Counting it would make every turn its own accuser.
 *
 * `result_delivery_id IS NULL` is stated even though `state <> 'done'` already implies it by the
 * DDL's own CHECK — the reader's question is "is there a delivery to point at", and asking it
 * directly is what stops a later state edit silently changing this floor's meaning.
 */
export interface OwedSendObligation {
  id: string;
  kind: 'ask' | 'commitment';
  title: string | null;
  conversationId: string | null;
  /** From the CONVERSATION's identity columns — who this obligation is owed TO. */
  counterpartyName: string | null;
  counterpartyId: string | null;
  state: WorkState;
  openedAt: number;
}

/**
 * Every obligation this agent still owes that a delivery would discharge, newest first.
 *
 * The caller matches the claimed recipient against `counterpartyName`/`counterpartyId` through
 * the canonical identity matcher rather than by substring, so "Michael" in a transcript cannot
 * become an accusation and an ask from Michael cannot be missed because he is stored by address.
 */
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

/**
 * Resolve an obligation id the way a weak model typed it: brackets stripped, any case, with or
 * without the `cmt:` prefix. Carried from the deleted `resolveOpenLoopByPrefix`'s forgiveness
 * (#37/#77 — absorb, do not refuse), minus its ambiguous-prefix branch, which whole-id
 * rendering makes unreachable.
 */
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
