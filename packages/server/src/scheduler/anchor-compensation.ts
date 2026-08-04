// ════════════════════════════════════════════════════════════════════════════
// THE COMPENSATED-ANCHOR SCAN — PHASE-6 T0A Step 4.
//
// ── WHY THIS EXISTS, AND WHAT IT IS PROTECTING ──────────────────────────────
// Between 2026-08-03 and the build that carries T0A's door fix, `anchor_time`
// was DROPPED at both agent-facing tracker doors and the only way to move a
// recurring task's firing time was to move `scheduled_start`. On the box that
// reported the defect the next-run computation ALSO ran a whole-offset shift, so
// the relief that was deployed there was a COMPENSATION: the intended LOCAL
// wall-clock digits were stored as if they were UTC, and the shift cancelled
// them back to the right instant. The issues-log entry of 2026-08-03 and its
// 2026-08-04 follow-up are the record.
//
// A compensation is only correct while the thing it compensates for is still
// there. The moment a box updates onto a build that honours the anchor as
// written, those rows fire an offset the OTHER way — silently, because a
// schedule that fires is not an error.
//
// ── WHAT IT DOES, AND THE ONE THING IT DELIBERATELY DOES NOT DO ─────────────
// It SURFACES suspects. It never rewrites a schedule, and that is a decision
// with a reason rather than caution: an instant carries no record of the intent
// behind it. A stored anchor of 06:00Z is indistinguishable, in the data, from
// a correct 06:00Z anchor and from a compensated stand-in for 06:00 local. The
// ONLY discriminator is WHEN it was written, which narrows the set but cannot
// prove any single row. Rewriting on that evidence would move a real recurring
// alert by hours on rows that were never compensated — trading a defect that is
// visible to its owner for one that is not (roadmap #15: absence of a
// contradicting fact is not evidence, and a schedule nobody chose is worse than
// one somebody has to fix). So each suspect is reported with BOTH readings and
// the exact one-call correction, and the correction works because T0A's fix is
// what put `anchor_time` back through the door.
//
// ── THE RULE, STATED, WITH ITS DENOMINATOR ──────────────────────────────────
// Every row carrying a schedule is EXAMINED. A row is SUSPECT when all four
// hold; a row that fails one is counted against the clause it failed, and the
// clause counts sum to the number examined:
//   1. it can still fire        — a future `next_run_at`, not terminal, not paused
//   2. it has a readable anchor — `anchor_local ?? scheduled_start` parses
//   3. it was written IN WINDOW — `updated_at` in [2026-08-03, first boot of a
//                                 build carrying the door fix)
//   4. the box is not on UTC    — at offset 0 the compensating transform is the
//                                 identity and there is nothing to undo
// ════════════════════════════════════════════════════════════════════════════
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { instantToWall, wallToInstant, getBoxTimeZone, normalizeDbTimestamp } from './engine.js';

const logger = createLogger('anchor-compensation');

/** The day the door-drop was reported and same-day relief began on the reporting box. */
export const COMPENSATION_WINDOW_OPENED_AT = '2026-08-03T00:00:00Z';

/** Set on the first boot of a build carrying T0A's door fix; closes the window. */
export const FIX_FIRST_BOOT_KEY = 'anchor_door_fix_first_boot_at';

/** The scan's durable record — this is the sink, because logs rotate. */
export const SCAN_RECORD_KEY = 'anchor_compensation_scan';

/** Terminal work states: a row here cannot fire again. */
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
  /** The instant the row holds today. */
  storedAnchor: string;
  /** The instant it would name if its digits were meant as box-local wall clock. */
  intendedIfCompensated: string;
  /** intendedIfCompensated - storedAnchor, in minutes. */
  shiftMinutes: number;
  /** The single call that corrects it, now that the door forwards the field. */
  correction: string;
}

export interface ScanResult {
  /** THE DENOMINATOR: rows carrying a schedule that were looked at. */
  examined: number;
  suspects: Suspect[];
  /** Why each non-suspect row stood down; these sum to `examined - suspects.length`. */
  standDown: Record<StandDownReason, number>;
  boxTimeZone: string;
  windowOpenedAt: string;
  windowClosedAt: string | null;
  scannedAt: string;
}

/** Read a config value, or null. */
function cfg(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setCfg(key: string, value: string): void {
  getDb().prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/**
 * The two readings of one stored anchor. `stored` is the instant the row holds;
 * `intended` is the instant those same digits would name if they had been meant
 * as box-local wall clock — which is exactly the transform a compensation
 * applied, and exactly the transform that has to be undone if it was one.
 */
export function readingsOf(anchorIso: string, timeZone: string): { stored: number; intended: number } | null {
  const stored = new Date(normalizeDbTimestamp(anchorIso)).getTime();
  if (Number.isNaN(stored)) return null;
  // The UTC digits of the stored instant, read back as wall clock in the box zone.
  const digits = instantToWall(stored, 'UTC');
  return { stored, intended: wallToInstant(digits, timeZone).getTime() };
}

/** Every row that carries a schedule. This SELECT is the denominator. */
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

/**
 * Classify every scheduled row. Pure with respect to its inputs — the boot pass
 * supplies the rows and the window, the unit tests supply their own, and the
 * `VACUUM INTO` rehearsal supplies a copy of a real body.
 */
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
    // 1 — can it still fire?
    const live =
      row.next_run_at !== null && row.next_run_at > now
      && !TERMINAL_STATES.has(String(row.state ?? ''))
      && (row.is_paused ?? 0) === 0;
    if (!live) { standDown['cannot-fire']++; continue; }

    // 2 — is there a readable anchor? The scheduler's own fallback is
    //     `anchor_time ?? scheduled_start`, so the EFFECTIVE anchor is what
    //     matters, never the column that happens to hold it.
    const effective = row.anchor_local ?? (row.scheduled_start !== null ? new Date(row.scheduled_start).toISOString() : null);
    const readings = effective ? readingsOf(effective, timeZone) : null;
    if (!readings) { standDown['no-readable-anchor']++; continue; }

    // 3 — was it written while the door was dropping the field?
    const writtenAt = row.updated_at ?? 0;
    if (writtenAt < openedAt || writtenAt >= closeBound) { standDown['written-outside-window']++; continue; }

    // 4 — on a UTC box the transform is the identity, so nothing was compensated.
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

/** The owner-facing brief. Plain language, both readings, and the one call that fixes it. */
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
 * Report suspects to the PRIMARY agent, on the events lane, so the agent raises
 * it with the owner in his own words (OR2: detect -> steer -> the agent speaks,
 * never the engine wearing the agent's face). `selfIntro` is off because this is
 * the platform reporting maintenance; "this is the scheduler agent" would
 * introduce an agent that does not exist.
 */
function reportToPrimary(brief: string): void {
  const primaryId = getPrimaryAgentId();
  if (!primaryId) return;
  postAgentNotice({ toAgentId: primaryId, fromName: 'scheduler', brief, selfIntro: false });
}

/**
 * The boot pass. Idempotent and one-shot: it records the first boot of a build
 * carrying the fix (which is what CLOSES the compensation window), runs the
 * scan once, writes its result to `config`, and never nags again.
 *
 * Returns the result it recorded, or null when it had already run.
 */
export function runAnchorCompensationPass(
  notify: (brief: string) => void = reportToPrimary,
): ScanResult | null {
  try {
    const already = cfg(SCAN_RECORD_KEY);
    const firstBoot = cfg(FIX_FIRST_BOOT_KEY);
    const nowIso = new Date().toISOString();

    // The window closes at the FIRST boot of a build carrying the fix. On that
    // boot the marker does not exist yet, so the bound is now; on every later
    // boot it is the recorded instant, which is what keeps the set stable.
    if (!firstBoot) setCfg(FIX_FIRST_BOOT_KEY, nowIso);
    if (already) return null;

    const result = scanForCompensatedAnchors({
      windowClosedAtMs: firstBoot ? Date.parse(firstBoot) : Date.now(),
    });
    setCfg(SCAN_RECORD_KEY, JSON.stringify(result));

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
        notify(describeSuspects(result));
    }
    return result;
  } catch (err) {
    // A maintenance scan never fails a boot.
    logger.warn('compensated-anchor scan failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
