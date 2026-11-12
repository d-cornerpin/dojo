// The fresh tail's horizon: where the live conversation starts. Prefix caching is positional, so every
// front-trim re-prefills the whole conversation: the tail grows from the compaction boundary (the newest row
// a summary covers; compaction only summarises rows outside the newest `getFreshTailCount`, so the cap is
// a floor) and is reduced only there. The read is bounded by tokens (`coverTokens`), not a row ceiling.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { CHARS_PER_TOKEN, type ContextWindowPolicy } from './budget.js';

const logger = createLogger('memory-tail-horizon');

/** The trim quantum in groups: the trim is stateless, so only block-multiple drops keep the front still.
 *  Half a row cap (floor 8), so the half-the-tail bound in `groupsToDropForBudget` can drop one block. */
export function tailTrimBlockGroups(freshTailCount: number): number {
  return Math.max(8, Math.ceil(Math.max(0, freshTailCount) / 2));
}

export interface TailHorizon {
  anchorSeq: number;
  rowsSinceBoundary: number;
  /** Keep rows with `seq >= this`; 0 means apply no front filter (the floor case). */
  keepFromSeq: number;
  requestRows: number;
  /** Rows past the boundary left unread because newer rows cover the budget; set aside and owed a fold. */
  unreadRows: number;
}

interface BoundaryRow { anchor: number; rows_since: number }

/** One read, both numbers, under the same session-boundary filter as the tail reader (`store.ts`). */
function readBoundary(agentId: string): BoundaryRow {
  const row = getDb().prepare(`
    WITH b AS (SELECT session_started_at AS st FROM agents WHERE id = @agentId),
         a AS (SELECT COALESCE(MAX(m.seq), 0) AS anchor
                 FROM messages m
                 JOIN summary_messages sm ON sm.message_id = m.id
                WHERE m.agent_id = @agentId)
    SELECT (SELECT anchor FROM a) AS anchor,
           (SELECT COUNT(*) FROM messages m, b
             WHERE m.agent_id = @agentId
               AND m.seq > (SELECT anchor FROM a)
               AND (b.st IS NULL OR m.created_at >= unixepoch(b.st) * 1000)) AS rows_since
  `).get({ agentId }) as BoundaryRow | undefined;
  return { anchor: row?.anchor ?? 0, rows_since: row?.rows_since ?? 0 };
}

function newestRowsCovering(agentId: string, anchor: number, coverTokens: number): number | null {
  const rows = getDb().prepare(`
    SELECT COALESCE(NULLIF(m.token_count, 0), (LENGTH(m.content) + @cpt - 1) / @cpt) AS cost
      FROM messages m
      LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.agent_id = @agentId
       AND m.seq > @anchor
       AND (a.session_started_at IS NULL OR m.created_at >= unixepoch(a.session_started_at) * 1000)
     ORDER BY m.seq DESC
  `).iterate({ agentId, anchor, cpt: CHARS_PER_TOKEN }) as IterableIterator<{ cost: number }>;
  let sum = 0;
  let read = 0;
  for (const r of rows) {
    sum += r.cost;
    read++;
    if (sum >= coverTokens) return read;
  }
  return null;
}

function rowAfterSkip(agentId: string, anchor: number, skip: number): { seq: number; role: string } | null {
  return (getDb().prepare(`
    SELECT m.seq AS seq, m.role AS role
      FROM messages m
      LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.agent_id = @agentId
       AND m.seq > @anchor
       AND (a.session_started_at IS NULL OR m.created_at >= unixepoch(a.session_started_at) * 1000)
     ORDER BY m.seq ASC
     LIMIT 1 OFFSET @skip
  `).get({ agentId, anchor, skip }) as { seq: number; role: string } | undefined) ?? null;
}

/** Where the live conversation starts this turn, from the boundary and window policy only; a failure
 *  returns the floor answer (the row cap, no front filter). */
export function freshTailHorizon(agentId: string, policy: ContextWindowPolicy, coverTokens?: number): TailHorizon {
  const cap = Math.max(1, policy.freshTailCount);
  const floorAnswer: TailHorizon = {
    anchorSeq: 0, rowsSinceBoundary: 0, keepFromSeq: 0,
    requestRows: cap, unreadRows: 0,
  };

  let boundary: BoundaryRow;
  try {
    boundary = readBoundary(agentId);
  } catch (err) {
    logger.warn('fresh-tail horizon: boundary read failed, falling back to the row cap', {
      error: err instanceof Error ? err.message : String(err), freshTailCount: cap,
    }, agentId);
    return floorAnswer;
  }

  // The floor: the newest `cap` rows, no filter. Below the cap they include summarised rows and each append
  // pushes one off the front, so it applies only when `anchor === 0` (no boundary) or `rows_since === 0`
  // (a filter would empty the tail); both halves are load-bearing.
  if (boundary.rows_since <= cap
      && (boundary.anchor === 0 || boundary.rows_since === 0)) {
    return { ...floorAnswer, anchorSeq: boundary.anchor, rowsSinceBoundary: boundary.rows_since };
  }

  const grow: TailHorizon = {
    anchorSeq: boundary.anchor,
    rowsSinceBoundary: boundary.rows_since,
    keepFromSeq: boundary.anchor + 1,
    requestRows: boundary.rows_since,
    unreadRows: 0,
  };
  if (coverTokens === undefined || boundary.rows_since <= cap) return grow;

  // The read is bounded by tokens: walk newest-first until the rows cover the budget; older rows are unread.
  // The unread count rounds DOWN to whole trim blocks so the front moves once per block, not per row.
  let read = boundary.rows_since;
  try {
    read = newestRowsCovering(agentId, boundary.anchor, coverTokens) ?? read;
  } catch (err) {
    logger.warn('fresh-tail horizon: the bounded read failed, reading the whole span', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  const block = Math.max(1, tailTrimBlockGroups(cap));
  let unread = Math.floor((boundary.rows_since - read) / block) * block;
  let keepFromSeq = 0;
  // The front must not land on a tool result: back up to the row that made the call.
  while (unread > 0) {
    try {
      const at = rowAfterSkip(agentId, boundary.anchor, unread);
      if (!at) { unread = 0; break; }
      if (at.role !== 'tool') { keepFromSeq = at.seq; break; }
    } catch (err) {
      logger.warn('fresh-tail horizon: the front read failed, reading the whole span', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
      unread = 0;
      break;
    }
    unread--;
  }
  if (unread <= 0 || keepFromSeq <= 0) return grow;
  logger.info('fresh-tail horizon: the newest rows already cover the budget; older rows past the boundary are not read', {
    rowsSinceBoundary: boundary.rows_since, rowsRead: boundary.rows_since - unread, rowsUnread: unread, coverTokens,
  }, agentId);
  return { ...grow, keepFromSeq, requestRows: boundary.rows_since - unread, unreadRows: unread };
}

/** The most a token trim may take off the front: half the units, rounded DOWN to blocks, so it moves only
 *  when the count crosses a multiple of 2 x block. The trim and the view gauge (`assembler.ts`) share it. */
export function maxTrimUnits(units: number, blockUnits: number): number {
  const block = Math.max(1, Math.floor(blockUnits));
  return Math.floor(Math.floor(Math.max(0, units) / 2) / block) * block;
}

/** Whole groups a token trim drops off the front: 0 when all fits, else `maxDrop`, the largest legal block
 *  multiple (the minimum that fits would move the front every turn). */
export function groupsToDropForBudget(
  groupTokens: readonly number[],
  availableTokens: number,
  blockGroups: number,
): number {
  const n = groupTokens.length;
  if (n === 0) return 0;

  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + groupTokens[i];
  if (suffix[0] <= availableTokens) return 0;

  const block = Math.max(1, Math.floor(blockGroups));
  // Never more than half the tail in one pass, only at block boundaries, so a legal drop always exists.
  const maxDrop = maxTrimUnits(n, block);
  // Cut the whole bound, not the smallest fit: the front then moves once per 2 x block appended groups.
  for (let drop = block; drop <= maxDrop; drop += block) {
    if (suffix[drop] <= availableTokens) return maxDrop;
  }

  // No legal block multiple fits: fit is non-negotiable, so drop the minimum that fits (the caller warns).
  let drop = maxDrop;
  while (drop < n - 1 && suffix[drop] > availableTokens) drop++;
  return drop;
}

// Which rows are about to leave the live view (the condense trigger's one question): 'full' (the gauge found
// the trim cutting within one block of growth) or 'out-of-view' (rows already taken out of view, owed their
// fold). Compaction folds every unsummarised row with `seq <= throughSeq`, stranded ones too.

export type LeavingCause = 'full' | 'out-of-view';

export interface LeavingView {
  cause: LeavingCause;
  throughSeq: number;
  rowsLeaving: number;
}

/** The rows about to leave this agent's live view, or null: the gauge's answer (`leavingFromView`). */
export function rowsLeavingView(opts: { full?: { throughSeq: number; rows: number } | null }): LeavingView | null {
  return opts.full && opts.full.throughSeq > 0 ? { cause: 'full', throughSeq: opts.full.throughSeq, rowsLeaving: opts.full.rows } : null;
}

// The boundary stays the one MAX(seq) anchor, right only while every session row at or below it is covered.
// A refused chunk can sit below another conversation's landed one, so the fold covers stranded rows too.

export function rowsStrandedBelowBoundary(agentId: string, fromSeq: number): { anchor: number; stranded: number } {
  try {
    const anchor = readBoundary(agentId).anchor;
    if (anchor <= 0 || anchor < fromSeq) return { anchor, stranded: 0 };
    const row = getDb().prepare(`
      SELECT COUNT(*) AS n FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
       WHERE m.agent_id = @agentId AND m.seq >= @fromSeq AND m.seq <= @anchor
         AND (a.session_started_at IS NULL OR m.created_at >= unixepoch(a.session_started_at) * 1000)
         AND NOT EXISTS (SELECT 1 FROM summary_messages sm WHERE sm.message_id = m.id)
    `).get({ agentId, fromSeq, anchor }) as { n: number } | undefined;
    return { anchor, stranded: row?.n ?? 0 };
  } catch {
    return { anchor: 0, stranded: 0 };
  }
}
