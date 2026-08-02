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

export interface FloorGhostInput {
  agentId: string;
  turnNumber: number;
  /** The floor whose steers were ignored. */
  floor: SteerFloorId;
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
  let noticeId: string | null = uuidv4();
  try {
    insertMessageIfAbsent({
      id: noticeId, agentId, role: 'system',
      content: `${OWNER_ALERT_HEADS_UP_PREFIX} ${ownerLine}`,
      turnNumber,
    });
  } catch (err) {
    noticeId = null;
    logger.warn('floor ghost: the owner-visible system note could not be written (non-fatal)', {
      agentId, floor, error: err instanceof Error ? err.message : String(err),
    }, agentId);
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
