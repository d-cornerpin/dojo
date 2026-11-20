// A GHOSTED FLOOR, recorded as a SYSTEM fault: the platform tells the owner in its own voice
// (`role='system'` + the heads-up prefix, never the agent's words); it adds rows, never rewrites one.

import { v4 as uuidv4 } from 'uuid';
import type { WsEvent } from '@dojo/shared';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { appendWorkEvent } from '../../work/store.js';
import type { SteerFloorId } from './steer-queue.js';

const logger = createLogger('floor-ghost');

/** Steers written before the silence is a fault: two; a floor ignored twice will not obey a third. */
export const MAX_FLOOR_STEER_ATTEMPTS = 2;

// Ghost subjects steered out of band (a sweep, not a turn): no enqueue site, so they cannot join
// the steer-queue floor table, but the ghost subject must come from a closed set, not a free string.
export const OUT_OF_BAND_GHOST_SUBJECTS = [
  'delegated-job-stuck',
  'owner-verdict-unasked',
  // A scheduled run owed the owner a message and closed unheard; one alert per run.
  'run-undelivered',
  // A request the agent could not answer after its bound of tries; told once on the request's record.
  'request-stood-down',
] as const;

export type FloorGhostSubject = SteerFloorId | (typeof OUT_OF_BAND_GHOST_SUBJECTS)[number];

export interface FloorGhostInput {
  agentId: string;
  /** Null when a sweep records the ghost: it has no turn, and a fake 0 would invent one. */
  turnNumber: number | null;
  floor: FloorGhostSubject;
  /** The work row the ghost is about; null (and no event row) rather than a forged id. */
  workId: string | null;
  attempts: number;
  ownerLine: string;
  label?: string;
  detail?: Record<string, unknown>;
}

export interface FloorGhostDeps {
  broadcast: (event: WsEvent) => void;
}

export interface FloorGhostRecord {
  eventId: number | null;
  noticeId: string | null;
}

/** True when the id names a real `work` row: the FK event writes NO row for a stale or forged id. */
function workRowExists(workId: string): boolean {
  try {
    return getDb().prepare('SELECT 1 FROM work WHERE id = ?').get(workId) !== undefined;
  } catch { return false; }
}

/** Records a ghosted floor; returns what it actually wrote, so the caller can log the truth. */
export function recordFloorGhost(input: FloorGhostInput, deps: FloorGhostDeps): FloorGhostRecord {
  const { agentId, turnNumber, floor, workId, attempts, ownerLine } = input;
  let eventId: number | null = null;

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

  // THE PLATFORM'S OWN VOICE. `role='system'` + the owner-alert prefix: the sanctioned way the
  //    platform addresses the owner (allowlist keyed on the shared constant, never retyped). A
  //    written row must also ride the ordinary `chat:message`, like every other owner-lane row. It stays
  //    role='system': delivery is recorded only for assistant rows, so a platform alert never closes an ask.
  let noticeId: string | null = uuidv4();
  const content = input.label ? `${input.label} ${ownerLine}` : `${OWNER_ALERT_HEADS_UP_PREFIX} ${ownerLine}`;
  let persisted: ReturnType<typeof insertMessageIfAbsent> = null;
  try {
    persisted = insertMessageIfAbsent({ id: noticeId, agentId, role: 'system', content, turnNumber });
  } catch (err) {
    noticeId = null;
    logger.warn('floor ghost: the owner-visible system note could not be written (non-fatal)', {
      agentId, floor, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  // Announced only when a row was actually written: a frame for an id with no row is an orphan
  // broadcast (live-only, gone on refresh), the mirror image of the defect being fixed.
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

  try {
    deps.broadcast({
      type: 'chat:error', cardClass: 'informational', agentId,
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
