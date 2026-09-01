// ════════════════════════════════════════════════════════════════════════════════
// THE GRIND-VS-TELL LADDER — SWEEP-A TB2 (`DESIGN-2BUGS/DESIGN.md` §2), OR2's own shape.
//
// ── THE THESIS THIS SERVES (owner ruling, 2026-08-05) ──
// The platform exists to make models FINISH long jobs. THE SYSTEM owns the job's convergence:
// a weak model only ever takes one bounded step, and coming back for the next one is the
// engine's work, not the model's memory. A long-job failure is never written off as "model
// limitation" while the system still has drives left.
//
// ── THE LADDER, AND EVERY BOUND IS STATED BESIDE ITS REASON ──
//   rungs 1..N   RE-DRIVE.  The engine wakes the agent and puts the owed step back in front
//                of it WITH the join's own results quoted. This is a REAL DRIVE, not a note
//                filed somewhere: `resolveCompilePendingJoins` re-issues the compile steer
//                and asks the runtime for a wakeup, so the model gets an actual turn.
//   rung  N+1    ENGINE RELAY (UX-REPAIR ROUND 12 T48).  The drives are spent AND every piece
//                came back with content — so the deliverable the owner asked for is already in
//                the platform's hands. Announcing failure while holding the answer is not
//                honesty, it is a lie of omission. The engine ships the pieces VERBATIM under
//                one preface line, through the door D13's one-piece relay already uses, and the
//                ask closes on that delivery. Fires ONLY on that condition; a join still
//                missing a deliverable falls straight through to the rung below, unchanged.
//   rungs N+2..M THE AGENT TELLS THE OWNER.  The drives are spent; the person who asked is
//                owed the truth that the job is stuck. THE AGENT SAYS IT, in its own words —
//                the engine only steers, and VERIFIES via the delivery ledger. Retried to its
//                own bound because one steer can be missed.
//   last rung    PLATFORM TROUBLE.  The agent could not deliver even that: it is fully
//                unresponsive, which is a PLATFORM fault, and the platform's existing
//                watchdog/health surface is what says so. No new voice is built here.
//
// ── WHY THE NUMBERS ARE WHAT THEY ARE ──
// N = 3 is the orchestrator's stated judgment call under the Phase-0 standing authority
// (DESIGN §2), revisable by the owner: at the join sweep's 10-minute cadence three failed
// drives reach him inside roughly half an hour of a genuinely stuck job, and the turn-end
// drain runs the same ladder far faster when the agent is active at all. M = 2 is carried
// from `MAX_FLOOR_STEER_ATTEMPTS` (`agent/v2/floor-ghost.ts`), the platform's existing answer
// to "how many steers before silence is a fault": one to catch a distracted model, one to
// catch a model that read the first and did nothing. It is READ from that module rather than
// restated, so the two cannot drift.
//
// ── WHERE THE STATE LIVES, AND WHY THERE IS NO NEW COLUMN AND NO NEW EVENT KIND ──
// `work_events.kind` carries a CHECK (migration `152`) against the declared list in
// `event-kinds.ts`; a new kind is a table rebuild on every lived-in body, which this task is
// not allowed to spend. The ladder therefore rides `kind='audit'` with its own `entry_kind`
// inside the payload — the landing place migration `152`'s own header names for exactly this:
// *"`kind='audit'` is read in one module and nowhere else — so nothing filed there can answer
// a predicate that decides whether work counts as validated, escalated or poked."* The
// counter is a COUNT over those rows, never a maintained integer: it survives a restart, it
// cannot drift from the events that caused it, and `work.attempts` (the recurrence fire
// count) is left alone for the reason `work-reaper.ts` records at length.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { MAX_FLOOR_STEER_ATTEMPTS } from '../agent/v2/floor-ghost.js';
import { AUDIT_KIND } from './audit-trail.js';
import { appendWorkEvent, type WorkState } from './store.js';
import { setTrackerStatus } from './tracker-store.js';

const logger = createLogger('join-drive');

/** How many REAL DRIVES back to the owed step the system spends before it stops grinding and
 *  starts telling. Orchestrator's judgment call, stated and revisable (DESIGN §2). */
export const JOIN_REDRIVE_BOUND = 3;

/** How many times the "tell the owner it is stuck" steer is retried before the silence is a
 *  platform fault. CARRIED, not chosen: `MAX_FLOOR_STEER_ATTEMPTS`, the platform's existing
 *  bounded-re-steer number, read from its own module so the two copies cannot drift. */
export const STUCK_NOTICE_RETRY_BOUND = MAX_FLOOR_STEER_ATTEMPTS;

/** How many times the engine ships the pieces itself. ONE, and the number is not a judgment
 *  call: the relay is DETERMINISTIC (the same pieces produce the same delivery), so a second
 *  attempt could only ever tell the owner the same thing twice — which is the defect SWEEP-A
 *  TB13 spent a whole task removing. A relay that could not be delivered does not repeat; the
 *  rung is spent and the ladder carries on to the notice, which is the direction that never
 *  errs toward silence. */
export const ENGINE_RELAY_BOUND = 1;

/** The ladder's markers. Free strings inside the `audit` payload — see the header. */
export const JOIN_DRIVE_ENTRY = {
  /** One real drive back to the owed compile, with the join's results in front of the model. */
  redrive: 'join_redrive',
  /** A drive pass that landed on a turn a rung was ALREADY spent on — the model has not had a
   *  turn since the last steer, so this pass is not a chance and does not spend one. Recorded
   *  so the deferral is a fact on the row rather than an absence in the log. */
  redriveDeferred: 'join_redrive_deferred',
  /** T48: the drives were spent with every piece back, so the ENGINE shipped them to the owner
   *  itself rather than announcing a failure it was holding the cure for. */
  engineRelay: 'join_engine_relay',
  /** One steer asking the AGENT to tell the owner the job is stuck. */
  stuckNotice: 'join_stuck_notice',
  /** The agent could not deliver even the notice; the platform surface was handed the fault. */
  ghosted: 'join_drive_ghosted',
} as const;

export type JoinDriveEntry = (typeof JOIN_DRIVE_ENTRY)[keyof typeof JOIN_DRIVE_ENTRY];

export type JoinDriveRung = 'redrive' | 'engine-relay' | 'stuck-notice' | 'platform-trouble';

export interface JoinDriveDecision {
  rung: JoinDriveRung;
  /** 1-based, WITHIN the rung — "this is drive 2 of 3", not "this is step 2 of the ladder". */
  attempt: number;
  /** The bound this rung is spending against, so a log line can state it. */
  bound: number;
  redrives: number;
  stuckNotices: number;
}

/** How many of this marker are on the row. A COUNT over the log, never a stored integer.
 *
 *  UX-REPAIR round 2 T10 note: this stayed a plain COUNT, deliberately. The sibling ladder
 *  (`work/run-deliver-drive.ts:76-92`) counts DISTINCT TURNS because every one of its passes
 *  originates in a turn, so a turn key that never moves means no pass ever happens. This
 *  ladder's second driver is the 10-minute reaper, which fires whether the agent runs turns or
 *  not — so a DISTINCT-turn count here would stall the ladder for exactly the agent it exists
 *  to catch: one that has stopped running turns altogether, whose owner is then never told.
 *  The same discipline is applied one layer up instead, where it cannot stall: a pass that is
 *  not a real chance is RECORDED as `redriveDeferred` rather than `redrive`
 *  (`joinRedriveIsBlind`), so the rung is not spent and the deferral is still visible. */
export function joinDriveCount(workId: string, entryKind: JoinDriveEntry): number {
  try {
    const r = getDb().prepare(
      `SELECT COUNT(*) AS n FROM work_events
        WHERE work_id = ? AND kind = ? AND json_extract(payload, '$.entry_kind') = ?`,
    ).get(workId, AUDIT_KIND, entryKind) as { n: number } | undefined;
    return r?.n ?? 0;
  } catch (err) {
    // A ladder that cannot read its own counter must not spend an unbounded number of drives.
    // Reporting the count as already AT the bound is the safe direction: it escalates rather
    // than grinds, and the owner hears something rather than nothing.
    logger.warn('join drive: the ladder could not read its own counter; treating it as spent', {
      workId, entryKind, error: err instanceof Error ? err.message : String(err),
    });
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Record one rung's spend on the row's own durable history. Returns the event rowid.
 *
 *  `turnNumber` is what the bound is counted in (see `joinDriveCount`) — the turn the agent was
 *  on when the drive was issued. It is written through `appendWorkEvent` rather than
 *  `appendAuditEntry` only because the trail's field set is fixed; every key `appendAuditEntry`
 *  writes is written here byte-identically, so `readAuditTrail` renders these rows unchanged. */
export function recordJoinDrive(
  workId: string, entryKind: JoinDriveEntry,
  detail: { attempt: number; bound: number; note?: string; turnNumber?: number | null },
): number {
  return appendWorkEvent(workId, AUDIT_KIND, 'engine', {
    entry_kind: entryKind,
    from_status: null,
    to_status: null,
    reason: detail.note ?? null,
    action_taken: `${entryKind} ${detail.attempt}/${detail.bound}`,
    note: null,
    evidence_json: null,
    turn_number: detail.turnNumber ?? null,
  });
}

/**
 * IS EVERY PIECE OF THIS JOIN BACK, WITH SOMETHING IN IT? — the T48 rung's whole condition,
 * and it is STRUCTURE.
 *
 * It reads two recorded facts per child: the piece SETTLED `done`, and its recorded result is
 * not empty. It does not read the words. That boundary is the round-11 NOT-DOING list's ban on
 * engine prose-classification, and it is not a compromise here: an outstanding hand-off — the
 * case T48 must fall through on — is structurally visible without reading anything, because
 * T43c re-points the join edge on a DECLARED hand-off, so the piece is not settled at all.
 *
 * A join with no children is not a join whose children are all back; `every` on an empty array
 * is `true`, which would make the emptiest possible join the most eligible one.
 */
export function everyPieceLandedWithContent(
  pieces: ReadonlyArray<{ state: string; content: string | null }>,
): boolean {
  if (pieces.length === 0) return false;
  return pieces.every((p) => p.state === 'done' && (p.content ?? '').trim().length > 0);
}

/**
 * THE ONE LINE THE ENGINE COMPOSES FOR THE T48 RELAY, and the whole of it.
 *
 * Everything after it is the peers' own delivered text, verbatim. Summarising the pieces is
 * the MODEL's job — the job it just declined three times — and an engine summary of content
 * it did not produce is the round-12 NOT-DOING list's own entry. So: one sentence, which says
 * what happened (the results are in, the combining did not) and hands over.
 *
 * The quantifier is the only variable byte, and it varies for one reason: the sentence must be
 * TRUE. "Both" is the measured S5 shape (two delegated research streams) and stands verbatim;
 * past two the same sentence counts. The rung never sees one piece — `resolveCompletedJoin`'s
 * own branch owns that world (D13's relay) and this rung is fenced off it by the same split.
 *
 * Owner-delivery lane: 0 prefix bytes, no engine tag, delivered in the agent's voice through
 * the door the one-piece relay already uses.
 */
export function engineRelayPreface(total: number): string {
  const quantifier = total === 2 ? 'Both' : `All ${total}`;
  return `${quantifier} results are in as delivered by the helpers — I could not get them `
    + `combined, so here they are in full:`;
}

// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 14 / T66 — THE RELAY CLOSES THE MODEL'S OWN SCAFFOLD CARD.
//
// ── THE MEASURED SHAPE (orchestrator-verified, re-verified here row by row) ──
// `ask:64b85330-f08c-49ba-930a-7d2238711015` ("Anniversary dinner outing and at-home backup")
// was claimed by turn 4984, opened a two-piece join, and went `blocked` on the hold. Both
// pieces landed. Three redrives were spent (turns 4985, 4986 — plus one deferred — and 4987),
// then `join_engine_relay 1/1` shipped the pieces and the ask closed `done` on delivery
// `9b15cc2f` with `compile_resolved`. The disarm walk reached the ask, the compile flag, the
// adjudication and the doorbell — and left the model's own card for the same job, task
// `708985b4` "Combine anniversary dinner plan and deliver to David", sitting `blocked` and
// PM-upheld, which by `pm-agent.ts`'s own queue rules is never re-adjudicated and surfaces
// only as a 30-minute `BLOCKED:` notice about work that was finished an hour ago.
//
// ── THE TIE IS STRUCTURAL, AND HERE IS EXACTLY WHICH ONE, BECAUSE MOST OF THEM ARE EMPTY ──
// Read off the live row: `source_message_id` NULL, `origin_conv_key` NULL, `parent_id` NULL,
// `a2a_thread_id` NULL, `conversation_id` NULL, `root_id` = itself. The ONE lineage column
// that carries anything is `origin_turn` = 4985 (with `origin_kind` = `model`).
//
// So the tie is: THE CARD WAS OPENED ON A TURN THIS VERY ASK'S LADDER WAS DRIVING. Those turn
// numbers are on the ask's own ledger — every rung this module records carries `turn_number` —
// which makes the walk one read of the spine the relay is already writing to. Turn 4985 is
// `join_redrive 1/3` for this ask, and 4985 is where the card came from. No title is read; no
// prose is touched.
//
// ⚠ THE DEEPER ROOT, NAMED AND NOT FIXED HERE. The card SHOULD have carried
// `source_message_id` — the real task->ask edge — and does not, because the gap-filler that
// supplies it (`tracker-store.ts` `askSourceMessageForCreatingTurn`) looks for an ask that is
// `state='claimed' AND claimed_by_turn=<turn>`, and an ask held behind a join is `blocked`. So
// every card the model opens while serving a delegated ask is born with no edge to it. Widening
// that predicate changes what EVERY model-created task records and has readers in
// delivery-evidence, task-stamps, the tracker door and the spawner — a blast radius this task
// is not scoped for. It is handed up as its own task, and this comment is where the next reader
// finds it.
//
// HONEST BOUND: a card opened on a turn where no rung fired is NOT reached, deliberately. When
// the relay fires, at least one rung turn exists by construction (the drives are spent), so the
// measured shape is covered; a card born on the join-complete turn before any redrive is not,
// and that is stated rather than guessed at with a wider net.
//
// COLLISIONS, argued: (a) the close goes through `setTrackerStatus` by:'engine' with the
// relay's own delivery as BOTH evidence and receipt — the exact family
// `tracker/tools.ts`'s ASSIGN-deliverable close and the project rollup already use, so Key-1
// and the two-key gate are satisfied the same way and PM validation reads the same receipt;
// (b) it can never touch an ask, a piece or an engine scaffold: `kind='task'`,
// `root_kind='tracker'` and `origin_kind='model'` are all required, so pieces
// (`root_kind='a2a_thread'`) and the >=6 floor's rows (`origin_kind='engine_scaffold'`) are
// out by construction; (c) already-terminal cards are not touched, so a second pass over the
// same relay closes nothing twice; (d) T48's rung accounting is untouched — this spends no
// rung and records no ladder entry, it only reads their turn numbers.
// ════════════════════════════════════════════════════════════════════════════════

/** The turns this row's ladder has been driven on, from the rungs' own records. Distinct, and
 *  nulls dropped: the relay itself records `turn_number: null` (it is not issued from a turn),
 *  which is a real answer and not a turn to match against. */
export function joinDriveTurns(workId: string): number[] {
  try {
    const rows = getDb().prepare(
      `SELECT DISTINCT json_extract(payload, '$.turn_number') AS t FROM work_events
        WHERE work_id = ? AND kind = ? AND json_extract(payload, '$.turn_number') IS NOT NULL`,
    ).all(workId, AUDIT_KIND) as Array<{ t: number | null }>;
    return rows.map((r) => r.t).filter((t): t is number => typeof t === 'number');
  } catch (err) {
    // A read that fails closes NOTHING. Every other direction risks closing a card that is
    // genuinely still owed, which is the one outcome worse than leaving this one open.
    logger.warn('join drive: could not read the turns this ladder drove; no scaffold card is released', {
      workId, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * The relay's disarm walk, extended to the cards the MODEL opened for the job the engine just
 * finished. Returns what it closed, for the caller's log.
 *
 * Called ONLY after a relay that recorded a delivery — the receipt is what makes the close
 * honest and what the two-key gate is satisfied by.
 */
export function releaseScaffoldCardsAfterRelay(input: {
  workId: string; agentId: string; deliveryId: string;
}): Array<{ id: string; from: string; title: string }> {
  const turns = joinDriveTurns(input.workId);
  if (turns.length === 0) return [];
  let candidates: Array<{ id: string; state: string; title: string; origin_turn: number }>;
  try {
    candidates = getDb().prepare(
      `SELECT id, state, title, origin_turn FROM work
        WHERE kind = 'task' AND root_kind = 'tracker' AND origin_kind = 'model'
          AND agent_id = ? AND state NOT IN ('done','failed','abandoned')
          AND origin_turn IN (${turns.map(() => '?').join(',')})
        ORDER BY opened_at ASC`,
    ).all(input.agentId, ...turns) as typeof candidates;
  } catch (err) {
    logger.warn('join drive: could not look for the scaffold cards this relay discharged', {
      workId: input.workId, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  const released: Array<{ id: string; from: string; title: string }> = [];
  for (const card of candidates) {
    const res = setTrackerStatus(card.id, 'complete', {
      by: 'engine', actorId: 'engine',
      expectedState: card.state as WorkState,
      evidenceRef: input.deliveryId, resultDeliveryId: input.deliveryId,
      reason: 'the engine delivered the compiled result of the delegated work this card was '
        + "opened to combine and deliver, so this card's purpose is discharged; the owner's own "
        + 'delivery receipt is its evidence',
    });
    if (res.kind === 'applied') released.push({ id: card.id, from: card.state, title: card.title });
    else {
      // A refusal is a fact, not a retry: the gates that refuse a close are the same ones that
      // protect a card that is genuinely still owed.
      logger.warn('join drive: the relay could not release a scaffold card it had discharged', {
        workId: input.workId, card: card.id, from: card.state, outcome: res,
      });
    }
  }
  return released;
}

/**
 * WHAT THE LADDER DOES NEXT for this row, read entirely from the row's own history.
 *
 * Pure: it decides, it never spends. The caller performs the rung and then records it, so a
 * drive that could not actually be issued does not burn the bound.
 *
 * `everyPieceLanded` is the ONLY fact the decision cannot read off the row's own event log, so
 * it is passed rather than queried — the caller already holds the pieces. It defaults to
 * absent, and the absent case is the pre-T48 ladder EXACTLY: a caller that names nothing
 * cannot reach the relay rung.
 */
export function nextJoinDriveRung(
  workId: string, ctx: { everyPieceLanded?: boolean } = {},
): JoinDriveDecision {
  const redrives = joinDriveCount(workId, JOIN_DRIVE_ENTRY.redrive);
  if (redrives < JOIN_REDRIVE_BOUND) {
    return {
      rung: 'redrive', attempt: redrives + 1, bound: JOIN_REDRIVE_BOUND,
      redrives, stuckNotices: 0,
    };
  }
  // T48. Between the drives and the notice, and only here: the drives are spent and the
  // platform is holding every piece the owner asked for. `joinDriveCount` reports an unreadable
  // counter as ALREADY AT the bound, so a ladder that cannot read its own history falls through
  // to the notice rather than relaying — the same safe direction the rest of this file takes.
  if (ctx.everyPieceLanded === true
      && joinDriveCount(workId, JOIN_DRIVE_ENTRY.engineRelay) < ENGINE_RELAY_BOUND) {
    return {
      rung: 'engine-relay', attempt: 1, bound: ENGINE_RELAY_BOUND,
      redrives, stuckNotices: 0,
    };
  }
  const stuckNotices = joinDriveCount(workId, JOIN_DRIVE_ENTRY.stuckNotice);
  if (stuckNotices < STUCK_NOTICE_RETRY_BOUND) {
    return {
      rung: 'stuck-notice', attempt: stuckNotices + 1, bound: STUCK_NOTICE_RETRY_BOUND,
      redrives, stuckNotices,
    };
  }
  return { rung: 'platform-trouble', attempt: 1, bound: 1, redrives, stuckNotices };
}

/**
 * IS THIS PASS A REAL CHANCE, OR A RE-RUN AGAINST A TURN THAT HAS ALREADY HAD ONE?
 *
 * ── WHAT IT IS FOR (measured, S4 2026-08-10) ──
 * Two drive passes landed either side of one turn boundary with no turn in between: the
 * 10-minute reaper at 06:17:10, with turn 4553 already in flight and its context long since
 * assembled, and the turn-end drain of that SAME turn at 06:18:01. Two of three rungs, 51
 * seconds apart, against a model that had not run once since the first steer. That is the same
 * class `work/run-deliver-drive.ts:76-92` fixed for the run ladder after `bmslqef2w3r`: a rung
 * is meant to be a DRIVE — a separate attempt with a turn in between for the agent to act on
 * the steer — so the unit is the turn.
 *
 * ── AND WHY THE GRACE IS EXACTLY ONE PASS ──
 * The ladder's LAST rung exists for an agent that is not speaking at all, and that agent's turn
 * key never moves. An unbounded "wait for a new turn" would therefore silence the ladder for
 * precisely the case it was built to catch. So a turn gets ONE deferral: the pass that finds a
 * rung already spent here and no deferral yet recorded here. The next pass accepts that the key
 * is not going to move and spends. Worst case the ladder takes one extra pass per rung; the
 * platform rung stays reachable, which the governing priority ("it never errs toward silence")
 * requires. `selfWakeStandDown`'s burn is covered by the same rule — standing the wake down
 * means no turn happens, so the key does not move.
 */
export function joinRedriveIsBlind(workId: string, turnNumber: number | null): boolean {
  if (turnNumber === null) return false;
  try {
    const seen = getDb().prepare(
      `SELECT json_extract(payload, '$.entry_kind') AS entry_kind
         FROM work_events
        WHERE work_id = ? AND kind = ?
          AND json_extract(payload, '$.turn_number') = ?
          AND json_extract(payload, '$.entry_kind') IN (?, ?)`,
    ).all(
      workId, AUDIT_KIND, turnNumber,
      JOIN_DRIVE_ENTRY.redrive, JOIN_DRIVE_ENTRY.redriveDeferred,
    ) as Array<{ entry_kind: string }>;
    const spentHere = seen.some((r) => r.entry_kind === JOIN_DRIVE_ENTRY.redrive);
    const deferredHere = seen.some((r) => r.entry_kind === JOIN_DRIVE_ENTRY.redriveDeferred);
    return spentHere && !deferredHere;
  } catch (err) {
    // Unreadable history: treat the pass as a real one. Spending a rung keeps the ladder MOVING
    // toward telling the owner, which is the safe direction for this failure.
    logger.warn('join drive: could not read the turn the last rung was spent on; treating this pass as a real drive', {
      workId, turnNumber, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * THE COMPILE ORDER, as text. Pure, and exported for the same reason `runDeliverSteerText` is:
 * the wording is incident-derived and belongs beside the ladder that spends it, where a test
 * can read it without driving a turn.
 *
 * ── WHY THE IMPERATIVE COMES FIRST (UX-REPAIR round 2 T10) ──
 * This row reaches the model through the EVENTS & NOTICES lane, which renders each row as a
 * 400-char gist (`memory/lanes.ts:308`, applied at `memory/assembler.ts:1099-1111`). The
 * original wording put "Compose ONE reply to the owner now" AFTER two piece quotes capped at
 * 1,200 chars each — i.e. past the cut, every time. Measured on S4 (2026-08-10): the model
 * quoted only the opening sentence back in its own reasoning and went to `history_get` for the
 * rest. Order first, quotes after: the cap is untouched (#14 / O15's refusal stands) and the
 * order survives it.
 *
 * ── WHAT IS CARRIED UNCHANGED ──
 * Every clause below is incident-derived and stays: the pieces are quoted VERBATIM because the
 * separate-lane architecture keeps A2A deliverables out of the chat store, so "read the
 * messages above" pointed at content the model could not reach (run bmrpxzuhxvh: four empty
 * history_search calls and no compile); tools are FORBIDDEN because an earlier wording that
 * said "verify each piece's ACTUAL content" made the floor model exec a blocked loop and spin
 * 45 tool calls (run bmrplgdg33l).
 *
 * ── UX-REPAIR ROUND 11 T43b — "ARE THESE ACTUALLY THE DELIVERABLES?" ──
 * Round-11 S5-A: kelly (the PM, no web tools) could not do her research stream, so she sent a
 * HAND-OFF note naming kevin. A non-empty, non-FAIL terminal reply settles a piece, so the
 * join completed with ONE research stream in hand and this steer told the model the pieces
 * were back. ~6m20s from "pieces back" to answer, recovered only because the model improvised:
 * it asked kevin directly and a redrive caught the result. The paragraph added below makes
 * that improvised rescue the INSTRUCTED path.
 *
 * THE MODEL JUDGES DELIVERABLE-NESS. That is deliberate and it is the only allowed shape: the
 * engine may count structure and may not classify reply prose (the round-11 NOT-DOING list
 * names engine punt-detection as a banned class). And the verb fix — "only COMPLETE settles a
 * piece" — was killed by measurement, not taste: `a2a_replies` intents are ANSWER 341 /
 * DELIVERABLE 262 / COMPLETE 42 / FAIL 2, so that rule would break the dominant working flow.
 *
 * THE NO-TOOLS SENTENCE IS UNTOUCHED. The new paragraph names ITSELF as the single exception
 * and bounds it to one `send_to_agent` in one situation, so bmrplgdg33l's lookup spiral has no
 * reading under which it is licensed again.
 *
 * `attempt` null = the steer issued at join completion, before any rung has been spent.
 */
/**
 * THE HEADER THE PIECES SIT UNDER — one constant, because two modules now depend on it.
 *
 * T68b: the compile gate's refusal used to ASSERT "the pieces are in the steer, quoted
 * verbatim" without ever reading the assembled context, and in all six recorded grinds the
 * sentence was FALSE — the assembler had cut the order at 400 chars, before this line. The
 * gate verifies before it says it now (`memory/assembler.ts`, `compileOrderIntact`), and this
 * is what it looks for: the boundary between the ORDER and the PAYLOAD. A row that carries
 * this string is a compile order rather than one of the ladder's other `fanout_join` rungs,
 * and a row whose bytes survive INTO the emitted messages carried its pieces with it.
 *
 * It is a constant rather than a literal in the checker for the one reason that matters: the
 * writer and the reader of a fingerprint must be the same string, or the check silently stops
 * checking the day someone rewords the steer. `__tests__/the-compile-steer-checks-the-pieces`
 * pins that this text still appears in the generated steer.
 */
export const COMPILE_ORDER_PIECES_MARKER = "Here is each piece's delivered content, verbatim:";

export function compileSteerText(p: {
  total: number; pieces: string[]; attempt: number | null; bound: number;
}): string {
  const attemptLine = p.attempt === null
    ? ''
    : ` (steer ${p.attempt} of ${p.bound}; after that the platform asks you to tell the owner `
      + `the job is stuck, and then reports it as a platform fault.)`;
  return (
    `All ${p.total} delegated pieces for the owner's request are now back. `
    + `The owner has NOT been answered yet.\n\n`
    + `Compose ONE reply to the owner now that carries each piece's content exactly as delivered `
    + `below (quote the key results, e.g. any codes or figures, character for character; do not `
    + `summarize them away, and do not trust a tracker row that says "complete" over the delivered `
    + `text itself). Do NOT search, open files, run commands, or call any tools first — not the `
    + `tracker, not the vault, not a peer notification; everything you need is quoted below. `
    + `If a piece reads as a failure, say so honestly in the same reply.${attemptLine}\n\n`
    + `First, check each piece below: is it the deliverable that stream was asked for, or is `
    + `it a hand-off ("I passed this to X", "X is doing it") with no result in it? A hand-off `
    + `means that deliverable is NOT back. In that case, and only in that case, send ONE `
    + `send_to_agent message to the agent it names asking them for the result directly — the `
    + `single exception to the no-tools rule above — and compile after it arrives. Do not `
    + `present a hand-off note to the owner as if it were the answer.\n\n`
    + `${COMPILE_ORDER_PIECES_MARKER}\n\n`
    + p.pieces.join('\n')
  );
}
