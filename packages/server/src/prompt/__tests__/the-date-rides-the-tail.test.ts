// ════════════════════════════════════════════════════════════════════════════
// T72b claim 4 — THE DATE RIDES THE TAIL, NOT THE PREFIX.
//
// THE INCIDENT (owner's DS4-server agent, 2026-09): "a date near the top of the
// prompt changes at midnight, so the whole prompt is rebuilt daily."
//
// OUR OWN CORROBORATION, twice, before he said it:
//   * W54/W56/W58 recorded the cached system prefix at 35,725 chars;
//     W63 recorded 35,724 — "the one-character difference is the date inside
//     the prompt, `Aug 31, 2026` -> `Sep 1, 2026`" (task-W63-report.md §5a).
//   * The release's own cache-prefix determinism gate moved 23,846 -> 23,845
//     for the identical reason, the same night.
//
// WHY NO GATE CAUGHT IT: `sys.time` carries a DECLARED exemption in
// dojo-test-kit/checks/check-cache-prefix.mjs ('varies: field', 2026-07-07,
// "the golden went stale daily on a one-line diff"), and the check normalizes
// `**Current date: ...**` to `<NORMALIZED>` before comparing. The exemption
// made the GOLDEN stable; it did nothing for the real request, where the date
// is the FIRST LINE of the system prompt and a provider's prefix cache breaks
// at the first differing token. One character at offset ~15 invalidates
// 35,724 chars of system + 72,616 chars of tools, every midnight.
//
// THE FIX: `sys.time` keeps its behavioral prose and loses the date. The date
// is NOT lost to the model — `msg.current-time` (the volatile tail message)
// already renders the same weekday/month/day/year, plus the clock time, and
// has since the cache relocation. The prefix stops moving; nothing the model
// can read changes.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderTimeHeader, renderCurrentTimeMessage } from '../assembler.js';

// Two instants either side of a local midnight, so the ONLY thing that differs
// between them is the calendar date.
const BEFORE_MIDNIGHT = new Date('2026-08-31T20:30:00-07:00'); // Mon Aug 31 local
const AFTER_MIDNIGHT = new Date('2026-09-01T09:15:00-07:00'); // Tue Sep 1 local

describe('T72b/4 — the date rides the tail, not the cached prefix', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the system-prompt time slot is byte-identical across a midnight roll', () => {
    vi.setSystemTime(BEFORE_MIDNIGHT);
    const aug31 = renderTimeHeader();
    vi.setSystemTime(AFTER_MIDNIGHT);
    const sep1 = renderTimeHeader();

    // RED at HEAD: "**Current date: Mon, Aug 31, 2026**" vs "Tue, Sep 1, 2026".
    expect(sep1).toBe(aug31);
  });

  it('the system-prompt time slot carries no calendar date at all', () => {
    vi.setSystemTime(AFTER_MIDNIGHT);
    const header = renderTimeHeader();

    // Any month name + day, any 4-digit year, any ISO or numeric date: none of
    // it belongs in a byte-stable slot. This is the anti-reintroduction guard —
    // it fails on a "helpful" future edit that puts a date back, whatever
    // format it picks.
    expect(header).not.toMatch(
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/,
    );
    expect(header).not.toMatch(/\b20\d{2}\b/);
    expect(header).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(header).not.toMatch(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/);
  });

  it('the volatile tail message still carries the full date — nothing is lost', () => {
    vi.setSystemTime(AFTER_MIDNIGHT);
    const tail = renderCurrentTimeMessage();

    // The model still learns weekday, month, day and year from turn 1; it just
    // learns them from the message that already churned every minute anyway.
    expect(tail).toMatch(/Tue/);
    expect(tail).toMatch(/Sep 1/);
    expect(tail).toMatch(/2026/);
  });

  it('the tail message is the thing that moves at midnight (control)', () => {
    vi.setSystemTime(BEFORE_MIDNIGHT);
    const aug31 = renderCurrentTimeMessage();
    vi.setSystemTime(AFTER_MIDNIGHT);
    const sep1 = renderCurrentTimeMessage();

    // Positive control: the date change IS still observable to the model. If
    // this ever passes as equal, the fix deleted the date instead of moving it.
    expect(sep1).not.toBe(aug31);
  });
});
