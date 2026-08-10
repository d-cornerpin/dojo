// ════════════════════════════════════════════════════════════════════════════════════════
// THE DASHBOARD READS SERVER TIME TRUTHFULLY — the behavioral half of UX-REPAIR T9.
//
// THE DEFECT, in the owner's words: "next run time isn't matching". The board route serves
// datetimes as Z-LESS UTC TEXT — `msToText` (`work/tracker-view.ts:189`) is
// `strftime('%Y-%m-%d %H:%M:%S', col/1000, 'unixepoch')`, so `work.next_run_at` reaches the
// client as "2026-08-11 02:00:00" with no zone marker. `new Date()` reads that as LOCAL time.
// On a Pacific box a 7 PM reminder therefore rendered "Aug 11, 2:00 AM" — the next day, +7h.
//
// The dashboard already owned the safe parser (`lib/dates.ts:parseUtc`, whose header documents
// exactly this trap) and the Tracker detail page already used it, which is why the same row read
// correctly in one place and wrongly in another. Nothing ENFORCED the parser; that enforcement is
// the sibling census in `dashboard-date-parse-census.test.ts`. This file pins the BEHAVIOR.
//
// WHY THESE TESTS LIVE IN THE SERVER PACKAGE. `npm test` runs `vitest` in packages/server only —
// the dashboard package has no test runner and wiring one would mean editing root/dashboard
// package.json, outside this task's fence. The precedent is `marker-ownership.test.ts:25`, whose
// ROOTS already include `dashboard/src`: cross-package source guards live here so that they RUN.
// A guard the suite does not run is a sentence in a report, not a guard.
//
// TIMEZONE. Node >= 16 honours a runtime `process.env.TZ` reassignment, so each zone-sensitive
// test forces a zone and restores it. The zone is forced to Pacific because that is the owner's
// box and the zone the defect was reported from.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, afterEach } from 'vitest';
import {
  parseUtc,
  formatDate,
  formatShortDateTime,
  formatTimeSince,
  formatElapsed,
} from '../../../dashboard/src/lib/dates';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { process.env.TZ = ORIGINAL_TZ; });

/** Run `fn` with the process timezone forced, then restore it. */
function inZone<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

/**
 * The exact text shapes that cross the wire, so every assertion below is about a real
 * serialization and not an invented one.
 *   Z_LESS  — `msToText`: work.next_run_at / paused_until / updated_at / created_at, and every
 *             SQLite `datetime('now')` column (contacts, generation jobs, …).
 *   WITH_Z  — a JS `.toISOString()` value stored or emitted verbatim (e.g. `work.anchor_local`).
 */
const Z_LESS = '2026-08-11 02:00:00';
const WITH_Z = '2026-08-11T02:00:00.000Z';
const SAME_INSTANT_MS = Date.parse('2026-08-11T02:00:00Z');

describe('T9 — parseUtc is the single authority for server datetime text', () => {
  it('reads Z-less SQLite text as UTC, not local', () => {
    expect(parseUtc(Z_LESS)!.getTime()).toBe(SAME_INSTANT_MS);
  });

  it('passes an explicit Z through unchanged', () => {
    expect(parseUtc(WITH_Z)!.getTime()).toBe(SAME_INSTANT_MS);
  });

  it('passes an explicit numeric offset through unchanged (the branch T9 must not disturb)', () => {
    // 02:00 at +02:00 is midnight UTC — proof the offset is honoured rather than overwritten.
    expect(parseUtc('2026-08-11T02:00:00+02:00')!.getTime())
      .toBe(Date.parse('2026-08-11T00:00:00Z'));
  });

  it('is zone-independent: the same text is the same instant in any zone', () => {
    const pacific = inZone('America/Los_Angeles', () => parseUtc(Z_LESS)!.getTime());
    const tokyo = inZone('Asia/Tokyo', () => parseUtc(Z_LESS)!.getTime());
    const utc = inZone('UTC', () => parseUtc(Z_LESS)!.getTime());
    expect([pacific, tokyo, utc]).toEqual([SAME_INSTANT_MS, SAME_INSTANT_MS, SAME_INSTANT_MS]);
  });

  it('returns null on empty input', () => {
    expect(parseUtc(null)).toBeNull();
    expect(parseUtc(undefined)).toBeNull();
    expect(parseUtc('')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE OWNER'S DEFECT, pinned. This is the RED that opened T9.
// ════════════════════════════════════════════════════════════════════════════════════════

describe("T9 — the kanban card's Next:/Paused-until line (formatShortDateTime)", () => {
  it('renders a 7 PM Pacific reminder as 7:00 PM, not 2:00 AM the next day', () => {
    // work.next_run_at for a 2026-08-10 19:00 Pacific reminder serializes to this exact text.
    expect(inZone('America/Los_Angeles', () => formatShortDateTime(Z_LESS)))
      .toBe('Aug 10, 7:00 PM');
  });

  it('renders the same instant correctly in a zone east of UTC', () => {
    // 02:00 UTC is 11:00 the same morning in Tokyo (+09:00).
    expect(inZone('Asia/Tokyo', () => formatShortDateTime(Z_LESS)))
      .toBe('Aug 11, 11:00 AM');
  });

  it('agrees with UTC when the box is on UTC', () => {
    expect(inZone('UTC', () => formatShortDateTime(Z_LESS))).toBe('Aug 11, 2:00 AM');
  });

  it('treats an explicitly-zoned value identically to its Z-less twin', () => {
    const fromZless = inZone('America/Los_Angeles', () => formatShortDateTime(Z_LESS));
    const fromZ = inZone('America/Los_Angeles', () => formatShortDateTime(WITH_Z));
    expect(fromZ).toBe(fromZless);
  });

  it('renders nothing for an absent instant', () => {
    expect(formatShortDateTime(null)).toBe('');
    expect(formatShortDateTime(undefined)).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE FOLDED HAND-ROLLED DUPLICATES.
//
// Four sites had independently hand-rolled `parseUtc`'s job. Each is now routed through the
// shared helper, and each fold is proven BYTE-IDENTICAL on the shapes that actually cross the
// wire by comparing against the ORIGINAL implementation, pinned verbatim below. These reference
// copies are the fold's evidence: if a future edit changes what the user reads, these fail.
// ════════════════════════════════════════════════════════════════════════════════════════

/** ORIGINAL `TaskCard.tsx:18-25` `formatTimeSince`, verbatim at `9d51721`. */
function ORIGINAL_formatTimeSince(dateStr: string): string {
  const normalized = dateStr.includes('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(normalized).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** ORIGINAL `ActiveJobsIndicator.tsx:22-32` `elapsed`, verbatim at `9d51721`. */
function ORIGINAL_elapsed(startedAt: string): string {
  const start = new Date(startedAt.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(start)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

/** ORIGINAL `ContactsPanel.tsx:24-31` `fmtDate`, verbatim at `9d51721`. */
function ORIGINAL_fmtDate(iso: string): string {
  try {
    const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

/** ORIGINAL `TaskScheduleForm.tsx:114-120` inline `utcStr` parse, verbatim at `9d51721`. */
function ORIGINAL_scheduleFormParse(scheduledStart: string): Date {
  const utcStr = scheduledStart.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(scheduledStart)
    ? scheduledStart
    : scheduledStart + 'Z';
  return new Date(utcStr);
}

/**
 * Instants spanning every branch of the elapsed formatters, expressed as offsets from a fixed
 * "now" so the assertions cannot straddle a second boundary.
 */
const AGES_SEC = [0, 1, 45, 59, 60, 61, 125, 3599, 3600, 3601, 7200, 86399, 86400, 90000, 259200];

/** Both wire shapes of an instant `ageSec` seconds before now. */
function wireShapesFor(ageSec: number): { zLess: string; withZ: string } {
  const iso = new Date(Date.now() - ageSec * 1000).toISOString();
  return { withZ: iso, zLess: iso.slice(0, 19).replace('T', ' ') };
}

describe('T9 — folded duplicate: TaskCard formatTimeSince', () => {
  it('is byte-identical to the original on both wire shapes, across every branch', () => {
    for (const ageSec of AGES_SEC) {
      const { zLess, withZ } = wireShapesFor(ageSec);
      expect(formatTimeSince(zLess), `Z-less, age ${ageSec}s`).toBe(ORIGINAL_formatTimeSince(zLess));
      expect(formatTimeSince(withZ), `with-Z, age ${ageSec}s`).toBe(ORIGINAL_formatTimeSince(withZ));
    }
  });

  it('reads Z-less text as UTC (the two shapes of one instant agree)', () => {
    const { zLess, withZ } = wireShapesFor(125);
    expect(formatTimeSince(zLess)).toBe(formatTimeSince(withZ));
  });

  it('stays seconds-granular under a minute — it is NOT formatRelative', () => {
    const { zLess } = wireShapesFor(5);
    expect(formatTimeSince(zLess)).toBe('5s ago');
  });
});

describe('T9 — folded duplicate: ActiveJobsIndicator elapsed', () => {
  it('is byte-identical to the original on the Z-less wire shape, across every branch', () => {
    for (const ageSec of AGES_SEC) {
      const { zLess } = wireShapesFor(ageSec);
      expect(formatElapsed(zLess), `age ${ageSec}s`).toBe(ORIGINAL_elapsed(zLess));
    }
  });

  it('reads Z-less text as UTC (the two shapes of one instant agree)', () => {
    const { zLess, withZ } = wireShapesFor(125);
    expect(formatElapsed(zLess)).toBe(formatElapsed(withZ));
  });

  it('survives an already-Z value, which the original turned into NaN', () => {
    // The original appended 'Z' unconditionally -> "…ZZ" -> Invalid Date -> ''. Routing through
    // parseUtc makes the helper total over both shapes; this is a strict repair, not a
    // behaviour change on the shape the route actually serves.
    const { withZ } = wireShapesFor(45);
    expect(ORIGINAL_elapsed(withZ)).toBe('');
    expect(formatElapsed(withZ)).toBe('45s');
  });
});

describe('T9 — folded duplicate: ContactsPanel fmtDate -> formatDate', () => {
  it('is byte-identical to the original on both wire shapes', () => {
    for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      inZone(tz, () => {
        expect(formatDate(Z_LESS), `Z-less in ${tz}`).toBe(ORIGINAL_fmtDate(Z_LESS));
        expect(formatDate(WITH_Z), `with-Z in ${tz}`).toBe(ORIGINAL_fmtDate(WITH_Z));
      });
    }
  });
});

describe('T9 — folded duplicate: TaskScheduleForm inline utcStr parse -> parseUtc', () => {
  it('is byte-identical to the original on every shape anchor_time/scheduled_start can hold', () => {
    for (const s of [Z_LESS, WITH_Z, '2026-08-11T02:00:00+02:00', '2026-08-11T02:00:00']) {
      expect(parseUtc(s)!.getTime(), s).toBe(ORIGINAL_scheduleFormParse(s).getTime());
    }
  });
});
