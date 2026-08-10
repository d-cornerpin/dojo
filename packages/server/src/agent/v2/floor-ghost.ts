// ════════════════════════════════════════════════════════════════════════════════════════
// WHAT HAPPENS WHEN A FLOOR IS IGNORED — PHASE-4 T4 (OR2's last clause).
//
// OR2: *"The engine detects → steers → verifies (via delivery records) → retries bounded. If
// the model still ghosts, that is a SYSTEM fault surfaced as the system (health/watchdog
// voice), never the engine wearing the agent's face."*
//
// Every engine-composed user-facing line this phase deletes ended the same way: the model went
// quiet, and the engine spoke in its place, in the first person, on the owner's chat lane. The
// user could not tell. That is the whole of what OR2 forbids, and this module is what replaces
// it — the honest end of the ladder, in three parts, none of which is the agent's voice:
//
//   1. A ROW.  `work_events(kind='floor_ghosted')` on the work the floor was about. Durable,
//      queryable, and countable AGAINST A DENOMINATOR (how many times the floor fired vs how
//      many times it was ignored), which a log line that rotates could never be.
//   2. THE PLATFORM'S OWN VOICE.  A `role='system'` row carrying the owner-alert prefix — the
//      same allowlisted, plain-language channel the scheduler uses for a failed final run and
//      the approval gate uses for an expiry. It is rendered as a system note, never as an
//      assistant bubble, so nobody can mistake it for the agent.
//   3. THE HEALTH SURFACE.  `chat:error` with `FLOOR_GHOSTED` and a real severity, so the
//      dashboard shows a platform fault where a platform fault happened.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────
// The agent's words. Not a paraphrase of them, not a pool line standing in for them, not the
// reminder text re-read out of the work row. If the model would not say it, the platform says
// *that the model would not say it* — and says so as the platform.
//
// "THE REPLY STANDS" (research 21, caution 2) is untouched: this adds rows, it never removes
// or rewrites one. A ghost is by definition a turn where there was no reply to stand.
// ════════════════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type { WsEvent } from '@dojo/shared';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { appendWorkEvent } from '../../work/store.js';
import type { SteerFloorId } from './steer-queue.js';

const logger = createLogger('floor-ghost');

/** How many steers a floor writes before the silence is recorded as a fault. Two, per the
 *  plan's "bounded re-steer (2 attempts)": one to catch a distracted model, one to catch a
 *  model that read the first and did nothing, and no third because a floor that has been
 *  ignored twice is not going to be obeyed the third time — it is a system fault. */
export const MAX_FLOOR_STEER_ATTEMPTS = 2;

/**
 * GHOST SUBJECTS THAT ARE NOT STEER-QUEUE FLOORS (SWEEP-A TB2).
 *
 * The queue's floors are the ones a TURN enqueues and the assembler injects; its conformance
 * walk asserts every declared floor is used at a `floor: '<id>'` enqueue site, which is a
 * guard worth keeping exactly as it is. A delegated job that has gone quiet is steered from a
 * SWEEP, out of band on the events lane, so it has no enqueue site and does not belong in
 * that table — but the ghost row still has to NAME what ghosted, and that name must come from
 * a closed set rather than a free string. This is that set.
 */
export const OUT_OF_BAND_GHOST_SUBJECTS = [
  'delegated-job-stuck',
  // UX-REPAIR round 2 T12 — the same shape one surface over: the 5-minute validation failsafe
  // steers the PRIMARY to decide whether the owner needs to rule, and a primary that never
  // speaks leaves a pulsing icon on a board and nothing else. Steered from a SWEEP, so no
  // enqueue site, so it belongs here rather than in the steer-queue table.
  'owner-verdict-unasked',
] as const;

/** What a ghost row may be ABOUT: a steer-queue floor, or a declared out-of-band subject. */
export type FloorGhostSubject = SteerFloorId | (typeof OUT_OF_BAND_GHOST_SUBJECTS)[number];

export interface FloorGhostInput {
  agentId: string;
  /** SWEEP-A TB2 widened this to `number | null`: the delegated-job ghost is recorded by a
   *  SWEEP, which has no turn. `null` is the honest answer and both writes below already
   *  accept it (`work_events.payload` is JSON; `messages.turn_number` is nullable). Writing
   *  a `0` to satisfy a type would have put a turn that does not exist on the record. */
  turnNumber: number | null;
  /** The floor — or out-of-band subject — whose steers were ignored. */
  floor: FloorGhostSubject;
  /** The work row the ghost is ABOUT. `null` when the floor genuinely has none, in which case
   *  no event row is written — a forged work id would be worse than a missing row. */
  workId: string | null;
  /** How many steers were written before giving up (the denominator's other half). */
  attempts: number;
  /** ONE plain-language line for the owner, in the PLATFORM's voice. Never the agent's words,
   *  and never a first-person sentence — the platform says what the platform observed. */
  ownerLine: string;
  /** Machine detail for the event payload. */
  detail?: Record<string, unknown>;
}

export interface FloorGhostDeps {
  broadcast: (event: WsEvent) => void;
}

export interface FloorGhostRecord {
  /** The `work_events` rowid, or null when there was no work row to attach it to. */
  eventId: number | null;
  /** The owner-visible system row, or null when the write failed (best-effort, logged). */
  noticeId: string | null;
}

/** True when the id names a real `work` row. The event carries an FK; a floor handing us a
 *  stale or synthetic id must produce NO row rather than take the turn down. */
function workRowExists(workId: string): boolean {
  try {
    return getDb().prepare('SELECT 1 FROM work WHERE id = ?').get(workId) !== undefined;
  } catch { return false; }
}

/**
 * Record a ghosted floor. Returns what it managed to write, so the caller can log the truth
 * rather than assume it.
 */
export function recordFloorGhost(input: FloorGhostInput, deps: FloorGhostDeps): FloorGhostRecord {
  const { agentId, turnNumber, floor, workId, attempts, ownerLine } = input;
  let eventId: number | null = null;

  // 1 — THE ROW.
  if (workId && workRowExists(workId)) {
    try {
      eventId = appendWorkEvent(workId, 'floor_ghosted', 'engine', {
        floor, turn_number: turnNumber, steer_attempts: attempts, ...(input.detail ?? {}),
      });
    } catch (err) {
      logger.warn('floor ghost: the work_events row could not be written (non-fatal)', {
        agentId, workId, floor, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  } else if (workId) {
    logger.warn('floor ghost: no work row for the id the floor handed us; no event written', {
      agentId, workId, floor,
    }, agentId);
  }

  // 2 — THE PLATFORM'S OWN VOICE. `role='system'` + the owner-alert prefix. This is the one
  //     sanctioned way the platform addresses the owner directly, and the dashboard's own
  //     allowlist is keyed on the prefix taken FROM the shared constant, never retyped.
  //
  //     ⚠ AND IT IS ANNOUNCED (SWEEP-A TB4). Battery `bmsgc3l0cnb` tripped
  //     `BROADCAST_EQUALS_ROW` for the first time in that invariant's life on this exact row:
  //     user-visible, written, and never put on the wire, so the owner met a platform fault
  //     only by reloading the page (research 17's D4, "reload-only rows"). The row was never
  //     the problem — the missing half was the announcement, and the health frame below is a
  //     DIFFERENT surface that names no message id and cannot stand in for it.
  //     The announcement rides the ONE path every other owner-lane system row rides — an
  //     ordinary `chat:message` beside the write, exactly as `destructive-gate.ts`'s expiry
  //     notice, `scheduler/runner.ts`'s skipped-reminder heads-up and `a2a-transport.ts`'s
  //     platform-voice join notice do it. No new mechanism: `broadcast()`'s own seam
  //     (`gateway/ws.ts:stampPersistedRow`) then stamps content, `createdAt` and the row
  //     itself off the database, so the frame and the row cannot disagree. The dashboard door
  //     reads `role === 'assistant'` (`v2/outbound.ts:424`) and so records NO delivery for a
  //     system note — a platform alert is not an answer and must never close an ask.
  //     OR2 is untouched: same sentence, same voice, same moment; only the wire is new.
  let noticeId: string | null = uuidv4();
  const content = `${OWNER_ALERT_HEADS_UP_PREFIX} ${ownerLine}`;
  let persisted: ReturnType<typeof insertMessageIfAbsent> = null;
  try {
    persisted = insertMessageIfAbsent({ id: noticeId, agentId, role: 'system', content, turnNumber });
  } catch (err) {
    noticeId = null;
    logger.warn('floor ghost: the owner-visible system note could not be written (non-fatal)', {
      agentId, floor, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  // Announced only when a row was actually written. A frame for an id with no row behind it is
  // the OTHER half of the same defect (an "orphan broadcast": live-only, gone on refresh), and
  // trading one for the other would be no fix at all.
  if (noticeId && persisted) {
    try {
      deps.broadcast({
        type: 'chat:message', agentId,
        message: {
          id: noticeId, agentId, role: 'system', content,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: persisted.createdAt,
        },
      });
    } catch { /* the row is the durable half; a frame that could not go out is not fatal */ }
  }

  // 3 — THE HEALTH SURFACE.
  try {
    deps.broadcast({
      type: 'chat:error', agentId,
      error: ownerLine,
      code: 'FLOOR_GHOSTED',
      severity: 'warning',
      retryable: false,
    });
  } catch { /* the row and the note are the durable halves; a frame is not */ }

  logger.warn('OR2 floor ghosted: the engine steered and the agent stayed silent; recorded as a system fault, not spoken as the agent', {
    agentId, turnNumber, floor, workId, attempts, eventId,
  }, agentId);

  return { eventId, noticeId };
}
