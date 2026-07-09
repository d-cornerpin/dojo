import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  mergeCalendarChronologically,
  dedupCalendarItems,
  mergeMailByRecency,
  computeAmbiguousLabels,
  formatSourceLabel,
  renderCalendarAgenda,
  renderEmailSearch,
  compactEventTime,
  renderOtherCalendarsSection,
  renderOtherMailboxesCount,
  type UnifiedSource,
  type UnifiedCalendarItem,
  type UnifiedMailItem,
  type OtherCalendarRow,
  type MailboxCount,
} from '../unified-read.js';

// Fabricated sources — no network, no DB.
const agentGoogle: UnifiedSource = { providerLabel: 'Google', slot: 'agent', email: 'agent@ex.com', labelKey: 'agent Google' };
const ownerGoogle: UnifiedSource = { providerLabel: 'Google', slot: 'owner', email: 'owner@ex.com', labelKey: 'owner Google' };
const agentMs: UnifiedSource = { providerLabel: 'Microsoft', slot: 'agent', email: 'agent@ms.com', labelKey: 'agent Microsoft' };
// Two Google agent accounts share a label — the ambiguity case.
const agentGoogle2: UnifiedSource = { providerLabel: 'Google', slot: 'agent', email: 'second@ex.com', labelKey: 'agent Google' };

function cal(title: string, sortKey: number, source: UnifiedSource, extra: Partial<UnifiedCalendarItem> = {}): UnifiedCalendarItem {
  return {
    title,
    startISO: extra.startISO ?? new Date(sortKey).toISOString(),
    sortKey,
    allDay: extra.allDay ?? false,
    location: extra.location,
    when: extra.when ?? `when(${title})`,
    source,
  };
}

function mail(id: string, sortKey: number, source: UnifiedSource, extra: Partial<UnifiedMailItem> = {}): UnifiedMailItem {
  return {
    id,
    from: extra.from ?? 'Sender <s@ex.com>',
    subject: extra.subject ?? `subject-${id}`,
    when: extra.when ?? `when-${id}`,
    sortKey,
    snippet: extra.snippet ?? '',
    unread: extra.unread ?? false,
    source,
  };
}

describe('normalizeTitle', () => {
  it('trims, lowercases, and collapses whitespace', () => {
    expect(normalizeTitle('  Team   Standup ')).toBe('team standup');
    expect(normalizeTitle('TEAM STANDUP')).toBe('team standup');
  });
});

describe('mergeCalendarChronologically', () => {
  it('sorts ascending by sortKey without mutating input', () => {
    const input = [cal('c', 300, agentGoogle), cal('a', 100, ownerGoogle), cal('b', 200, agentMs)];
    const out = mergeCalendarChronologically(input);
    expect(out.map(i => i.title)).toEqual(['a', 'b', 'c']);
    // original untouched
    expect(input.map(i => i.title)).toEqual(['c', 'a', 'b']);
  });
});

describe('dedupCalendarItems', () => {
  it('collapses same (title,start) across sources into one entry with both sources, preserving order', () => {
    const start = '2026-07-07T15:00:00.000Z';
    const items = mergeCalendarChronologically([
      cal('Standup', 100, agentGoogle, { startISO: start }),
      cal('standup', 100, ownerGoogle, { startISO: start }), // different case, same time
      cal('Lunch', 200, agentMs),
    ]);
    const merged = dedupCalendarItems(items);
    expect(merged).toHaveLength(2);
    expect(merged[0].title).toBe('Standup');
    expect(merged[0].sources).toHaveLength(2);
    expect(merged[1].title).toBe('Lunch');
  });

  it('does NOT collapse same title at different starts', () => {
    const merged = dedupCalendarItems([
      cal('Standup', 100, agentGoogle, { startISO: 'A' }),
      cal('Standup', 200, ownerGoogle, { startISO: 'B' }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('deduplicates the same source appearing twice', () => {
    const start = 'X';
    const merged = dedupCalendarItems([
      cal('Standup', 1, agentGoogle, { startISO: start }),
      cal('Standup', 1, agentGoogle, { startISO: start }),
    ]);
    expect(merged[0].sources).toHaveLength(1);
  });
});

describe('computeAmbiguousLabels / formatSourceLabel', () => {
  it('flags a label only when it maps to more than one email', () => {
    const amb = computeAmbiguousLabels([agentGoogle, agentGoogle2, ownerGoogle]);
    expect(amb.has('agent Google')).toBe(true); // two distinct emails
    expect(amb.has('owner Google')).toBe(false);
  });

  it('shows the email only for ambiguous labels', () => {
    const amb = computeAmbiguousLabels([agentGoogle, agentGoogle2]);
    expect(formatSourceLabel(agentGoogle, amb)).toBe('[agent Google] (agent@ex.com)');
    expect(formatSourceLabel(ownerGoogle, new Set())).toBe('[owner Google]');
  });
});

describe('renderCalendarAgenda', () => {
  it('separates all-day items, labels sources, and annotates shared events', () => {
    const start = 'S';
    const items = mergeCalendarChronologically([
      cal('Standup', 100, agentGoogle, { startISO: start, when: '9am' }),
      cal('Standup', 100, ownerGoogle, { startISO: start, when: '9am' }),
      cal('Holiday', 50, agentMs, { allDay: true, when: 'all day' }),
    ]);
    const merged = dedupCalendarItems(items);
    const ambiguous = computeAmbiguousLabels([agentGoogle, ownerGoogle, agentMs]);
    const out = renderCalendarAgenda(merged, ambiguous, [], { days: 1, accountCount: 3 });
    expect(out).toContain('Merged agenda (next 1 day(s)) across 3 connected calendars:');
    expect(out).toContain('(on both [agent Google] and [owner Google])');
    expect(out).toContain('All-day:');
    expect(out).toContain('- Holiday');
    expect(out).toContain('[agent Microsoft]');
  });

  it('renders per-account failures at the end and never throws on them', () => {
    const out = renderCalendarAgenda([], new Set(), [{ label: 'owner Microsoft calendar (o@ms.com)', error: 'token expired' }], { days: 1, accountCount: 1 });
    expect(out).toContain('No events on any connected calendar in this window.');
    expect(out).toContain('could not read owner Microsoft calendar (o@ms.com): token expired');
  });
});

describe('mergeMailByRecency', () => {
  it('sorts most-recent-first', () => {
    const out = mergeMailByRecency([mail('a', 100, agentGoogle), mail('c', 300, ownerGoogle), mail('b', 200, agentMs)]);
    expect(out.map(m => m.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('renderEmailSearch', () => {
  it('labels each result by source and marks unread', () => {
    const items = mergeMailByRecency([
      mail('m1', 200, agentGoogle, { unread: true, subject: 'Invoice', from: 'A <a@ex.com>' }),
      mail('m2', 100, ownerGoogle, { subject: 'Receipt' }),
    ]);
    const out = renderEmailSearch(items, new Set(), [], { query: 'invoice', accountCount: 2 });
    expect(out).toContain('Merged email search for "invoice" across 2 connected mailboxes:');
    expect(out).toContain('[agent Google] [UNREAD]');
    expect(out).toContain('Invoice');
    expect(out).toContain('[owner Google]');
    expect(out).not.toContain('[owner Google] [UNREAD]');
  });

  it('handles the empty + partial-failure case plainly', () => {
    const out = renderEmailSearch([], new Set(), [{ label: 'agent Outlook (x@ms.com)', error: 'HTTP 503' }], { query: 'foo', accountCount: 1 });
    expect(out).toContain('No matching email in any connected mailbox.');
    expect(out).toContain('could not read agent Outlook (x@ms.com): HTTP 503');
  });
});

// ── Narrow-tool DATA-floor helpers ──

// Mail-surface sources carry Gmail/Outlook provider labels (calendar carries Google/Microsoft).
const agentGmail: UnifiedSource = { providerLabel: 'Gmail', slot: 'agent', email: 'a@ex.com', labelKey: 'agent Gmail' };
const ownerOutlook: UnifiedSource = { providerLabel: 'Outlook', slot: 'owner', email: 'o@ms.com', labelKey: 'owner Outlook' };

describe('compactEventTime', () => {
  it('returns "All day" for all-day events regardless of the start', () => {
    expect(compactEventTime(new Date('2026-07-07T15:05:00Z'), 'UTC', true)).toBe('All day');
    expect(compactEventTime(null, 'UTC', true)).toBe('All day');
  });

  it('renders a compact clock time in the given timezone for timed events', () => {
    expect(compactEventTime(new Date('2026-07-07T15:05:00Z'), 'UTC', false)).toBe('3:05 PM');
  });

  it('falls back to "time TBD" when the start is missing or unparseable', () => {
    expect(compactEventTime(null, 'UTC', false)).toBe('time TBD');
    expect(compactEventTime(new Date('not-a-date'), 'UTC', false)).toBe('time TBD');
  });
});

describe('renderOtherCalendarsSection', () => {
  it('returns empty string when there is nothing elsewhere', () => {
    expect(renderOtherCalendarsSection([], new Set())).toBe('');
  });

  it('renders one labeled compact line per event under the header', () => {
    const rows: OtherCalendarRow[] = [
      { title: 'Dentist', when: 'All day', source: agentGoogle },
      { title: 'Sync', when: '9:00 AM', source: agentMs },
    ];
    const out = renderOtherCalendarsSection(rows, new Set());
    expect(out).toContain('Also on other connected calendars (not shown above):');
    expect(out).toContain('- Dentist, All day [agent Google]');
    expect(out).toContain('- Sync, 9:00 AM [agent Microsoft]');
    // Not truncated — no merged-view pointer.
    expect(out).not.toContain('call calendar_agenda for the fully merged view');
  });

  it('caps at 6 lines and points at the merged view when more exist', () => {
    const rows: OtherCalendarRow[] = Array.from({ length: 8 }, (_, i) => ({
      title: `E${i}`, when: 'All day', source: agentGoogle,
    }));
    const out = renderOtherCalendarsSection(rows, new Set());
    const bulletLines = out.split('\n').filter(l => l.startsWith('- '));
    expect(bulletLines).toHaveLength(6);
    expect(out).toContain('(call calendar_agenda for the fully merged view)');
  });

  it('disambiguates a label with the email only when it covers >1 account', () => {
    const rows: OtherCalendarRow[] = [
      { title: 'A', when: '9:00 AM', source: agentGoogle },
      { title: 'B', when: '9:30 AM', source: agentGoogle2 },
    ];
    const ambiguous = computeAmbiguousLabels([agentGoogle, agentGoogle2]);
    const out = renderOtherCalendarsSection(rows, ambiguous);
    expect(out).toContain('[agent Google] (agent@ex.com)');
    expect(out).toContain('[agent Google] (second@ex.com)');
  });
});

describe('renderOtherMailboxesCount', () => {
  it('returns empty string when every other mailbox is zero', () => {
    expect(renderOtherMailboxesCount([], new Set())).toBe('');
    expect(renderOtherMailboxesCount([{ source: agentGmail, count: 0 }], new Set())).toBe('');
  });

  it('lists nonzero counts by source with the merged-tool call-to-action', () => {
    const counts: MailboxCount[] = [
      { source: agentGmail, count: 3 },
      { source: ownerOutlook, count: 1 },
    ];
    const out = renderOtherMailboxesCount(counts, new Set());
    expect(out).toBe(
      'Also matching in other connected mailboxes: 3 in [agent Gmail], 1 in [owner Outlook]. Call email_search to see them together.',
    );
  });

  it('drops zero-count surfaces but keeps nonzero ones', () => {
    const counts: MailboxCount[] = [
      { source: agentGmail, count: 0 },
      { source: ownerOutlook, count: 2 },
    ];
    const out = renderOtherMailboxesCount(counts, new Set());
    expect(out).toContain('2 in [owner Outlook]');
    expect(out).not.toContain('[agent Gmail]');
  });
});

// ── F4 coverage floor (2026-07-08): checked-empty must be visible, and distinct
// from both never-checked (silence) and could-not-check (failure). ──

describe('renderOtherCalendarsSection — coverage floor', () => {
  it('enumerates checked-empty surfaces even with no rows (was silent before)', () => {
    const out = renderOtherCalendarsSection([], new Set(), { emptySurfaces: [ownerGoogle, agentMs] });
    expect(out).toBe('Also checked, nothing in this window: [owner Google], [agent Microsoft]');
  });

  it('renders rows, then the checked-empty line, then failures — all three', () => {
    const rows: OtherCalendarRow[] = [{ title: 'Sync', when: '9:00 AM', source: agentGoogle }];
    const out = renderOtherCalendarsSection(rows, new Set(), {
      emptySurfaces: [ownerGoogle],
      failed: [{ label: 'agent Microsoft calendar (a@ms.com)', error: 'HTTP 503' }],
    });
    expect(out).toContain('Also on other connected calendars (not shown above):');
    expect(out).toContain('- Sync, 9:00 AM [agent Google]');
    expect(out).toContain('Also checked, nothing in this window: [owner Google]');
    expect(out).toContain('could not check: agent Microsoft calendar (a@ms.com) (HTTP 503)');
  });

  it('keeps a FAILED surface distinguishable from a checked-EMPTY one', () => {
    const emptyOut = renderOtherCalendarsSection([], new Set(), { emptySurfaces: [ownerGoogle] });
    const failOut = renderOtherCalendarsSection([], new Set(), {
      failed: [{ label: 'owner Google calendar', error: 'token expired' }],
    });
    expect(emptyOut).toContain('Also checked, nothing in this window: [owner Google]');
    expect(emptyOut).not.toContain('could not check');
    expect(failOut).toContain('could not check: owner Google calendar (token expired)');
    expect(failOut).not.toContain('Also checked, nothing in this window');
  });

  it('all-empty: the checked list still renders so the sweep is visible', () => {
    const out = renderOtherCalendarsSection([], new Set(), {
      emptySurfaces: [agentGoogle, ownerGoogle, agentMs],
    });
    expect(out).not.toBe('');
    expect(out).toContain('[agent Google]');
    expect(out).toContain('[owner Google]');
    expect(out).toContain('[agent Microsoft]');
  });

  it('nothing at all (no rows, no empty, no failures) is still honest silence', () => {
    expect(renderOtherCalendarsSection([], new Set(), {})).toBe('');
    expect(renderOtherCalendarsSection([], new Set())).toBe('');
  });

  it('disambiguates a checked-empty surface by email when its slot+provider has >1 account', () => {
    const ambiguous = computeAmbiguousLabels([agentGoogle, agentGoogle2]);
    const out = renderOtherCalendarsSection([], ambiguous, { emptySurfaces: [agentGoogle2] });
    expect(out).toContain('Also checked, nothing in this window: [agent Google] (second@ex.com)');
  });
});

describe('renderOtherMailboxesCount — coverage floor', () => {
  it('lists checked-empty mailboxes on a "No matches in" line (was silent before)', () => {
    const out = renderOtherMailboxesCount([], new Set(), { emptySurfaces: [agentGmail, ownerOutlook] });
    expect(out).toBe('No matches in: [agent Gmail], [owner Outlook]');
  });

  it('combines matches, empties, and failures on distinct lines', () => {
    const out = renderOtherMailboxesCount([{ source: agentGmail, count: 2 }], new Set(), {
      emptySurfaces: [ownerOutlook],
      failed: [{ label: 'agent Outlook (x@ms.com)', error: 'HTTP 500' }],
    });
    expect(out).toContain('Also matching in other connected mailboxes: 2 in [agent Gmail]');
    expect(out).toContain('No matches in: [owner Outlook]');
    expect(out).toContain('could not check: agent Outlook (x@ms.com) (HTTP 500)');
  });

  it('keeps a FAILED mailbox distinguishable from a checked-EMPTY one', () => {
    const emptyOut = renderOtherMailboxesCount([], new Set(), { emptySurfaces: [agentGmail] });
    const failOut = renderOtherMailboxesCount([], new Set(), { failed: [{ label: 'agent Gmail', error: 'quota' }] });
    expect(emptyOut).toContain('No matches in: [agent Gmail]');
    expect(emptyOut).not.toContain('could not check');
    expect(failOut).toContain('could not check: agent Gmail (quota)');
    expect(failOut).not.toContain('No matches in');
  });

  it('all-empty: the checked list still renders so the sweep is visible', () => {
    const out = renderOtherMailboxesCount([], new Set(), { emptySurfaces: [agentGmail, ownerOutlook] });
    expect(out).not.toBe('');
  });

  it('nothing at all is still honest silence', () => {
    expect(renderOtherMailboxesCount([], new Set(), {})).toBe('');
    expect(renderOtherMailboxesCount([], new Set())).toBe('');
  });
});

describe('renderCalendarAgenda — empty-surface enumeration (merged view)', () => {
  it('lists empty surfaces so the "across N connected calendars" count is verifiable', () => {
    const out = renderCalendarAgenda([], new Set(), [], {
      days: 1, accountCount: 2, emptySurfaces: [ownerGoogle, agentMs],
    });
    expect(out).toContain('across 2 connected calendars');
    expect(out).toContain('No events on any connected calendar in this window.');
    expect(out).toContain('Empty in this window: [owner Google], [agent Microsoft]');
  });

  it('lists only the EMPTY surfaces when some have events', () => {
    const merged = dedupCalendarItems(mergeCalendarChronologically([cal('Standup', 100, agentGoogle, { when: '9am' })]));
    const out = renderCalendarAgenda(merged, new Set(), [], {
      days: 1, accountCount: 2, emptySurfaces: [ownerGoogle],
    });
    expect(out).toContain('- Standup');
    expect(out).toContain('Empty in this window: [owner Google]');
    expect(out).not.toContain('Empty in this window: [agent Google]');
  });
});

describe('renderEmailSearch — empty-surface enumeration (merged view)', () => {
  it('lists empty mailboxes so the "across N connected mailboxes" count is verifiable', () => {
    const out = renderEmailSearch([], new Set(), [], {
      query: 'invoice', accountCount: 2, emptySurfaces: [agentGmail, ownerOutlook],
    });
    expect(out).toContain('across 2 connected mailboxes');
    expect(out).toContain('No matching email in any connected mailbox.');
    expect(out).toContain('Empty in this window: [agent Gmail], [owner Outlook]');
  });
});
