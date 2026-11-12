// THE GRIND-VS-TELL LADDER for a stuck join: re-drive the agent with the join's results quoted, then the engine
// relays the pieces verbatim (only when every piece came back with content), then the agent tells the owner, then
// platform trouble. State rides `kind='audit'` rows (`entry_kind` in the payload), never a new kind (a CHECK
// rebuild) or a stored integer: a COUNT over the rows survives restarts and cannot drift.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { MAX_FLOOR_STEER_ATTEMPTS } from '../agent/v2/floor-ghost.js';
import { AUDIT_KIND } from './audit-trail.js';
import { appendWorkEvent } from './store.js';

const logger = createLogger('join-drive');

/** Real drives back to the owed step before the system stops grinding and starts telling. */
export const JOIN_REDRIVE_BOUND = 3;

/** Retries of the tell-the-owner steer; read from `MAX_FLOOR_STEER_ATTEMPTS` so the two numbers cannot drift. */
export const STUCK_NOTICE_RETRY_BOUND = MAX_FLOOR_STEER_ATTEMPTS;

/** ONE relay: it is deterministic, so a second attempt could only tell the owner the same thing twice. */
export const ENGINE_RELAY_BOUND = 1;

export const JOIN_DRIVE_ENTRY = {
  redrive: 'join_redrive',
  /** A pass that landed on a turn a rung was already spent on is not a chance, so it spends none. */
  redriveDeferred: 'join_redrive_deferred',
  engineRelay: 'join_engine_relay',
  stuckNotice: 'join_stuck_notice',
  ghosted: 'join_drive_ghosted',
} as const;

export type JoinDriveEntry = (typeof JOIN_DRIVE_ENTRY)[keyof typeof JOIN_DRIVE_ENTRY];

export type JoinDriveRung = 'redrive' | 'engine-relay' | 'stuck-notice' | 'platform-trouble';

export interface JoinDriveDecision {
  rung: JoinDriveRung;
  attempt: number;
  bound: number;
  redrives: number;
  stuckNotices: number;
}

/** How many of this marker are on the row: a plain COUNT, never DISTINCT turns, because the 10-minute reaper
 *  drives this ladder whether or not the agent runs turns, and a turn-keyed count would stall for that agent. */
export function joinDriveCount(workId: string, entryKind: JoinDriveEntry): number {
  try {
    const r = getDb().prepare(
      `SELECT COUNT(*) AS n FROM work_events
        WHERE work_id = ? AND kind = ? AND json_extract(payload, '$.entry_kind') = ?`,
    ).get(workId, AUDIT_KIND, entryKind) as { n: number } | undefined;
    return r?.n ?? 0;
  } catch (err) {
    // An unreadable counter reads as AT the bound, so the ladder escalates instead of grinding unbounded.
    logger.warn('join drive: the ladder could not read its own counter; treating it as spent', {
      workId, entryKind, error: err instanceof Error ? err.message : String(err),
    });
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Record one rung's spend in `appendAuditEntry`'s keys, so `readAuditTrail` renders the rows unchanged. */
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

/** Every piece settled `done` with non-empty result? Structure, never the words; an empty join is false. */
export function everyPieceLandedWithContent(
  pieces: ReadonlyArray<{ state: string; content: string | null }>,
): boolean {
  if (pieces.length === 0) return false;
  return pieces.every((p) => p.state === 'done' && (p.content ?? '').trim().length > 0);
}

/** The one line the engine composes for the relay; the peers' delivered text follows verbatim, since summarising
 *  is the model's job. The quantifier varies only so the sentence stays TRUE (the rung never sees one piece). */
export function engineRelayPreface(total: number): string {
  const quantifier = total === 2 ? 'Both' : `All ${total}`;
  return `${quantifier} results are in as the helpers delivered them; they were `
    + `not combined, so here they are in full:`;
}

// The relay also hands in the model's own card (model-opened tracker task, `origin_turn` among the ladder's turns).

/** The turns this ladder was driven on, nulls dropped (the relay records `turn_number: null`). */
export function joinDriveTurns(workId: string): number[] {
  try {
    const rows = getDb().prepare(
      `SELECT DISTINCT json_extract(payload, '$.turn_number') AS t FROM work_events
        WHERE work_id = ? AND kind = ? AND json_extract(payload, '$.turn_number') IS NOT NULL`,
    ).all(workId, AUDIT_KIND) as Array<{ t: number | null }>;
    return rows.map((r) => r.t).filter((t): t is number => typeof t === 'number');
  } catch (err) {
    // A read that fails closes NOTHING: closing a card that is still owed is worse than leaving one open.
    logger.warn('join drive: could not read the turns this ladder drove; no scaffold card is released', {
      workId, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function scaffoldCardsOfRelay(workId: string, agentId: string): Array<{ id: string; state: string; title: string }> {
  const turns = joinDriveTurns(workId);
  if (turns.length === 0) return [];
  return getDb().prepare(
    `SELECT id, state, title FROM work
      WHERE kind = 'task' AND root_kind = 'tracker' AND origin_kind = 'model'
        AND agent_id = ? AND ${workingExpr('work', true)}
        AND origin_turn IN (${turns.map(() => '?').join(',')})
      ORDER BY opened_at ASC`,
  ).all(agentId, ...turns) as Array<{ id: string; state: string; title: string }>;
}

/** WHAT THE LADDER DOES NEXT, from the row's history; pure, never spends. An unreadable counter falls to the
 *  notice, not the relay. `everyPieceLanded` is passed in since the log cannot say it (absent: no relay). */
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

/** IS THIS PASS A REAL CHANCE? A rung is a DRIVE with a turn between it and the next, so a pass that finds a rung
 *  already spent on this turn and no deferral recorded defers. The grace is exactly ONE pass: the last rung exists
 *  for an agent that speaks no more, whose turn never moves, so an unbounded wait would silence it. */
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
    // Unreadable history counts as a real pass: spending the rung moves the ladder toward telling the owner.
    logger.warn('join drive: could not read the turn the last rung was spent on; treating this pass as a real drive', {
      workId, turnNumber, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** The boundary between the compile ORDER and the PAYLOAD: `memory/assembler.ts` looks for this exact string in the
 *  assembled context, so the steer and that check must share the one constant. */
export const COMPILE_ORDER_PIECES_MARKER = "Here is each piece's delivered content, verbatim:";

import type { CompileAsker } from './compile-asker.js';
import { workingExpr } from './terminal-states.js';

// THE COMPILE ORDER, as text. The imperative leads since the events lane cuts each row to a 400-char gist
// (`memory/lanes.ts`); pieces go VERBATIM since A2A deliverables stay out of the chat store; the model
// judges hand-offs, as the engine counts structure but never classifies reply prose. Tools stay forbidden
// (one send_to_agent for a hand-off excepted): asking the model to verify pieces loops it on blocked calls.
export function compileSteerText(p: {
  total: number; pieces: string[]; attempt: number | null; bound: number;
  asker?: CompileAsker | null;
}): string {
  // The relay delivers to the ASK's own sender, so the steer names that person and channel, not always the owner.
  const who = p.asker ? `${p.asker.name}${p.asker.channel ? ` (by ${p.asker.channel})` : ''}` : 'the owner';
  const Who = p.asker ? who : 'The owner';
  const attemptLine = p.attempt === null
    ? ''
    : ` (steer ${p.attempt} of ${p.bound}; after that the platform asks you to tell ${who} `
      + `the job is stuck, and then reports it as a platform fault.)`;
  return (
    `All ${p.total} delegated pieces for ${p.asker ? `${p.asker.name}'s` : "the owner's"} request are now back. `
    + `${Who} has NOT been answered yet.\n\n`
    + `Compose ONE reply to ${who} now that carries each piece's content exactly as delivered `
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
    + `present a hand-off note to ${who} as if it were the answer.\n\n`
    + `${COMPILE_ORDER_PIECES_MARKER}\n\n`
    + p.pieces.join('\n')
  );
}
