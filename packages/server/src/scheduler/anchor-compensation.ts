// Compensated-anchor scan. Rows written while the tracker doors dropped `anchor_time` may hold the intended
// LOCAL wall-clock digits stored as UTC; once the door honours the anchor they fire an offset the other way.
// The scan only SURFACES suspects (both readings plus the one-call correction): a stored instant carries no
// record of intent, so a rewrite could move a real alert by hours.
// Every scheduled row is EXAMINED; a SUSPECT passes all four clauses and a row failing one is counted
// against it, so the stand-down counts plus the suspects sum to the number examined:
//   1. it can still fire: a future `next_run_at`, not terminal, not paused
//   2. it has a readable anchor: `anchor_local ?? scheduled_start` parses
//   3. written in window: `updated_at` in [COMPENSATION_WINDOW_OPENED_AT, first boot with the door fix)
//   4. the box is not on UTC: at offset 0 the compensating transform is the identity
import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { createLogger } from '../logger.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { instantToWall, wallToInstant, getBoxTimeZone, normalizeDbTimestamp } from './engine.js';

const logger = createLogger('anchor-compensation');

export const COMPENSATION_WINDOW_OPENED_AT = '2026-08-03T00:00:00Z';

/** Config key set on the first boot of a build carrying the door fix; it closes the window. */
export const FIX_FIRST_BOOT_KEY = 'anchor_door_fix_first_boot_at';

/** Config key for the scan's durable result (logs rotate, so the record lives in config). */
export const SCAN_RECORD_KEY = 'anchor_compensation_scan';

const TERMINAL_STATES = new Set(['done', 'failed', 'abandoned']);

export type StandDownReason =
  | 'cannot-fire'
  | 'no-readable-anchor'
  | 'written-outside-window'
  | 'box-is-utc';

export interface ScheduledRow {
  id: string;
  title: string | null;
  anchor_local: string | null;
  scheduled_start: number | null;
  next_run_at: number | null;
  updated_at: number | null;
  state: string | null;
  is_paused: number | null;
  repeat_interval: number | null;
  repeat_unit: string | null;
}

export interface Suspect {
  id: string;
  title: string;
  storedAnchor: string;
  intendedIfCompensated: string;
  shiftMinutes: number;
  correction: string;
}

export interface ScanResult {
  examined: number;
  suspects: Suspect[];
  /** Why each non-suspect row stood down; these sum to `examined - suspects.length`. */
  standDown: Record<StandDownReason, number>;
  boxTimeZone: string;
  windowOpenedAt: string;
  windowClosedAt: string | null;
  scannedAt: string;
}

function cfg(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** The two readings of one stored anchor: as stored, and as its UTC digits read in the box zone. */
export function readingsOf(anchorIso: string, timeZone: string): { stored: number; intended: number } | null {
  const stored = new Date(normalizeDbTimestamp(anchorIso)).getTime();
  if (Number.isNaN(stored)) return null;
  const digits = instantToWall(stored, 'UTC');
  return { stored, intended: wallToInstant(digits, timeZone).getTime() };
}

export function scheduledRows(): ScheduledRow[] {
  return getDb().prepare(`
    SELECT id, title, anchor_local, scheduled_start, next_run_at, updated_at,
           state, is_paused, repeat_interval, repeat_unit
      FROM work
     WHERE anchor_local IS NOT NULL OR scheduled_start IS NOT NULL
  `).all() as ScheduledRow[];
}

export interface ScanOptions {
  rows?: ScheduledRow[];
  timeZone?: string;
  now?: number;
  windowOpenedAtMs?: number;
  /** null = the window is still open (this build's first boot has not been recorded yet). */
  windowClosedAtMs?: number | null;
}

/** Classify every scheduled row. Pure with respect to its inputs (rows, zone, window, clock). */
export function scanForCompensatedAnchors(opts: ScanOptions = {}): ScanResult {
  const timeZone = opts.timeZone ?? getBoxTimeZone();
  const now = opts.now ?? Date.now();
  const rows = opts.rows ?? scheduledRows();
  const openedAt = opts.windowOpenedAtMs ?? Date.parse(COMPENSATION_WINDOW_OPENED_AT);
  const closedAtMs = opts.windowClosedAtMs === undefined
    ? (cfg(FIX_FIRST_BOOT_KEY) ? Date.parse(cfg(FIX_FIRST_BOOT_KEY)!) : null)
    : opts.windowClosedAtMs;
  const closeBound = closedAtMs ?? now;

  const standDown: Record<StandDownReason, number> = {
    'cannot-fire': 0, 'no-readable-anchor': 0, 'written-outside-window': 0, 'box-is-utc': 0,
  };
  const suspects: Suspect[] = [];

  for (const row of rows) {
    const live =
      row.next_run_at !== null && row.next_run_at > now
      && !TERMINAL_STATES.has(String(row.state ?? ''))
      && (row.is_paused ?? 0) === 0;
    if (!live) { standDown['cannot-fire']++; continue; }

    // The effective anchor (`anchor_time ?? scheduled_start`) matters, never the column holding it.
    const effective = row.anchor_local ?? (row.scheduled_start !== null ? new Date(row.scheduled_start).toISOString() : null);
    const readings = effective ? readingsOf(effective, timeZone) : null;
    if (!readings) { standDown['no-readable-anchor']++; continue; }

    const writtenAt = row.updated_at ?? 0;
    if (writtenAt < openedAt || writtenAt >= closeBound) { standDown['written-outside-window']++; continue; }

    const shiftMinutes = Math.round((readings.intended - readings.stored) / 60_000);
    if (shiftMinutes === 0) { standDown['box-is-utc']++; continue; }

    suspects.push({
      id: row.id,
      title: row.title ?? '(untitled)',
      storedAnchor: new Date(readings.stored).toISOString(),
      intendedIfCompensated: new Date(readings.intended).toISOString(),
      shiftMinutes,
      correction:
        `work_update(action="edit", task_id="${row.id}", anchor_time="${new Date(readings.intended).toISOString()}")`,
    });
  }

  return {
    examined: rows.length,
    suspects,
    standDown,
    boxTimeZone: timeZone,
    windowOpenedAt: new Date(openedAt).toISOString(),
    windowClosedAt: closedAtMs === null ? null : new Date(closedAtMs).toISOString(),
    scannedAt: new Date(now).toISOString(),
  };
}

export function describeSuspects(result: ScanResult): string {
  const lines = result.suspects.map(
    (s) => `- "${s.title}" (${s.id.slice(0, 8)}): set to fire at ${s.storedAnchor}; `
      + `if that time was meant as ${result.boxTimeZone} local it should be `
      + `${s.intendedIfCompensated} (${s.shiftMinutes > 0 ? '+' : ''}${s.shiftMinutes} min).`,
  );
  return (
    `${result.suspects.length} recurring item(s) of ${result.examined} scheduled item(s) examined may carry a `
    + `timezone workaround entered while a scheduling bug was live (between ${result.windowOpenedAt} and this update). `
    + `The bug is fixed, so a workaround that was correct before is now wrong by the same amount:\n`
    + lines.join('\n')
    + `\nAsk the owner what local time each should fire, then set it with `
    + `work_update(action="edit", task_id=…, anchor_time=…). Do not change anything he does not confirm.`
  );
}

/**
 * Report suspects to the primary agent on the events lane so the agent raises them with the owner in
 * its own words (the engine detects, the agent speaks). `selfIntro` is off: this is platform
 * maintenance, and there is no scheduler agent to introduce.
 */
function reportToPrimary(brief: string): void {
  const primaryId = getPrimaryAgentId();
  if (!primaryId) return;
  postAgentNotice({ toAgentId: primaryId, fromName: 'scheduler', brief, selfIntro: false });
}

/**
 * The boot pass, idempotent and one-shot: records the first boot of a build carrying the fix (which closes
 * the window), runs the scan once, writes its result to `config`, and never nags again. Returns the
 * result it recorded, or null when it had already run.
 */
export function runAnchorCompensationPass(
  notify: (brief: string) => void = reportToPrimary,
): ScanResult | null {
  try {
    const already = cfg(SCAN_RECORD_KEY);
    const firstBoot = cfg(FIX_FIRST_BOOT_KEY);
    const nowIso = new Date().toISOString();

    // The window closes at the first boot of a build carrying the fix: the marker is absent then (the bound
    // is now) and recorded afterwards, which keeps the set stable.
    if (!firstBoot) setConfigValue(FIX_FIRST_BOOT_KEY, nowIso);
    if (already) return null;

    const result = scanForCompensatedAnchors({
      windowClosedAtMs: firstBoot ? Date.parse(firstBoot) : Date.now(),
    });
    logger.info('compensated-anchor scan complete', {
      examined: result.examined,
      suspects: result.suspects.length,
      standDown: result.standDown,
      boxTimeZone: result.boxTimeZone,
      window: `${result.windowOpenedAt} .. ${result.windowClosedAt ?? nowIso}`,
    });

    if (result.suspects.length > 0) {
      logger.warn('compensated-anchor suspects found — reported, NOT rewritten', {
        suspects: result.suspects,
      });
      // The record is saved only after the notice has gone out: a failed send
      // throws to the catch below, leaves the scan open, and the next boot retries.
      notify(describeSuspects(result));
    }
    setConfigValue(SCAN_RECORD_KEY, JSON.stringify(result));
    return result;
  } catch (err) {
    // A maintenance scan never fails a boot.
    logger.warn('compensated-anchor scan failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
