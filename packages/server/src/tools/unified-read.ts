// Unified read tools: one call enumerates EVERY connected, service-enabled account across both providers
// and both slots, fetches each in parallel (a failed account never sinks the call), merges, and labels every
// line by source. Coverage is the engine's job, so a narrow pick cannot give a silently incomplete answer.
// The per-account fetch helpers (google/tools-read.ts and the Microsoft mirrors) are reused, never duplicated.
// Import direction is one-way (this module -> providers): fetch helpers come via DYNAMIC import so there is
// no top-level cycle and the pure merge/dedup/render functions import without any provider in tests.

import type { ToolDefinition } from '../agent/tools/types.js';
import { registerConcurrency, registerMaxResultTokens } from '../agent/v2/classifiers/concurrency.js';
import { outsideSpan } from './external-content.js';

// ── Pure types (no provider / DB / format-time dependency) ──

export type SlotWord = 'agent' | 'owner';

export interface UnifiedSource {
  /** Display name for the provider surface: Google/Microsoft (calendar) or Gmail/Outlook (mail). */
  providerLabel: string;
  slot: SlotWord;
  email: string;
  /** `${slot} ${providerLabel}`, the ambiguity key (email is only shown when a label maps to >1 account). */
  labelKey: string;
}

export interface UnifiedCalendarItem {
  title: string;
  /** Instant ISO for a timed event, or the all-day date. Half of the dedup key. */
  startISO: string;
  /** Epoch ms for chronological sort (unparseable times sink to the end). */
  sortKey: number;
  allDay: boolean;
  location?: string;
  /** Preformatted, timezone-labeled display range (built by the executor). */
  when: string;
  source: UnifiedSource;
}

export interface MergedCalendarItem {
  title: string;
  startISO: string;
  allDay: boolean;
  location?: string;
  when: string;
  /** One entry per distinct source that carries this same (title, start). */
  sources: UnifiedSource[];
}

export interface UnifiedMailItem {
  id: string;
  from: string;
  subject: string;
  /** Preformatted, timezone-labeled date. */
  when: string;
  /** Epoch ms for most-recent-first sort. */
  sortKey: number;
  snippet: string;
  /** True only when the source reported the message as unread (Gmail search does not report read-state). */
  unread: boolean;
  source: UnifiedSource;
}

export interface AccountFailure {
  label: string;
  error: string;
}

// ── Pure helpers (unit-tested directly) ──

export function normalizeTitle(t: string): string {
  return (t ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Chronological (earliest first). Stable, non-mutating. */
export function mergeCalendarChronologically(items: UnifiedCalendarItem[]): UnifiedCalendarItem[] {
  return [...items].sort((a, b) => a.sortKey - b.sortKey);
}

/**
 * Collapse events that share a normalized title AND the same start into one
 * line carrying every distinct source. Preserves first-seen order, so run this
 * on an already-chronological list to keep the merged agenda chronological.
 */
export function dedupCalendarItems(items: UnifiedCalendarItem[]): MergedCalendarItem[] {
  const order: string[] = [];
  const map = new Map<string, MergedCalendarItem>();
  for (const it of items) {
    const key = `${normalizeTitle(it.title)}|${it.startISO}`;
    const existing = map.get(key);
    if (existing) {
      if (!existing.sources.some(s => s.labelKey === it.source.labelKey && s.email === it.source.email)) {
        existing.sources.push(it.source);
      }
    } else {
      map.set(key, {
        title: it.title,
        startISO: it.startISO,
        allDay: it.allDay,
        location: it.location,
        when: it.when,
        sources: [it.source],
      });
      order.push(key);
    }
  }
  return order.map(k => map.get(k)!);
}

/** Most-recent-first. Stable, non-mutating. */
export function mergeMailByRecency(items: UnifiedMailItem[]): UnifiedMailItem[] {
  return [...items].sort((a, b) => b.sortKey - a.sortKey);
}

/** A source label needs its email shown only when the SAME label covers >1 account. */
export function computeAmbiguousLabels(sources: UnifiedSource[]): Set<string> {
  const byLabel = new Map<string, Set<string>>();
  for (const s of sources) {
    if (!byLabel.has(s.labelKey)) byLabel.set(s.labelKey, new Set());
    byLabel.get(s.labelKey)!.add(s.email);
  }
  const ambiguous = new Set<string>();
  for (const [label, emails] of byLabel) {
    if (emails.size > 1) ambiguous.add(label);
  }
  return ambiguous;
}

export function formatSourceLabel(s: UnifiedSource, ambiguous: Set<string>): string {
  const base = `[${s.slot} ${s.providerLabel}]`;
  return ambiguous.has(s.labelKey) && s.email ? `${base} (${s.email})` : base;
}

function joinSourceLabels(sources: UnifiedSource[], ambiguous: Set<string>): string {
  const labels = sources.map(s => formatSourceLabel(s, ambiguous));
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `(on both ${labels[0]} and ${labels[1]})`;
  return `(on ${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]})`;
}

function renderCalendarLine(m: MergedCalendarItem, ambiguous: Set<string>): string {
  let line = `- ${m.title}\n  ${m.when}  ${joinSourceLabels(m.sources, ambiguous)}`;
  if (m.location) line += `\n  Location: ${m.location}`;
  return line;
}

function renderFailures(failures: AccountFailure[]): string[] {
  return failures.map(f => `could not read ${f.label}: ${f.error}`);
}

export function renderCalendarAgenda(
  merged: MergedCalendarItem[],
  ambiguous: Set<string>,
  failures: AccountFailure[],
  // `emptySurfaces`: connected calendars checked with nothing in this window, listed so "across N calendars"
  // is verifiable and empty is distinguishable from never-checked.
  opts: { days: number; accountCount: number; emptySurfaces?: UnifiedSource[] },
): string {
  const timed = merged.filter(m => !m.allDay);
  const allDay = merged.filter(m => m.allDay);
  const lines: string[] = [];
  lines.push(
    `Merged agenda (next ${opts.days} day(s)) across ${opts.accountCount} connected calendar${opts.accountCount === 1 ? '' : 's'}:`,
  );
  // The events are outside text (an invite is written by its sender); the headings,
  // the coverage lines and the failures are the platform's.
  if (timed.length > 0) {
    lines.push('');
    lines.push(timed.map((m) => outsideSpan(renderCalendarLine(m, ambiguous))).join('\n'));
  }
  if (allDay.length > 0) {
    lines.push('');
    lines.push('All-day:');
    lines.push(allDay.map((m) => outsideSpan(renderCalendarLine(m, ambiguous))).join('\n'));
  }
  if (timed.length === 0 && allDay.length === 0) {
    lines.push('');
    lines.push('No events on any connected calendar in this window.');
  }
  const empty = opts.emptySurfaces ?? [];
  if (empty.length > 0) {
    lines.push('');
    lines.push(`Empty in this window: ${empty.map(s => formatSourceLabel(s, ambiguous)).join(', ')}`);
  }
  if (failures.length > 0) {
    lines.push('');
    lines.push(...renderFailures(failures));
  }
  return lines.join('\n');
}

export function renderEmailSearch(
  items: UnifiedMailItem[],
  ambiguous: Set<string>,
  failures: AccountFailure[],
  // `emptySurfaces`: connected mailboxes searched with no match, listed so "across N mailboxes" is
  // verifiable and empty is distinguishable from never-checked.
  opts: { query: string; accountCount: number; emptySurfaces?: UnifiedSource[] },
): string {
  const lines: string[] = [];
  lines.push(
    `Merged email search for "${opts.query}" across ${opts.accountCount} connected mailbox${opts.accountCount === 1 ? '' : 'es'}:`,
  );
  if (items.length > 0) {
    lines.push('');
    // The emails are outside text; the heading, coverage lines and failures are the platform's.
    lines.push(items.map((m) => {
      const label = formatSourceLabel(m.source, ambiguous);
      const unread = m.unread ? ' [UNREAD]' : '';
      const snip = m.snippet
        ? ` | ${m.snippet.length > 160 ? m.snippet.slice(0, 160) + '…' : m.snippet}`
        : '';
      return outsideSpan(`- ${label}${unread} ${m.when} | ${m.from} — ${m.subject}\n  ID: ${m.id}${snip}`);
    }).join('\n'));
  } else {
    lines.push('');
    lines.push(failures.length > 0 ? 'No readable matches.' : 'No matching email in any connected mailbox.');
  }
  const empty = opts.emptySurfaces ?? [];
  if (empty.length > 0) {
    lines.push('');
    lines.push(`Empty in this window: ${empty.map(s => formatSourceLabel(s, ambiguous)).join(', ')}`);
  }
  if (failures.length > 0) {
    lines.push('');
    lines.push(...renderFailures(failures));
  }
  return lines.join('\n');
}

// ── Narrow-tool DATA-floor helpers (pure; unit-tested directly) ──
// A narrow call touches ONE surface and advice to call the merged tool is ignored by weak models, so the floor
// is DATA: the narrow result carries what the OTHER surfaces hold. The fan-out feeding these renderers lives
// in the two orchestrators below.

/** Compact single time for the "also elsewhere" block: "9:00 AM", or "All day". Intl-only, pure. */
export function compactEventTime(start: Date | null, tz: string, allDay: boolean): string {
  if (allDay) return 'All day';
  if (!start || Number.isNaN(start.getTime())) return 'time TBD';
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(start);
  } catch {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(start);
  }
}

export interface OtherCalendarRow {
  title: string;
  /** Preformatted compact time or 'All day' (from compactEventTime). */
  when: string;
  source: UnifiedSource;
}

/**
 * "Also on other connected calendars" block appended to a NARROW agenda result. It accounts for every OTHER
 * calendar the fan-out touched: surfaces with events keep their data lines (capped at `cap`, overflow points
 * to the merged tool), checked-empty ones share one "Also checked, nothing in this window" line, and failed
 * ones are itemized as "could not check" so a failure never reads as checked-empty.
 * Returns '' only when there is no other surface at all. Pure.
 */
export function renderOtherCalendarsSection(
  rows: OtherCalendarRow[],
  ambiguous: Set<string>,
  opts: { emptySurfaces?: UnifiedSource[]; failed?: AccountFailure[]; cap?: number } = {},
): string {
  const cap = opts.cap ?? 6;
  const empty = opts.emptySurfaces ?? [];
  const failed = opts.failed ?? [];
  const lines: string[] = [];
  if (rows.length > 0) {
    lines.push('Also on other connected calendars (not shown above):');
    lines.push(rows.slice(0, cap).map((r) => outsideSpan(`- ${r.title}, ${r.when} ${formatSourceLabel(r.source, ambiguous)}`)).join('\n'));
    if (rows.length > cap) lines.push('(call calendar_agenda for the fully merged view)');
  }
  if (empty.length > 0) {
    lines.push(`Also checked, nothing in this window: ${empty.map(s => formatSourceLabel(s, ambiguous)).join(', ')}`);
  }
  for (const f of failed) {
    lines.push(`could not check: ${f.label} (${f.error})`);
  }
  return lines.join('\n');
}

export interface MailboxCount {
  source: UnifiedSource;
  count: number;
  /** True when the count hit the per-mailbox page limit, so the real total may be higher. */
  atLeast?: boolean;
}

/**
 * "Also matching / checked elsewhere" block for a NARROW mail search. Every OTHER mailbox queried is
 * accounted for: matches get a count on the "Also matching" line, checked-with-none are named on a
 * "No matches in" line, and failed queries are itemized as "could not check".
 * Returns '' only when there was no other mailbox at all. Pure.
 */
export function renderOtherMailboxesCount(
  counts: MailboxCount[],
  ambiguous: Set<string>,
  opts: { emptySurfaces?: UnifiedSource[]; failed?: AccountFailure[] } = {},
): string {
  const empty = opts.emptySurfaces ?? [];
  const failed = opts.failed ?? [];
  const nonzero = counts.filter(c => c.count > 0);
  const lines: string[] = [];
  if (nonzero.length > 0) {
    const parts = nonzero.map(c => `${c.count}${c.atLeast ? '+' : ''} in ${formatSourceLabel(c.source, ambiguous)}`);
    lines.push(`Also matching in other connected mailboxes: ${parts.join(', ')}. Call email_search to see them together.`);
  }
  if (empty.length > 0) {
    lines.push(`No matches in: ${empty.map(s => formatSourceLabel(s, ambiguous)).join(', ')}`);
  }
  for (const f of failed) {
    lines.push(`could not check: ${f.label} (${f.error})`);
  }
  return lines.join('\n');
}

// ── Account enumeration (runtime; touches the DB via dynamic import) ──

interface EnumeratedAccount {
  provider: 'google' | 'microsoft';
  accountId: string;
  source: UnifiedSource;
  /** Human label used in per-account failure lines. */
  label: string;
}

/** A per-account service is enabled unless its JSON explicitly sets it false (defaults are all-on). */
function serviceEnabled(enabledServices: string | null, service: string): boolean {
  if (!enabledServices) return true;
  try {
    return (JSON.parse(enabledServices) as Record<string, unknown>)[service] !== false;
  } catch {
    return true;
  }
}

async function enumerateAccounts(service: 'calendar' | 'mail'): Promise<EnumeratedAccount[]> {
  const { listGoogleAccounts } = await import('../google/accounts.js');
  const { listMicrosoftAccounts } = await import('../microsoft/accounts.js');

  const googleService = service === 'calendar' ? 'calendar' : 'gmail';
  const msService = service === 'calendar' ? 'calendar' : 'outlook';
  const googleProvider = service === 'calendar' ? 'Google' : 'Gmail';
  const msProvider = service === 'calendar' ? 'Microsoft' : 'Outlook';
  const surface = service === 'calendar' ? 'calendar' : 'mailbox';

  const out: EnumeratedAccount[] = [];
  const make = (
    provider: 'google' | 'microsoft',
    accountId: string,
    kind: 'agent' | 'user',
    email: string | null,
    providerLabel: string,
  ): EnumeratedAccount => {
    const slot: SlotWord = kind === 'user' ? 'owner' : 'agent';
    const mail = email ?? '';
    return {
      provider,
      accountId,
      source: { providerLabel, slot, email: mail, labelKey: `${slot} ${providerLabel}` },
      label: `${slot} ${providerLabel} ${surface}${mail ? ` (${mail})` : ''}`,
    };
  };

  for (const kind of ['agent', 'user'] as const) {
    for (const a of listGoogleAccounts(kind)) {
      if (a.connected && serviceEnabled(a.enabledServices, googleService)) {
        out.push(make('google', a.id, kind, a.email, googleProvider));
      }
    }
    for (const a of listMicrosoftAccounts(kind)) {
      if (a.connected && serviceEnabled(a.enabledServices, msService)) {
        out.push(make('microsoft', a.id, kind, a.email, msProvider));
      }
    }
  }
  return out;
}

// ── Executors ──

/** Keep items inside the last `days` days; `days <= 0` keeps all, and an unparseable date (0) is never hidden. */
function withinDays<T extends { dateSortMs: number }>(items: T[], days: number): T[] {
  if (!(days > 0)) return items;
  const cutoff = Date.now() - days * 86400000;
  return items.filter(it => it.dateSortMs === 0 || it.dateSortMs >= cutoff);
}

/**
 * Merged agenda across EVERY connected calendar (agent + owner, Google +
 * Microsoft). The `account` arg is intentionally ignored: this view spans all
 * accounts; the provider variants take a single account.
 */
export async function unifiedCalendarAgenda(
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  const days = (args.days as number) ?? 1;
  const requestedTz = args.timezone as string | undefined;
  const tz = requestedTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const startDate = args.start_date as string | undefined;

  const { computeCalendarWindow } = await import('../services/calendar-window.js');
  const window = computeCalendarWindow({ days, timezone: requestedTz, start_date: startDate });

  const accounts = await enumerateAccounts('calendar');
  if (accounts.length === 0) {
    return 'No calendar is connected. Connect a Google or Microsoft account in Settings to see your agenda.';
  }

  const { fetchAgendaItemsForAccount } = await import('../google/tools-read.js');
  const { fetchAgendaItemsForAccountMs } = await import('../microsoft/tools-read.js');
  const { formatTimeRangeForAgent } = await import('../services/format-time.js');

  const failures: AccountFailure[] = [];
  const emptySurfaces: UnifiedSource[] = [];
  const collected: UnifiedCalendarItem[] = [];

  // Fetch in parallel but classify in a second pass in enumeration order, so the empty-surface list is stable.
  const results = await Promise.all(
    accounts.map(async (acc) => {
      try {
        const res =
          acc.provider === 'google'
            ? await fetchAgendaItemsForAccount(acc.accountId, window, tz, agentId, agentName, { days })
            : await fetchAgendaItemsForAccountMs(acc.accountId, window, agentId, agentName, { days });
        return { acc, res };
      } catch (err) {
        return { acc, res: { ok: false as const, error: err instanceof Error ? err.message : String(err) } };
      }
    }),
  );

  for (const { acc, res } of results) {
    if (!res.ok) {
      failures.push({ label: acc.label, error: res.error });
      continue;
    }
    if (res.items.length === 0) {
      emptySurfaces.push(acc.source); // checked, nothing in this window
      continue;
    }
    for (const it of res.items) {
      const when =
        it.start && it.end
          ? formatTimeRangeForAgent(it.start, it.end, { timezone: tz, allDay: it.allDay })
          : `${it.rawStart} to ${it.rawEnd} (could not parse)`;
      const startISO = it.start ? it.start.toISOString() : it.rawStart;
      const sortKey = it.start ? it.start.getTime() : Number.MAX_SAFE_INTEGER;
      collected.push({
        title: it.title,
        startISO,
        sortKey,
        allDay: it.allDay,
        location: it.location,
        when,
        source: acc.source,
      });
    }
  }

  const merged = dedupCalendarItems(mergeCalendarChronologically(collected));
  const ambiguous = computeAmbiguousLabels(accounts.map(a => a.source));
  return renderCalendarAgenda(merged, ambiguous, failures, { days, accountCount: accounts.length, emptySurfaces });
}

/**
 * Search EVERY connected mailbox at once (agent + owner, Gmail + Outlook). The
 * `days` bound is applied per-mailbox (Gmail via `newer_than`), `limit` caps
 * results per mailbox.
 */
export async function unifiedEmailSearch(
  args: Record<string, unknown>,
  agentId: string,
  agentName: string,
): Promise<string> {
  const query = (args.query as string | undefined)?.trim();
  if (!query) return 'Error: email_search requires a non-empty `query`.';
  const days = (args.days as number) ?? 30;
  const limit = (args.limit as number) ?? 5;

  const accounts = await enumerateAccounts('mail');
  if (accounts.length === 0) {
    return 'No mailbox is connected. Connect a Gmail or Outlook account in Settings to search your email.';
  }

  const { searchMailForAccount } = await import('../google/tools-read.js');
  const { searchMailForAccountMs } = await import('../microsoft/tools-read.js');

  const failures: AccountFailure[] = [];
  const emptySurfaces: UnifiedSource[] = [];
  const collected: UnifiedMailItem[] = [];

  // Fetch in parallel; classify in a second pass in enumeration order so the empty-surface list is stable.
  const results = await Promise.all(
    accounts.map(async (acc) => {
      try {
        if (acc.provider === 'google') {
          // Gmail understands `newer_than:Nd` as a recency bound in the query.
          const gq = days > 0 ? `${query} newer_than:${days}d` : query;
          const res = await searchMailForAccount(acc.accountId, gq, limit, agentId, agentName);
          return { acc, res: res.ok ? { ok: true as const, items: res.items, unfetched: res.unfetched } : res };
        }
        const res = await searchMailForAccountMs(acc.accountId, query, limit, agentId, agentName);
        // Outlook search takes no date bound: apply `days` here (0 = unparseable date, kept).
        return { acc, res: res.ok ? { ok: true as const, items: withinDays(res.items, days) } : res };
      } catch (err) {
        return { acc, res: { ok: false as const, error: err instanceof Error ? err.message : String(err) } };
      }
    }),
  );

  for (const { acc, res } of results) {
    if (!res.ok) {
      failures.push({ label: acc.label, error: res.error });
      continue;
    }
    const unread = 'unfetched' in res ? (res.unfetched?.length ?? 0) : 0;
    if (unread > 0) failures.push({ label: acc.label, error: `${unread} of ${unread + res.items.length} matching messages could not be read (Gmail refused the detail fetch); results from this mailbox are incomplete` });
    else if (res.items.length === 0) {
      emptySurfaces.push(acc.source); // searched, matched nothing
      continue;
    }
    for (const it of res.items) {
      collected.push({
        id: it.id,
        from: it.from,
        subject: it.subject,
        when: it.dateDisplay,
        sortKey: it.dateSortMs,
        snippet: it.snippet,
        unread: it.read === false,
        source: acc.source,
      });
    }
  }

  return renderEmailSearch(mergeMailByRecency(collected), computeAmbiguousLabels(accounts.map(a => a.source)), failures, { query, accountCount: accounts.length, emptySurfaces });
}

// ── Narrow-tool DATA-floor orchestrators (impure; fan out over OTHER surfaces) ──
// Called by the narrow cases in the provider files via dynamic import (keeps the static graph one-way). They
// reuse the merged executors' enumeration and fetch helpers, excluding the account already read. Each fetch
// runs in parallel and its failure is caught and reported as "could not check", so a narrow answer is never
// sunk or delayed by another surface.

/**
 * Compact "also on other calendars" block for a NARROW agenda read. `exclude` is the account the narrow tool
 * already rendered (provider + row id); every OTHER calendar is fetched for the SAME window in parallel and
 * accounted for (events, checked-empty, could not check). Returns '' when there is no other calendar.
 */
export async function otherCalendarsAgendaSection(
  exclude: { provider: 'google' | 'microsoft'; accountId: string },
  window: { startISO: string; endISO: string; anchored: boolean },
  tz: string,
  days: number,
  agentId: string,
  agentName: string,
): Promise<string> {
  const all = await enumerateAccounts('calendar');
  const accounts = all.filter(
    a => !(a.provider === exclude.provider && a.accountId === exclude.accountId),
  );
  if (accounts.length === 0) return '';

  const { fetchAgendaItemsForAccount } = await import('../google/tools-read.js');
  const { fetchAgendaItemsForAccountMs } = await import('../microsoft/tools-read.js');

  const results = await Promise.all(
    accounts.map(async (acc) => {
      try {
        const res =
          acc.provider === 'google'
            ? await fetchAgendaItemsForAccount(acc.accountId, window, tz, agentId, agentName, { days })
            : await fetchAgendaItemsForAccountMs(acc.accountId, window, agentId, agentName, { days });
        return { acc, res };
      } catch (err) {
        return { acc, res: { ok: false as const, error: err instanceof Error ? err.message : String(err) } };
      }
    }),
  );

  const collected: Array<{ row: OtherCalendarRow; sortKey: number }> = [];
  const emptySurfaces: UnifiedSource[] = [];
  const failed: AccountFailure[] = [];
  for (const { acc, res } of results) {
    if (!res.ok) {
      failed.push({ label: acc.label, error: res.error });
      continue;
    }
    if (res.items.length === 0) {
      emptySurfaces.push(acc.source);
      continue;
    }
    for (const it of res.items) {
      collected.push({
        row: { title: it.title, when: compactEventTime(it.start, tz, it.allDay), source: acc.source },
        sortKey: it.start ? it.start.getTime() : Number.MAX_SAFE_INTEGER,
      });
    }
  }

  collected.sort((a, b) => a.sortKey - b.sortKey);
  // Ambiguity spans ALL surfaces (the one already read included) so two accounts in a slot still differ by email.
  const ambiguous = computeAmbiguousLabels(all.map(a => a.source));
  const section = renderOtherCalendarsSection(collected.map(c => c.row), ambiguous, { emptySurfaces, failed });
  return section ? `\n\n${section}` : '';
}

/**
 * "Also matching / checked in other mailboxes" block for a NARROW mail search: the SAME query against every
 * OTHER mailbox (small per-mailbox cap), accounting for matches, checked-with-none and failed ones.
 * `days > 0` applies a Gmail recency bound; 0 mirrors an unbounded narrow search. Returns '' when none.
 */
export async function otherMailboxesCountSection(
  exclude: { provider: 'google' | 'microsoft'; accountId: string },
  query: string,
  days: number,
  agentId: string,
  agentName: string,
): Promise<string> {
  const all = await enumerateAccounts('mail');
  const accounts = all.filter(
    a => !(a.provider === exclude.provider && a.accountId === exclude.accountId),
  );
  if (accounts.length === 0) return '';

  const { searchMailForAccount } = await import('../google/tools-read.js');
  const { searchMailForAccountMs } = await import('../microsoft/tools-read.js');
  const perMailboxLimit = 5;

  const results = await Promise.all(
    accounts.map(async (acc) => {
      try {
        if (acc.provider === 'google') {
          const gq = days > 0 ? `${query} newer_than:${days}d` : query;
          const res = await searchMailForAccount(acc.accountId, gq, perMailboxLimit, agentId, agentName);
          return { acc, count: res.ok ? res.total : null, error: res.ok ? null : res.error };
        }
        const res = await searchMailForAccountMs(acc.accountId, query, perMailboxLimit, agentId, agentName);
        return { acc, count: res.ok ? withinDays(res.items, days).length : null, error: res.ok ? null : res.error };
      } catch (err) {
        return { acc, count: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const counts: MailboxCount[] = [];
  const emptySurfaces: UnifiedSource[] = [];
  const failed: AccountFailure[] = [];
  for (const r of results) {
    if (r.count === null) {
      failed.push({ label: r.acc.label, error: r.error ?? 'unknown error' });
      continue;
    }
    if (r.count > 0) counts.push({ source: r.acc.source, count: r.count, atLeast: r.count >= perMailboxLimit });
    else emptySurfaces.push(r.acc.source);
  }

  // Ambiguity spans ALL surfaces (the one already read included) so two accounts in a slot still differ by email.
  const ambiguous = computeAmbiguousLabels(all.map(a => a.source));
  const line = renderOtherMailboxesCount(counts, ambiguous, { emptySurfaces, failed });
  return line ? `\n\n${line}` : '';
}

// ── Tool surface ──

export const EMAIL_SEARCH_TOOL: ToolDefinition = {
  name: 'email_search',
  description:
    "[DEFAULT for any 'my email / check email for X' ask] Search EVERY connected mailbox at once (agent + owner, Gmail + Outlook), results labeled by source and merged most-recent-first. Use gmail_search / outlook_search / user_gmail_search / user_outlook_search only when the user names one specific mailbox. There is no `account` parameter here (the merged view spans every mailbox); the per-mailbox tools take one.",
  effects: [],
  // An explicit NEGATIVE advertisement: this tool says it has no `account` parameter (the merged view spans
  // every mailbox), because the four Google and Microsoft families have one, injected at module load.
  advertisedNotDeclared: {
    account: 'named only to say it does NOT exist on this merged view — an explicit negative advertisement distinguishing it from the per-mailbox tools that do take it',
  },
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to search for across all mailboxes (sender, subject keyword, or phrase).',
      },
      days: {
        type: 'number',
        description: 'How far back to search, in days (default 30). Applied as a per-mailbox recency bound.',
      },
      limit: {
        type: 'number',
        description: 'Max results per mailbox (default 5). Total results scale with the number of connected mailboxes.',
      },
    },
    required: ['query'],
  },
  concurrency: 'safe',
  maxResultTokens: 6000,
};

export const unifiedToolDefinitions: ToolDefinition[] = [EMAIL_SEARCH_TOOL];

// Register with the v2 partitioner / cap registry at module load (same path the
// Google/Microsoft tool files use). email_search is a pure read, safe to run in
// the same parallel batch as the other read tools.
registerConcurrency('email_search', 'safe');
registerMaxResultTokens('email_search', 6000);
